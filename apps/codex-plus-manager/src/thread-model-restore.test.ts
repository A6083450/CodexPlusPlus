import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../../assets/inject/renderer-inject/70-model-catalog.js", import.meta.url), "utf8");

test("resume without an explicit model remembers the native response model", () => {
  const helper = source.match(/^  function codexThreadModelRequestState\([^]*?^  \}/m)?.[0];
  assert.ok(helper);
  const context = vm.createContext({}); vm.runInContext(helper, context);
  const state = context.codexThreadModelRequestState("thread/resume", { threadId: "thread-a" }, { model: "gpt-6.1-sol" });
  assert.equal(state.model, "gpt-6.1-sol");
});

function fixture() {
  let active = "thread-a";
  let route = active;
  const conversations: Record<string, any> = Object.fromEntries(["thread-a", "thread-b"].map(id => [id, {
    resumeState: "resumed", latestModel: "gpt-image-2.5-flare", latestReasoningEffort: "high",
    latestCollaborationMode: { mode: "default", settings: { model: "gpt-image-2.5-flare" } },
    threadRuntimeStatus: { type: "idle" }, turns: [],
  }]));
  const calls: any[] = [], updates: any[] = [];
  let listener: any, timerId = 0;
  const timers = new Map<number, () => void>();
  const manager: any = { requestClient: { hostId: "local" },
    getConversation: (id: string) => conversations[id],
    addAnyConversationCallback(callback: any) { listener = callback; return () => { listener = null; }; },
    async updateThreadSettingsForNextTurn(id: string, change: any, condition: any) {
      const current = conversations[id];
      if (current.latestModel !== condition.ifModelEquals || current.latestReasoningEffort !== condition.ifEffortEquals) return false;
      updates.push({ id, ...change }); current.latestModel = change.model;
      current.latestCollaborationMode.settings.model = change.model; return true;
    },
  };
  const context: any = { window: { __codexSessionDeleteBridge() {} },
    codexPlusBackendSettings: { enhancementsEnabled: true },
    codexAppServerModelRequestPatchVersion: "33",
    setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    codexPlusUsageComposerCard: () => ({}), codexPlusUsageThreadId: () => active,
    locationThreadId: () => route,
    sendCodexPlusDiagnostic() {},
    codexContextUsageTurnActive: (manager: any, id: string) => manager.getConversation(id)?.threadRuntimeStatus?.type === "active",
    postJson: async (route: string, params: any) => {
      assert.equal(route, "/thread-last-model"); calls.push(params.session_id);
      return { status: "ok", session_id: params.session_id, last_model: params.session_id === "thread-a" ? "gpt-6.1-sol" : "gpt-image-2.5-flare" };
    },
  };
  vm.createContext(context);
  const helper = source.match(/^  async function syncCodexThreadModelSelection\([^]*?^  \}/m)?.[0];
  assert.ok(helper, "restore the model for the active conversation"); vm.runInContext(helper, context);
  const observer = source.match(/^  function installCodexThreadModelSelectionObserver\([^]*?^  \}/m)?.[0];
  assert.ok(observer); vm.runInContext(observer, context); context.installCodexThreadModelSelectionObserver(manager);
  return { context, manager, conversations, calls, updates, select: (id: string) => { active = route = id; },
    hideComposer: () => { active = ""; }, showComposer: () => { active = route; },
    notify: async () => { listener?.([]); await new Promise(setImmediate); },
    retry: async () => { const [id, callback] = timers.entries().next().value!; timers.delete(id); callback(); await new Promise(setImmediate); },
    sync: () => context.syncCodexThreadModelSelection([manager]) };
}

test("switching A/B/A restores each last-used model once and preserves manual selection on the current visit", async () => {
  const f = fixture(); await f.sync();
  assert.deepEqual(f.updates, [{ id: "thread-a", model: "gpt-6.1-sol" }]);
  f.conversations["thread-a"].latestModel = "manual-model";
  await f.sync(); assert.equal(f.calls.length, 1);
  f.hideComposer(); await f.sync(); f.showComposer(); await f.sync();
  assert.equal(f.conversations["thread-a"].latestModel, "manual-model", "preview/composer remount is not a thread switch");
  f.select("thread-b"); await f.sync();
  f.select("thread-a"); await f.sync();
  assert.equal(f.conversations["thread-a"].latestModel, "gpt-6.1-sol");
  assert.deepEqual(f.calls, ["thread-a", "thread-b", "thread-a"]);
});

