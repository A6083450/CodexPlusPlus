import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { UpdateNotifications } from "./update-notification.ts";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function load(name: string, dependencies: Record<string, unknown>) {
  let code = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) code = node.initializer.getText(tree);
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) code = node.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(code, name);
  const compiled = ts.transpileModule(`const result = ${code};`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${compiled}; return result;`)(...Object.values(dependencies));
}

test("update checks throttle automatic polling, deduplicate requests and preserve an available update on failure", { timeout: 2000 }, async () => {
  let now = 2000000;
  let calls = 0;
  const reply = { status: "ok", updateAvailable: true, latestVersion: "v1.10.0+63" };
  let current: any = null;
  let resolve!: (value: any) => void;
  const installing = { current: false };
  const checkPending = { current: null as { manual: boolean } | null };
  const dependencies = {
    Date: { now: () => now }, updateCheckPending: checkPending, lastUpdateCheckAtRef: { current: 0 },
    updateInstallPending: installing,
    updateNotifications: { current: new UpdateNotifications(() => ({ getItem: () => null, setItem: () => {} })) },
    setUpdatePrompt: () => {}, stringifyError: String,
    call: async () => { calls++; return new Promise(value => { resolve = value; }); },
    setUpdate: (value: any) => { current = typeof value === "function" ? value(current) : value; },
    showNotice: () => {}, t: (text: string) => text,
  };
  const check = load("checkUpdate", dependencies);
  const pending = check(true);
  const duplicate = check(true);
  assert.equal(calls, 1);
  assert.deepEqual(checkPending.current, { manual: false });
  resolve(reply); await pending; await duplicate;
  assert.equal(dependencies.updateCheckPending.current, null);
  await check(true);
  assert.equal(calls, 1);
  const manual = check(false);
  assert.equal(calls, 2);
  resolve({ status: "failed", updateAvailable: false }); await manual;
  assert.equal(current.latestVersion, reply.latestVersion);
  now += 30 * 60 * 1000 - 1;
  await check(true);
  assert.equal(calls, 2, "automatic checks remain throttled until the full interval has elapsed");
  now++;
  installing.current = true;
  await check(true);
  await check(false);
  assert.equal(calls, 2);
  installing.current = false;
  const next = check(true);
  assert.equal(calls, 3);
  resolve({ status: "not_checked", updateAvailable: false }); await next;
  assert.equal(current.updateAvailable, false);
});

test("the update notice exposes an in-app install action and protects unsaved settings", () => {
  const Notice = load("UpdateNotice", {
    React, t: (text: string) => text, tf: (text: string, args: string[]) => text.replace("{0}", args[0]),
    Button: ({ children, ...props }: any) => React.createElement("button", props, children),
    Download: () => null, Loader2: () => null, TaskProgressBox: () => null,
  });
  const props = { update: { updateAvailable: true, latestVersion: "v1.10.0+63", assetName: "app.dmg", assetUrl: "https://example.invalid/app.dmg" }, progress: { active: false, percent: 0 }, blocked: false, onUpdate: () => {}, onDetails: () => {} };
  const render = (patch: object = {}) => renderToStaticMarkup(React.createElement(Notice, { ...props, ...patch }));
  assert.match(render(), /v1\.10\.0\+63/);
  assert.match(render(), /立即更新/);
  assert.doesNotMatch(render(), /disabled/);
  assert.match(render({ blocked: true }), /disabled/);
  assert.match(render({ progress: { active: true, percent: 20 } }), /disabled/);
  assert.equal(render({ update: { updateAvailable: false } }), "");
});

test("the shared installer action refuses to exit with unsaved configuration", async () => {
  for (const dirty of [
    { settingsDirty: true, dreamSkinDraftDirty: false },
    { settingsDirty: false, dreamSkinDraftDirty: true },
  ]) {
    const notices: string[] = [];
    const pending = { current: false };
    const perform = load("performUpdate", {
      update: { latestVersion: "v1.10.0+63", assetName: "app.dmg", assetUrl: "https://example.invalid/app.dmg" },
      updateInstallPending: pending, ...dirty,
      t: (text: string) => text, showNotice: (_title: string, message: string) => notices.push(message),
      listen: () => assert.fail("dirty drafts must block the installer before subscribing to progress"),
      call: () => assert.fail("dirty drafts must not start a download"),
    });
    await perform();
    assert.deepEqual(notices, ["请先保存当前修改后再更新。"]);
    assert.equal(pending.current, false);
  }
});

test("closing the update notification preserves the release used by the persistent notice", () => {
  const update = { status: "ok", updateAvailable: true, latestVersion: "v1.10.0+63", assetName: "app.dmg", assetUrl: "https://example.invalid/app.dmg" };
  const notifications = new UpdateNotifications(() => ({ getItem: () => null, setItem: () => {} }));
  let prompt: typeof update | null = update;
  const close = load("closeUpdatePrompt", {
    updatePrompt: update, updateNotifications: { current: notifications },
    setUpdatePrompt: (value: null) => { prompt = value; },
    setUpdate: () => assert.fail("closing the notification must not clear the available release"),
  });
  close();
  assert.equal(prompt, null);
  assert.equal(notifications.shouldPrompt(update), false);
  assert.equal(notifications.shouldPrompt(update, true), true);
  assert.equal(update.updateAvailable, true);
  assert.equal(update.assetUrl, "https://example.invalid/app.dmg");
});
