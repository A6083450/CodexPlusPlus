const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('  function patchAppServerModelRequestClient(');
const end = source.indexOf('\n  // issue #2177', start);
const context = {
  codexAppServerModelRequestPatchVersion: source.match(/const codexAppServerModelRequestPatchVersion = "([^"]+)"/)[1],
  registerNativeHostClient() {},
  codexPlusPluginNativeInterceptClient: () => null,
  appServerModelRequestMethod: method => method,
  prepareCodexImageGenerationTurn: async () => {},
  codexManagedSessionConnection: () => null,
  prepareCodexManagedSessionConnection: async (_method, params) => params,
  sendCodexManagedSessionTurn: async () => null,
  noteCodexManagedSessionStart() {},
  refreshCodexNativeModelCache: async () => {},
  codexRemoteSessionProviderRequestMethod: () => false,
  applyCodexRemoteSessionProviderOverride: (_method, params) => params,
  applyCodexAppServerRequestOverrides: (_method, _client, params) => params,
  codexServiceTierRequestMethods: () => new Set(),
  refreshCodexThreadModelBeforeTurn: async () => true,
  codexThreadModelRequestState: () => ({}),
  codexPlusModelUnlockEnabled: () => false,
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
(async () => {
  for (const mode of ['inherited', 'old-own-wrapper', 'custom-own-wrapper']) {
    let oldCalls = 0, customCalls = 0;
    function nativeSendRequest(_method, params) {
      assert.equal(this.hostId, 'local', 'native receiver must be preserved');
      return Promise.resolve(params);
    }
    const proto = {
      __codexPlusModelRequestPatch: '27',
      __codexPlusModelOriginalSendRequest: nativeSendRequest,
      sendRequest: async function codexPlusModelPatchedSendRequest(method, params) { oldCalls++; return nativeSendRequest.call(this, method, params); },
    };
    const client = Object.assign(Object.create(proto), { hostId: 'local' });
    if (mode === 'old-own-wrapper') {
      async function codexPlusModelPatchedSendRequest(_method, params) {
        oldCalls++; return { ...params, config: { 'features.image_generation': false } };
      }
      client.__codexPlusModelOriginalSendRequest = codexPlusModelPatchedSendRequest.bind(client);
    } else if (mode === 'custom-own-wrapper') {
      client.__codexPlusModelOriginalSendRequest = async function customOriginal(_method, params) {
        customCalls++; return params;
      };
    }
    assert.equal(context.patchAppServerModelRequestClient(client), true);
    const params = { model: 'gpt-6' };
    assert.equal(await client.sendRequest('turn/start', params), params);
    assert.equal(oldCalls, 0, 'obsolete Codex++ wrapper must not run after reinjection');
    assert.equal(customCalls, mode === 'custom-own-wrapper' ? 1 : 0, 'preserve unrelated instance wrappers');
  }
  // 新会话立即有 rollout，且首条消息发送时 React manager 可能尚不可用。
  Object.assign(context, {
    window: {}, collectCodexReactRuntimeCandidates: () => ({ conversationManagers: [] }),
    codexPlusBackendSettings: { imageGenerationProxy: { provider: 'custom', baseUrl: 'http://127.0.0.1:57321/v1' } },
    codexRemoteSessionActiveProfile: () => null,
    codexServiceTierCurrentModelName: () => 'gpt-image-2.5-flare',
    postJson: async () => ({ status: 'ok' }), loadBackendSettingsState: async () => true,
    sendCodexPlusDiagnostic() {},
    applyCodexAppServerRequestOverrides: (method, _client, params) => context.applyCodexImageGenerationRequestOverride(method, params),
  });
  const runtimePath = require('node:path').resolve(__dirname, '../ui/renderer-runtime.js');
  vm.runInContext(fs.readFileSync(runtimePath, 'utf8'), context);
  const stateStart = source.indexOf('  function codexThreadModelRequestState(');
  vm.runInContext(source.slice(stateStart, source.indexOf('  async function refreshCodexNativeModelCache(', stateStart)), context);
  context.setCodexImageGenerationRuntimeActive(true);
  const requests = [];
  const fresh = { hostId: 'local', async sendRequest(method, params) {
    requests.push(method);
    if (method === 'thread/start') {
      assert.equal(params.config.model_providers.custom.base_url, context.codexPlusBackendSettings.imageGenerationProxy.baseUrl);
      return { thread: { id: 'fresh', path: '/already-created-rollout.jsonl' } };
    }
    if (method === 'thread/read') return { thread: { path: '/already-created-rollout.jsonl', status: { type: 'idle' } } };
    assert.equal(method, 'turn/start');
    return { turn: { id: 'first-turn' } };
  } };
  context.patchAppServerModelRequestClient(fresh);
  await fresh.sendRequest('thread/start', { model: 'gpt-image-2.5-flare' });
  assert.equal((await fresh.sendRequest('turn/start', { threadId: 'fresh', model: 'gpt-image-2.5-flare' })).turn.id, 'first-turn');
  assert.deepEqual(requests, ['thread/start', 'turn/start'], 'applied start config must not trigger an archive/resume round trip');
  for (const params of [{ threadId: 'fresh', model: 'gpt-6' }, { threadId: 'unknown', model: 'gpt-image-2.5-flare' }]) {
    await assert.rejects(fresh.sendRequest('turn/start', params), /生图会话配置未恢复/,
      'switching model and untracked sessions still require verified restoration');
  }
  context.codexPlusBackendSettings.imageGenerationProxy.baseUrl = 'http://127.0.0.1:57322/v1';
  await assert.rejects(fresh.sendRequest('turn/start', { threadId: 'fresh', model: 'gpt-image-2.5-flare' }), /生图会话配置未恢复/,
    'a changed proxy must invalidate the successfully started session');
})().catch(error => { console.error(error); process.exitCode = 1; });
