import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

export const MAX_DURATION_SECONDS = 1_800;
export const MAX_PROCESS_ROWS = 4_096;
export const MAX_RENDERERS = 32;
export const MAX_CDP_METRICS = 128;
export const MAX_DIAGNOSTIC_BYTES = 64 * 1_024;
export const MAX_DIAGNOSTIC_DURATIONS = 256;

const execFileAsync = promisify(execFile);
const CDP_RESPONSE_TIMEOUT_MS = 10_000;
const CDP_PAYLOAD_LIMIT_BYTES = 8 * 1_024 * 1_024;
const MAX_TRACE_BUFFER_BYTES = 16 * 1_024 * 1_024;
const TRACE_CATEGORIES = "devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.cpu_profiler";
const PAGE_DIAGNOSTIC_COUNTERS = [
  "domWrites",
  "listenerCount",
  "outstandingTimers",
  "observerCount",
  "bridgeCalls",
  "snapshotCount",
  "ownedNodeCount",
];
const NATIVE_DIAGNOSTIC_COUNTERS = [
  "events_ingested",
  "events_coalesced",
  "events_rejected",
  "queue_depth",
  "queue_high_water",
  "recent_turns",
  "dedupe_fingerprints",
  "snapshots_published",
  "snapshots_sent",
  "lazy_commands_sent",
];

function requiredText(value, name, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^[0-9]+$/.test(value || "")) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const allowed = new Set(["--debug-port", "--duration-seconds", "--label", "--output", "--trace-output"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || values.has(name)) {
      throw new Error(`invalid or duplicate argument: ${String(name)}`);
    }
    values.set(name, value);
  }
  for (const name of ["--debug-port", "--duration-seconds", "--label", "--output"]) {
    if (!values.has(name)) throw new Error(`missing required argument: ${name}`);
  }

  const output = requiredText(values.get("--output"), "--output", 4_096);
  const traceOutput = values.has("--trace-output")
    ? requiredText(values.get("--trace-output"), "--trace-output", 4_096)
    : null;
  if (traceOutput && resolve(traceOutput) === resolve(output)) {
    throw new Error("--output and --trace-output must be different destinations");
  }

  return {
    debugPort: boundedInteger(values.get("--debug-port"), "--debug-port", 1, 65_535),
    durationSeconds: boundedInteger(values.get("--duration-seconds"), "--duration-seconds", 1, MAX_DURATION_SECONDS),
    label: requiredText(values.get("--label"), "--label", 128),
    output,
    traceOutput,
  };
}

export function parseProcessList(source) {
  const processes = [];
  const seen = new Set();
  for (const rawLine of String(source).split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const match = rawLine.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) throw new Error(`invalid process row: ${rawLine}`);
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || seen.has(pid)) {
      throw new Error(`invalid process row: ${rawLine}`);
    }
    if (processes.length >= MAX_PROCESS_ROWS) throw new Error(`process list exceeds ${MAX_PROCESS_ROWS} rows`);
    seen.add(pid);
    processes.push({ pid, ppid, command: match[3] });
  }
  return processes;
}

function commandArguments(command) {
  return command.trim().split(/\s+/);
}

function isCodexBrowserCommand(command) {
  const executable = commandArguments(command)[0] || "";
  return executable === "Codex" || executable.endsWith("/Codex.app/Contents/MacOS/Codex");
}

export function discoverCodexProcesses(source, debugPort) {
  const processes = parseProcessList(source);
  const marker = `--remote-debugging-port=${debugPort}`;
  const browsers = processes.filter((process) => {
    const args = commandArguments(process.command);
    return isCodexBrowserCommand(process.command) && args.includes(marker) && !args.some((arg) => arg.startsWith("--type="));
  });
  if (browsers.length !== 1) throw new Error(`expected exactly one Codex browser for ${marker}; found ${browsers.length}`);

  const children = new Map();
  for (const process of processes) {
    const bucket = children.get(process.ppid) || [];
    bucket.push(process);
    children.set(process.ppid, bucket);
  }
  const descendants = [];
  const pending = [browsers[0].pid];
  const visited = new Set(pending);
  for (let index = 0; index < pending.length; index += 1) {
    for (const child of children.get(pending[index]) || []) {
      if (visited.has(child.pid)) throw new Error("process tree contains a cycle");
      visited.add(child.pid);
      descendants.push(child);
      pending.push(child.pid);
    }
  }
  const rendererPids = descendants
    .filter((process) => commandArguments(process.command).includes("--type=renderer"))
    .map((process) => process.pid)
    .sort((left, right) => left - right);
  if (rendererPids.length === 0) throw new Error("expected at least one recursive renderer descendant");
  if (rendererPids.length > MAX_RENDERERS) throw new Error(`renderer count exceeds ${MAX_RENDERERS}`);
  return { browserPid: browsers[0].pid, rendererPids };
}

