import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
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
    // Unrelated long-lived user processes (e.g. IDE build servers) can exceed
    // the command buffer; truncate them so process discovery stays usable.
    const command = Buffer.byteLength(match[3]) > 4_096 ? match[3].slice(0, 4_096) : match[3];
    seen.add(pid);
    processes.push({ pid, ppid, command });
  }
  return processes;
}

function commandArguments(command) {
  return command.trim().split(/\s+/);
}

function isCodexBrowserCommand(command) {
  const executable = commandArguments(command)[0] || "";
  return executable === "Codex"
    || executable.endsWith("/Codex.app/Contents/MacOS/Codex")
    || executable === "ChatGPT"
    || executable === "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
}

function discoverCodexProcessRecords(processes, debugPort) {
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
  const renderers = descendants
    .filter((process) => commandArguments(process.command).includes("--type=renderer"))
    .sort((left, right) => left.pid - right.pid);
  if (renderers.length === 0) throw new Error("expected at least one recursive renderer descendant");
  if (renderers.length > MAX_RENDERERS) throw new Error(`renderer count exceeds ${MAX_RENDERERS}`);
  return { browser: browsers[0], renderers };
}

export function discoverCodexProcesses(source, debugPort) {
  const { browser, renderers } = discoverCodexProcessRecords(parseProcessList(source), debugPort);
  return { browserPid: browser.pid, rendererPids: renderers.map((process) => process.pid) };
}

export function rediscoverRenderers(source, debugPort, expectedBrowserPid) {
  const { browserPid, rendererPids } = discoverCodexProcesses(source, debugPort);
  if (browserPid !== expectedBrowserPid) throw new Error("Codex browser identity changed during measurement");
  return rendererPids;
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

function parseProcessSampleList(source) {
  const processes = [];
  const seen = new Set();
  for (const rawLine of String(source).split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const match = rawLine.match(/^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?|\.\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) throw new Error(`invalid process sample row: ${rawLine}`);
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuPercent = Number(match[3]);
    const rssKb = Number(match[4]);
    // Same truncation policy as parseProcessList for unrelated over-long commands.
    const command = Buffer.byteLength(match[5]) > 4_096 ? match[5].slice(0, 4_096) : match[5];
    if (
      !Number.isSafeInteger(pid)
      || pid <= 0
      || !Number.isSafeInteger(ppid)
      || ppid < 0
      || !Number.isFinite(cpuPercent)
      || cpuPercent < 0
      || !Number.isSafeInteger(rssKb)
      || rssKb < 0
      || seen.has(pid)
      || processes.length >= MAX_PROCESS_ROWS
    ) {
      throw new Error(`invalid process sample row: ${rawLine}`);
    }
    seen.add(pid);
    processes.push({ pid, ppid, command, cpuPercent, rssKb });
  }
  return processes;
}

export function collectRendererProcessSample(source, debugPort, expectedBrowserPid) {
  const { browser, renderers } = discoverCodexProcessRecords(parseProcessSampleList(source), debugPort);
  if (browser.pid !== expectedBrowserPid) throw new Error("Codex browser identity changed during measurement");
  return {
    rendererPids: renderers.map((process) => process.pid),
    processes: renderers.map(({ pid, cpuPercent, rssKb }) => ({ pid, cpuPercent, rssKb })),
  };
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

export function selectPrimaryPage(targets, debugPort) {
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
    && target.url === "app://-/index.html"
    && typeof target.webSocketDebuggerUrl === "string"
    && Buffer.byteLength(target.webSocketDebuggerUrl) <= 4_096
    && target.webSocketDebuggerUrl === `ws://127.0.0.1:${debugPort}/devtools/page/${target.id}`
  ));
  if (pages.length !== 1) throw new Error(`expected exactly one primary page; found ${pages.length}`);
  return pages[0];
}

