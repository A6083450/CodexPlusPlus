const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
let alive = true, busy = false;
const resumes = [];
const conversation = { latestModel: 'gpt-image-2.5-flare', turns: [] };
const client = { hostId: 'local', async sendRequest(method) {
  if (method === 'thread/read') return { thread: { path: '/rollout.jsonl', cwd: '/tmp', status: { type: busy ? 'active' : 'idle' }, turns: [] } };
  assert.ok(['thread/archive', 'thread/unarchive'].includes(method));
  return {};
} };
let context;
const manager = { requestClient: client,
  settings: { readDefaultFeatureOverrides: () => ({ image_generation: true, retained: true }) },
  notificationContext: { handleThreadArchived() {}, handleThreadUnarchived() {} },
  streamState: { stopFollowingConversationState() {} },
  getConversation: () => conversation, getConversationCwd: () => '/tmp',
  updateConversationState(_id, update) { update(conversation); },
  async resumeConversation({ model }) {
    const params = context.applyCodexImageGenerationRequestOverride('thread/resume', { model });
    resumes.push(params); conversation.latestModel = model;
    return { status: 'ready' };
  },
};
context = {
  window: {}, collectCodexReactRuntimeCandidates: () => ({ conversationManagers: [manager] }),
  currentSessionRef: () => ({ session_id: 'image-thread' }),
  loadBackendSettingsState: async () => alive,
  postJson: async () => ({ status: alive ? 'ok' : 'failed' }),
  codexRemoteSessionActiveProfile: () => null,
  codexPlusBackendSettings: { imageGenerationProxy: { provider: 'custom', baseUrl: 'http://127.0.0.1:57321/v1' } },
  codexServiceTierCurrentModelName: () => conversation.latestModel,
  sendCodexPlusDiagnostic() {},
};
vm.createContext(context);
vm.runInContext(source, context);
(async () => {
  const params = { model: 'gpt-image-2.5-flare' };
  assert.equal(context.applyCodexImageGenerationRequestOverride('thread/start', params), params,
    'backend has not confirmed startup: native request must remain untouched');
  context.setCodexImageGenerationRuntimeActive(true);
  context.patchCodexImageGenerationManager(manager);
  assert.equal(context.window.__codexPlusImageGenerationRuntime.threads.size, 0,
    'a displayed image model is not evidence that the thread applied an image proxy');
  assert.equal(manager.settings.readDefaultFeatureOverrides().image_generation, false);
  const image = context.applyCodexImageGenerationRequestOverride('thread/start', params);
  assert.equal(image.config['features.image_generation'], false);
  context.recordCodexImageGenerationThread(client, { requestMethod: 'thread/start', threadId: 'image-thread', model: params.model }, image);
  const stopped = await context.window.__codexPlusRestoreNativeImageGeneration();
  assert.equal(stopped.restored, 1);
  assert.equal(stopped.pending, 0);
  assert.equal(resumes.at(-1).config, undefined);
  assert.equal(manager.settings.readDefaultFeatureOverrides().image_generation, true);
  assert.equal(context.applyCodexImageGenerationRequestOverride('thread/start', params), params);
  vm.runInContext(source, context);
  context.setCodexImageGenerationRuntimeActive(true);
  context.recordCodexImageGenerationThread(client, { requestMethod: 'thread/resume', threadId: 'image-thread', model: params.model }, image);
  let releasePrevious;
  const previous = new Promise(resolve => { releasePrevious = () => {
    context.window.__codexPlusImagePersistenceJobs.delete('image-thread'); resolve(true);
  }; });
  context.window.__codexPlusImagePersistenceJobs.set('image-thread', previous);
  const beforeRestore = resumes.length;
  const restoration = context.window.__codexPlusRestoreNativeImageGeneration();
  releasePrevious();
  await restoration;
  assert.equal(resumes.length, beforeRestore + 1, 'finishing an older image save cannot replace native restoration');
  assert.equal(resumes.at(-1).config, undefined);
  vm.runInContext(source, context);
  context.setCodexImageGenerationRuntimeActive(true);
  context.recordCodexImageGenerationThread(client, { requestMethod: 'thread/resume', threadId: 'image-thread', model: params.model }, image);
  busy = true;
  assert.equal((await context.window.__codexPlusRestoreNativeImageGeneration()).pending, 1);
  busy = false; alive = false;
  await context.prepareCodexImageGenerationTurn(client, 'turn/start', { threadId: 'image-thread', model: 'gpt-6' });
  assert.equal(resumes.at(-1).model, 'gpt-6');
  assert.equal(resumes.at(-1).config, undefined);
  assert.equal(context.window.__codexPlusImageGenerationRuntime.threads.size, 0);
  vm.runInContext(source, context);
  context.setCodexImageGenerationRuntimeActive(true);
  context.recordCodexImageGenerationThread(client, { requestMethod: 'thread/start', threadId: 'image-thread', model: params.model }, image);
  await context.prepareCodexImageGenerationTurn(client, 'turn/start', { threadId: 'image-thread', model: params.model });
  assert.equal(context.applyCodexImageGenerationRequestOverride('thread/start', params), params,
    'lost backend must restore native behavior before the next request');
})().catch(error => { console.error(error); process.exitCode = 1; });
