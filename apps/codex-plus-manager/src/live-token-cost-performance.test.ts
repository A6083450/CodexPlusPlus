import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
const runnerUrl = new URL("../../../scripts/measure-ds-style-cost-performance.mjs", import.meta.url);
const {
  CdpClient,
  buildCostDiagnostics,
  discoverCodexProcesses,
  parseArgs,
  parseBrowserVersion,
  parseCdpSample,
  parseProcessList,
  parseProcessStat,
  readBoundedResponseText,
  rediscoverRenderers,
  selectPrimaryPage,
  summarizeSamples,
  startTrace,
  validateTraceCompletion,
  writeJsonAtomically,
} = await import(runnerUrl.href);

const SOURCE_URL = new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url);
const RENDERER_SOURCE_URL = new URL("../../../assets/inject/renderer-inject.js", import.meta.url);
const MAX_STARTUP_BYTES = 61_440;
const FORBIDDEN: Array<[string, RegExp]> = [
  ["localStorage", /\blocalStorage\b/],
  ["sessionStorage", /\bsessionStorage\b/],
  ["indexedDB", /\bindexedDB\b/],
  ["MutationObserver", /\bMutationObserver\b/],
  ["ResizeObserver", /\bResizeObserver\b/],
  ["setInterval", /\bsetInterval\s*\(/],
  ["clone", /(?:\.\s*clone|\[\s*["']clone["']\s*\])\s*\(/],
  ["layout dimension read", /\b(?:offsetWidth|offsetHeight|clientWidth|clientHeight|scrollWidth|scrollHeight)\b/],
  ["getBoundingClientRect", /\bgetBoundingClientRect\s*\(/],
  ["getComputedStyle", /\bgetComputedStyle\s*\(/],
  ["Array.prototype", /\bArray\s*(?:\.\s*prototype|\[\s*["']prototype["']\s*\])/],
  ["Promise.prototype", /\bPromise\s*(?:\.\s*prototype|\[\s*["']prototype["']\s*\])/],
  ["RegExp.prototype", /\bRegExp\s*(?:\.\s*prototype|\[\s*["']prototype["']\s*\])/],
  ["fetch replacement", /\b(?:window|globalThis)\s*(?:\.\s*fetch|\[\s*["']fetch["']\s*\])\s*=/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["electronBridge replacement", /\belectronBridge\s*=/],
  ["Statsig", /\bStatsig\b/],
  ["__react", /\b__react\w*\b/],
  ["eval", /\beval\s*\(/],
  ["new Function", /\bnew\s+Function\b/],
];

function forbiddenMechanisms(source: string) {
  return FORBIDDEN.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
}

function extractTokenCostBlock(source: string) {
  const begin = "// TOKEN_COST_BEGIN";
  const end = "// TOKEN_COST_END";
  assert.equal(source.split(begin).length - 1, 1, "renderer must contain exactly one TOKEN_COST_BEGIN marker");
  assert.equal(source.split(end).length - 1, 1, "renderer must contain exactly one TOKEN_COST_END marker");
  const start = source.indexOf(begin) + begin.length;
  const finish = source.indexOf(end);
  assert.ok(start < finish, "token cost policy markers must be ordered");
  return source.slice(start, finish);
}

function functionBody(source: string, openBrace: number) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === "\"" || current === "'" || current === "`") {
      quote = current;
      continue;
    }
    if (current === "{") depth += 1;
    if (current === "}" && --depth === 0) return source.slice(openBrace + 1, index);
  }
  throw new Error("unterminated function body in policy source");
}

function recursiveArbitraryEnumerators(source: string) {
  const suspects = new Set<string>();
  const enumerates = (body: string) => /\bObject\s*\.\s*(?:keys|values|entries)\s*\(/.test(body)
    || /\bfor\s*\(\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s+in\s+/.test(body);
  const inspect = (reportedName: string, recursiveNames: string[], body: string) => {
    const recurses = recursiveNames.some((name) => new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\s*\\(`).test(body));
    if (enumerates(body) && recurses) suspects.add(reportedName);
  };
  const blocks: Array<[RegExp, (match: RegExpMatchArray) => [string, string[]]]> = [
    [/\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g, (match) => [match[1], [match[1]]]],
    [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function(?:\s+([A-Za-z_$][\w$]*))?\s*\([^)]*\)\s*\{/g,
      (match) => [match[1], [match[1], match[2]].filter(Boolean)]],
    [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
      (match) => [match[1], [match[1]]]],
  ];
  for (const [pattern, names] of blocks) {
    for (const match of source.matchAll(pattern)) {
      const openBrace = match.index + match[0].lastIndexOf("{");
      const [reportedName, recursiveNames] = names(match);
      inspect(reportedName, recursiveNames, functionBody(source, openBrace));
    }
  }
  const expressionArrows = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?!\{)([^;\n]+)/g;
  for (const match of source.matchAll(expressionArrows)) inspect(match[1], [match[1]], match[2]);
  return [...suspects];
}

describe("Codex Live Token Cost startup performance policy", () => {
  it("keeps the full startup below 60 KiB", async () => {
    const source = await readFile(SOURCE_URL);
    assert.ok(source.byteLength <= MAX_STARTUP_BYTES, `startup is ${source.byteLength} bytes; limit is ${MAX_STARTUP_BYTES}`);
  });

  it("rejects whitespace-obscured properties and recursive function expressions or arrows", () => {
    for (const fixture of [
      "node . getBoundingClientRect ( )",
      "Array . prototype . map",
      "window . fetch = replacement",
      "setInterval (work, 1000)",
      "new   Function ('return 1')",
    ]) {
      assert.ok(forbiddenMechanisms(fixture).length > 0, `missed forbidden fixture: ${fixture}`);
    }
    assert.deepEqual(recursiveArbitraryEnumerators(`
      const walk = (value) => { for (const key in value) walk(value[key]); };
      const visit = function (value) { Object . entries (value); visit(value); };
      const mapTree = value => Object . keys (value).map((key) => mapTree(value[key]));
    `).sort(), ["mapTree", "visit", "walk"]);
  });

  it("scans only the full startup and exactly one marked renderer block for forbidden mechanisms", async () => {
    const [startup, renderer] = await Promise.all([
      readFile(SOURCE_URL, "utf8"),
      readFile(RENDERER_SOURCE_URL, "utf8"),
    ]);
    const tokenCostBlock = extractTokenCostBlock(renderer);
    for (const [label, source] of [["startup", startup], ["renderer token-cost block", tokenCostBlock]]) {
      const found = forbiddenMechanisms(source);
      assert.deepEqual(found, [], `${label} contains forbidden APIs`);
      assert.deepEqual(recursiveArbitraryEnumerators(source), [], `${label} recursively enumerates arbitrary objects`);
    }
    assert.equal((tokenCostBlock.match(/\brequestAnimationFrame\s*\(/g) || []).length, 1);
  });
});

describe("DS style cost measurement runner arguments", () => {
  it("accepts the bounded Task 14 command contract", () => {
    assert.deepEqual(parseArgs([
      "--debug-port", "9339",
      "--duration-seconds", "1800",
      "--label", "enabled-soak",
      "--output", "target/enabled-soak.json",
      "--trace-output", "target/enabled-soak-trace.json",
    ]), {
      debugPort: 9339,
      durationSeconds: 1800,
      label: "enabled-soak",
      output: "target/enabled-soak.json",
      traceOutput: "target/enabled-soak-trace.json",
    });
  });

  it("rejects missing, malformed, duplicate, and conflicting arguments", () => {
    const valid = [
      "--debug-port", "9339",
      "--duration-seconds", "600",
      "--label", "enabled-idle",
      "--output", "target/enabled-idle.json",
    ];
    const invalid = [
      [],
      [...valid.slice(0, 1), "0", ...valid.slice(2)],
      [...valid.slice(0, 3), "1.5", ...valid.slice(4)],
      [...valid.slice(0, 3), "1801", ...valid.slice(4)],
      [...valid.slice(0, 5), "", ...valid.slice(6)],
      [...valid, "--debug-port", "9339"],
      [...valid, "--unknown", "value"],
      [...valid, "--trace-output", "target/enabled-idle.json"],
    ];
    for (const argv of invalid) assert.throws(() => parseArgs(argv));
  });
});

describe("DS style cost measurement runner process discovery", () => {
  const PROCESS_LIST = `
  101     1 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9339
  102   101 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=zygote
  103   102 /Applications/Codex.app/Contents/Frameworks/Codex Helper (Renderer).app/Contents/MacOS/Codex Helper (Renderer) --type=renderer
  104   101 /Applications/Codex.app/Contents/Frameworks/Codex Helper (Renderer).app/Contents/MacOS/Codex Helper (Renderer) --type=renderer
  105     1 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=93390
  `;

  it("recursively finds renderer descendants of the one exact-port Codex browser", () => {
    assert.equal(parseProcessList(PROCESS_LIST).length, 5);
    assert.deepEqual(discoverCodexProcesses(PROCESS_LIST, 9339), {
      browserPid: 101,
      rendererPids: [103, 104],
    });
  });

  it("rejects malformed process rows, ambiguous browsers, and missing renderers", () => {
    assert.throws(() => parseProcessList("not a ps row"), /invalid process row/);
    assert.throws(() => discoverCodexProcesses(`${PROCESS_LIST}\n  106 1 Codex --remote-debugging-port=9339`, 9339), /exactly one Codex browser/);
    assert.throws(() => discoverCodexProcesses("101 1 Codex --remote-debugging-port=9339", 9339), /at least one .*renderer/);
    assert.throws(() => discoverCodexProcesses(`
      101 103 Codex --remote-debugging-port=9339
      102 101 Codex Helper --type=zygote
      103 102 Codex Helper --type=renderer
    `, 9339), /cycle/);
  });

  it("rediscovers renderer additions and exits without sampling a reused PID", () => {
    assert.deepEqual(rediscoverRenderers(PROCESS_LIST, 9339, 101), [103, 104]);
    assert.deepEqual(rediscoverRenderers(`${PROCESS_LIST}
      106 102 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=renderer
    `, 9339, 101), [103, 104, 106]);
    assert.deepEqual(rediscoverRenderers(`
      101 1 Codex --remote-debugging-port=9339
      104 101 Codex Helper --type=renderer
    `, 9339, 101), [104]);
    assert.deepEqual(rediscoverRenderers(`
      101 1 Codex --remote-debugging-port=9339
      103 1 /usr/bin/reused-unrelated --type=worker
      104 101 Codex Helper --type=renderer
    `, 9339, 101), [104]);
    assert.throws(() => rediscoverRenderers(`
      201 1 Codex --remote-debugging-port=9339
      204 201 Codex Helper --type=renderer
    `, 9339, 101), /browser identity changed/);
  });
});

describe("DS style cost measurement runner sample parsing", () => {
  it("accepts complete numeric process and CDP samples", () => {
    assert.deepEqual(parseProcessStat(" 12.5 204800\n", 103), {
      pid: 103,
      cpuPercent: 12.5,
      rssKb: 204800,
    });
    assert.deepEqual(parseCdpSample(
      { metrics: [{ name: "TaskDuration", value: 1.25 }, { name: "JSHeapUsedSize", value: 1024 }] },
      { usedSize: 2048, totalSize: 4096, embedderHeapUsedSize: 512, backingStorageSize: 256 },
    ), {
      metrics: { TaskDuration: 1.25, JSHeapUsedSize: 1024 },
      heap: { usedSize: 2048, totalSize: 4096, embedderHeapUsedSize: 512, backingStorageSize: 256 },
    });
  });

  it("rejects missing, extra, non-numeric, negative, and inconsistent samples", () => {
    for (const sample of ["", "12.5", "12.5 2048 extra", "NaN 2048", "-1 2048", "1 -2"]) {
      assert.throws(() => parseProcessStat(sample, 103), /invalid process sample/);
    }
    const heap = { usedSize: 2048, totalSize: 4096, embedderHeapUsedSize: 512, backingStorageSize: 256 };
    assert.throws(() => parseCdpSample({ metrics: [] }, heap), /TaskDuration/);
    assert.throws(() => parseCdpSample({ metrics: [{ name: "TaskDuration", value: Number.NaN }] }, heap), /invalid CDP metric/);
    assert.throws(() => parseCdpSample(
      { metrics: [{ name: "TaskDuration", value: 1 }] },
      { ...heap, totalSize: 1024 },
    ), /invalid heap sample/);
  });

  it("keeps a malformed CDP payload fatal for every later sample command", async () => {
    class FakeSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: { data?: string }) => void>>();

      addEventListener(name: string, listener: (event: { data?: string }) => void) {
        const bucket = this.listeners.get(name) || new Set();
        bucket.add(listener);
        this.listeners.set(name, bucket);
      }

      emit(name: string, event: { data?: string }) {
        for (const listener of this.listeners.get(name) || []) listener(event);
      }

      send() {}

      close() {
        this.readyState = 3;
        this.emit("close", {});
      }
    }

    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    socket.emit("message", { data: "{" });
    await assert.rejects(client.send("Performance.getMetrics"), /invalid CDP JSON payload/);
    client.close();
  });

  it("stops reading the CDP target response at its fixed byte budget", async () => {
    assert.equal(await readBoundedResponseText(new Response("ok"), 2), "ok");
    await assert.rejects(
      readBoundedResponseText(new Response("x".repeat(257 * 1_024)), 256 * 1_024),
      /exceeds byte limit/,
    );
  });
});

describe("DS style cost measurement runner output aggregation", () => {
  it("rejects trace data loss and completes only after an ordered lossless event", async () => {
    assert.throws(() => validateTraceCompletion({ dataLossOccurred: true }), /data loss/);
    assert.throws(() => validateTraceCompletion({}), /dataLossOccurred/);
    assert.doesNotThrow(() => validateTraceCompletion({ dataLossOccurred: false }));

    class FakeTraceClient {
      listeners = new Map<string, Set<(params: any) => void>>();
      sent: string[] = [];

      on(method: string, listener: (params: any) => void) {
        const bucket = this.listeners.get(method) || new Set();
        bucket.add(listener);
        this.listeners.set(method, bucket);
        return () => bucket.delete(listener);
      }

      async send(method: string) {
        this.sent.push(method);
        return {};
      }

      emit(method: string, params: any) {
        for (const listener of this.listeners.get(method) || []) listener(params);
      }
    }

    const output = join(tmpdir(), `codex-ds-trace-${randomUUID()}.json`);
    const client = new FakeTraceClient();
    try {
      const trace = await startTrace(client, output);
      client.emit("Tracing.dataCollected", { value: [{ name: "first" }, { name: "second" }] });
      let stopped = false;
      const stopping = trace.stop().then(() => { stopped = true; });
      await Promise.resolve();
      assert.equal(stopped, false);
      assert.deepEqual(client.sent, ["Tracing.start", "Tracing.end"]);
      client.emit("Tracing.tracingComplete", { dataLossOccurred: false });
      await stopping;
      assert.deepEqual(JSON.parse(await readFile(output, "utf8")).traceEvents, [
        { name: "first" },
        { name: "second" },
      ]);
    } finally {
      await unlink(output).catch(() => {});
    }
  });

  it("publishes trace and metrics only after their temporary files finish successfully", async () => {
    const priorTrace = join(tmpdir(), `codex-ds-prior-trace-${randomUUID()}.json`);
    const newTrace = join(tmpdir(), `codex-ds-new-trace-${randomUUID()}.json`);
    const priorMetrics = join(tmpdir(), `codex-ds-prior-metrics-${randomUUID()}.json`);
    const newMetrics = join(tmpdir(), `codex-ds-new-metrics-${randomUUID()}.json`);
    const failingClient = {
      on() { return () => {}; },
      async send(method: string) {
        if (method === "Tracing.start") throw new Error("injected CDP failure");
      },
    };
    const assertMissing = async (path: string) => {
      await assert.rejects(readFile(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    };
    await writeFile(priorTrace, "prior trace", "utf8");
    await writeFile(priorMetrics, "prior metrics", "utf8");
    try {
      await assert.rejects(startTrace(failingClient, priorTrace), /injected CDP failure/);
      await assert.rejects(startTrace(failingClient, newTrace), /injected CDP failure/);
      assert.equal(await readFile(priorTrace, "utf8"), "prior trace");
      await assertMissing(newTrace);

      await assert.rejects(startTrace({
        on() { return () => {}; },
        async send() {},
      }, newTrace, {
        createStream() { throw new Error("injected stream failure"); },
      }), /injected stream failure/);
      await assertMissing(newTrace);

      for (const path of [priorTrace, newTrace]) {
        const aborting = await startTrace({
          on() { return () => {}; },
          async send() {},
        }, path);
        await aborting.abort();
      }
      assert.equal(await readFile(priorTrace, "utf8"), "prior trace");
      await assertMissing(newTrace);

      const failingWrite = { async writeFile() { throw new Error("injected write failure"); } };
      await assert.rejects(writeJsonAtomically(priorMetrics, { valid: true }, failingWrite), /injected write failure/);
      await assert.rejects(writeJsonAtomically(newMetrics, { valid: true }, failingWrite), /injected write failure/);
      assert.equal(await readFile(priorMetrics, "utf8"), "prior metrics");
      await assertMissing(newMetrics);
    } finally {
      for (const path of [priorTrace, newTrace, priorMetrics, newMetrics]) await unlink(path).catch(() => {});
    }
  });

  it("keeps before and after diagnostics outside the observer and trace window", async () => {
    const source = await readFile(runnerUrl, "utf8");
    const before = source.indexOf("const diagnosticsBefore = await pageDiagnostics(client)");
    const observerStart = source.indexOf("await installLongTaskObserver(client)");
    const traceStart = source.indexOf("trace = await startTrace(client, options.traceOutput)");
    const samples = source.indexOf("const samples = []");
    const observerStop = source.indexOf("const longTasks = await removeLongTaskObserver(client)");
    const traceStop = source.indexOf("await trace.stop()", observerStop);
    const after = source.indexOf("const diagnosticsAfter = await pageDiagnostics(client)");
    assert.ok(before >= 0 && before < observerStart);
    assert.ok(observerStart < traceStart && traceStart < samples);
    assert.ok(samples < observerStop && observerStop < traceStop && traceStop < after);
  });

  it("selects one primary Codex page and summarizes every retained sample", () => {
    assert.deepEqual(selectPrimaryPage([
      { id: "worker", type: "worker", url: "app://-/worker.js", webSocketDebuggerUrl: "ws://worker" },
      { id: "page", type: "page", title: "Codex", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/page" },
    ], 9339), { id: "page", type: "page", title: "Codex", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/page" });
    assert.deepEqual(parseBrowserVersion({
      protocolVersion: "1.3",
      product: "Chrome/140.0.0.0",
      revision: "@abc123",
      userAgent: "Codex Test",
      jsVersion: "14.0.0",
    }), {
      protocolVersion: "1.3",
      product: "Chrome/140.0.0.0",
      revision: "@abc123",
      userAgent: "Codex Test",
      jsVersion: "14.0.0",
    });
    assert.deepEqual(summarizeSamples([
      { aggregate: { cpuPercent: 3, rssKb: 100 }, cdp: { heap: { usedSize: 20 } } },
      { aggregate: { cpuPercent: 1, rssKb: 150 }, cdp: { heap: { usedSize: 40 } } },
      { aggregate: { cpuPercent: 2, rssKb: 125 }, cdp: { heap: { usedSize: 30 } } },
    ]), {
      cpuPercent: { median: 2, average: 2, max: 3 },
      rssKb: { start: 100, end: 125, max: 150 },
      heapUsedBytes: { start: 20, end: 30, max: 40 },
    });
  });

  it("rejects ambiguous pages and produces explicit bounded diagnostic deltas", () => {
    assert.throws(() => selectPrimaryPage([], 9339), /exactly one primary page/);
    assert.throws(() => selectPrimaryPage([
      { id: "one", type: "page", title: "One", url: "app://-/one", webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/one" },
      { id: "two", type: "page", title: "Two", url: "app://-/two", webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/two" },
    ], 9339), /exactly one primary page/);
    for (const target of [
      { id: "page", type: "page", title: "Codex", url: "https://example.com", webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/page" },
      { id: "page", type: "page", title: "Codex", url: "app://-/index.html", webSocketDebuggerUrl: "ws://localhost:9339/devtools/page/page" },
      { id: "page", type: "page", title: "Codex", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9340/devtools/page/page" },
      { id: "page", type: "page", title: "Codex", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/other" },
    ]) {
      assert.throws(() => selectPrimaryPage([target], 9339), /exactly one primary page/);
    }
    const validVersion = {
      protocolVersion: "1.3", product: "Chrome/140", revision: "@abc", userAgent: "Codex", jsVersion: "14",
    };
    assert.throws(() => parseBrowserVersion({ ...validVersion, revision: undefined }), /Browser.getVersion/);
    assert.throws(() => parseBrowserVersion({ ...validVersion, product: "x".repeat(257) }), /Browser.getVersion/);
    const before = {
      instanceId: "cost-instance-1",
      domWrites: 10,
      listenerCount: 3,
      outstandingTimers: 0,
      observerCount: 0,
      bridgeCalls: 2,
      snapshotCount: 1,
      ownedNodeCount: 8,
      updateDurationsMs: [1, 2],
      mountedModules: ["settings"],
      native: {
        events_ingested: 100,
        events_coalesced: 2,
        events_rejected: 0,
        queue_depth: 0,
        queue_high_water: 1,
        recent_turns: 4,
        dedupe_fingerprints: 6,
        snapshots_published: 20,
        snapshots_sent: 3,
        lazy_commands_sent: 1,
      },
    };
    const after = {
      instanceId: "cost-instance-1",
      domWrites: 14,
      listenerCount: 3,
      outstandingTimers: 0,
      observerCount: 0,
      bridgeCalls: 3,
      snapshotCount: 3,
      ownedNodeCount: 8,
      updateDurationsMs: [1, 2, 3],
      mountedModules: ["settings"],
      native: {
        events_ingested: 125,
        events_coalesced: 4,
        events_rejected: 0,
        queue_depth: 0,
        queue_high_water: 1,
        recent_turns: 5,
        dedupe_fingerprints: 8,
        snapshots_published: 25,
        snapshots_sent: 5,
        lazy_commands_sent: 1,
      },
    };
    assert.deepEqual(buildCostDiagnostics(before, after), {
      before,
      after,
      pageDelta: {
        domWrites: 4,
        listenerCount: 0,
        outstandingTimers: 0,
        observerCount: 0,
        bridgeCalls: 1,
        snapshotCount: 2,
        ownedNodeCount: 0,
      },
      nativeDelta: {
        events_ingested: 25,
        events_coalesced: 2,
        events_rejected: 0,
        queue_depth: 0,
        queue_high_water: 0,
        recent_turns: 1,
        dedupe_fingerprints: 2,
        snapshots_published: 5,
        snapshots_sent: 2,
        lazy_commands_sent: 0,
      },
    });
    assert.equal(buildCostDiagnostics(null, null), null);
    assert.throws(() => buildCostDiagnostics(null, after), /availability changed/);
    assert.throws(() => buildCostDiagnostics(before, { ...after, instanceId: "cost-instance-2" }), /instance changed/);
    assert.throws(() => buildCostDiagnostics(before, {
      ...after,
      native: { ...after.native, events_ingested: undefined },
    }), /invalid cost diagnostics/);
  });
});
