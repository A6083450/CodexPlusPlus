import assert from "node:assert/strict";
import { test } from "node:test";
import { imageGenerationUsesProxy } from "../ui/model-routes.ts";

test("image routing follows the provider protocol, opt-out and configured model list", () => {
  const profile = {
    protocol: "responses", relayMode: "pureApi", officialMixApiKey: false,
    model: "gpt-6-sol", modelList: "gpt-6-sol\n GPT-IMAGE-2.5-FLARE ",
  };
  assert.equal(imageGenerationUsesProxy(profile), true);
  assert.equal(imageGenerationUsesProxy({ ...profile, model: "gpt-image-2", modelList: "" }), true);
  assert.equal(imageGenerationUsesProxy({ ...profile, modelList: "" }), false);
  assert.equal(imageGenerationUsesProxy({ ...profile, protocol: "chatCompletions" }), false);
  assert.equal(imageGenerationUsesProxy({ ...profile, imageGenerationProxy: false }), false);
  assert.equal(imageGenerationUsesProxy({ ...profile, relayMode: "official" }), false);
  assert.equal(imageGenerationUsesProxy({ ...profile, relayMode: "official", officialMixApiKey: true }), true);
});
