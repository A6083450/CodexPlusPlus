import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../../assets/inject/renderer-inject/70-model-catalog.js", import.meta.url), "utf8");
const body = source.match(/^  async function patchModelJsonResponse\([^]*?^  \}/m)?.[0];
assert.ok(body);

test("unrelated JSON responses never wait for a model catalog", async () => {
  let loads = 0;
  const context = vm.createContext({
    codexPlusModelUnlockEnabled: () => true,
    codexPlusModelNames: () => [],
    loadCodexModelCatalog: () => { loads++; return new Promise(() => {}); },
    modelJsonResponseLooksPatchable: () => false,
  });
  vm.runInContext(body, context);
  const payload = { account: { type: "apiKey" } };
  const response = context.patchModelJsonResponse(payload);
  assert.equal(loads, 0);
  assert.equal(await response, payload);
});

test("native models finish loading while additional catalog metadata is pending", async () => {
  let loads = 0;
  let patches = 0;
  const context = vm.createContext({
    window: {}, codexPlusModelUnlockEnabled: () => true,
    codexPlusModelNames: () => [],
    loadCodexModelCatalog: () => { loads++; return new Promise(() => {}); },
    modelJsonResponseLooksPatchable: () => true,
    modelResponseHostId: () => "local",
    patchModelContainer: () => { patches++; },
  });
  vm.runInContext(body, context);
  const payload = { models: [{ model: "gpt-6-astra" }] };
  const response = context.patchModelJsonResponse(payload);
  let completed = false;
  response.then(() => { completed = true; });
  await new Promise(setImmediate);
  assert.equal(completed, true, "model loading must not depend on the enhancement backend");
  assert.equal(await response, payload);
  assert.equal(loads, 1);
  assert.equal(patches, 1);
});
