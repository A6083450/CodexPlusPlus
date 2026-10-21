import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

test("successful deletion refreshes native state without reloading", async () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
  const start = source.indexOf("  function openDeleteConfirmForRow(");
  const end = source.indexOf("  async function exportMarkdown(", start);
  for (const hostId of ["local", "ssh:fixture"]) for (const refreshed of [false, true]) {
    const calls: string[] = [];
    const hidden: string[] = [], unhidden: string[] = [];
    const rawThreadId = `${hostId}:fixture`;
    const row = {
      isConnected: true,
      getAttribute: (name: string) => name === "data-app-action-sidebar-thread-id" ? rawThreadId : null,
    };
    let onUndone: (() => void) | undefined;
    const run = vm.runInNewContext(`${source.slice(start, end)}; openDeleteConfirmForRow`, {
      releaseDeleteFocus() {}, confirmDelete: async () => true,
      sameDeletedSessionRef: () => true, sessionRefFromRow: () => ({}), isCurrentSessionRow: () => false,
      postJson: async () => ({ status: hostId === "local" ? "local_deleted" : "server_deleted", session_id: "fixture" }),
      removeDeletedRow: () => { calls.push("remove"); return null; },
      hideDeletedSessionRows: (id: string) => hidden.push(id),
      unhideDeletedSessionRows: (ids: string[]) => unhidden.push(...ids),
      refreshRecentConversationsForHost: async () => { calls.push("refresh"); return refreshed; },
      window: { location: { href: "app://-/thread/other", reload: () => calls.push("reload") } },
      showToast: (_message: string, options: { onUndone?: () => void } | null) => { onUndone = options?.onUndone; },
    });
    await run(row, {}, { session_id: "fixture", title: "fixture", host_id: hostId }, { preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(calls, hostId !== "local" ? [] : ["remove", "refresh"]);
    assert.deepEqual(hidden, hostId === "local" ? [rawThreadId] : []);
    assert.ok(onUndone);
    onUndone();
    assert.deepEqual(unhidden, hidden);
  }
});
