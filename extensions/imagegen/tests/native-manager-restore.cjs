const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(process.argv[3]);
const host = fs.readFileSync(path.join(root, 'assets/inject/renderer-inject/20-menu.js'), 'utf8');
const source = fs.readFileSync(process.argv[2], 'utf8');
let busy = false, failed = false, resumes = 0, releases = 0, loads = 0;
const conversation = { cwd: '/workspace', latestModel: 'gpt-image-2.5-flare',
  latestReasoningEffort: null, resumeState: 'resumed', threadRuntimeStatus: { type: 'idle' } };
const resumedConfigs = [];
let context;
const manager = {
  async getHostId() { return 'local'; },
  async sendRequest(method, params) {
    assert.equal(method, 'thread/read'); assert.equal(params.threadId, 'image');
    return { thread: { cwd: '/workspace', status: { type: busy ? 'active' : 'idle' } } };
  },
  async getConversation(id) {
    assert.equal(id, 'image');
    // 原生提交前会先把界面标记为 active，是否忙碌必须读取后端。
    return { ...conversation, threadRuntimeStatus: { type: 'active' } };
  },
  async unsubscribeInactiveConversation(id) { assert.equal(id, 'image'); releases++; conversation.resumeState = 'needs_resume'; },
  async resumeConversation(params) {
    assert.equal(params.conversationId, 'image');
    assert.deepEqual(Array.from(params.workspaceRoots), ['/workspace']);
    assert.equal(params.model, conversation.latestModel);
    assert.equal(params.reasoningEffort, null);
    resumes++;
    resumedConfigs.push(context.applyCodexImageGenerationRequestOverride('thread/resume', { model: params.model }));
    if (failed) return { status: 'failed' };
    conversation.resumeState = 'resumed';
    return { status: 'ready' };
  },
};
const scope = { scope: {}, get() { return { forHost(hostId) { assert.equal(hostId, 'local'); return manager; } }; }, set() {} };
function nativeManager(scope, hostId) {
  const service = scope.get();
  if (!service) throw new Error('AppServerManager RPC is unavailable for hostId: ' + hostId);
  return service.forHost(hostId);
}
const fiber = { memoizedState: { memoizedState: { current: scope } } };
context = {
  window: {}, Map, Set, codexReactFiberRoots: () => [fiber],
  loadOptionalCodexAppModule: async prefix => { assert.equal(prefix, 'app-initial-'); loads++; return { getter: nativeManager }; },
  codexPlusBackendSettings: { imageGenerationProxy: { provider: 'custom', baseUrl: 'http://127.0.0.1:57321/v1' } },
  codexRemoteSessionActiveProfile: () => null,
  codexServiceTierCurrentModelName: () => conversation.latestModel,
  postJson: async () => ({ status: 'ok' }), loadBackendSettingsState: async () => true,
  sendCodexPlusDiagnostic() {},
};
vm.createContext(context);
vm.runInContext(host.match(/^  function collectCodexReactRuntimeCandidates\([^]*?^  \}/m)[0], context);
vm.runInContext(host.match(/^  async function codexLocalAppServerManagerRpc\([^]*?^  \}/m)[0], context);
vm.runInContext(source, context);
const client = { hostId: 'local', async sendRequest(method) {
  assert.equal(method, 'thread/read'); return { thread: { path: '/rollout.jsonl', status: { type: 'idle' } } };
} };
(async () => {
  context.setCodexImageGenerationRuntimeActive(true);
  const prepare = () => context.prepareCodexImageGenerationTurn(client, 'turn/start', { threadId: 'image', model: conversation.latestModel });
  assert.equal(context.collectCodexReactRuntimeCandidates().conversationManagers.length, 0);
  await prepare();
  assert.equal(resumes, 1, 'an image follow-up must restore through the native RPC when React exposes no manager');
  assert.equal(releases, 1);
  assert.equal(resumedConfigs[0].config.model_providers.custom.base_url, 'http://127.0.0.1:57321/v1');
  await prepare();
  assert.equal(resumes, 1, 'a prepared follow-up must not repeatedly reload its thread');
  client.__codexPlusImageGenerationReady.clear();
  busy = true;
  await assert.rejects(prepare(), /生图会话配置未恢复/);
  assert.equal(releases, 1, 'busy native threads must remain loaded');
  assert.equal(client.__codexPlusImageGenerationReady.size, 0);
  busy = false; failed = true;
  await assert.rejects(prepare(), /生图会话配置未恢复/);
  assert.equal(client.__codexPlusImageGenerationReady.size, 0);
  failed = false;
  await prepare();
  assert.equal(conversation.resumeState, 'resumed');
  assert.equal(context.window.__codexPlusImagePersistenceJobs.size, 0);
  assert.ok(loads > 0);
  assert.equal(await context.window.__codexPlusPersistGeneratedImages({ session_id: 'image' }), false,
    'saving files still requires the original persistence path');
  context.setCodexImageGenerationRuntimeActive(false);
  conversation.latestModel = 'gpt-6.1-sol';
  await prepare();
  assert.equal(resumedConfigs.at(-1).config, undefined, 'backend exit restores the direct native configuration');
})().catch(error => { console.error(error); process.exitCode = 1; });
