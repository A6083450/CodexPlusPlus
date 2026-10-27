import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

test("native image delivery removes an existing recovery thumbnail", () => {
  const source = readFileSync(new URL("../ui/generated-images-inject.js", import.meta.url), "utf8");
  const start = source.indexOf("  function renderImages(");
  const end = source.indexOf("  async function refresh(", start);
  let removed = false;
  const render = vm.runInNewContext(`${source.slice(start,end)}; renderImages`, {
    document: { querySelectorAll: () => [{ getAttribute: () => "ig-native", parentElement: { remove: () => { removed = true; } } }] },
  });
  render([], []);
  assert.equal(removed, true);
});
