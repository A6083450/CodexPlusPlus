import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

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
  let reply: any = { status: "ok", updateAvailable: true, latestVersion: "v1.10.0+63" };
  let current: any = null;
  let resolve!: (value: any) => void;
  const progress = { active: false };
  const dependencies = {
    Date: { now: () => now }, updateCheckPendingRef: { current: false }, lastUpdateCheckAtRef: { current: 0 },
    updateInstallProgress: progress,
    run: async (task: () => Promise<any>) => task(),
    call: async () => { calls++; return new Promise(value => { resolve = value; }); },
    setUpdate: (value: any) => { current = typeof value === "function" ? value(current) : value; },
    showNotice: () => {}, t: (text: string) => text,
  };
  const check = load("checkUpdate", dependencies);
  const pending = check(true);
  const duplicate = check(true);
  assert.equal(calls, 1);
  resolve(reply); await pending; await duplicate;
  await check(true);
  assert.equal(calls, 1);
  const manual = check(false);
  assert.equal(calls, 2);
  resolve({ status: "failed", updateAvailable: false }); await manual;
  assert.equal(current.latestVersion, reply.latestVersion);
  now += 30 * 60 * 1000;
  progress.active = true;
  await check(true);
  assert.equal(calls, 2);
  progress.active = false;
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
  const notices: string[] = [];
  const perform = load("performUpdate", {
    updateInstallProgress: { active: false }, settingsDirty: true, dreamSkinDraftDirty: false,
    t: (text: string) => text, showNotice: (_title: string, message: string) => notices.push(message),
  });
  await perform();
  assert.match(notices[0], /保存/);
});