test("native RPC conversations restore A/B/A when React exposes no synchronous manager", async () => {
  const f = fixture(); let hostReads = 0;
  const rpc = new Proxy({
    async getHostId() { hostReads++; return "local"; },
    async getConversation(id: string) { return structuredClone(f.conversations[id]); },
    async updateThreadSettingsForNextTurn(...args: any[]) { return f.manager.updateThreadSettingsForNextTurn(...args); },
  }, { get(target: any, key: string) {
    if (key === "then") return undefined;
    if (key in target) return target[key];
    throw new Error(`RPC method is not public: ${key}`);
  } });
  f.context.codexLocalAppServerManagerRpc = async () => { assert.equal(await rpc.getHostId(), "local"); return rpc; };
  const sync = () => f.context.syncCodexThreadModelSelection([]);
  await sync();
  assert.equal(f.conversations["thread-a"].latestModel, "gpt-6.1-sol");
  f.select("thread-b"); await sync();
  f.select("thread-a"); f.conversations["thread-a"].latestModel = "global-model"; await sync();
  assert.equal(f.conversations["thread-a"].latestModel, "gpt-6.1-sol");
  assert.equal(hostReads, 3);
});

test("a manual choice while native RPC discovery is pending cancels restoration", async () => {
  const f = fixture(); let resolveManager: any;
  f.context.codexLocalAppServerManagerRpc = () => new Promise(done => { resolveManager = done; });
  const pending = f.context.syncCodexThreadModelSelection([]);
  f.context.window.__codexPlusThreadModelVisit.done = true;
  f.conversations["thread-a"].latestModel = "manual-model";
  resolveManager({ getConversation: async (id: string) => f.conversations[id] });
  await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.updates.length, 0);
});

test("current native picker rows and slider cancel a restoration before RPC returns", async () => {
  for (const control of ['[data-model-picker-view] [role="menuitemradio"][aria-checked]', '[data-model-picker-power-slider]']) {
    const f = fixture(); let resolveManager: any;
    f.context.codexLocalAppServerManagerRpc = () => new Promise(done => { resolveManager = done; });
    const handler = source.match(/^  function noteCodexThreadModelManualSelection\([^]*?^  \}/m)?.[0];
    assert.ok(handler); vm.runInContext(handler, f.context);
    const pending = f.context.syncCodexThreadModelSelection([]);
    // 当前原生未选中行没有 data-model-selected，也没有旧版 model-row 属性。
    const target: any = { closest: (selector: string) => selector.includes(control) ? target : null };
    f.context.noteCodexThreadModelManualSelection({ type: "pointerdown", target });
    f.conversations["thread-a"].latestModel = "manual-model";
    resolveManager({ getConversation: async (id: string) => f.conversations[id],
      updateThreadSettingsForNextTurn: f.manager.updateThreadSettingsForNextTurn });
    await pending;
    assert.equal(f.conversations["thread-a"].latestModel, "manual-model");
    assert.equal(f.calls.length, 0);
  }
});

test("the native image overlay does not reset a visit when the URL contains no thread id", async () => {
  const f = fixture(); await f.sync();
  f.conversations["thread-a"].latestModel = "manual-model";
  f.context.window.__codexPlusGeneratedImageOverlay = {};
  f.context.locationThreadId = () => "";
  f.hideComposer(); await f.sync();
  delete f.context.window.__codexPlusGeneratedImageOverlay;
  f.showComposer(); await f.sync();
  assert.equal(f.conversations["thread-a"].latestModel, "manual-model");
});

test("native model picker clicks cancel pending restoration and its retry", () => {
  const f = fixture();
  f.context.window.__codexPlusThreadModelVisit = { done: false, timer: 4 };
  const handler = source.match(/^  function noteCodexThreadModelManualSelection\([^]*?^  \}/m)?.[0];
  assert.ok(handler); vm.runInContext(handler, f.context);
  f.context.noteCodexThreadModelManualSelection({ target: { closest: () => ({}) } });
  assert.equal(f.context.window.__codexPlusThreadModelVisit.done, true);
  assert.equal(f.context.window.__codexPlusThreadModelVisit.timer, null);
});

test("a failed history read cannot restart restoration after a manual picker click", async () => {
  const f = fixture(); let rejectHistory: any;
  f.context.postJson = () => new Promise((_resolve, reject) => { rejectHistory = reject; });
  const pending = f.sync(); await new Promise(setImmediate);
  const handler = source.match(/^  function noteCodexThreadModelManualSelection\([^]*?^  \}/m)?.[0];
  assert.ok(handler); vm.runInContext(handler, f.context);
  f.context.noteCodexThreadModelManualSelection({ target: { closest: () => ({}) } });
  rejectHistory(new Error("bridge disconnected")); await pending;
  assert.equal(f.context.window.__codexPlusThreadModelVisit.done, true);
  assert.equal(f.context.window.__codexPlusThreadModelVisit.timer, null);
});

test("late history responses cannot change another visit or overwrite a new manual choice", async () => {
  const f = fixture(); const resolvers: any[] = [];
  f.context.postJson = () => new Promise(done => { resolvers.push(done); });
  const stale = f.sync(); await new Promise(setImmediate); f.select("thread-b");
  const current = f.sync();
  await new Promise(setImmediate);
  resolvers[1]({ status: "ok", session_id: "thread-b", last_model: "gpt-image-2.5-flare" }); await current;
  resolvers[0]({ status: "ok", session_id: "thread-a", last_model: "gpt-6.1-sol" }); await stale;
  assert.equal(f.updates.length, 0);
  f.select("thread-a"); const manual = f.sync();
  await new Promise(setImmediate);
  f.conversations["thread-a"].latestModel = "manual-model";
  resolvers[2]({ status: "ok", session_id: "thread-a", last_model: "gpt-6.1-sol" }); await manual;
  assert.equal(f.updates.length, 0);
});

