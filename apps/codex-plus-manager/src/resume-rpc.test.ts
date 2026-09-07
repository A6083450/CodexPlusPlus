import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

test("context usage tracking preserves RpcTarget prototype methods and removes legacy shadow", async () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
  const start = source.indexOf("  function patchCodexContextUsageManager(");
  const end = source.indexOf("  function bootstrapCodexContextWindowUsage(", start);
  let restored = 0;
  const patch = vm.runInNewContext(`${source.slice(start,end)}; patchCodexContextUsageManager`, {
    codexAppServerModelRequestPatchVersion: "test",
    bootstrapCodexContextWindowUsage() {},
    currentSessionRef: () => ({ session_id: "thread" }),
    restoreCodexContextWindowUsage: () => { restored++; },
  });
  class RpcTarget {
    requestClient = { hostId: "local" };
    listeners = new Set<(id: string) => void>();
    addAnyConversationCallback(callback: (id: string) => void) {
      this.listeners.add(callback); return () => this.listeners.delete(callback);
    }
    async resumeConversation() { this.listeners.forEach(callback => callback("thread")); return "ready"; }
  }
  for (const legacy of [false, true]) {
    const target = new RpcTarget();
    if (legacy) {
      Object.assign(target, { __codexPlusOriginalResumeConversation: target.resumeConversation });
      target.resumeConversation = async () => "broken";
    }
    patch(target); patch(target);
    assert.equal(Object.hasOwn(target, "resumeConversation"), false, "RPC rejects instance properties");
    assert.equal(target.resumeConversation, RpcTarget.prototype.resumeConversation);
    assert.equal(await target.resumeConversation(), "ready");
    assert.equal(target.listeners.size, 1);
  }
  assert.equal(restored, 2);
});
