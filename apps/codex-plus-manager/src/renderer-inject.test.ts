import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function loadCodexPlusTriggerClassNormalizer(renderer: string) {
  const start = renderer.indexOf("  function normalizeCodexPlusTriggerClassName");
  const end = renderer.indexOf("\n\n  function configureCodexPlusTrigger", start);
  assert.ok(start >= 0 && end > start, "Codex++ trigger class normalizer should exist");

  const source = renderer.slice(start, end).trim();
  return vm.runInNewContext(`(${source})`) as (className: string) => string;
}

describe("renderer injection header compatibility", () => {
  it("anchors the Codex++ menu to current and legacy application top bars only", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    assert.match(renderer, /appHeader:\s*'[^"]*\[class\*="ApplicationMenuTopBar"\][^']*\.app-header-tint'/);
    assert.doesNotMatch(renderer, /document\.querySelector\(["']header["']\)/);
    assert.match(renderer, /isApplicationMenuTopBar\s*\?\s*Math\.max\(4, headerRect\.top\)/);
    assert.match(renderer, /isApplicationMenuTopBar\s*\?\s*28\s*:\s*headerRect\.height/);
  });

  it("does not install Codex++ UI in embedded browser documents", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    assert.match(renderer, /window\.top\s*!==\s*window/);
    assert.match(renderer, /!window\.electronBridge/);
    assert.ok(renderer.includes("/^app:\\\/\\\/\\-\\//i.test(window.location.href)"));
    assert.match(renderer, /codexPlusIsNodeTestHarness/);
  });

  it("keeps the Codex++ trigger pill-shaped when copying native button classes", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const normalize = loadCodexPlusTriggerClassNormalizer(renderer);

    const classNames = normalize("flex h-7 rounded-lg rounded-l-none border-l-0 px-1.5").split(/\s+/);

    assert.ok(classNames.includes("rounded-full"));
    assert.ok(!classNames.includes("rounded-lg"));
    assert.ok(!classNames.includes("rounded-l-none"));
  });
});
