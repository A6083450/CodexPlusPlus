import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isVersionNewer, syncMarketInstalledState } from "./script-market-sync.ts";

describe("isVersionNewer semantic version comparison", () => {
  it("detects newer candidates across major/minor/patch", () => {
    assert.equal(isVersionNewer("1.0.0", "0.7.2"), true);
    assert.equal(isVersionNewer("1.2", "1.0"), true);
    assert.equal(isVersionNewer("0.7.3", "0.7.2"), true);
    assert.equal(isVersionNewer("1.0.0", "1.0.1"), false);
  });

  it("treats equal versions and locally newer versions as not newer", () => {
    assert.equal(isVersionNewer("1.0.0", "1.0.0"), false);
    assert.equal(isVersionNewer("0.7.2", "1.0.0"), false);
    assert.equal(isVersionNewer("1.0", "1.2"), false);
  });

  it("pads missing segments and trims v prefixes", () => {
    assert.equal(isVersionNewer("101", "1.0.0"), true);
    assert.equal(isVersionNewer("v1.2.3", "1.2.2"), true);
  });

  it("returns false for unparseable versions", () => {
    assert.equal(isVersionNewer("", "0.7.2"), false);
    assert.equal(isVersionNewer("abc", "0.7.2"), false);
    assert.equal(isVersionNewer("1.0.0", ""), false);
  });
});

describe("syncMarketInstalledState", () => {
  const localScript = (marketId: string, version: string) => ({
    key: `user:market-${marketId}.js`,
    name: "Codex Live Token Cost",
    source: "user",
    enabled: true,
    status: "loaded",
    error: "",
    market_id: marketId,
    version,
    installed: true,
    source_url: "https://example.com/script.js",
    homepage: "",
  });

  const market = (version: string) => ({
    status: "ok",
    message: "ready",
    market: {
      status: "ok",
      message: "ready",
      indexUrl: "https://example.com/index.json",
      updatedAt: "",
      scripts: [
        {
          id: "codex-live-token-cost",
          name: "Codex Live Token Cost",
          description: "",
          version,
          author: "",
          tags: [],
          homepage: "",
          script_url: "https://example.com/script.js",
          sha256: "",
          installed: false,
          installedVersion: "",
          updateAvailable: false,
        },
      ],
    },
    user_scripts: { enabled: true, scripts: [] },
  });

  it("shows the on-disk version as installed and does not flag locally newer files", () => {
    const result = syncMarketInstalledState(market("0.7.2"), {
      enabled: true,
      scripts: [localScript("codex-live-token-cost", "1.0.0")],
    });
    const script = result?.market.scripts[0];
    assert.equal(script?.installed, true);
    assert.equal(script?.installedVersion, "1.0.0");
    assert.equal(script?.updateAvailable, false);
  });

  it("flags an update when the market version is newer than the installed file", () => {
    const result = syncMarketInstalledState(market("1.1.0"), {
      enabled: true,
      scripts: [localScript("codex-live-token-cost", "1.0.0")],
    });
    assert.equal(result?.market.scripts[0].updateAvailable, true);
  });

  it("keeps a script uninstalled when no local script matches", () => {
    const result = syncMarketInstalledState(market("1.1.0"), {
      enabled: true,
      scripts: [],
    });
    const script = result?.market.scripts[0];
    assert.equal(script?.installed, false);
    assert.equal(script?.installedVersion, "");
    assert.equal(script?.updateAvailable, false);
  });

  it("passes through a null market result", () => {
    assert.equal(syncMarketInstalledState(null, { enabled: true, scripts: [] }), null);
  });
});
