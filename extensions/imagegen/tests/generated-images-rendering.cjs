const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('  function renderImages(');
const end = source.indexOf('\n  async function refresh()', start);
const findStart = source.indexOf('  function findResponseTarget(');
const findEnd = source.indexOf('\n  async function openPreview(', findStart);

(async () => {
  let clicks = 0, notices = 0, opens = 0, failed = false;
  const trigger = { querySelector: () => null, appendChild: () => { notices++; } };
  const image = { src: 'data:image/png;base64,fixture', getAttribute: () => 'ig-matching', parentElement: trigger };
  const native = { disabled: false, getAttribute: () => null, querySelectorAll: () => [], click() { clicks++; },
    __reactFiber$fixture: { memoizedProps: { image: { src: '/generated_images/response-assets/ig-matching.png' } } },
  };
  let candidates = [native];
  const context = { state: { images: [{ id: 'ig-matching', base64_data: 'fixture' }] }, window: {
    __codexPlusCurrentSessionRef: () => ({ session_id: 'thread' }),
    async __codexPlusOpenGeneratedImagePreview(image, session, sourceImage) {
      assert.equal(image.id, 'ig-matching'); assert.equal(session.session_id, 'thread');
      assert.equal(sourceImage.getAttribute('data-codex-generated-image-id'), 'ig-matching');
      opens++; if (failed) throw new Error('原生图片打开失败'); return true;
    },
  }, document: { querySelectorAll: () => candidates,
    createElement(tag) { assert.notEqual(tag, 'dialog', 'fallback image clicks must never open a replacement lightbox'); return { setAttribute() {} }; },
  } };
  vm.createContext(context);
  vm.runInContext(source.slice(findEnd, start), context);
  await context.openPreview(image); assert.equal(clicks, 0); assert.equal(opens, 1); assert.equal(notices, 0);
  candidates = []; await context.openPreview(image);
  assert.equal(clicks, 0); assert.equal(opens, 2); assert.equal(notices, 0, 'thumbnail clicks must open the overlay instead of a native side-panel button');
  failed = true; await context.openPreview(image);
  assert.equal(notices, 1); assert.equal(trigger.disabled, false, 'a failed open must remain retryable');
  failed = false; await context.openPreview(image); assert.equal(opens, 4);
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  let reads = 0, synchronizations = 0;
  const context = { state: { pending: false }, window: {
    __codexPlusGeneratedImageOverlay: { sync() { synchronizations++; } },
    __codexPlusCurrentSessionRef() { reads++; },
  } };
  vm.createContext(context);
  const refreshStart = source.indexOf('  async function refresh()');
  const refreshEnd = source.indexOf('\n  function scheduleRefresh()', refreshStart);
  vm.runInContext(source.slice(refreshStart, refreshEnd), context);
  await context.refresh();
  assert.equal(synchronizations, 1);
  assert.equal(reads, 0, 'an open overlay must sync native context without persisting and replacing its chat thumbnail');
})().catch(error => { console.error(error); process.exitCode = 1; });