export function parseProcessStat(source, pid) {
  const fields = String(source).trim().split(/\s+/);
  if (
    fields.length !== 2
    || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(fields[0])
    || !/^\d+$/.test(fields[1])
  ) {
    throw new Error(`invalid process sample for PID ${pid}`);
  }
  const cpuPercent = Number(fields[0]);
  const rssKb = Number(fields[1]);
  if (!Number.isFinite(cpuPercent) || cpuPercent < 0 || !Number.isSafeInteger(rssKb) || rssKb < 0) {
    throw new Error(`invalid process sample for PID ${pid}`);
  }
  return { pid, cpuPercent, rssKb };
}

export function parseCdpSample(performanceResult, heapResult) {
  const entries = performanceResult?.metrics;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_CDP_METRICS) {
    throw new Error("CDP metrics must contain TaskDuration in a bounded list");
  }
  const metrics = {};
  for (const entry of entries) {
    if (
      !entry
      || typeof entry.name !== "string"
      || entry.name.length === 0
      || Buffer.byteLength(entry.name) > 128
      || typeof entry.value !== "number"
      || !Number.isFinite(entry.value)
      || entry.value < 0
      || Object.hasOwn(metrics, entry.name)
    ) {
      throw new Error("invalid CDP metric");
    }
    metrics[entry.name] = entry.value;
  }
  if (!Object.hasOwn(metrics, "TaskDuration")) throw new Error("CDP metrics are missing TaskDuration");

  const heapFields = ["usedSize", "totalSize", "embedderHeapUsedSize", "backingStorageSize"];
  const heap = {};
  for (const name of heapFields) {
    const value = heapResult?.[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error("invalid heap sample");
    }
    heap[name] = value;
  }
  if (heap.usedSize > heap.totalSize) throw new Error("invalid heap sample");
  return { metrics, heap };
}

export function selectPrimaryPage(targets) {
  if (!Array.isArray(targets) || targets.length > 128) throw new Error("expected exactly one primary page");
  const pages = targets.filter((target) => (
    target
    && typeof target.id === "string"
    && target.id.length > 0
    && Buffer.byteLength(target.id) <= 256
    && target.type === "page"
    && typeof target.title === "string"
    && Buffer.byteLength(target.title) <= 1_024
    && typeof target.url === "string"
    && Buffer.byteLength(target.url) <= 4_096
    && typeof target.webSocketDebuggerUrl === "string"
    && target.webSocketDebuggerUrl.length > 0
    && Buffer.byteLength(target.webSocketDebuggerUrl) <= 4_096
  ));
  const codexPages = pages.filter((target) => target.url.startsWith("app://-/"));
  const candidates = codexPages.length > 0 ? codexPages : pages;
  if (candidates.length !== 1) throw new Error(`expected exactly one primary page; found ${candidates.length}`);
  return candidates[0];
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`invalid ${label}`);
  return value;
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_DURATION_SECONDS) {
    throw new Error("invalid bounded sample collection");
  }
  const cpu = samples.map((sample) => finiteNumber(sample?.aggregate?.cpuPercent, "aggregate CPU sample"));
  const rss = samples.map((sample) => finiteNumber(sample?.aggregate?.rssKb, "aggregate RSS sample"));
  const heap = samples.map((sample) => finiteNumber(sample?.cdp?.heap?.usedSize, "heap sample"));
  const sortedCpu = [...cpu].sort((left, right) => left - right);
  const middle = Math.floor(sortedCpu.length / 2);
  const median = sortedCpu.length % 2 === 0
    ? (sortedCpu[middle - 1] + sortedCpu[middle]) / 2
    : sortedCpu[middle];
  return {
    cpuPercent: {
      median,
      average: cpu.reduce((sum, value) => sum + value, 0) / cpu.length,
      max: Math.max(...cpu),
    },
    rssKb: { start: rss[0], end: rss.at(-1), max: Math.max(...rss) },
    heapUsedBytes: { start: heap[0], end: heap.at(-1), max: Math.max(...heap) },
  };
}

function validateDiagnosticEndpoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid cost diagnostics");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_DIAGNOSTIC_BYTES) throw new Error("cost diagnostics exceed byte limit");
  if (
    typeof value.instanceId !== "string"
    || value.instanceId.length === 0
    || Buffer.byteLength(value.instanceId) > 128
    || PAGE_DIAGNOSTIC_COUNTERS.some((name) => !Number.isSafeInteger(value[name]) || value[name] < 0)
    || !Array.isArray(value.updateDurationsMs)
    || value.updateDurationsMs.length > MAX_DIAGNOSTIC_DURATIONS
    || value.updateDurationsMs.some((duration) => typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
    || !Array.isArray(value.mountedModules)
    || value.mountedModules.length > 4
    || value.mountedModules.some((name) => !["settings", "analytics", "profile", "flatpickr"].includes(name))
    || !value.native
    || typeof value.native !== "object"
    || Array.isArray(value.native)
    || NATIVE_DIAGNOSTIC_COUNTERS.some((name) => !Number.isSafeInteger(value.native[name]) || value.native[name] < 0)
  ) {
    throw new Error("invalid cost diagnostics");
  }
  return value;
}

function numericDelta(before, after, names) {
  const delta = {};
  for (const name of names) delta[name] = after[name] - before[name];
  return delta;
}

export function buildCostDiagnostics(beforeValue, afterValue) {
  if (beforeValue == null && afterValue == null) return null;
  if (beforeValue == null || afterValue == null) throw new Error("cost diagnostics availability changed during measurement");
  const before = validateDiagnosticEndpoint(beforeValue);
  const after = validateDiagnosticEndpoint(afterValue);
  if (before.instanceId !== after.instanceId) throw new Error("cost diagnostics instance changed during measurement");
  return {
    before,
    after,
    pageDelta: numericDelta(before, after, PAGE_DIAGNOSTIC_COUNTERS),
    nativeDelta: numericDelta(before.native, after.native, NATIVE_DIAGNOSTIC_COUNTERS),
  };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function readBoundedResponseText(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array) || totalBytes + value.byteLength > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`response exceeds byte limit of ${maxBytes}`);
    }
    totalBytes += value.byteLength;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(CDP_RESPONSE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`CDP endpoint ${url} returned HTTP ${response.status}`);
  const body = await readBoundedResponseText(response, 256 * 1_024);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`CDP target list is invalid JSON: ${error.message}`);
  }
}

