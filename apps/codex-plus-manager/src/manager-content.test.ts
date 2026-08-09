import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

const managerRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
let vite: ViteDevServer;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: path.join(managerRoot, "vite.config.ts"),
    root: managerRoot,
    server: { middlewareMode: true },
  });
});

after(async () => {
  await vite.close();
});

test("管理工具概览和导航不展示赞助或推荐内容", async () => {
  const { App } = await vite.ssrLoadModule("/src/App.tsx");
  const html = renderToStaticMarkup(React.createElement(App));

  assert.doesNotMatch(html, /项目赞助商|JOJO Code/);
  assert.doesNotMatch(html, />推荐内容</);
});
