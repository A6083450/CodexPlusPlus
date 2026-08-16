import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
const runnerUrl = new URL("../../../scripts/measure-ds-style-cost-performance.mjs", import.meta.url);
const {
  CdpClient,
  buildCostDiagnostics,
  collectRendererProcessSample,
  discoverCodexProcesses,
  parseArgs,
  parseBrowserVersion,
  parseCdpSample,
  parseProcessList,
  parseProcessStat,
  readBoundedResponseText,
  rediscoverRenderers,
  runMeasurement,
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
  ["electronBridge replacement", /\b(?:(?:window|globalThis)\s*(?:\.\s*electronBridge|\[\s*["']electronBridge["']\s*\])|electronBridge)\s*=/],
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
  const enumerates = (body: string) => /\bObject\s*(?:\.\s*(?:keys|values|entries)|\[\s*["'](?:keys|values|entries)["']\s*\])\s*\(/.test(body)
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
      "window['electronBridge'] = replacement",
      "window [ \"electronBridge\" ] = replacement",
      "setInterval (work, 1000)",
      "new   Function ('return 1')",
    ]) {
      assert.ok(forbiddenMechanisms(fixture).length > 0, `missed forbidden fixture: ${fixture}`);
    }
    assert.deepEqual(recursiveArbitraryEnumerators(`
      const walk = (value) => { for (const key in value) walk(value[key]); };
      const visit = function (value) { Object . entries (value); visit(value); };
      const mapTree = value => Object . keys (value).map((key) => mapTree(value[key]));
      const bracketTree = value => Object['keys'](value).map((key) => bracketTree(value[key]));
      const spacedBracketTree = value => Object [ "entries" ] (value).map((entry) => spacedBracketTree(entry));
    `).sort(), ["bracketTree", "mapTree", "spacedBracketTree", "visit", "walk"]);
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

  it("accepts only the exact installed ChatGPT browser identities used by Task 14", () => {
    const renderer = "ChatGPT Helper (Renderer) --type=renderer";
    assert.deepEqual(discoverCodexProcesses(`
      201 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9339
      204 201 ${renderer}
    `, 9339), { browserPid: 201, rendererPids: [204] });
    assert.deepEqual(discoverCodexProcesses(`
      201 1 ChatGPT --remote-debugging-port=9339
      204 201 ${renderer}
    `, 9339), { browserPid: 201, rendererPids: [204] });

    for (const executable of [
      "FooChatGPT",
      "/Applications/FooChatGPT.app/Contents/MacOS/ChatGPT",
      "/tmp/ChatGPT.app/Contents/MacOS/ChatGPT",
    ]) {
      assert.throws(() => discoverCodexProcesses(`
        201 1 ${executable} --remote-debugging-port=9339
        204 201 ${renderer}
      `, 9339), /exactly one Codex browser/);
    }
    assert.throws(() => discoverCodexProcesses(`
      201 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=93390
      204 201 ${renderer}
    `, 9339), /exactly one Codex browser/);
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

  it("truncates unrelated over-long process commands instead of aborting", () => {
    const overLong = "x".repeat(5_000);
    const rows = parseProcessList(`106 1 ${overLong}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pid, 106);
    assert.equal(rows[0].command.length, 4_096);
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

  it("does not sample a renderer PID reused between discovery and the resource sample", () => {
    const discovered = rediscoverRenderers(PROCESS_LIST, 9339, 101);
    assert.deepEqual(discovered, [103, 104]);
    assert.deepEqual(collectRendererProcessSample(`
      101 1 0.2 1024 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9339
      103 1 99.9 4096 /usr/bin/reused-unrelated --type=worker
      104 101 12.5 204800 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=renderer
    `, 9339, 101), {
      rendererPids: [104],
      processes: [{ pid: 104, cpuPercent: 12.5, rssKb: 204800 }],
    });
    assert.deepEqual(collectRendererProcessSample(`
      101 1 0.2 1024 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9339
      103 101 6.25 102400 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=renderer
      104 101 12.5 204800 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=renderer
    `, 9339, 101, discovered), {
      rendererPids: [103, 104],
      processes: [
        { pid: 103, cpuPercent: 6.25, rssKb: 102400 },
        { pid: 104, cpuPercent: 12.5, rssKb: 204800 },
      ],
    });
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
  class FakeTraceClient {
    listeners = new Map<string, Set<(params: any) => void>>();
    sent: string[] = [];
    sendEnd: () => Promise<any> = async () => ({});

    on(method: string, listener: (params: any) => void) {
      const bucket = this.listeners.get(method) || new Set();
      bucket.add(listener);
      this.listeners.set(method, bucket);
      return () => bucket.delete(listener);
    }

    async send(method: string) {
      this.sent.push(method);
      return method === "Tracing.end" ? this.sendEnd() : {};
    }

    emit(method: string, params: any) {
      for (const listener of this.listeners.get(method) || []) listener(params);
    }
  }

  const fullRunDependencies = (outputOperations: Record<string, any> = {}) => {
    const client = new FakeTraceClient() as FakeTraceClient & { close: () => void };
    client.close = () => {};
    client.sendEnd = async () => {
      client.emit("Tracing.tracingComplete", { dataLossOccurred: false });
      return {};
    };
    const originalSend = client.send.bind(client);
    client.send = async (method: string) => {
      if (method === "Browser.getVersion") {
        return {
          protocolVersion: "1.3",
          product: "Chrome/140.0.0.0",
          revision: "@abc123",
          userAgent: "Codex Test",
          jsVersion: "14.0",
        };
      }
      return originalSend(method);
    };
    return {
      fetchJson: async () => [{
        id: "page",
        type: "page",
        title: "Codex",
        url: "app://-/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/page",
      }],
      processList: async () => `
        101 1 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9339
        103 101 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=renderer
      `,
      connectCdp: async () => client,
      pageDiagnostics: async () => null,
      installLongTaskObserver: async () => {},
      removeLongTaskObserver: async () => ({ count: 0, totalDurationMs: 0, maxDurationMs: 0 }),
      delay: async () => {},
      performanceNow: () => 0,
      sampleOnce: async () => ({
        timestamp: "2026-08-16T00:00:01.000Z",
        rendererPids: [103],
        processes: [{ pid: 103, cpuPercent: 1, rssKb: 2048 }],
        aggregate: { cpuPercent: 1, rssKb: 2048 },
        cdp: {
          metrics: { TaskDuration: 0.25 },
          heap: { usedSize: 1024, totalSize: 2048, embedderHeapUsedSize: 128, backingStorageSize: 64 },
        },
      }),
      outputOperations,
    };
  };

  const runFullMeasurement = (output: string, traceOutput: string, outputOperations: Record<string, any> = {}) => runMeasurement({
    debugPort: 9339,
    durationSeconds: 1,
    label: "round-three-publication",
    output,
    traceOutput,
  }, fullRunDependencies(outputOperations));

  it("latches every tracingComplete received before Tracing.end as fatal", async () => {
    for (const params of [{ dataLossOccurred: false }, { dataLossOccurred: true }, {}]) {
      const output = join(tmpdir(), `codex-ds-early-trace-${randomUUID()}.json`);
      const client = new FakeTraceClient();
      try {
        const trace = await startTrace(client, output);
        client.emit("Tracing.tracingComplete", params);
        assert.throws(() => trace.assertHealthy(), /before Tracing\.end/);
        await assert.rejects(trace.stop(), /before Tracing\.end/);
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        await unlink(output).catch(() => {});
      }
    }
  });

  it("accepts lossless completion before or after the Tracing.end response", async () => {
    assert.throws(() => validateTraceCompletion({ dataLossOccurred: true }), /data loss/);
    assert.throws(() => validateTraceCompletion({}), /dataLossOccurred/);
    assert.doesNotThrow(() => validateTraceCompletion({ dataLossOccurred: false }));

    for (const completionBeforeResponse of [true, false]) {
      const output = join(tmpdir(), `codex-ds-trace-${randomUUID()}.json`);
      const client = new FakeTraceClient();
      let resolveEnd!: () => void;
      client.sendEnd = () => new Promise((resolve) => { resolveEnd = () => resolve({}); });
      try {
        const trace = await startTrace(client, output);
        client.emit("Tracing.dataCollected", { value: [{ name: "first" }, { name: "second" }] });
        let stopped = false;
        const stopping = trace.stop().then(() => { stopped = true; });
        await Promise.resolve();
        assert.equal(stopped, false);
        assert.deepEqual(client.sent, ["Tracing.start", "Tracing.end"]);
        if (completionBeforeResponse) client.emit("Tracing.tracingComplete", { dataLossOccurred: false });
        resolveEnd();
        await Promise.resolve();
        if (!completionBeforeResponse) client.emit("Tracing.tracingComplete", { dataLossOccurred: false });
        await stopping;
        assert.deepEqual(JSON.parse(await readFile(output, "utf8")).traceEvents, [
          { name: "first" },
          { name: "second" },
        ]);
      } finally {
        await unlink(output).catch(() => {});
      }
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

  it("keeps the prior trace and metrics pair through every post-trace full-run failure", async () => {
    const browserVersion = {
      protocolVersion: "1.3",
      product: "Chrome/140.0.0.0",
      revision: "@abc123",
      userAgent: "Codex Test",
      jsVersion: "14.0",
    };
    const target = {
      id: "page",
      type: "page",
      title: "Codex",
      url: "app://-/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/page",
    };
    const processSource = `
      101 1 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9339
      103 101 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=renderer
    `;
    const sample = {
      timestamp: "2026-08-16T00:00:01.000Z",
      rendererPids: [103],
      processes: [{ pid: 103, cpuPercent: 1, rssKb: 2048 }],
      aggregate: { cpuPercent: 1, rssKb: 2048 },
      cdp: {
        metrics: { TaskDuration: 0.25 },
        heap: { usedSize: 1024, totalSize: 2048, embedderHeapUsedSize: 128, backingStorageSize: 64 },
      },
    };

    for (const failure of [
      "diagnostics",
      "summary",
      "metrics-write",
      "backup-trace-rename",
      "backup-metrics-rename",
      "publish-trace-rename",
      "publish-metrics-rename",
    ] as const) {
      for (const hasPriorPair of [true, false]) {
        const output = join(tmpdir(), `codex-ds-pair-metrics-${randomUUID()}.json`);
        const traceOutput = join(tmpdir(), `codex-ds-pair-trace-${randomUUID()}.json`);
        if (hasPriorPair) {
          await writeFile(output, "prior metrics", "utf8");
          await writeFile(traceOutput, "prior trace", "utf8");
        }
        const client = new FakeTraceClient() as FakeTraceClient & { close: () => void };
        client.close = () => {};
        client.sendEnd = async () => {
          client.emit("Tracing.tracingComplete", { dataLossOccurred: false });
          return {};
        };
        const originalSend = client.send.bind(client);
        client.send = async (method: string) => {
          if (method === "Browser.getVersion") return browserVersion;
          return originalSend(method);
        };
        let diagnosticsCalls = 0;
        let renameFailed = false;
        try {
          await assert.rejects(runMeasurement({
            debugPort: 9339,
            durationSeconds: 1,
            label: "pair-failure",
            output,
            traceOutput,
          }, {
            fetchJson: async () => [target],
            processList: async () => processSource,
            connectCdp: async () => client,
            pageDiagnostics: async () => {
              diagnosticsCalls += 1;
              if (failure === "diagnostics" && diagnosticsCalls === 2) throw new Error("injected diagnostics failure");
              return null;
            },
            installLongTaskObserver: async () => {},
            removeLongTaskObserver: async () => ({ count: 0, totalDurationMs: 0, maxDurationMs: 0 }),
            delay: async () => {},
            performanceNow: () => 0,
            sampleOnce: async () => sample,
            summarizeSamples: failure === "summary"
              ? () => { throw new Error("injected summary failure"); }
              : summarizeSamples,
            outputOperations: {
              writeFile: async (path: string, value: string, encoding: BufferEncoding) => {
                if (failure === "metrics-write") throw new Error("injected metrics write failure");
                await writeFile(path, value, encoding);
              },
              rename: async (from: string, to: string) => {
                const injected = (failure === "backup-trace-rename" && from === traceOutput && to.includes(".backup-"))
                  || (failure === "backup-metrics-rename" && from === output && to.includes(".backup-"))
                  || (failure === "publish-trace-rename" && to === traceOutput && from.includes(".tmp-"))
                  || (failure === "publish-metrics-rename" && to === output && from.includes(".tmp-"));
                if (injected && !renameFailed) {
                  renameFailed = true;
                  throw new Error("injected pair publish rename failure");
                }
                await rename(from, to);
              },
            },
          }), /injected/);

          if (hasPriorPair) {
            assert.equal(await readFile(traceOutput, "utf8"), "prior trace", `${failure} changed the prior trace`);
            assert.equal(await readFile(output, "utf8"), "prior metrics", `${failure} changed the prior metrics`);
          } else {
            await assert.rejects(readFile(traceOutput), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
            await assert.rejects(readFile(output), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
          }
        } finally {
          await unlink(traceOutput).catch(() => {});
          await unlink(output).catch(() => {});
        }
      }
    }
  });

  it("rejects every non-regular final before changing either full-run output", async () => {
    for (const unsafeKind of ["directory", "symlink"] as const) {
      const output = join(tmpdir(), `codex-ds-unsafe-metrics-${randomUUID()}.json`);
      const traceOutput = join(tmpdir(), `codex-ds-unsafe-trace-${randomUUID()}.json`);
      const symlinkTarget = join(tmpdir(), `codex-ds-symlink-target-${randomUUID()}.json`);
      const backupPaths: string[] = [];
      if (unsafeKind === "directory") {
        await mkdir(traceOutput);
        await writeFile(output, "prior metrics", "utf8");
      } else {
        await writeFile(symlinkTarget, "symlink target", "utf8");
        await symlink(symlinkTarget, traceOutput);
      }
      try {
        await assert.rejects(runFullMeasurement(output, traceOutput, {
          rename: async (from: string, to: string) => {
            if (to.includes(".backup-")) backupPaths.push(to);
            await rename(from, to);
          },
        }), /regular file/);
        const traceStat = await lstat(traceOutput);
        assert.equal(unsafeKind === "directory" ? traceStat.isDirectory() : traceStat.isSymbolicLink(), true);
        if (unsafeKind === "directory") assert.equal(await readFile(output, "utf8"), "prior metrics");
        else await assert.rejects(readFile(output), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
        assert.deepEqual(backupPaths, [], "preflight rejection must happen before the first rename");
      } finally {
        for (const path of backupPaths) {
          const stat = await lstat(path).catch(() => null);
          if (stat?.isDirectory()) await rmdir(path);
          else await unlink(path).catch(() => {});
        }
        const traceStat = await lstat(traceOutput).catch(() => null);
        if (traceStat?.isDirectory()) await rmdir(traceOutput);
        else await unlink(traceOutput).catch(() => {});
        await unlink(output).catch(() => {});
        await unlink(symlinkTarget).catch(() => {});
      }
    }
  });

  it("keeps the committed new pair authoritative when backup garbage collection fails", async () => {
    const output = join(tmpdir(), `codex-ds-committed-metrics-${randomUUID()}.json`);
    const traceOutput = join(tmpdir(), `codex-ds-committed-trace-${randomUUID()}.json`);
    const retainedBackups: string[] = [];
    const warnings: string[] = [];
    await writeFile(output, "prior metrics", "utf8");
    await writeFile(traceOutput, "prior trace", "utf8");
    try {
      const result = await runFullMeasurement(output, traceOutput, {
        unlink: async (path: string) => {
          if (path.startsWith(`${traceOutput}.backup-`)) {
            retainedBackups.push(path);
            throw new Error("injected backup cleanup failure");
          }
          await unlink(path);
        },
        warn: (message: string) => warnings.push(message),
      });
      assert.equal(result.label, "round-three-publication");
      assert.equal(JSON.parse(await readFile(output, "utf8")).label, "round-three-publication");
      assert.deepEqual(JSON.parse(await readFile(traceOutput, "utf8")).traceEvents, []);
      assert.equal(retainedBackups.length, 1);
      assert.equal(await readFile(retainedBackups[0], "utf8"), "prior trace");
      assert.equal(warnings.length, 1);
      assert.ok(Buffer.byteLength(warnings[0]) <= 128, "post-commit warning must remain bounded");
    } finally {
      for (const path of retainedBackups) await unlink(path).catch(() => {});
      await unlink(traceOutput).catch(() => {});
      await unlink(output).catch(() => {});
    }
  });

  it("keeps before and after diagnostics outside the observer and trace window", async () => {
    const source = await readFile(runnerUrl, "utf8");
    const before = source.indexOf("const diagnosticsBefore = await readDiagnostics(client)");
    const observerStart = source.indexOf("await startObserver(client)");
    const traceStart = source.indexOf("trace = await startTraceCapture(client, options.traceOutput)");
    const samples = source.indexOf("const samples = []");
    const observerStop = source.indexOf("const longTasks = await stopObserver(client)");
    const traceStop = source.indexOf("await trace.prepare()", observerStop);
    const after = source.indexOf("const diagnosticsAfter = await readDiagnostics(client)");
    assert.ok(before >= 0 && before < observerStart);
    assert.ok(observerStart < traceStart && traceStart < samples);
    assert.ok(samples < observerStop && observerStop < traceStop && traceStop < after);
  });

  it("selects one primary Codex page and summarizes every retained sample", () => {
    assert.deepEqual(selectPrimaryPage([
      { id: "worker", type: "worker", url: "app://-/worker.js", webSocketDebuggerUrl: "ws://worker" },
      { id: "avatar", type: "page", title: "Codex", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9339/devtools/page/avatar" },
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
