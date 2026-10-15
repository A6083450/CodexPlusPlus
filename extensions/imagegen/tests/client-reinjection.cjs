const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('  function patchAppServerModelRequestClient(');
const end = source.indexOf('\n  // issue #2177', start);
const context = {
  codexAppServerModelRequestPatchVersion: '16',
  registerNativeHostClient() {},
  codexPlusPluginNativeInterceptClient: () => null,
  appServerModelRequestMethod: method => method,
  prepareCodexImageGenerationTurn: async () => {},
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
      __codexPlusModelRequestPatch: '15',
      __codexPlusModelOriginalSendRequest: nativeSendRequest,
      sendRequest: async function codexPlusModelPatchedSendRequest(method, params) { return nativeSendRequest.call(this, method, params); },
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
})().catch(error => { console.error(error); process.exitCode = 1; });
