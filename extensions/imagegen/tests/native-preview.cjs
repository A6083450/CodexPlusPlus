const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const imagePath = '/home/user/with space/generated_images/response-assets/ig_probe-0123456789abcdef.png';
const message = (text = `![已生成图像](<${imagePath}>)`, id = 'msg_cpp_images_' + 'a'.repeat(32)) => ({ type: 'agentMessage', id, text });
const original = message();
const native = { type: 'imageGeneration', id: 'native', status: 'completed', src: imagePath };
const text = message('keep this text', 'ordinary');
const pending = { turnId: 'stream', status: 'inProgress', items: [message()] };
const historical = { turnId: 'history', status: 'completed', items: [message(`![已生成图像](<${imagePath}>)\n\n![已生成图像](<C:\\Codex\\generated_images\\response-assets\\ig_windows.jpg>)`, 'msg_cpp_images_' + 'b'.repeat(32))] };
const originalHistory = historical.items[0];
const conversation = { turns: [{ turnId: 'done', status: 'completed', items: [original, native, text] }, pending],
  turnHistory: { history: { entitiesByKey: { old: historical } } } };
let callback, updates = 0, unsubscribed = 0;
const manager = { requestClient: { hostId: 'local' },
  getConversation: id => id === 'thread' ? conversation : null,
  updateConversationState(id, update, broadcast) { assert.equal(id, 'thread'); assert.equal(broadcast, false); updates++; update(conversation); callback([conversation]); },
  addAnyConversationCallback(fn) { callback = fn; return () => { unsubscribed++; }; },
};
const context = { window: {}, codexAppServerModelRequestPatchVersion: '32',
  currentSessionRef: () => ({ session_id: 'thread' }), codexPlusBackendSettings: {},
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), context);
context.setCodexImageGenerationRuntimeActive(true);
context.patchCodexImageGenerationManager(manager);
const converted = conversation.turns[0].items[0];
assert.equal(converted.type, 'imageGeneration', 'proxy-delivered image must use the native gallery item');
assert.equal(converted.id, original.id, 'preserve the native message lookup identity');
assert.equal(converted.savedPath, imagePath);
assert.equal(converted.src, imagePath);
assert.equal(converted.result, imagePath);
assert.equal(converted.status, 'completed');
assert.equal(conversation.turns[0].items[1], native);
assert.equal(conversation.turns[0].items[2], text);
assert.equal(pending.items[0].type, 'agentMessage', 'streaming deltas must keep their original target');
assert.equal(historical.items.length, 2);
assert.equal(historical.items[1].src, 'C:\\Codex\\generated_images\\response-assets\\ig_windows.jpg');
assert.notEqual(historical.items[0].id, historical.items[1].id);
callback('thread'); context.patchCodexImageGenerationManager(manager);
assert.equal(updates, 1, 'projection must settle without a self-triggered update loop');
pending.status = 'completed'; callback([conversation]);
assert.equal(pending.items[0].type, 'imageGeneration');
assert.equal(updates, 2);
const retainedImage = historical.items[1];
historical.items = [originalHistory, retainedImage];
callback([conversation]);
assert.equal(historical.items.length, 2, 'resume may restore the source message while retaining its projected images');
assert.equal(historical.items[1], retainedImage, 'keep the retained native image identity');
assert.equal(new Set(historical.items.map(item => item.id)).size, 2);
assert.equal(updates, 3);
for (const item of [message(`![user image](<${imagePath}>)`, 'ordinary'), message('![已生成图像](<https://host/image.png>)'),
  message('![已生成图像](</etc/passwd>)'), message(`![已生成图像](<${imagePath}>)\nDo not discard this text`),
  message(`![已生成图像](</tmp/../generated_images/response-assets/ig_probe.png>)`),
  message(undefined, 'msg_cpp_images_' + 'c'.repeat(33)), message(undefined, 'msg_cpp_images_' + 'c'.repeat(63)), null]) {
  conversation.turns.push({ status: 'completed', items: [item] });
  callback('thread'); assert.equal(conversation.turns.at(-1).items[0], item);
}
assert.equal(updates, 3, 'ordinary messages and invalid references stay intact');
context.setCodexImageGenerationRuntimeActive(false);
conversation.turns.push({ status: 'completed', items: [message()] }); callback('thread');
assert.equal(updates, 3, 'disabled runtime must not rewrite the display');
context.setCodexImageGenerationRuntimeActive(true);
context.codexAppServerModelRequestPatchVersion = '33';
context.patchCodexImageGenerationManager(manager);
assert.equal(unsubscribed, 1, 'reinjection must replace the prior observer');
assert.equal(updates, 4);
const remote = { requestClient: { hostId: 'remote' }, addAnyConversationCallback() { assert.fail('remote manager'); } };
context.patchCodexImageGenerationManager(remote);
