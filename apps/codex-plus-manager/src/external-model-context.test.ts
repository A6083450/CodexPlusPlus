import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

test("external model context refreshes an already selected model before a turn without provider management", async () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject/70-model-catalog.js", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf("  function codexPerModelContextEnabled("), source.indexOf("  function patchAppServerModelRequestClient("));
  const runtime = vm.createContext({
    window: {}, codexRemoteSessionActiveProfile: () => null,
    codexManagedSessionConnection: () => null,
    applyCodexRemoteSessionProviderOverride: (_method: string, params: any) => params,
    applyCodexManagedSessionConnection: (_method: string, params: any) => params,
    sendCodexPlusDiagnostic: () => {},
  });
  vm.runInContext(helpers, runtime);
  const client: any = { hostId: "local", __codexPlusThreadModels: new Map([["thread", "gpt-6.1-sol"]]),
    __codexPlusNativeModelContext: { model: "gpt-6.1-sol", contextWindow: 1000000,
      config: { model_context_window: 1000000, model_auto_compact_token_limit: 950000 } } };
  const calls: any[] = [];
  const request = runtime.applyCodexNativeContextConfig("thread/start", client, { model: "gpt-6.1-sol", serviceTier: "priority" });
  assert.equal(request.config.model_context_window, 1000000);
  assert.equal(request.serviceTier, "priority");
  const send = async (method: string, params: any) => { calls.push({ method, params }); return {}; };
  const params = { threadId: "thread", collaborationMode: { settings: { model: "gpt-6.1-sol" } } };
  await runtime.refreshCodexThreadModelBeforeTurn(client, send, "turn/start", params);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "thread/resume");
  assert.equal(calls[0].params.config.model_context_window, 1000000);
  await runtime.refreshCodexThreadModelBeforeTurn(client, send, "turn/start", params);
  assert.equal(calls.length, 1);
  client.__codexPlusNativeModelContext.config.model_context_window = 500000;
  await runtime.refreshCodexThreadModelBeforeTurn(client, send, "turn/start", params);
  assert.equal(calls.length, 2);
  client.hostId = "remote";
  client.__codexPlusNativeModelContext.config.model_context_window = 200000;
  await runtime.refreshCodexThreadModelBeforeTurn(client, send, "turn/start", params);
  assert.equal(calls.length, 2);
});

test("context usage changes after a model switch only when the active turn is finished", () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject/70-model-catalog.js", import.meta.url), "utf8");
  const body = source.match(/^  function restoreCodexContextWindowUsage\([^]*?^  \}/m)?.[0];
  assert.ok(body);
  const runtime = vm.createContext({});
  vm.runInContext(body, runtime);
  let streaming = true;
  const conversation = { latestModel: "gpt-6-sol", resumeState: "resumed",
    latestTokenUsageInfo: { modelContextWindow: 1000000, totalTokens: 104000 } };
  const manager = {
    requestClient: { __codexPlusNativeModelContext: { model: "gpt-6-sol", contextWindow: 500000 } },
    getConversation: () => conversation,
    isConversationStreaming: () => streaming,
    updateConversationState: (_id: string, update: (state: typeof conversation) => void) => update(conversation),
  };
  assert.equal(runtime.restoreCodexContextWindowUsage(manager, "thread"), false);
  assert.equal(conversation.latestTokenUsageInfo.modelContextWindow, 1000000);
  streaming = false;
  assert.equal(runtime.restoreCodexContextWindowUsage(manager, "thread"), true);
  assert.equal(conversation.latestTokenUsageInfo.modelContextWindow, 500000);
  assert.equal(conversation.latestTokenUsageInfo.totalTokens, 104000);
  assert.equal(runtime.restoreCodexContextWindowUsage(manager, "thread"), false);
});