export function parseBrowserVersion(value) {
  const fields = {
    protocolVersion: 64,
    product: 256,
    revision: 256,
    userAgent: 1_024,
    jsVersion: 128,
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Browser.getVersion response");
  }
  const identity = {};
  for (const [name, maxBytes] of Object.entries(fields)) {
    if (typeof value[name] !== "string" || value[name].length === 0 || Buffer.byteLength(value[name]) > maxBytes) {
      throw new Error(`invalid Browser.getVersion field: ${name}`);
    }
    identity[name] = value[name];
  }
  return identity;
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

async function processSampleList() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1_024 * 1_024,
  });
  return stdout;
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

async function sampleOnce(client, debugPort, browserPid, listProcessSamples = processSampleList) {
  const [performanceResult, heapResult, processSource] = await Promise.all([
    client.send("Performance.getMetrics"),
    client.send("Runtime.getHeapUsage"),
    listProcessSamples(),
  ]);
  const { rendererPids, processes } = collectRendererProcessSample(processSource, debugPort, browserPid);
  return {
    timestamp: new Date().toISOString(),
    rendererPids,
    processes,
    aggregate: aggregateProcesses(processes),
    cdp: parseCdpSample(performanceResult, heapResult),
  };
}

export function validateTraceCompletion(params) {
  if (!params || typeof params !== "object" || !Object.hasOwn(params, "dataLossOccurred")) {
    throw new Error("Tracing.tracingComplete is missing dataLossOccurred");
  }
  if (params.dataLossOccurred !== false) {
    if (params.dataLossOccurred === true) throw new Error("CDP trace reported data loss");
    throw new Error("Tracing.tracingComplete has invalid dataLossOccurred");
  }
}

function temporarySibling(outputPath) {
  return `${resolve(outputPath)}.tmp-${process.pid}-${randomUUID()}`;
}

