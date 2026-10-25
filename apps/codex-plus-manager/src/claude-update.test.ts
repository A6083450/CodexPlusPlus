import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const { selectRelease, download, installUpdater } = require("../../../assets/claude-localization/managed-update.cjs");
const payload = {
  name: "Claude 2.42304.2", version: "2.42304.2", notes: "Release",
  pub_date: "2026-10-19T01:33:55", size: 3,
  url: "https://downloads.claude.ai/releases/darwin/arm64/2.42304.2/Claude.zip",
  sha256: "a".repeat(64),
};
const feed = { currentRelease: "2.42304.2", releases: [{ version: "2.42304.2", updateTo: payload }] };

test("selects the current full release, never a delta or unrelated version", () => {
  assert.deepEqual(selectRelease(feed, "2.42304.0"), payload);
  assert.equal(selectRelease(feed, "2.42304.2"), null);
  assert.equal(selectRelease(feed, "2.50000.0"), null);
  assert.throws(() => selectRelease({ ...feed, releases: [] }, "2.42304.0"));
  for (const change of [
    { url: "http://downloads.claude.ai/Claude.zip" },
    { url: "https://downloads.claude.ai.attacker.test/Claude.zip" },
    { sha256: "" }, { size: -1 }, { version: "2.42304.3" },
  ]) {
    assert.throws(() => selectRelease({ ...feed, releases: [{ version: payload.version, updateTo: { ...payload, ...change } }] }, "2.42304.0"));
  }
});

test("failed feed returns an updater error and permits retry instead of staying downloading", async () => {
  const updater = new EventEmitter() as any;
  updater.getFeedURL = () => "https://api.anthropic.com/api/desktop/darwin/arm64/squirrel/update";
  let calls = 0;
  const electron = {
    app: { getVersion: () => "2.42304.0" }, autoUpdater: updater,
    net: { fetch: async () => { calls++; throw new Error("offline"); } },
  };
  const events: string[] = [];
  updater.on("checking-for-update", () => events.push("checking"));
  updater.on("error", (error: Error) => events.push(error.message));
  updater.on("update-downloaded", () => assert.fail("failed checks must never be ready"));
  installUpdater(electron, {}, () => {});
  await updater.checkForUpdates();
  await updater.checkForUpdates();
  assert.equal(calls, 2);
  assert.deepEqual(events, ["checking", "offline", "checking", "offline"]);
});

test("unknown feed origins are rejected without any network request", async () => {
  const updater = new EventEmitter() as any;
  updater.getFeedURL = () => "https://attacker.test/update";
  const errors: Error[] = [];
  updater.on("error", (error: Error) => errors.push(error));
  installUpdater({ app: { getVersion: () => "2.42304.0" }, autoUpdater: updater,
    net: { fetch: () => assert.fail("untrusted feed must not be fetched") } }, {}, () => {});
  await updater.checkForUpdates();
  assert.equal(errors.length, 1);
});

test("download verifies actual bytes, length and SHA-256 before accepting a release", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "claude-update-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = { ...payload, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
  const fetch = async () => new Response("abc");
  await download(fetch, release, path.join(root, "valid.zip"));
  assert.equal(readFileSync(path.join(root, "valid.zip"), "utf8"), "abc");
  await assert.rejects(download(fetch, { ...release, sha256: "b".repeat(64) }, path.join(root, "corrupt.zip")), /SHA-256/);
  await assert.rejects(download(fetch, { ...release, size: 2 }, path.join(root, "large.zip")), /大小/);
  await assert.rejects(download(fetch, { ...release, size: 4 }, path.join(root, "short.zip")), /大小/);
});

test("checking an already prepared release completes the native manual-check event sequence", { skip: process.platform === "win32" }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "claude-ready-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const module = { exports: {} as any };
  // 只替换昂贵的签名/副本构建进程；下载、校验、暂存和 updater 状态运行真实实现。
  new Function("require", "module", "__dirname", readFileSync(require.resolve("../../../assets/claude-localization/managed-update.cjs"), "utf8"))(require, module, root);
  const updater = new EventEmitter() as any;
  updater.getFeedURL = () => "https://api.anthropic.com/api/desktop/darwin/arm64/squirrel/update";
  const release = { ...payload, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
  const events: string[] = [];
  for (const name of ["checking-for-update", "update-available", "update-downloaded"])
    updater.on(name, () => events.push(name));
  updater.on("error", (error: Error) => { throw error; });
  module.exports.installUpdater({ app: { getVersion: () => "2.42304.0" }, autoUpdater: updater,
    net: { fetch: async (url: string) => url === release.url ? new Response("abc") : Response.json({
      currentRelease: release.version, releases: [{ version: release.version, updateTo: release }],
    }) } }, { python: "/usr/bin/true" }, () => {});
  await updater.checkForUpdates();
  await updater.checkForUpdates();
  assert.deepEqual(events, ["checking-for-update", "update-available", "update-downloaded",
    "checking-for-update", "update-available", "update-downloaded"]);
});

