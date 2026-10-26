const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(process.argv[3]);
const runtime = fs.readFileSync(process.argv[2], 'utf8');
const host = fs.readFileSync(path.join(root, 'assets/inject/renderer-inject/20-menu.js'), 'utf8');
const route = { scope: {}, value: { routeKind: 'local-thread', conversationId: 'image-thread' }, get() {}, set() {} };
const unrelated = { ...route, value: { routeKind: 'local-thread', conversationId: 'other-thread' } };
const app = { ...route, value: {} };
const fiber = { memoizedState: { memoizedState: { current: app } },
  child: { dependencies: { firstContext: { memoizedValue: route } }, memoizedProps: { value: unrelated } } };
let current = 'image-thread', opens = 0, release;
const options = [];
// 与原生导出一致的形参契约；不依赖随构建改变的导出名。
function nativeOpen(scope, { availableImageCount = 1, initialView = 'single', initialZoomPercent, openInEditor = false, ...props }) {
  assert.equal(scope, route); assert.equal(openInEditor, true); assert.equal(initialView, 'single');
  assert.equal(props.sourceConversationId, 'image-thread');
  assert.equal(props.imageSourceContext.hostId, 'local');
  assert.equal(props.attachmentSrc, props.src); assert.match(props.src, /^data:image\/png;base64,/);
  assert.equal(props.generatedImages, undefined, 'raw tool results must not require a cached native image item');
  options.push(props); opens++; return true;
}
const context = { window: {}, Map, Set, codexReactFiberRoots: () => [fiber],
  currentSessionRef: () => ({ session_id: current }),
  loadOptionalCodexAppModule: async () => ({ renamedExport: nativeOpen }),
  sendCodexPlusDiagnostic() {},
};
vm.createContext(context);
vm.runInContext(host.match(/^  function collectCodexReactRuntimeCandidates\([^]*?^  \}/m)[0], context);
vm.runInContext(runtime, context);
(async () => {
  const image = { id: 'ig-raw', base64_data: 'aW1hZ2U=', media_type: 'image/png' };
  assert.equal(await context.window.__codexPlusOpenGeneratedImagePreview(image, { session_id: current }), true);
  assert.equal(opens, 1, 'a raw image call must open even without any native gallery button');
  context.loadOptionalCodexAppModule = () => new Promise(resolve => { release = () => resolve({ nativeOpen }); });
  const pending = context.window.__codexPlusOpenGeneratedImagePreview(image, { session_id: current });
  current = 'other-thread'; release();
  assert.equal(await pending, false); assert.equal(opens, 1, 'switching chats during module loading must not open in another chat');
  current = 'image-thread'; context.loadOptionalCodexAppModule = async () => ({});
  await assert.rejects(context.window.__codexPlusOpenGeneratedImagePreview(image, { session_id: current }), /原生图片/);
})().catch(error => { console.error(error); process.exitCode = 1; });