async function removeTemporary(path, removeFile) {
  try { await removeFile(path); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function prepareJsonOutput(outputPath, value, operations = {}) {
  const write = operations.writeFile || writeFile;
  const removeFile = operations.unlink || unlink;
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== "string") throw new Error("metrics output is not serializable");
  JSON.parse(serialized);
  const finalPath = resolve(outputPath);
  const temporaryPath = temporarySibling(finalPath);
  await mkdir(dirname(finalPath), { recursive: true });
  try {
    await write(temporaryPath, `${serialized}\n`, "utf8");
    return { temporaryPath, finalPath };
  } catch (error) {
    await removeTemporary(temporaryPath, removeFile);
    throw error;
  }
}

async function discardPreparedOutput(output, operations = {}) {
  if (output) await removeTemporary(output.temporaryPath, operations.unlink || unlink);
}

export async function publishPreparedOutputs(outputs, operations = {}) {
  if (!Array.isArray(outputs) || outputs.length === 0 || outputs.length > 2) {
    throw new Error("invalid prepared output group");
  }
  const finalPaths = new Set();
  const temporaryPaths = new Set();
  const states = outputs.map((output) => {
    const finalPath = resolve(output?.finalPath || "");
    const temporaryPath = resolve(output?.temporaryPath || "");
    if (
      dirname(finalPath) !== dirname(temporaryPath)
      || !temporaryPath.startsWith(`${finalPath}.tmp-`)
      || finalPaths.has(finalPath)
      || temporaryPaths.has(temporaryPath)
    ) {
      throw new Error("invalid prepared output group");
    }
    finalPaths.add(finalPath);
    temporaryPaths.add(temporaryPath);
    return {
      finalPath,
      temporaryPath,
      backupPath: `${finalPath}.backup-${process.pid}-${randomUUID()}`,
      hadPrior: false,
      published: false,
    };
  });
  const statFile = operations.lstat || lstat;
  const renameFile = operations.rename || rename;
  const removeFile = operations.unlink || unlink;
  const warn = operations.warn || ((message) => process.emitWarning(message));
  for (const state of states) {
    try {
      const status = await statFile(state.finalPath);
      if (!status.isFile()) throw new Error("existing output must be a regular file");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    for (const state of states) {
      try {
        await renameFile(state.finalPath, state.backupPath);
        state.hadPrior = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    for (const state of states) {
      await renameFile(state.temporaryPath, state.finalPath);
      state.published = true;
    }
  } catch (error) {
    let rollbackError = null;
    for (const state of [...states].reverse()) {
      if (state.published) {
        try { await removeTemporary(state.finalPath, removeFile); } catch (failure) { rollbackError ||= failure; }
      }
    }
    for (const state of states) {
      if (state.hadPrior) {
        try { await renameFile(state.backupPath, state.finalPath); } catch (failure) { rollbackError ||= failure; }
      }
      try { await removeTemporary(state.temporaryPath, removeFile); } catch (failure) { rollbackError ||= failure; }
    }
    if (rollbackError) throw new AggregateError([error, rollbackError], "output group publication and rollback failed");
    throw error;
  }
  for (const state of states) {
    if (!state.hadPrior) continue;
    try {
      await removeTemporary(state.backupPath, removeFile);
    } catch {
      try { warn("committed output backup cleanup failed"); } catch {}
    }
  }
}

export async function writeJsonAtomically(outputPath, value, operations = {}) {
  const prepared = await prepareJsonOutput(outputPath, value, operations);
  await publishPreparedOutputs([prepared], operations);
}

export async function startTrace(client, outputPath, operations = {}) {
  const createStream = operations.createStream || createWriteStream;
  const removeFile = operations.unlink || unlink;
  const finalPath = resolve(outputPath);
  const temporaryPath = temporarySibling(finalPath);
  await mkdir(dirname(finalPath), { recursive: true });
  let stream;
  try {
    stream = createStream(temporaryPath, { encoding: "utf8" });
  } catch (error) {
    await removeTemporary(temporaryPath, removeFile);
    throw error;
  }
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
  const completed = new Promise((resolveComplete) => {
    completeTrace = resolveComplete;
  });
  let endRequested = false;
  let completionError = null;
  const removeComplete = client.on("Tracing.tracingComplete", (params) => {
    if (!endRequested) {
      completionError ||= new Error("Tracing.tracingComplete arrived before Tracing.end was requested");
      return;
    }
    try {
      validateTraceCompletion(params);
    } catch (error) {
      completionError ||= error;
    }
    completeTrace();
  });
  try {
    await client.send("Tracing.start", { categories: TRACE_CATEGORIES, transferMode: "ReportEvents" });
  } catch (error) {
    removeData();
    removeComplete();
    stream.destroy();
    try { await finished(stream); } catch {}
    await removeTemporary(temporaryPath, removeFile);
    throw error;
  }
  let stopped = false;
  let prepared = null;
  const controller = {
    assertHealthy() {
      if (streamError) throw streamError;
      if (completionError) throw completionError;
    },
    async abort() {
      if (stopped) return;
      stopped = true;
      removeData();
      removeComplete();
      try { await client.send("Tracing.end"); } catch {}
      if (!stream.destroyed) stream.destroy();
      try { await finished(stream); } catch {}
      await removeTemporary(temporaryPath, removeFile);
    },
    async prepare() {
      if (prepared) return prepared;
      if (stopped) throw new Error("trace capture is no longer available");
      stopped = true;
      let timeout;
      let stopError = null;
      try {
        endRequested = true;
        await client.send("Tracing.end");
        if (completionError) throw completionError;
        await Promise.race([
          completed,
          new Promise((_, rejectTimeout) => {
            timeout = setTimeout(() => rejectTimeout(new Error("Tracing.tracingComplete timed out")), 30_000);
          }),
        ]);
        if (completionError) throw completionError;
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
      stopError ||= streamError;
      if (stopError) {
        await removeTemporary(temporaryPath, removeFile);
        throw stopError;
      }
      prepared = { temporaryPath, finalPath };
      return prepared;
    },
    async stop() {
      const output = await controller.prepare();
      await publishPreparedOutputs([output], operations);
    },
  };
  return controller;
}

export async function runMeasurement(options, dependencies = {}) {
  const fetchTargets = dependencies.fetchJson || fetchJson;
  const listProcesses = dependencies.processList || processList;
  const connectCdp = dependencies.connectCdp || CdpClient.connect;
  const readDiagnostics = dependencies.pageDiagnostics || pageDiagnostics;
  const startObserver = dependencies.installLongTaskObserver || installLongTaskObserver;
  const stopObserver = dependencies.removeLongTaskObserver || removeLongTaskObserver;
  const startTraceCapture = dependencies.startTrace || startTrace;
  const sleep = dependencies.delay || delay;
  const monotonicNow = dependencies.performanceNow || (() => performance.now());
  const takeSample = dependencies.sampleOnce
    || ((client, debugPort, browserPid) => sampleOnce(client, debugPort, browserPid, dependencies.processSampleList));
  const summarize = dependencies.summarizeSamples || summarizeSamples;
  const endpoint = `http://127.0.0.1:${options.debugPort}/json/list`;
  const [targets, psOutput] = await Promise.all([fetchTargets(endpoint), listProcesses()]);
  const page = selectPrimaryPage(targets, options.debugPort);
  const { browserPid, rendererPids } = discoverCodexProcesses(psOutput, options.debugPort);
  const client = await connectCdp(page.webSocketDebuggerUrl);
  let trace = null;
  let preparedTrace = null;
  let preparedMetrics = null;
  let observerInstalled = false;
  try {
    const browserVersion = parseBrowserVersion(await client.send("Browser.getVersion"));
    await client.send("Performance.enable");
    const diagnosticsBefore = await readDiagnostics(client);
    await startObserver(client);
    observerInstalled = true;
    if (options.traceOutput) trace = await startTraceCapture(client, options.traceOutput);
    const startedAt = new Date().toISOString();
    const startedMonotonic = monotonicNow();
    const samples = [];
    for (let index = 0; index < options.durationSeconds; index += 1) {
      const deadline = startedMonotonic + ((index + 1) * 1_000);
      await sleep(Math.max(0, deadline - monotonicNow()));
      const lateness = monotonicNow() - deadline;
      if (lateness > 900) throw new Error(`missed 1 Hz sample deadline by ${lateness.toFixed(1)}ms`);
      trace?.assertHealthy();
      samples.push(await takeSample(client, options.debugPort, browserPid));
      trace?.assertHealthy();
    }
    if (samples.length !== options.durationSeconds) throw new Error("sample collection is incomplete");
    const endedAt = new Date().toISOString();
    const longTasks = await stopObserver(client);
    observerInstalled = false;
    if (trace) {
      preparedTrace = await trace.prepare();
      trace = null;
    }
    const diagnosticsAfter = await readDiagnostics(client);
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
      summary: summarize(samples),
      longTasks,
      costDiagnostics: buildCostDiagnostics(diagnosticsBefore, diagnosticsAfter),
    };
    preparedMetrics = await prepareJsonOutput(options.output, result, dependencies.outputOperations);
    await publishPreparedOutputs(
      preparedTrace ? [preparedTrace, preparedMetrics] : [preparedMetrics],
      dependencies.outputOperations,
    );
    preparedTrace = null;
    preparedMetrics = null;
    return result;
  } finally {
    if (observerInstalled) {
      try { await stopObserver(client); } catch {}
    }
    if (trace) {
      try { await trace.abort(); } catch {}
    }
    try { await discardPreparedOutput(preparedTrace, dependencies.outputOperations); } catch {}
    try { await discardPreparedOutput(preparedMetrics, dependencies.outputOperations); } catch {}
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