export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.fatalError = null;
    socket.addEventListener("message", (event) => this.#receive(event));
    socket.addEventListener("close", () => this.#fail(new Error("CDP WebSocket closed")));
    socket.addEventListener("error", () => this.#fail(new Error("CDP WebSocket failed")));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => {
        socket.close();
        rejectOpen(new Error("CDP WebSocket open timed out"));
      }, CDP_RESPONSE_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("CDP WebSocket open failed"));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  on(method, listener) {
    const bucket = this.listeners.get(method) || new Set();
    bucket.add(listener);
    this.listeners.set(method, bucket);
    return () => bucket.delete(listener);
  }

  send(method, params = {}, timeoutMs = CDP_RESPONSE_TIMEOUT_MS) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.socket.readyState !== 1 || this.pending.size >= 64) {
      return Promise.reject(new Error("CDP command queue is unavailable or full"));
    }
    const id = this.nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolveCommand, reject: rejectCommand, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectCommand(error);
      }
    });
  }

  close() {
    if (this.socket.readyState < 2) this.socket.close();
    this.#fail(new Error("CDP client closed"));
  }

  #receive(event) {
    if (typeof event.data !== "string" || Buffer.byteLength(event.data) > CDP_PAYLOAD_LIMIT_BYTES) {
      this.#fail(new Error("invalid or oversized CDP payload"));
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      this.#fail(new Error("invalid CDP JSON payload"));
      return;
    }
    if (Number.isSafeInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message || "unknown error"}`));
      else pending.resolve(message.result || {});
      return;
    }
    if (typeof message.method !== "string") return;
    for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
  }

  #fail(error) {
    this.fatalError ||= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.fatalError);
    }
    this.pending.clear();
  }
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(`Runtime.evaluate failed: ${response.exceptionDetails.text || "page exception"}`);
  }
  if (!response.result || !Object.hasOwn(response.result, "value")) throw new Error("Runtime.evaluate returned no value");
  return response.result.value;
}

async function pageDiagnostics(client) {
  return evaluate(client, `(async()=>{
    const api=window.__codexLiveTokenCostV1;
    const capture=window.__codexLiveTokenCostCaptureV1;
    if(!api||typeof api.diagnostics!=="function"||!capture||capture.enabled!==true||capture.instanceId!==api.instanceId)return null;
    return await api.diagnostics();
  })()`);
}

async function installLongTaskObserver(client) {
  const installed = await evaluate(client, `(()=>{
    if(typeof PerformanceObserver!=="function")throw new Error("PerformanceObserver unavailable");
    window.__codexDsStyleCostMeasurementV1?.observer?.disconnect?.();
    const state={count:0,totalDurationMs:0,maxDurationMs:0,observer:null};
    state.observer=new PerformanceObserver((list)=>{
      for(const entry of list.getEntries()){
        state.count+=1;
        state.totalDurationMs+=entry.duration;
        state.maxDurationMs=Math.max(state.maxDurationMs,entry.duration);
      }
    });
    state.observer.observe({type:"longtask"});
    window.__codexDsStyleCostMeasurementV1=state;
    return true;
  })()`);
  if (installed !== true) throw new Error("failed to install long-task observer");
}

async function removeLongTaskObserver(client) {
  const result = await evaluate(client, `(()=>{
    const state=window.__codexDsStyleCostMeasurementV1;
    if(!state)return null;
    state.observer?.disconnect?.();
    const result={count:state.count,totalDurationMs:state.totalDurationMs,maxDurationMs:state.maxDurationMs};
    delete window.__codexDsStyleCostMeasurementV1;
    return result;
  })()`);
  if (
    !result
    || !Number.isSafeInteger(result.count)
    || result.count < 0
    || !Number.isFinite(result.totalDurationMs)
    || result.totalDurationMs < 0
    || !Number.isFinite(result.maxDurationMs)
    || result.maxDurationMs < 0
  ) {
    throw new Error("invalid long-task aggregates");
  }
  return result;
}

async function processList() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1_024 * 1_024,
  });
  return stdout;
}

async function sampleRenderer(pid) {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "%cpu=,rss="], {
    encoding: "utf8",
    maxBuffer: 64 * 1_024,
  });
  return parseProcessStat(stdout, pid);
}

function aggregateProcesses(processes) {
  if (!Array.isArray(processes) || processes.length === 0 || processes.length > MAX_RENDERERS) {
    throw new Error("invalid renderer process sample set");
  }
  return {
    cpuPercent: processes.reduce((sum, process) => sum + process.cpuPercent, 0),
    rssKb: processes.reduce((sum, process) => sum + process.rssKb, 0),
  };
}

async function sampleOnce(client, rendererPids) {
  const [performanceResult, heapResult, processes] = await Promise.all([
    client.send("Performance.getMetrics"),
    client.send("Runtime.getHeapUsage"),
    Promise.all(rendererPids.map((pid) => sampleRenderer(pid))),
  ]);
  return {
    timestamp: new Date().toISOString(),
    processes,
    aggregate: aggregateProcesses(processes),
    cdp: parseCdpSample(performanceResult, heapResult),
  };
}

async function startTrace(client, outputPath) {
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  const stream = createWriteStream(outputPath, { encoding: "utf8" });
  let first = true;
  let streamError = null;
  stream.on("error", (error) => { streamError = error; });
  stream.write('{"traceEvents":[');
  const removeData = client.on("Tracing.dataCollected", (params) => {
    if (streamError) return;
    if (!Array.isArray(params.value)) {
      streamError = new Error("invalid Tracing.dataCollected payload");
      stream.destroy(streamError);
      return;
    }
    for (const event of params.value) {
      let chunk;
      try {
        chunk = `${first ? "" : ","}${JSON.stringify(event)}`;
      } catch (error) {
        streamError = new Error(`invalid trace event: ${error.message}`);
        stream.destroy(streamError);
        return;
      }
      if (stream.writableLength + Buffer.byteLength(chunk) > MAX_TRACE_BUFFER_BYTES) {
        streamError = new Error(`trace write buffer exceeds ${MAX_TRACE_BUFFER_BYTES} bytes`);
        stream.destroy(streamError);
        return;
      }
      stream.write(chunk);
      first = false;
    }
  });
  let completeTrace;
  const completed = new Promise((resolveComplete) => { completeTrace = resolveComplete; });
  const removeComplete = client.on("Tracing.tracingComplete", completeTrace);
  try {
    await client.send("Tracing.start", { categories: TRACE_CATEGORIES, transferMode: "ReportEvents" });
  } catch (error) {
    removeData();
    removeComplete();
    stream.destroy();
    try { await finished(stream); } catch {}
    throw error;
  }
  let stopped = false;
  return {
    assertHealthy() {
      if (streamError) throw streamError;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      let timeout;
      let stopError = null;
      try {
        await client.send("Tracing.end");
        await Promise.race([
          completed,
          new Promise((_, rejectTimeout) => {
            timeout = setTimeout(() => rejectTimeout(new Error("Tracing.tracingComplete timed out")), 30_000);
          }),
        ]);
      } catch (error) {
        stopError = error;
      } finally {
        clearTimeout(timeout);
        removeData();
        removeComplete();
        if (stopError && !stream.destroyed) stream.destroy(stopError);
        else if (!stream.destroyed) stream.end("]}\n");
      }
      try {
        await finished(stream);
      } catch (error) {
        stopError ||= error;
      }
      if (streamError) throw streamError;
      if (stopError) throw stopError;
    },
  };
}

async function runMeasurement(options) {
  const endpoint = `http://127.0.0.1:${options.debugPort}/json/list`;
  const [targets, psOutput] = await Promise.all([fetchJson(endpoint), processList()]);
  const page = selectPrimaryPage(targets);
  const { browserPid, rendererPids } = discoverCodexProcesses(psOutput, options.debugPort);
  const client = await CdpClient.connect(page.webSocketDebuggerUrl);
  let trace = null;
  let observerInstalled = false;
  try {
    const browserVersion = await client.send("Browser.getVersion");
    await client.send("Performance.enable");
    const diagnosticsBefore = await pageDiagnostics(client);
    await installLongTaskObserver(client);
    observerInstalled = true;
    if (options.traceOutput) trace = await startTrace(client, options.traceOutput);
    const startedAt = new Date().toISOString();
    const startedMonotonic = performance.now();
    const samples = [];
    for (let index = 0; index < options.durationSeconds; index += 1) {
      const deadline = startedMonotonic + ((index + 1) * 1_000);
      await delay(Math.max(0, deadline - performance.now()));
      const lateness = performance.now() - deadline;
      if (lateness > 900) throw new Error(`missed 1 Hz sample deadline by ${lateness.toFixed(1)}ms`);
      trace?.assertHealthy();
      samples.push(await sampleOnce(client, rendererPids));
      trace?.assertHealthy();
    }
    if (samples.length !== options.durationSeconds) throw new Error("sample collection is incomplete");
    const endedAt = new Date().toISOString();
    const longTasks = await removeLongTaskObserver(client);
    observerInstalled = false;
    if (trace) {
      await trace.stop();
      trace = null;
    }
    const diagnosticsAfter = await pageDiagnostics(client);
    const result = {
      label: options.label,
      startedAt,
      endedAt,
      identity: {
        debugEndpoint: endpoint,
        page: { id: page.id, type: page.type, title: page.title, url: page.url },
        browserVersion,
      },
      browserPid,
      rendererPids,
      samples,
      summary: summarizeSamples(samples),
      longTasks,
      costDiagnostics: buildCostDiagnostics(diagnosticsBefore, diagnosticsAfter),
    };
    await mkdir(dirname(resolve(options.output)), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } finally {
    if (observerInstalled) {
      try { await removeLongTaskObserver(client); } catch {}
    }
    if (trace) {
      try { await trace.stop(); } catch {}
    }
    client.close();
  }
}

async function main() {
  await runMeasurement(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
