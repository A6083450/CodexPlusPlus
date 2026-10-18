import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

test("native Fast opt-in exposes configured GPT tiers without selecting a default and restores native metadata", () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject/70-model-catalog.js", import.meta.url), "utf8");
  const body = source.match(/^  function applyCodexNativeFastModelCapability\([^]*?^  \}/m)?.[0];
  assert.ok(body);
  let enabled = false;
  const context = vm.createContext({
    codexPlusSettings: () => ({ nativeFastUnlock: enabled }),
    codexPlusNativeFastModelSnapshots: new Map(),
  });
  vm.runInContext(body, context);
  const apply = context.applyCodexNativeFastModelCapability;
  for (const model of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]) {
    const descriptor: any = { model, defaultServiceTier: "standard" };
    enabled = false;
    assert.equal(apply(descriptor, model, "local"), false);
    enabled = true;
    assert.equal(apply(descriptor, model, "local"), true);
    assert.equal(descriptor.serviceTiers[0].id, "priority");
    assert.deepEqual(Array.from(descriptor.additionalSpeedTiers), ["fast"]);
    assert.equal(descriptor.defaultServiceTier, "standard");
    assert.equal(apply(descriptor, model, "local"), false);
    enabled = false;
    const cloned = structuredClone(descriptor);
    assert.equal(apply(cloned, model, "local"), true);
    assert.equal(Object.hasOwn(cloned, "serviceTiers"), false);
    assert.equal(apply(descriptor, model, "local"), true);
    assert.equal(Object.hasOwn(descriptor, "serviceTiers"), false);
    assert.equal(Object.hasOwn(descriptor, "additionalSpeedTiers"), false);
  }
  enabled = true;
  for (const [model, host] of [["gpt-image-2", "local"], ["gpt-image-2.5-flare", "local"], ["deepseek-v4", "local"], ["gpt-6-sol", "remote"]]) {
    const descriptor = { model };
    assert.equal(apply(descriptor, model, host), false);
    assert.deepEqual(descriptor, { model });
  }
  const descriptor = { serviceTiers: [{ id: "ultrafast", name: "Ultrafast" }], additionalSpeedTiers: ["ultrafast"] };
  const original = structuredClone(descriptor);
  apply(descriptor, "gpt-6-sol", "local");
  assert.equal(descriptor.serviceTiers[0].id, "ultrafast");
  enabled = false;
  apply(descriptor, "gpt-6-sol", "local");
  assert.deepEqual(descriptor, original);
  enabled = true;
  const native = { serviceTiers: [{ id: "priority", name: "Native Fast", requirements: ["account"] }], additionalSpeedTiers: ["fast"] };
  assert.equal(apply(native, "gpt-6-sol", "local"), false);
  assert.equal(native.serviceTiers[0].name, "Native Fast");
  assert.deepEqual(native.serviceTiers[0].requirements, ["account"]);
});

test("cached local models gain Fast and restore across clones while remote caches stay unchanged", () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject/70-model-catalog.js", import.meta.url), "utf8");
  const extract = (name: string) => source.match(new RegExp(`^  function ${name}\\([^]*?^  \\}`, "m"))?.[0];
  let enabled = true;
  const context = vm.createContext({
    structuredClone, window: {},
    codexPlusSettings: () => ({ nativeFastUnlock: enabled }),
    codexPlusNativeFastModelSnapshots: new Map(),
    patchModelContainer: (data: any, host: string) => context.applyCodexNativeFastModelCapability(data.data[0], "gpt-6-sol", host),
  });
  vm.runInContext([extract("applyCodexNativeFastModelCapability"), extract("patchCodexModelQueryClient")].join("\n"), context);
  const queries = ["local", "remote"].map(host => ({ queryKey: ["models", "list", host], data: { data: [{ model: "gpt-6-sol" }] } as any }));
  const client = { setQueriesData(filter: any, update: any) {
    for (const q of queries) if (filter.predicate(q)) q.data = structuredClone(update(q.data));
  } };
  assert.equal(context.patchCodexModelQueryClient(client), 1);
  assert.equal(queries[0].data.data[0].serviceTiers[0].id, "priority");
  assert.equal(queries[1].data.data[0].serviceTiers, undefined);
  enabled = false;
  assert.equal(context.patchCodexModelQueryClient(client), 1);
  assert.equal(queries[0].data.data[0].serviceTiers, undefined);
});
