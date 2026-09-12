import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

test("image quality menus are excluded from service tier injection", () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
  const start = source.indexOf("  function codexServiceTierMenuModelCandidates()");
  const end = source.indexOf("  function codexServiceTierNativeSpeedRow(", start);
  const rows = ["GPT-Image-2 高", "image-2", "gpt-image-1.5", "GPT-6 Ultra", "DeepSeek"].map(textContent => ({
    textContent, getAttribute: () => null,
  }));
  const result = vm.runInNewContext(`${source.slice(start, end)}; codexServiceTierMenuModelCandidates()`, {
    document: { querySelectorAll: () => rows },
    codexServiceTierSemanticModelMenuRowSelector: () => "[data-model-picker-view-toggle]",
  });
  assert.deepEqual(Array.from(result), rows.slice(3));
});

test("native image delivery removes an existing recovery thumbnail", () => {
  const source = readFileSync(new URL("../../../extensions/imagegen/ui/generated-images-inject.js", import.meta.url), "utf8");
  const start = source.indexOf("  function renderImages(");
  const end = source.indexOf("  async function refresh(", start);
  let removed = false;
  const render = vm.runInNewContext(`${source.slice(start,end)}; renderImages`, {
    document: { querySelectorAll: () => [{ getAttribute: () => "ig-native", parentElement: { remove: () => { removed = true; } } }] },
  });
  render([], []);
  assert.equal(removed, true);
});
