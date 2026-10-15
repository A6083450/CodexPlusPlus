const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('  function renderImages(');
const end = source.indexOf('\n  async function refresh()', start);

for (const width of [0, 128]) {
  let created = 0, removed = 0;
  const fallback = { getAttribute: () => 'ig-broken', parentElement: {
    getAttribute: () => 'true', remove: () => { removed++; },
  } };
  const native = { complete: true, naturalWidth: width,
    getAttribute: () => '/generated_images/ig-broken.png', addEventListener() {},
  };
  const document = { querySelectorAll: selector =>
    selector === '[data-codex-generated-image-id]' ? [fallback] : [native],
    createElement: () => { created++; throw new Error('existing fallback must be reused'); },
  };
  vm.runInNewContext(source.slice(start, end) + '\nrenderImages([{id:"ig-broken",base64_data:"aW1hZ2U="}], []);',
    { document, state: {}, scheduleRefresh() {} });
  assert.equal(removed, width > 0 ? 1 : 0, 'failed native image must preserve the fallback');
  assert.equal(created, 0);
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
  const native = { complete: true, naturalWidth: 0, getAttribute: () => '/missing/ig-broken.png',
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
