import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("about screen displays and opens the fork repository", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const about = source.slice(source.indexOf("function AboutScreen("));
  assert.match(about, /label=\{t\("项目地址"\)\} value="github\.com\/A6083450\/CodexPlusPlus"/);
  assert.match(about, /openExternalUrl\("https:\/\/github\.com\/A6083450\/CodexPlusPlus"\)/);
});
