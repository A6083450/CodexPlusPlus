import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { UpdateNotifications } from "./update-notification.ts";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function handler(name: string, dependencies: Record<string, unknown>): (...args: any[]) => Promise<void> {
  let expression = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) expression = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(expression, `missing ${name}`);
  const javascript = ts.transpileModule(`const handler = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${javascript}; return handler;`)(...Object.values(dependencies));
}

const release = {
  status: "ok", message: "发现可用更新。", currentVersion: "1.10.0", latestVersion: "v1.11.0",
  releaseSummary: "### 新增\n- **更新弹窗**", updateAvailable: true, assetName: "update.dmg", assetUrl: "https://example.test/update.dmg",
};

test("actual update check keeps About data, honors mute, and allows manual prompts", async () => {
  const notices: unknown[] = [];
  const updates: unknown[] = [];
  const prompts: unknown[] = [];
  const notifications = new UpdateNotifications(() => ({ getItem: () => null, setItem: () => {} }));
  const pending = { current: null };
  let now = 2_000_000;
  let response: any = release;
  const check = handler("checkUpdate", {
    Date: { now: () => now }, lastUpdateCheckAtRef: { current: 0 },
    updateCheckPending: pending, updateInstallPending: { current: false },
    call: async () => { if (response instanceof Error) throw response; return response; },
    setUpdate: (value: unknown) => updates.push(value), setUpdatePrompt: (value: unknown) => prompts.push(value),
    updateNotifications: { current: notifications }, showNotice: (...args: unknown[]) => notices.push(args),
    t: (value: string) => value, stringifyError: String,
  });
  await check(true);
  assert.deepEqual(prompts, [release]);
  notifications.muteToday();
  now += 30 * 60 * 1000;
  await check(true);
  assert.equal(prompts.length, 1);
  assert.equal(updates.length, 2, "About remains usable while automatic reminders are muted");
  await check(false);
  assert.equal(prompts.length, 2);
  response = { ...release, status: "failed" };
  now += 30 * 60 * 1000;
  await check(true);
  assert.equal(updates.length, 3, "background failures preserve the previous usable release");
  assert.equal(notices.length, 0);
  response = new Error("offline");
  now += 30 * 60 * 1000;
  await check(true);
  assert.equal(notices.length, 0);
  await check(false);
  assert.equal(notices.length, 1);
  assert.equal(pending.current, null);
  response = { ...release, status: "failed" };
  await check(false);
  assert.equal(notices.length, 2, "manual failures are reported even inside the automatic polling interval");
  assert.equal(updates.length, 3, "manual failures also retain the previously available release");
  assert.equal(prompts.length, 2);
});

test("a manual check reuses an in-flight background request and overrides today's mute", async () => {
  const notifications = new UpdateNotifications(() => ({ getItem: () => null, setItem: () => {} }));
  notifications.muteToday();
  const prompts: unknown[] = [];
  let requests = 0;
  let finish!: (value: unknown) => void;
  const response = new Promise((resolve) => { finish = resolve; });
  const check = handler("checkUpdate", {
    Date: { now: () => 2_000_000 }, lastUpdateCheckAtRef: { current: 0 },
    updateCheckPending: { current: null }, updateInstallPending: { current: false },
    call: async () => { requests++; return response; }, setUpdate: () => {},
    setUpdatePrompt: (value: unknown) => prompts.push(value), updateNotifications: { current: notifications },
    showNotice: () => {}, t: (value: string) => value, stringifyError: String,
  });
  const background = check(true);
  await check(false);
  finish(release);
  await background;
  assert.equal(requests, 1);
  assert.deepEqual(prompts, [release]);
});

test("installing the prompted release prevents duplicate downloads and preserves retry data on failure", async () => {
  const states: any[] = [];
  const updates: any[] = [];
  const calls: any[] = [];
  const pending = { current: false };
  let callback: (event: any) => void = () => {};
  let finish!: (result: unknown) => void;
  const result = new Promise((resolve) => { finish = resolve; });
  let unlistened = 0;
  const install = handler("performUpdate", {
    update: { ...release, latestVersion: "v1.12.0" }, updateInstallPending: pending,
    settingsDirty: false, dreamSkinDraftDirty: false,
    setUpdateInstallProgress: (state: unknown) => states.push(state), setUpdate: (state: unknown) => updates.push(state),
    t: (value: string) => value, stringifyError: String, showNotice: () => {},
    window: { setTimeout: () => 1, clearTimeout: () => {} },
    listen: async (_event: string, listener: typeof callback) => { callback = listener; return () => unlistened++; },
    call: async (command: string, args: unknown) => { calls.push({ command, args }); return result; },
    run: async (task: () => unknown) => task(),
  });
  const task = install(release);
  assert.equal(pending.current, true, "installation locks synchronously before the progress listener is ready");
  await Promise.resolve();
  await install(release);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.release.version, release.latestVersion);
  callback({ payload: { stage: "downloading", percent: 68 } });
  assert.equal(states.at(-1).percent, 68);
  finish({ status: "failed", message: "network failure", progress: 0 });
  await task;
  assert.equal(pending.current, false);
  assert.equal(unlistened, 1);
  assert.equal(states.at(-1).failed, true);
  assert.equal(updates[0].assetUrl, release.assetUrl, "failed installs retain their original asset for retry from About");
  assert.equal(updates[0].latestVersion, release.latestVersion);
  assert.equal(updates[0].updateAvailable, true);
  await install(release);
  assert.equal(calls.length, 2);
});

test("a progress listener failure clears the installation lock and shows the error", async () => {
  const pending = { current: false };
  const states: any[] = [];
  const notices: unknown[][] = [];
  const install = handler("performUpdate", {
    update: release, updateInstallPending: pending, t: (value: string) => value, stringifyError: String,
    settingsDirty: false, dreamSkinDraftDirty: false,
    setUpdateInstallProgress: (state: unknown) => states.push(state), showNotice: (...args: unknown[]) => notices.push(args),
    window: { setTimeout: () => 1, clearTimeout: () => {} },
    listen: async () => { throw new Error("listener unavailable"); },
  });
  await install();
  assert.equal(pending.current, false);
  assert.equal(states.at(-1).failed, true);
  assert.match(states.at(-1).message, /listener unavailable/);
  assert.deepEqual(notices, [["更新安装", "Error: listener unavailable", "failed"]]);
});
