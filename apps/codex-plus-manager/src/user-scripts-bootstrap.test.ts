import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const bootstrap = await readFile(new URL("../../../assets/inject/user-scripts-bootstrap.js", import.meta.url), "utf8");
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function page(readyState = "complete") {
  const window = Object.assign(new EventTarget(), {
    electronBridge: {}, location: { href: "app://-/index.html" },
  }) as EventTarget & Record<string, any>;
  window.top = window.self = window;
  const document = Object.assign(new EventTarget(), { readyState });
  const warnings: unknown[][] = [];
  const context = vm.createContext({ window, document, Event, console: { warn: (...args: unknown[]) => warnings.push(args) } });
  return { window, document, warnings, run: () => vm.runInContext(bootstrap, context) };
}

it("waits for a late bridge without throwing or loading twice", async () => {
  const p = page();
  let calls = 0;
  let loaded = 0;
  p.window.addEventListener("codex-plus-user-scripts-loaded", () => loaded++);
  assert.doesNotThrow(p.run);
  p.run();
  p.window.__codexSessionDeleteBridge = async (path: string) => {
    assert.equal(path, "/user-scripts/load");
    calls++;
    return { scripts: [] };
  };
  p.window.dispatchEvent(new Event("codex-plus-bridge-ready"));
  p.window.dispatchEvent(new Event("codex-plus-bridge-ready"));
  await settle();
  p.window.dispatchEvent(new Event("codex-plus-bridge-ready"));
  assert.equal(calls, 1);
  assert.equal(loaded, 1);
  assert.equal(p.warnings.length, 0);
});

it("waits for DOM readiness even when the bridge is ready first", async () => {
  const p = page("loading");
  let calls = 0;
  p.window.__codexSessionDeleteBridge = async () => { calls++; return {}; };
  p.run();
  p.window.dispatchEvent(new Event("codex-plus-bridge-ready"));
  await settle();
  assert.equal(calls, 0);
  p.document.readyState = "complete";
  p.document.dispatchEvent(new Event("DOMContentLoaded"));
  await settle();
  assert.equal(calls, 1);
});

for (const failure of ["throw", "reject", "response"] as const) {
  it(`retries after bridge reconnect following a ${failure} failure`, async () => {
    const p = page();
    let calls = 0;
    p.window.__codexSessionDeleteBridge = () => {
      calls++;
      if (calls > 1) return Promise.resolve({ scripts: [] });
      if (failure === "throw") throw new Error("bridge disconnected");
      if (failure === "reject") return Promise.reject(new Error("bridge disconnected"));
      return Promise.resolve({ status: "failed", message: "bridge disconnected" });
    };
    assert.doesNotThrow(p.run);
    await settle();
    assert.equal(p.warnings.length, 1);
    p.window.dispatchEvent(new Event("codex-plus-bridge-ready"));
    await settle();
    assert.equal(calls, 2);
  });
}

it("retries when reconnect settles the old request before broadcasting readiness", async () => {
  const p = page();
  let calls = 0;
  let resolveOld!: (value: unknown) => void;
  const old = new Promise((resolve) => { resolveOld = resolve; });
  p.window.__codexSessionDeleteBridge = () => ++calls === 1 ? old : Promise.resolve({ scripts: [] });
  p.run();
  assert.equal(calls, 1);
  // build_bridge_script 先结算旧请求，再在同一轮同步广播就绪事件。
  resolveOld({ status: "failed", message: "桥接已重新连接" });
  p.window.dispatchEvent(new Event("codex-plus-bridge-ready"));
  await settle();
  assert.equal(calls, 2);
});

it("does not bootstrap non-app pages or child frames", () => {
  for (const target of ["url", "frame"] as const) {
    const p = page();
    if (target === "url") p.window.location.href = "https://example.com/";
    else p.window.top = {};
    p.window.__codexSessionDeleteBridge = () => { throw new Error("must not load"); };
    p.run();
    assert.equal(p.window.__codexPlusUserScriptsBootstrap, undefined);
  }
});

it("uses the same source label in the extension list and detail", async () => {
  const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
  const start = renderer.indexOf("  function renderCodexPlusExtensionsDetail()");
  const end = renderer.indexOf("  async function uninstallUserScript", start);
  const entriesStart = renderer.indexOf("  function codexPlusExtensionsEntries()");
  const entriesEnd = renderer.indexOf("  function codexPlusExtensionMarketItem", entriesStart);
  for (const [source, market_id, label] of [["user", "translate", "市场"], ["user", "", "用户"], ["builtin", "translate", "内置"]]) {
    const local = { key: "test", name: "Test", source, market_id, status: "loaded", enabled: true };
    const context = vm.createContext({
      codexPlusExtensionsSelectionDetail: () => ({ sel: { kind: "installed", key: local.key }, local }),
      codexPlusUserScripts: { scripts: [local] }, codexPlusScriptMarket: { scripts: [] },
      escapeHtml: String, extensionIconMarkup: () => "", userScriptStatusLabel: () => "已加载",
    });
    const detail = vm.runInContext(`${renderer.slice(start, end)}; renderCodexPlusExtensionsDetail()`, context);
    const list = vm.runInContext(`${renderer.slice(entriesStart, entriesEnd)}; codexPlusExtensionsEntries()`, context);
    assert.equal(list.installed[0].meta, `${label} · 已加载`);
    assert.ok(detail.includes(`${label} · 已加载`), `${label} missing in detail`);
  }
});


it("refreshes an open extension page when scripts finish loading without duplicate listeners", async () => {
  const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
  const start = renderer.indexOf('  window.removeEventListener("codex-plus-user-scripts-loaded"');
  const end = renderer.indexOf("  async function loadScriptMarket", start);
  assert.ok(start >= 0 && end > start);
  const window = Object.assign(new EventTarget(), { __codexPlusUserScripts: { scripts: { test: { status: "loaded" } } } });
  let requests = 0;
  let refreshes = 0;
  let active = "extensions";
  const context = vm.createContext({
    window, codexPlusUserScripts: {}, codexPlusUserScriptsLoaded: false,
    codexPlusActiveEntry: () => active, renderUserScripts: () => {},
    refreshCodexPlusExtensionsView: () => refreshes++,
    postJson: async (path: string, payload: any) => {
      assert.equal(path, "/user-scripts/list");
      assert.equal(payload.runtime_status.test.status, "loaded");
      requests++;
      return { scripts: [{ key: "test", status: "loaded" }] };
    },
  });
  vm.runInContext(renderer.slice(start, end), context);
  vm.runInContext(renderer.slice(start, end), context);
  window.dispatchEvent(new Event("codex-plus-user-scripts-loaded"));
  await settle();
  assert.equal(requests, 1);
  assert.equal(refreshes, 1);
  active = "home";
  window.dispatchEvent(new Event("codex-plus-user-scripts-loaded"));
  await settle();
  assert.equal(requests, 1);
});
