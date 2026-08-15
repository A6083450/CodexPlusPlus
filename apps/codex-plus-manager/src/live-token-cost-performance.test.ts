import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const SOURCE_URL = new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url);
const MAX_STARTUP_BYTES = 61_440;
const FORBIDDEN = [
  "localStorage",
  "indexedDB",
  "MutationObserver",
  "setInterval",
  ".clone(",
  "offsetWidth",
  "Array.prototype",
  "Promise.prototype",
  "RegExp.prototype",
  "window.fetch =",
  "XMLHttpRequest",
  "WebSocket",
  "electronBridge =",
  "Statsig",
  "__reactFiber",
  "eval(",
  "new Function",
];

describe("Codex Live Token Cost startup performance policy", () => {
  it("keeps the full startup below 60 KiB", async () => {
    const source = await readFile(SOURCE_URL);
    assert.ok(source.byteLength <= MAX_STARTUP_BYTES, `startup is ${source.byteLength} bytes; limit is ${MAX_STARTUP_BYTES}`);
  });

  it("contains none of the forbidden legacy CPU and global-patching mechanisms", async () => {
    const source = await readFile(SOURCE_URL, "utf8");
    const found = FORBIDDEN.filter((token) => source.includes(token));
    assert.deepEqual(found, []);
  });
});
