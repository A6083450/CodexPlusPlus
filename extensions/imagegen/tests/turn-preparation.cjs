const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('  async function prepareCodexImageGenerationTurn(');
const end = source.indexOf('  function patchCodexImageGenerationManager(', start);
let calls = 0, restores = 0, succeed = true, path = '/rollout.jsonl', expectedModel = 'gpt-image-2.5-flare';
const context = {
  window: { __codexPlusImagePersistenceJobs: new Map(),
    __codexPlusImageGenerationRuntime: { active: true, threads: new Map() },
    __codexPlusPersistGeneratedImages: async (session, refreshOnly) => {
      assert.equal(session.session_id, 'old'); assert.equal(refreshOnly, true);
      assert.equal(session.model, expectedModel);
      restores++; return succeed;
    } },
  loadBackendSettingsState: async () => {}, codexImageGenerationDisabled: () => false,
  postJson: async () => ({ status: 'ok' }),
  codexImageGenerationRuntimeActive: () => context.window.__codexPlusImageGenerationRuntime.active,
  setCodexImageGenerationRuntimeActive: active => { context.window.__codexPlusImageGenerationRuntime.active = active; },
  codexRemoteSessionActiveProfile: () => ({ id: 'images', protocol: 'responses', relayMode: 'pureApi', imageGenerationProxy: true }),
  codexPlusBackendSettings: { imageGenerationProxy: { provider: 'custom', baseUrl: 'http://127.0.0.1:57321/v1' } },
  codexServiceTierCurrentModelName: () => 'gpt-image-2.5-flare',
};
vm.createContext(context); vm.runInContext(source.slice(start, end), context);
const client = { hostId: 'local', async sendRequest(method) {
  assert.equal(method, 'thread/read'); calls++; return { thread: { path } };
} };
(async () => {
  context.codexImageGenerationDisabled = () => true;
  const textClient = { hostId: 'local', async sendRequest() {
    assert.fail('ordinary text turns must not read or reload image-generation state');
  } };
  const runtime = context.window.__codexPlusImageGenerationRuntime;
  for (const active of [true, false]) {
    runtime.active = active;
    runtime.threads.set('text', { client: textClient, model: 'gpt-6.1-sol' });
    await context.prepareCodexImageGenerationTurn(textClient, 'turn/start', {
      threadId: 'text', model: 'gpt-6.1-sol',
    });
  }
  assert.equal(restores, 0, 'unrelated text threads must not depend on image restoration');
  runtime.active = true;
  runtime.threads.delete('text');
  const prepare = () => context.prepareCodexImageGenerationTurn(client, 'turn/start', { threadId: 'old' });
  await prepare(); await prepare();
  assert.equal(restores, 1, 'previously loaded thread must be reloaded exactly once');
  assert.equal(calls, 1);
  client.__codexPlusImageGenerationReady.clear(); succeed = false;
  await assert.rejects(prepare()); assert.equal(client.__codexPlusImageGenerationReady.size, 0);
  path = null; await prepare(); assert.equal(restores, 2, 'new thread has no rollout to unload');
  client.hostId = 'remote'; await prepare(); assert.equal(calls, 3);
  vm.runInContext(source.slice(source.indexOf('  function codexImageGenerationDisabled(')), context);
  for (const provider of ['custom', 'relay.with."quotes"']) {
    context.codexPlusBackendSettings.imageGenerationProxy.provider = provider;
    const params = { model: 'gpt-image-2.5-flare', config: {
      retained: true, features: { image_generation: true, retained: true },
      model_providers: { [provider]: { name: 'Existing', base_url: 'https://original.invalid/v1',
        wire_api: 'responses', http_headers: { 'X-Tenant': 'fixture' } }, other: { name: 'Other' } },
    } };
    const before = JSON.stringify(params);
    for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
      const overridden = context.applyCodexImageGenerationRequestOverride(method, params);
      const actual = JSON.parse(JSON.stringify(overridden.config));
      assert.equal(overridden.modelProvider, provider);
      assert.deepEqual(actual.model_providers, { ...params.config.model_providers,
        [provider]: { ...params.config.model_providers[provider],
          base_url: 'http://127.0.0.1:57321/v1', supports_websockets: false },
      });
      assert.equal(Object.keys(actual).some(key => key.startsWith('model_providers.')), false,
        'app-server dotted config keys do not parse TOML quotes');
      assert.equal(actual.retained, true);
      assert.deepEqual(actual.features, { image_generation: false, retained: true });
      assert.equal(JSON.stringify(params), before, 'do not mutate caller config');
    }
  }
  context.codexPlusBackendSettings.imageGenerationProxy.provider = 'custom';
  const minimal = context.applyCodexImageGenerationRequestOverride('thread/start', { model: 'gpt-image-2.5-flare' });
  assert.equal(minimal.config.model_providers.custom.base_url, 'http://127.0.0.1:57321/v1');
  assert.equal(context.applyCodexImageGenerationRequestOverride('thread/start', { model: 'gpt-6' }).config['features.image_generation'], false);
  client.hostId = 'local'; path = '/rollout.jsonl'; succeed = true;
  expectedModel = 'gpt-6';
  await context.prepareCodexImageGenerationTurn(client, 'turn/start', { threadId: 'old', model: expectedModel });
  assert.equal(restores, 3, 'leaving image mode must restore the direct provider config');
  assert.equal(client.__codexPlusImageGenerationProxyThreads.has('old'), false);
  expectedModel = 'gpt-image-2.5-flare';
  await prepare();
  assert.equal(restores, 4, 'returning to image mode must not reuse stale readiness');
  context.codexPlusBackendSettings.imageGenerationProxy = null;
  context.codexRemoteSessionActiveProfile = () => null;
  await prepare();
  assert.equal(restores, 5, 'turning off image proxy must unload its old override');
  assert.equal(client.__codexPlusImageGenerationProxyThreads.has('old'), false);
  const recordStart = source.indexOf('  function recordCodexImageGenerationThread(');
  vm.runInContext(source.slice(recordStart, source.indexOf('  window.__codexPlusRestoreNativeImageGeneration', recordStart)), context);
  context.recordCodexImageGenerationThread(client, { threadId: 'old', model: 'gpt-image-2.5-flare' }, {
    config: { 'features.image_generation': false },
  });
  // 扫描到用户刚选的文字模型，不能丢掉已实际应用的生图代理记录。
  runtime.threads.set('old', { client, model: 'gpt-6' });
  expectedModel = 'gpt-6';
  await context.prepareCodexImageGenerationTurn(client, 'turn/start', { threadId: 'old', model: expectedModel });
  assert.equal(restores, 6, 'an image start must be restored even before its first image turn');
  assert.equal(client.__codexPlusImageGenerationProxyThreads.has('old'), false);
  runtime.threads.set('old', { client, model: 'gpt-image-2.5-flare' });
  await context.prepareCodexImageGenerationTurn(client, 'turn/start', { threadId: 'old', model: expectedModel });
  assert.equal(restores, 7, 'legacy image records must restore after the image proxy is disabled');
  assert.equal(client.__codexPlusImageGenerationProxyThreads.has('old'), false);
})().catch(error => { console.error(error); process.exitCode = 1; });
