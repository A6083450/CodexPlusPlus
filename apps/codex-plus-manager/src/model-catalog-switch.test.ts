import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

test("provider ownership changes refresh the cached model catalog", async () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject/30-service-tier.js", import.meta.url), "utf8");
  const body = source.match(/^  async function loadBackendSettingsState\([^]*?^  \}/m)?.[0];
  assert.ok(body);
  const calls: boolean[] = [];
  let settings = { enhancementsEnabled: true, relayProfilesEnabled: false, activeRelayId: "saved" };
  const context = vm.createContext({
    window: { __CODEX_PLUS_TEST_SERVICE_TIER__: true },
    codexPlusBackendSettings: { ...settings, relayProfilesEnabled: true },
    codexPlusBackendSettingsSeq: 0,
    codexPlusBackendSettingsLoaded: true,
    postJson: async () => settings,
    loadCodexModelCatalog: async (force: boolean) => { calls.push(force); },
  });
  vm.runInContext(body, context);
  assert.equal(await context.loadBackendSettingsState(), true);
  assert.deepEqual(calls, [true]);
  await context.loadBackendSettingsState();
  assert.deepEqual(calls, [true], "unchanged heartbeat must not fetch again");
  settings = { ...settings, relayProfilesEnabled: true };
  await context.loadBackendSettingsState();
  assert.deepEqual(calls, [true, true]);
});

test("an empty external catalog cannot fall back to a disabled saved provider", async () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject/70-model-catalog.js", import.meta.url), "utf8");
  const body = source.match(/^  async function loadCodexModelCatalog\([^]*?^  \}/m)?.[0];
  assert.ok(body);
  const context = vm.createContext({
    codexModelCatalogPromise: null,
    codexModelCatalogLoadedAt: 0,
    codexModelCatalog: {},
    readCodexAppServerPreparation: async (path: string) => path === "/settings/get"
      ? { relayProfilesEnabled: false, activeRelayId: "saved", relayProfiles: [{ id: "saved", modelList: "stale-model" }] }
      : { status: "not_configured", models: [] },
    renderCodexPlusMenu() {}, scheduleCodexModelWhitelistRefresh() {}, sendCodexPlusDiagnostic() {},
  });
  vm.runInContext(body, context);
  const result = await context.loadCodexModelCatalog(true);
  assert.deepEqual(Array.from(result.models), []);
});
