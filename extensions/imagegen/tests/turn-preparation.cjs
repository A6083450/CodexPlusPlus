const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('  async function prepareCodexImageGenerationTurn(');
const end = source.indexOf('  function patchCodexImageGenerationManager(', start);
let calls = 0, restores = 0, succeed = true, path = '/rollout.jsonl';
const context = {
  window: { __codexPlusImagePersistenceJobs: new Map(),
    __codexPlusPersistGeneratedImages: async (session, refreshOnly) => {
      assert.equal(session.session_id, 'old'); assert.equal(refreshOnly, true);
      restores++; return succeed;
    } },
  loadBackendSettingsState: async () => {}, codexImageGenerationDisabled: () => true,
  codexServiceTierCurrentModelName: () => 'gpt-image-2.5-flare',
};
vm.createContext(context); vm.runInContext(source.slice(start, end), context);
const client = { hostId: 'local', async sendRequest(method) {
  assert.equal(method, 'thread/read'); calls++; return { thread: { path } };
} };
(async () => {
  const prepare = () => context.prepareCodexImageGenerationTurn(client, 'turn/start', { threadId: 'old' });
  await prepare(); await prepare();
  assert.equal(restores, 1, 'previously loaded thread must be reloaded exactly once');
  assert.equal(calls, 1);
  client.__codexPlusImageGenerationReady.clear(); succeed = false;
  await assert.rejects(prepare()); assert.equal(client.__codexPlusImageGenerationReady.size, 0);
  path = null; await prepare(); assert.equal(restores, 2, 'new thread has no rollout to unload');
  client.hostId = 'remote'; await prepare(); assert.equal(calls, 3);
})().catch(error => { console.error(error); process.exitCode = 1; });
