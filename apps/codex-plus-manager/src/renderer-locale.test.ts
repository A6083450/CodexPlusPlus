import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import vm from "node:vm";

const fragment = (name: string) => readFile(
  new URL(`../../../assets/inject/renderer-inject/${name}`, import.meta.url), "utf8",
);

async function stateApi(modules: Record<string, object>) {
  const text = await fragment("60-plugin-marketplace.js");
  const source = text.slice(text.indexOf("  let codexStateApiPromise = null;"),
    text.indexOf("  async function getCodexGlobalState("));
  const loaded: string[] = [];
  const api = vm.runInNewContext(`(() => {${source}; return { codexStateApiFromModule, codexStateCall };})()`, {
    loadCodexAppModule: async (name: string) => {
      loaded.push(name);
      if (!(name in modules)) throw new Error("asset missing");
      return modules[name];
    },
  });
  return { ...api, loaded };
}

it("finds the current async state RPC without invoking a reused qut export", async () => {
  const collisions: string[] = [];
  // 新版 app-shared 的 RPC 保留这些选项；同步 query factory 也有同名字段。
  const queryFactory = (method: string, { params, select, signal, responsePriority }: any) =>
    ({ method, params, select, signal, responsePriority });
  const rpc = async (method: string, { params, select, signal, responsePriority }: any) => {
    void select; void signal; void responsePriority;
    return { value: method === "get-setting" && params.key === "localeOverride" ? "zh-CN" : null };
  };
  const api = await stateApi({
    "app-shared-": { queryFactory, renamedRpc: rpc },
    "app-initial-": { qut: () => { collisions.push("qut"); return null; } },
  });
  const result = await api.codexStateCall("get-setting", { params: { key: "localeOverride" } });
  assert.equal(result.value, "zh-CN");
  assert.deepEqual(collisions, []);
  assert.deepEqual(api.loaded, ["app-shared-"]);
  assert.equal(api.codexStateApiFromModule({ qut: () => null }, "app-initial-"), null);
});

it("still recognizes legacy state dispatchers by their supported operations", async () => {
  const legacy = async (method: string, options: any) => {
    const operations = ["get-global-state", "set-global-state"];
    return operations.includes(method) ? options.params : null;
  };
  const api = await stateApi({});
  for (const prefix of ["app-initial-", "app-shared-"]) {
    assert.equal(api.codexStateApiFromModule({ renamed: legacy }, prefix), legacy);
  }
});

async function localeSync(options: {
  current?: string | null;
  invalidRead?: boolean;
  ignoreWrite?: boolean;
  enabled?: boolean;
  managed?: object;
}) {
  const text = await fragment("00-prelude.js");
  const source = text.slice(text.indexOf("  function installCodexPlusForceChineseLocale()"),
    text.indexOf("  const helperBase ="));
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const managedKey = "codexPlus.forceChineseLocale.managed.v1";
  const reloadKey = "codexPlus.forceChineseLocale.reload.v1";
  if (options.managed) local.set(managedKey, JSON.stringify(options.managed));
  const storage = (values: Map<string, string>) => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  let current = options.current ?? null;
  let reloads = 0;
  const calls: string[] = [];
  const window = {
    __CODEX_PLUS_FORCE_CHINESE_LOCALE__: { enabled: options.enabled !== false, locale: "zh-CN" },
    localStorage: storage(local), sessionStorage: storage(session),
    location: { reload: () => { reloads += 1; } },
    setInterval: () => 1, clearInterval: () => {}, setTimeout,
  };
  vm.runInNewContext(`${source}; installCodexPlusForceChineseLocale();`, {
    window, Navigator: class {}, navigator: {},
    codexStateCall: async (method: string, { params }: any) => {
      assert.equal(params.key, "localeOverride");
      calls.push(method);
      if (method === "get-setting") return options.invalidRead ? null : { value: current };
      assert.equal(method, "set-setting");
      if (!options.ignoreWrite) current = params.value;
      return { success: !options.ignoreWrite };
    },
  });
  await new Promise(setImmediate);
  return { current, reloads, calls, managed: local.get(managedKey), reloadMarker: session.get(reloadKey) };
}

it("does not rewrite or reload an already Chinese desktop", async () => {
  const result = await localeSync({ current: "zh-CN" });
  assert.deepEqual(result.calls, ["get-setting"]);
  assert.equal(result.reloads, 0);
});

it("does not mistake an invalid setting response for an unset locale", async () => {
  const result = await localeSync({ invalidRead: true });
  assert.deepEqual(result.calls, ["get-setting"]);
  assert.equal(result.reloads, 0);
  assert.equal(result.managed, undefined);
});

it("does not reload when a locale write was not persisted", async () => {
  const result = await localeSync({ current: "en-US", ignoreWrite: true });
  assert.equal(result.current, "en-US");
  assert.equal(result.reloads, 0);
  assert.equal(result.reloadMarker, undefined);
});

it("verifies a changed locale before reloading once", async () => {
  const result = await localeSync({ current: "en-US" });
  assert.deepEqual(result.calls, ["get-setting", "set-setting", "get-setting"]);
  assert.equal(result.current, "zh-CN");
  assert.equal(result.reloads, 1);
  assert.deepEqual(JSON.parse(result.managed!), { appliedLocale: "zh-CN", previousValue: "en-US" });
});

it("verifies restoration of the previous locale before clearing its backup", async () => {
  const result = await localeSync({ current: "zh-CN", enabled: false,
    managed: { appliedLocale: "zh-CN", previousValue: "en-US" } });
  assert.deepEqual(result.calls, ["get-setting", "set-setting", "get-setting"]);
  assert.equal(result.current, "en-US");
  assert.equal(result.reloads, 1);
  assert.equal(result.managed, undefined);
});

it("preserves the previous locale backup when restoration fails", async () => {
  const managed = { appliedLocale: "zh-CN", previousValue: "en-US" };
  const result = await localeSync({ current: "zh-CN", enabled: false, ignoreWrite: true, managed });
  assert.equal(result.current, "zh-CN");
  assert.equal(result.reloads, 0);
  assert.deepEqual(JSON.parse(result.managed!), managed);
});