test("injector carries boolean Computer Use into the managed update plan", { skip: process.platform === "win32" }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "claude-cu-plan-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const injector = require.resolve("../../../assets/claude-localization/inject-cn.js");
  for (const [name, envValue, patched, expected] of [
    ["enabled", "1", false, true], ["disabled", "0", true, false], ["existing", undefined, true, true],
  ] as const) {
    await t.test(name, { timeout: 2000 }, async (t) => {
      const timers = new Set<ReturnType<typeof setTimeout>>();
      let stopped = false;
      let socket: InspectorSocket | undefined;
      const schedule = (callback: () => void, delay: number) => {
        if (stopped) return;
        const timer = setTimeout(() => { timers.delete(timer); callback(); }, Math.min(delay, 10));
        timers.add(timer);
        return timer;
      };
      const cancel = (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); };
      t.after(() => {
        stopped = true;
        socket?.close();
        for (const timer of timers) clearTimeout(timer);
      });
      const runtime = path.join(root, name);
      const copy = path.join(runtime, "Claude Enhanced.app");
      const executable = path.join(copy, "Contents/MacOS/Claude");
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(executable, "");
      if (patched) {
        mkdirSync(path.join(copy, "Contents/Resources"), { recursive: true });
        writeFileSync(path.join(copy, "Contents/Resources/.cu-patched"), "{}");
      }
      const inspected: any = {
        process: { execPath: executable, pid: 1234 }, setImmediate,
        require: (id: string) => {
          if (id === "electron") return { app: { getVersion: () => "2.42304.0", whenReady: async () => {} } };
          if (id === "node:inspector") return { close() {} };
          assert.equal(id, path.join(path.dirname(injector), "hook.js"));
          inspected.__claudeCnHookInstalled = true;
        },
      };
      // 只替换 inspector 传输；运行完整注入脚本，执行它实际发出的表达式。
      class InspectorSocket extends EventTarget {
        closed = false;
        constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
        send(message: string) {
          const { id, params } = JSON.parse(message);
          void Promise.resolve(runInNewContext(params.expression, inspected)).then((value) => {
            if (!this.closed) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { result: { value } } }) }));
          }, (error: Error) => {
            if (!this.closed) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, error: { message: error.message } }) }));
          });
        }
        close() { this.closed = true; }
      }
      let requests = 0;
      await runInNewContext(readFileSync(injector, "utf8"), {
        require, __dirname: path.dirname(injector), setTimeout: schedule, clearTimeout: cancel, AbortSignal,
        process: {
          platform: "darwin", execPath: process.execPath,
          argv: [process.execPath, injector, "--no-launch", "--port", "9411"],
          env: { CODEX_PLUS_CLAUDE_SOURCE: "/Applications/Claude.app", CODEX_PLUS_CLAUDE_COPY: copy,
            CODEX_PLUS_CLAUDE_PYTHON: "/usr/bin/true", CODEX_PLUS_CLAUDE_COMPUTER_USE: envValue },
          exit: (code: number) => { throw new Error(`injector exited: ${code}`); },
        },
        console: { log() {}, error(message: string) { throw new Error(message); } },
        WebSocket: InspectorSocket,
        fetch: async () => {
          if (requests++) throw new Error("inspector closed");
          return { json: async () => [{ type: "node", webSocketDebuggerUrl: "ws://fixture" }] };
        },
      });
      const options = JSON.parse(JSON.stringify(inspected.__claudeCnManagedUpdate));
      assert.equal(options.computerUse, expected);
      const module = { exports: {} as any };
      new Function("require", "module", "__dirname", readFileSync(require.resolve("../../../assets/claude-localization/managed-update.cjs"), "utf8"))(require, module, runtime);
      const updater = new EventEmitter() as any;
      updater.getFeedURL = () => "https://api.anthropic.com/api/desktop/darwin/arm64/squirrel/update";
      updater.on("error", (error: Error) => { throw error; });
      const release = { ...payload, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
      module.exports.installUpdater({ app: { getVersion: () => "2.42304.0" }, autoUpdater: updater,
        net: { fetch: async (url: string) => url === release.url ? new Response("abc") : Response.json({
          currentRelease: release.version, releases: [{ version: release.version, updateTo: release }],
        }) } }, options, () => {});
      await updater.checkForUpdates();
      const plan = path.join(runtime, "updates", readdirSync(path.join(runtime, "updates"))[0], "plan.json");
      assert.equal(JSON.parse(readFileSync(plan, "utf8")).computerUse, expected);
    });
  }
});
