import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

test("successful deletion refreshes native state and reloads when unavailable", async () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
  const start = source.indexOf("  function openDeleteConfirmForRow(");
  const end = source.indexOf("  async function exportMarkdown(", start);
  for (const refreshed of [false, true]) {
    const calls: string[] = [];
    const run = vm.runInNewContext(`${source.slice(start, end)}; openDeleteConfirmForRow`, {
      releaseDeleteFocus() {}, confirmDelete: async () => true,
      postJson: async () => ({ status: "local_deleted" }),
      removeDeletedRow: () => calls.push("remove"),
      refreshRecentConversationsForHost: async () => { calls.push("refresh"); return refreshed; },
      window: { location: { reload: () => calls.push("reload") } }, showToast() {},
    });
    run({}, {}, { title: "fixture" }, { preventDefault() {}, stopPropagation() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, refreshed ? ["remove", "refresh"] : ["remove", "refresh", "reload"]);
  }
});