{
  let oldDialogs = 0, nativeClicks = 0;
  const handlers = [];
  const container = {};
  const trigger = { parentElement: container,
    getAttribute: name => name === 'data-codex-generated-image-preview-trigger' ? 'true' : null,
    addEventListener(_type, handler, capture = false) { handlers.push({ handler, capture }); },
    removeEventListener(_type, handler, capture) { const i = handlers.findIndex(entry => entry.handler === handler && entry.capture === capture); if (i >= 0) handlers.splice(i, 1); },
    click() {
      const event = { preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
      for (const entry of [...handlers].sort((a, b) => Number(b.capture) - Number(a.capture))) {
        entry.handler(event); if (event.stopped) break;
      }
    },
  };
  trigger.addEventListener('click', () => { oldDialogs++; });
  const image = { parentElement: trigger, getAttribute: () => 'ig-existing' };
  const target = { children: [], querySelector: () => container };
  const context = { document: { querySelectorAll: selector => selector === '[data-codex-generated-image-id]' ? [image] : [] },
    state: {}, scheduleRefresh() {}, openPreview: () => { nativeClicks++; },
  };
  vm.createContext(context);
  const helpers = source.slice(findStart, findEnd) + source.slice(start, end);
  for (let i = 0; i < 2; i++) {
    vm.runInContext(helpers, context);
    context.renderImages([{ id: 'ig-existing', base64_data: 'aW1hZ2U=' }], [target]);
    trigger.click();
  }
  assert.equal(oldDialogs, 0, 'reinjection must suppress the anonymous listener left by the old lightbox');
  assert.equal(nativeClicks, 2, 'each click must delegate exactly once after reinjection');
}

for (const width of [0, 128]) {
  for (const src of ['/generated_images/ig-broken.png', 'data:image/png;base64,aW1hZ2U=']) {
    for (const preview of [false, true]) {
      let created = 0, removed = 0;
      const fallback = { getAttribute: () => 'ig-broken', parentElement: {
        getAttribute: () => 'true', remove: () => { removed++; },
      } };
      const native = { complete: true, naturalWidth: width,
        getAttribute: name => name === 'src' ? src : preview ? 'true' : null, addEventListener() {},
      };
      const document = { querySelectorAll: selector =>
        selector === '[data-codex-generated-image-id]' ? [fallback] : [native],
        createElement: () => { created++; throw new Error('existing fallback must be reused'); },
      };
      vm.runInNewContext(source.slice(findStart, findEnd) + source.slice(start, end) + '\nrenderImages([{id:"ig-broken",base64_data:"aW1hZ2U="}], []);',
        { document, state: {}, scheduleRefresh() {} });
      assert.equal(removed, width > 0 && !preview ? 1 : 0, 'only a loaded native image replaces the fallback; its own preview does not');
      assert.equal(created, 0);
    }
  }
}

(async () => {
  const timers = [];
  function element() {
    return { attributes: new Map(), children: [], style: {},
      setAttribute(name, value) { this.attributes.set(name, value); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      appendChild(child) { child.parentElement = this; this.children.push(child); },
      addEventListener() {},
      querySelector() { return this.children.find(child => child.getAttribute('data-codex-generated-images')) || null; },
      remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); },
    };
  }
  const target = element();
  target.setAttribute('data-response-annotation-target', 'msg-final');
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const fallbacks = () => descendants(target).filter(node => node.getAttribute('data-codex-generated-image-id'));
  const native = { complete: true, naturalWidth: 0, getAttribute: () => 'data:image/png;base64,aW1hZ2U=',
    addEventListener(_name, callback) { this.onload = callback; } };
  let reads = 0;
  const context = {
    document: { body: element(), documentElement: element(), createElement: element,
      querySelectorAll(selector) {
        if (selector === '[data-response-annotation-target]') return [target];
        if (selector === '[data-codex-generated-image-id]') return fallbacks();
        return [native];
      } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(callback) { timers.push(callback); }, clearTimeout() {},
    __codexPlusCurrentSessionRef: () => ({ session_id: 'image-thread' }),
    __codexPlusPostJson: async () => ++reads === 1
      ? { status: 'found', images: [{ id: 'ig-broken', assistant_message_id: 'msg-final', base64_data: 'aW1hZ2U=' }] }
      : { status: 'empty', images: [] },
    __codexPlusPersistGeneratedImages: async () => true,
  };
  context.window = context;
  vm.runInNewContext(source, context);
  for (let i = 0; timers.length && i < 10; i++) {
    timers.shift()();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(fallbacks().length, 1, 'successful persistence must retain fallback until native load succeeds');
  native.naturalWidth = 128;
  native.onload();
  timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fallbacks().length, 0, 'native load removes duplicate fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });

{
  function element() {
    return { attributes: new Map(), children: [], style: {},
      setAttribute(name, value) { this.attributes.set(name, value); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      appendChild(child) {
        if (child.parentElement) child.remove();
        child.parentElement = this; this.children.push(child);
      },
      addEventListener() {},
      querySelector() { return this.children.find(child => child.getAttribute('data-codex-generated-images')) || null; },
      remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); },
    };
  }
  const preface = element(), final = element();
  preface.setAttribute('data-response-annotation-target', 'msg-preface');
  final.setAttribute('data-response-annotation-target', 'msg-final');
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const previews = node => descendants(node).filter(child => child.getAttribute('data-codex-generated-image-id'));
  const context = { state: {}, scheduleRefresh() {},
    document: { createElement: element, querySelectorAll(selector) {
      return selector === '[data-codex-generated-image-id]' ? [...previews(preface), ...previews(final)] : [];
    } },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(findStart, findEnd) + source.slice(start, end), context);
  const image = { id: 'ig-streamed', base64_data: 'aW1hZ2U=', assistant_message_id: '' };
  context.renderImages([image], [preface]);
  const preview = previews(preface)[0];
  assert(preview, 'completed generation is visible before the final text arrives');
  context.renderImages([{ ...image, assistant_message_id: 'msg-final' }], [preface, final]);
  assert.equal(previews(final)[0], preview, 'streamed preview must move to the final reply instead of staying above it');
  assert.equal(previews(preface).length, 0);
}
