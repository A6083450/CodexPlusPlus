const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const runtime = fs.readFileSync(process.argv[2], 'utf8');
let current = 'image-thread', sidePanels = 0, mounts = 0, unmounts = 0, removed = 0, release, preloads = 0;
const route = { scope: {}, value: { routeKind: 'local-thread', conversationId: current }, get() {}, set() {} };
const outer = { $$typeof: Symbol.for('react.context') }, inner = { $$typeof: Symbol.for('react.context') };
const composerContext = { target: 'chat', composerHost: {}, setTarget(target) {
  innerFiber.memoizedProps.value = { ...composerContext, target };
} };
const outerFiber = { tag: 10, type: outer, memoizedProps: { value: route } };
const innerFiber = { tag: 10, type: inner, memoizedProps: { value: composerContext }, return: outerFiber };
const anchor = { isConnected: true, __reactFiber$test: { return: innerFiber } };
const imageElement = { isConnected: true, parentElement: anchor, setAttribute() {} };
const effects = [], renders = [];
function ImagePreviewOverlay() {}
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, ...(children.length ? { children: children[0] } : {}) } }; },
  useEffect(callback) { effects.push(callback); },
};
const client = { createRoot() { assert.equal(preloads, 1, 'cold opening must await native annotation styles'); mounts++; return {
  render(tree) {
    if (client.fail) throw new Error('native render failed');
    renders.push(tree);
    while (tree.type === outer || tree.type === inner) tree = tree.props.children;
    const overlay = typeof tree.type === 'function' && tree.type !== ImagePreviewOverlay ? tree.type(tree.props) : tree;
    assert.equal(overlay.type, ImagePreviewOverlay, 'must mount the original overlay component');
    client.overlay = overlay;
    for (const callback of effects.splice(0)) callback();
  }, unmount() {
    unmounts++;
    const composer = renders.at(-1).props.children.props.value;
    // 原生 cleanup 只有仍拥有迁入的输入框时才恢复它。
    if (composer.target === 'immediate-overlay') composer.setTarget('chat');
  },
}; } };
function sidePanel(scope, { availableImageCount, initialZoomPercent, openInEditor }) { sidePanels++; return true; }
const modules = { 'app-shared-': { XVt: () => React, KNt: () => client, async vIt(load, css, base) {
  assert.deepEqual(Array.from(css), ['./annotation-aaa.css', './image-edit-viewer-bbb.css']);
  assert.equal(base, 'app://assets/generated-image-gallery-def.js');
  assert.equal(typeof load, 'function');
  await Promise.resolve(); preloads++; return { ImagePreviewOverlay };
} },
  'overlay-': { ImagePreviewOverlay }, 'app-initial-': { renamed: sidePanel } };
const context = { window: {}, Map, Set, Promise, Symbol, Object,
  URL, fetch: async url => ({ ok: true, async text() {
    if (url.endsWith('local-conversation-turn-123.js')) return 'import "./schema-abc.js"';
    if (url.endsWith('schema-abc.js')) return 'import "./generated-image-gallery-def.js"';
    return '["./annotation-aaa.css","./image-edit-viewer-bbb.css","./overlay-789.js"]';
  } }),
  codexAppAssetUrl: () => 'app://assets/local-conversation-turn-123.js',
  document: { createElement: () => ({ setAttribute() {}, remove() { removed++; } }), body: { appendChild() {} } },
  currentSessionRef: () => ({ session_id: current }),
  collectCodexReactRuntimeCandidates: () => ({ appScopes: [route] }),
  loadOptionalCodexAppModule: async name => modules[name], sendCodexPlusDiagnostic() {},
};
vm.createContext(context); vm.runInContext(runtime, context);
(async () => {
  const image = { id: 'ig-raw', base64_data: 'aW1hZ2U=', media_type: 'image/png' };
  const open = () => context.window.__codexPlusOpenGeneratedImagePreview(image, { session_id: current }, imageElement);
  assert.equal(await open(), true);
  assert.equal(sidePanels, 0, 'clicking an image must not create a native side-panel tab');
  assert.equal(mounts, 1);
  assert.equal(renders[0].type, outer); assert.equal(renders[0].props.value, route);
  assert.equal(renders[0].props.children.type, inner);
  assert.equal(client.overlay.props.image.editInOverlay, true, 'markup must stay in the overlay');
  assert.equal(client.overlay.props.image.sourceConversationId, current);
  assert.match(client.overlay.props.image.src, /^data:image\/png;base64,/);
  assert.equal(client.overlay.props.getThumbnail(), imageElement);
  const attrs = {}; client.overlay.props.image.imageRef({ setAttribute: (key, value) => { attrs[key] = value; } });
  assert.equal(attrs['data-codex-generated-image-preview-content'], 'true', 'the overlay image must not replace its chat thumbnail');
  innerFiber.memoizedProps.value = { ...composerContext, target: 'overlay' };
  context.window.__codexPlusGeneratedImageOverlay.sync();
  assert.equal(renders.at(-1).props.children.props.value.target, 'overlay', 'native composer context must keep following its provider');
  const count = renders.length; context.window.__codexPlusGeneratedImageOverlay.sync(); assert.equal(renders.length, count);
  innerFiber.memoizedProps.value = { ...composerContext, target: 'immediate-overlay' };
  client.overlay.props.onClose(); assert.equal(unmounts, 1); assert.equal(removed, 1);
  assert.equal(innerFiber.memoizedProps.value.target, 'chat', 'closing before the debounced sync must restore the native composer');
  await open(); current = 'other-thread'; context.window.__codexPlusGeneratedImageOverlay.sync();
  assert.equal(unmounts, 2, 'changing chats must unmount the native overlay');
  current = 'image-thread';
  client.fail = true;
  await assert.rejects(open(), /native render failed/);
  assert.equal(context.window.__codexPlusGeneratedImageOverlay, null, 'render failures must remove the incomplete overlay');
  client.fail = false;
  const afterFailure = mounts;
  context.loadOptionalCodexAppModule = name => new Promise(resolve => { (release ||= []).push(() => resolve(modules[name])); });
  const pending = open(); current = 'other-thread'; release.forEach(fn => fn());
  assert.equal(await pending, false); assert.equal(mounts, afterFailure);
  await assert.rejects(context.window.__codexPlusOpenGeneratedImagePreview(image,
    { session_id: current, host_id: 'remote' }, imageElement), /原会话/);
  current = 'image-thread'; context.loadOptionalCodexAppModule = async () => ({});
  await assert.rejects(open(), /原生图片/);
})().catch(error => { console.error(error); process.exitCode = 1; });
