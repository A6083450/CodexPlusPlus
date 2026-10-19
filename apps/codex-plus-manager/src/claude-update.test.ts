import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { selectRelease, download, installUpdater } = require("../../../assets/claude-localization/managed-update.cjs");
const payload = {
  name: "Claude 2.42304.2", version: "2.42304.2", notes: "Release",
  pub_date: "2026-10-19T01:33:55", size: 3,
  url: "https://downloads.claude.ai/releases/darwin/arm64/2.42304.2/Claude.zip",
  sha256: "a".repeat(64),
};
const feed = { currentRelease: "2.42304.2", releases: [{ version: "2.42304.2", updateTo: payload }] };

test("selects the current full release, never a delta or unrelated version", () => {
  assert.deepEqual(selectRelease(feed, "2.42304.0"), payload);
  assert.equal(selectRelease(feed, "2.42304.2"), null);
  assert.equal(selectRelease(feed, "2.50000.0"), null);
  assert.throws(() => selectRelease({ ...feed, releases: [] }, "2.42304.0"));
  for (const change of [
    { url: "http://downloads.claude.ai/Claude.zip" },
    { url: "https://downloads.claude.ai.attacker.test/Claude.zip" },
    { sha256: "" }, { size: -1 }, { version: "2.42304.3" },
  ]) {
    assert.throws(() => selectRelease({ ...feed, releases: [{ version: payload.version, updateTo: { ...payload, ...change } }] }, "2.42304.0"));
  }
});

test("failed feed returns an updater error and permits retry instead of staying downloading", async () => {
  const updater = new EventEmitter() as any;
  updater.getFeedURL = () => "https://api.anthropic.com/api/desktop/darwin/arm64/squirrel/update";
  let calls = 0;
  const electron = {
    app: { getVersion: () => "2.42304.0" }, autoUpdater: updater,
    net: { fetch: async () => { calls++; throw new Error("offline"); } },
  };
  const events: string[] = [];
  updater.on("checking-for-update", () => events.push("checking"));
  updater.on("error", (error: Error) => events.push(error.message));
  updater.on("update-downloaded", () => assert.fail("failed checks must never be ready"));
  installUpdater(electron, {}, () => {});
  await updater.checkForUpdates();
  await updater.checkForUpdates();
  assert.equal(calls, 2);
  assert.deepEqual(events, ["checking", "offline", "checking", "offline"]);
});

test("unknown feed origins are rejected without any network request", async () => {
  const updater = new EventEmitter() as any;
  updater.getFeedURL = () => "https://attacker.test/update";
  const errors: Error[] = [];
  updater.on("error", (error: Error) => errors.push(error));
  installUpdater({ app: { getVersion: () => "2.42304.0" }, autoUpdater: updater,
    net: { fetch: () => assert.fail("untrusted feed must not be fetched") } }, {}, () => {});
  await updater.checkForUpdates();
  assert.equal(errors.length, 1);
});

test("download verifies actual bytes, length and SHA-256 before accepting a release", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "claude-update-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = { ...payload, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
  const fetch = async () => new Response("abc");
  await download(fetch, release, path.join(root, "valid.zip"));
  assert.equal(readFileSync(path.join(root, "valid.zip"), "utf8"), "abc");
  await assert.rejects(download(fetch, { ...release, sha256: "b".repeat(64) }, path.join(root, "corrupt.zip")), /SHA-256/);
  await assert.rejects(download(fetch, { ...release, size: 2 }, path.join(root, "large.zip")), /大小/);
  await assert.rejects(download(fetch, { ...release, size: 4 }, path.join(root, "short.zip")), /大小/);
});

test("checking an already prepared release completes the native manual-check event sequence", { skip: process.platform === "win32" }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "claude-ready-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const module = { exports: {} as any };
  // 只替换昂贵的签名/副本构建进程；下载、校验、暂存和 updater 状态运行真实实现。
  new Function("require", "module", "__dirname", readFileSync(require.resolve("../../../assets/claude-localization/managed-update.cjs"), "utf8"))(require, module, root);
  const updater = new EventEmitter() as any;
  updater.getFeedURL = () => "https://api.anthropic.com/api/desktop/darwin/arm64/squirrel/update";
  const release = { ...payload, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
  const events: string[] = [];
  for (const name of ["checking-for-update", "update-available", "update-downloaded"])
    updater.on(name, () => events.push(name));
  updater.on("error", (error: Error) => { throw error; });
  module.exports.installUpdater({ app: { getVersion: () => "2.42304.0" }, autoUpdater: updater,
    net: { fetch: async (url: string) => url === release.url ? new Response("abc") : Response.json({
      currentRelease: release.version, releases: [{ version: release.version, updateTo: release }],
    }) } }, { python: "/usr/bin/true" }, () => {});
  await updater.checkForUpdates();
  await updater.checkForUpdates();
  assert.deepEqual(events, ["checking-for-update", "update-available", "update-downloaded",
    "checking-for-update", "update-available", "update-downloaded"]);
});
