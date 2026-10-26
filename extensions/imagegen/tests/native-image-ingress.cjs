const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const id = 'msg_cpp_images_' + 'a'.repeat(32);
const path = '/home/user/generated_images/response-assets/ig_probe-0123456789abcdef.png';
const image = { type: 'agentMessage', id, text: `![已生成图像](<${path}>)` };
const listeners = new Map(), queued = [], received = [];
const window = {
  location: { origin: 'app://codex' },
  addEventListener(type, handler, capture) { assert.equal(capture, true); listeners.set(type, handler); },
  removeEventListener(type) { listeners.delete(type); },
  dispatchEvent(event) { listeners.get('message')?.(event); if (!event.stopped) received.push(event.data); },
};
const context = { window, queueMicrotask: callback => queued.push(callback),
  MessageEvent: class { constructor(type, options) { this.type = type; this.data = options.data; this.source = null; this.origin = ''; } },
};
vm.createContext(context); vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), context);
context.setCodexImageGenerationRuntimeActive(true);
const notification = (method, params, hostId = 'local') => {
  const event = { data: { type: 'mcp-notification', hostId, method, params }, source: null, origin: '',
    stopImmediatePropagation() { this.stopped = true; } };
  window.dispatchEvent(event); return event;
};
const start = notification('item/started', { threadId: 'thread', turnId: 'turn', item: { ...image, text: '' } });
assert.equal(start.data.params.item.type, 'imageGeneration', 'native item classification must be correct before it reaches the cache');
assert.equal(start.data.params.item.status, 'in_progress');
assert.equal(notification('item/agentMessage/delta', { itemId: id, delta: image.text }).stopped, true);
assert.equal(notification('item/agentMessage/delta', { itemId: 'ordinary', delta: 'keep text' }).stopped, undefined);
const done = notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { ...image } });
assert.equal(done.data.params.item.type, 'imageGeneration');
assert.equal(done.data.params.item.savedPath, path);
const raw = { thread: { turns: [{ id: 'turn', status: 'completed', items: [{ ...image }] }] } };
context.patchCodexNativeImageResult('thread/read', { hostId: 'local' }, raw);
assert.equal(raw.thread.turns[0].items[0].type, 'imageGeneration', 'history must be converted before native normalization');
const page = { data: [{ turnId: 'turn', completedAtMs: 123, item: { ...image,
  text: image.text + '\n\n' + image.text.replace('ig_probe', 'ig_second'),
} }] };
context.patchCodexNativeImageResult('thread/items/list', { hostId: 'local' }, page);
assert.deepEqual(page.data.map(entry => entry.item.type), ['imageGeneration', 'imageGeneration']);
assert.deepEqual(page.data.map(entry => entry.item.id), [id, id + '_1']);
assert(page.data.every(entry => entry.turnId === 'turn' && entry.completedAtMs === 123));
context.patchCodexNativeImageResult('thread/items/read', { hostId: 'local' }, page);
assert.equal(page.data.length, 2, 'repeated normalization must retain pagination order without duplicates');
const descending = { data: [
  { turnId: 'turn', item: { ...image, text: image.text + '\n\n' + image.text.replace('ig_probe', 'ig_second') } },
  { turnId: 'turn', item: { type: 'agentMessage', id: 'older', text: 'earlier caption' } },
] };
context.patchCodexNativeImageResult('thread/items/list', { hostId: 'local' }, descending, { sortDirection: 'desc' });
assert.deepEqual(descending.data.map(entry => entry.item.id), [id + '_1', id, 'older']);
assert.deepEqual(descending.data.map(entry => entry.item.id).reverse(), ['older', id, id + '_1'],
  'native descending-page reversal must restore chronological image order');
const remote = { thread: { turns: [{ status: 'completed', items: [{ ...image }] }] } };
context.patchCodexNativeImageResult('thread/read', { hostId: 'remote' }, remote);
assert.equal(remote.thread.turns[0].items[0].type, 'agentMessage');
assert.equal(notification('item/completed', { item: { ...image } }, 'remote').data.params.item.type, 'agentMessage');
const multi = notification('item/completed', { threadId: 'thread', turnId: 'turn', completedAtMs: 200, item: {
  ...image, text: image.text + '\n\n' + image.text.replace('ig_probe', 'ig_second'),
} });
assert.equal(multi.data.params.item.id, id);
while (queued.length) queued.shift()();
const additional = received.filter(value => value.params.item?.id === id + '_1');
assert.deepEqual(additional.map(value => value.method), ['item/started', 'item/completed']);
assert(additional.every(value => value.params.item.type === 'imageGeneration'));
assert.equal(additional[0].params.startedAtMs, 200, 'synthetic starts must satisfy the native notification schema');
assert.equal(additional[1].params.completedAtMs, 200);
const complete = notification('turn/completed', { turn: { status: 'completed', items: [{ ...image }] } });
assert.equal(complete.data.params.turn.items[0].type, 'imageGeneration');
context.setCodexImageGenerationRuntimeActive(false);
assert.equal(notification('item/completed', { item: { ...image } }).data.params.item.type, 'agentMessage');