test("new, remote, active, unready and missing-history conversations keep their settings", async () => {
  const f = fixture(); f.select(""); await f.sync(); assert.equal(f.calls.length, 0);
  f.select("thread-a"); f.manager.requestClient.hostId = "remote"; await f.sync(); assert.equal(f.calls.length, 0);
  f.manager.requestClient.hostId = "local"; f.conversations["thread-a"].resumeState = "needs_resume";
  await f.sync(); assert.equal(f.calls.length, 0);
  f.conversations["thread-a"].resumeState = "resumed"; f.conversations["thread-a"].threadRuntimeStatus.type = "active";
  await f.sync(); assert.equal(f.calls.length, 0);
  f.select("thread-b"); f.context.postJson = async () => ({ status: "ok", session_id: "thread-b", last_model: null });
  f.conversations["thread-b"].turns = [{ turnId: "inferred", permissionParamsSource: "inferred", params: { model: "wrong-resume-default" } }];
  await f.sync(); assert.equal(f.updates.length, 0);
});

test("a pending manual choice before the first scan cancels history restoration", async () => {
  const f = fixture(); f.manager.hasPendingThreadSettingsUpdate = () => true;
  await f.sync(); f.manager.hasPendingThreadSettingsUpdate = () => false;
  f.conversations["thread-a"].latestModel = "manual-model";
  await f.notify(); await f.sync();
  assert.equal(f.conversations["thread-a"].latestModel, "manual-model");
  assert.equal(f.calls.length, 0);
});

test("native hydration and turn completion trigger restoration without DOM changes", async () => {
  const f = fixture(); f.conversations["thread-a"].resumeState = "needs_resume";
  await f.sync(); assert.equal(f.calls.length, 0);
  f.conversations["thread-a"].resumeState = "resumed";
  f.conversations["thread-a"].threadRuntimeStatus.type = "active";
  await f.notify(); assert.equal(f.calls.length, 0);
  f.conversations["thread-a"].threadRuntimeStatus.type = "idle";
  await f.notify(); assert.equal(f.conversations["thread-a"].latestModel, "gpt-6.1-sol");
});

test("a temporary history read failure retries with the original manual-choice guard", async () => {
  const f = fixture(); let attempts = 0;
  f.context.postJson = async () => ++attempts === 1 ? { status: "failed" }
    : { status: "ok", session_id: "thread-a", last_model: "gpt-6.1-sol" };
  await f.sync(); assert.equal(f.updates.length, 0);
  await f.retry(); assert.equal(f.conversations["thread-a"].latestModel, "gpt-6.1-sol");
  assert.equal(attempts, 2);
});

test("composer identity attribute changes reach the shared scan scheduler", () => {
  const scan = readFileSync(new URL("../../../assets/inject/renderer-inject/98-scan-schedule.js", import.meta.url), "utf8");
  const startup = readFileSync(new URL("../../../assets/inject/renderer-inject/99-startup.js", import.meta.url), "utf8");
  let observer: any, options: any, scheduled = false;
  const context: any = { window: {}, document: { body: {}, removeEventListener() {}, addEventListener() {} }, selectors: {},
    noteCodexThreadModelManualSelection() {},
    codexPluginMarketplacePatchEnabled: () => false, isExtensionUiNode: () => false,
    nodeOrAncestorLooksLikeCodexUserBubble: () => false, nodeLooksLikeCodexUserBubble: () => false,
    MutationObserver: class {
      callback: any;
      constructor(callback: any) { this.callback = callback; observer = this; }
      observe(_node: any, value: any) { options = value; }
    },
    scheduleScan: (mutations: any[]) => { scheduled = context.shouldScheduleScan(mutations); },
  };
  vm.createContext(context);
  for (const name of ["scanRelevantSelector", "nodeSelfOrAncestorMatchesScanRelevance", "isScanRelevantNode", "isChatContentMutation", "shouldScheduleScan"]) {
    const fn = scan.match(new RegExp(`^  function ${name}\\([^]*?^  \\}`, "m"))?.[0];
    assert.ok(fn); vm.runInContext(fn, context);
  }
  const start = startup.indexOf("  window.__codexSessionDeleteObserver?.disconnect();");
  vm.runInContext(startup.slice(start, startup.indexOf('  document.removeEventListener("pointerdown"', start)), context);
  const attribute = "data-above-composer-conversation-id";
  const target = { nodeType: 1, closest: (selector: string) => selector.includes(`[${attribute}]`) ? target : null };
  if (options.attributes && options.attributeFilter.includes(attribute)) {
    observer.callback([{ type: "attributes", attributeName: attribute, target, addedNodes: [], removedNodes: [] }]);
  }
  assert.equal(scheduled, true, "switches that reuse the composer DOM still schedule model restoration");
});
