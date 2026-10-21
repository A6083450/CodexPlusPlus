import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import vm from "node:vm";

async function discovery(urls: string[] = []) {
  const text = await readFile(new URL("../../../assets/inject/renderer-inject/20-menu.js", import.meta.url), "utf8");
  const source = text.slice(text.indexOf("  function appServerFallbackAssetUrls()"),
    text.indexOf("  async function loadAppServerRequestModules()"));
  return vm.runInNewContext(`(() => {${source}; return { appServerFallbackAssetUrls, collectAppServerRequestCandidatesFromModule };})()`, {
    Map, codexAppAssetCandidateUrls: () => urls,
  });
}

it("does not import application entrypoints while discovering request clients", async () => {
  const urls = [
    "app://-/assets/app-initial-current.js",
    "app://-/assets/app-main-current.js",
    "app://-/assets/page-chatgpt-current.js",
    "app://-/assets/use-host-config-current.js",
    "app://-/assets/app-server-manager-signals-current.js",
  ];
  const api = await discovery(urls);
  assert.deepEqual(Array.from(api.appServerFallbackAssetUrls()), urls.slice(3));
});

it("discovers stored clients without invoking unrelated store reads or getters", async () => {
  let reads = 0;
  const direct = { sendRequest() {} };
  const nested = { sendRequest() {} };
  const mapped = { sendRequest() {} };
  const defaultClient = { sendRequest() {} };
  const unrelated = {
    get() { reads += 1; return {}; },
    get initializeQuery() { reads += 1; return {}; },
  };
  const api = await discovery();
  const clients = api.collectAppServerRequestCandidatesFromModule({
    direct, wrapper: { nested }, localClients: new Map([["local", mapped], [undefined, defaultClient]]), unrelated,
  });
  assert.equal(reads, 0, "probing module exports must not initialize native state or queries");
  assert.ok(clients.includes(direct));
  assert.ok(clients.includes(nested));
  assert.ok(clients.includes(mapped));
  assert.ok(clients.includes(defaultClient));
});
