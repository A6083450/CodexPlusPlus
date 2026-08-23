import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function loadCodexPlusTriggerClassNormalizer(renderer: string) {
  const normalizedRenderer = renderer.replace(/\r\n/g, "\n");
  const start = normalizedRenderer.indexOf("  function normalizeCodexPlusTriggerClassName");
  const end = normalizedRenderer.indexOf("\n\n  function configureCodexPlusTrigger", start);
  assert.ok(start >= 0 && end > start, "Codex++ trigger class normalizer should exist");

  const source = normalizedRenderer.slice(start, end).trim();
  return vm.runInNewContext(`(${source})`) as (className: string) => string;
}

function loadNativeMenuInsertionBefore(renderer: string) {
  const normalizedRenderer = renderer.replace(/\r\n/g, "\n");
  const start = normalizedRenderer.indexOf("  function nativeMenuInsertionBefore(");
  const end = normalizedRenderer.indexOf("\n\n  function findNativeMenuInsertionPoint", start);
  assert.ok(start >= 0 && end > start, "native menu insertion anchor helper should exist");

  const source = normalizedRenderer.slice(start, end).trim();
  return vm.runInNewContext(`(${source})`) as (
    children: Array<{ id?: string }>,
    menu: { id?: string },
  ) => { id?: string } | null;
}

type FakeElementOptions = {
  className?: string;
  dismissLabel?: string;
  hasProgress?: boolean;
  styleDisplay?: string;
};

class FakeElement {
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  style: { display: string };
  private readonly className: string;
  private readonly dismissLabel: string;
  private readonly hasProgress: boolean;

  constructor(options: FakeElementOptions = {}) {
    this.className = options.className ?? "";
    this.dismissLabel = options.dismissLabel ?? "";
    this.hasProgress = options.hasProgress ?? false;
    this.style = { display: options.styleDisplay ?? "" };
  }

  appendChild(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
  }

  getAttribute(name: string) {
    return name === "aria-label" ? this.dismissLabel : null;
  }

  matches(selector: string) {
    return selector === "div.w-full" && this.className.split(/\s+/).includes("w-full");
  }

  querySelector(selector: string) {
    return selector === 'progress[max="100"]' && this.hasProgress ? new FakeElement() : null;
  }

  querySelectorAll(selector: string) {
    return selector === "button" && this.dismissLabel ? [this] : [];
  }
}

function usageAlertRuntime(renderer: string, cards: FakeElement[], managed: FakeElement[]) {
  const start = renderer.indexOf("  function officialUsageAlertHidden(");
  const end = renderer.indexOf("\n  let zedRemoteStatusPromise", start);
  assert.ok(start >= 0 && end > start);
  const source = renderer.slice(start, end);
  const selectors: string[] = [];
  const document = {
    querySelectorAll(selector: string) {
      selectors.push(selector);
      return selector === '[data-codex-plus-usage-alert-hidden="true"]'
        ? managed.filter((node) => node.dataset.codexPlusUsageAlertHidden === "true")
        : cards;
    },
  };
  const windowValue: Record<string, unknown> = {};
  const create = new Function(
    "window",
    "document",
    "HTMLElement",
    `${source}\nreturn { officialUsageAlertHidden, refreshOfficialUsageAlertVisibility };`,
  ) as (
    windowValue: Record<string, unknown>,
    documentValue: typeof document,
    elementType: typeof FakeElement,
  ) => {
    officialUsageAlertHidden: () => boolean;
    refreshOfficialUsageAlertVisibility: () => void;
  };
  return { runtime: create(windowValue, document, FakeElement), selectors, windowValue };
}

function installRendererStyle(renderer: string) {
  const start = renderer.indexOf("  function installStyle()");
  const end = renderer.indexOf("\n  function defaultCodexPlusSettings", start);
  assert.ok(start >= 0 && end > start);
  const source = renderer.slice(start, end);
  const requiredNames = new Set([
    "styleId",
    "codexDeleteStyleVersion",
    ...Array.from(source.matchAll(/\$\{([A-Za-z_$][A-Za-z0-9_$]*)/g), (match) => match[1]),
  ]);
  const declarations = Array.from(requiredNames, (name) => {
    const declaration = renderer.match(new RegExp(`^  const ${name} = .+;$`, "m"))
      ?? renderer.match(new RegExp(`^  const ${name} = [\\s\\S]*?^  };$`, "m"));
    assert.ok(declaration, `missing renderer declaration for ${name}`);
    return declaration[0];
  }).join("\n");
  const appended: Array<{ dataset: Record<string, string>; id?: string; textContent?: string }> = [];
  const document = {
    getElementById() {
      return null;
    },
    createElement() {
      return { dataset: {} };
    },
    documentElement: {
      appendChild(node: (typeof appended)[number]) {
        appended.push(node);
      },
    },
  };
  const install = new Function("document", `${declarations}\n${source}\ninstallStyle();`) as (documentValue: typeof document) => void;

  install(document);
  return appended;
}

describe("renderer injection header compatibility", () => {
  it("keeps the native menu after Today without competing insertion anchors", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const insertionBefore = loadNativeMenuInsertionBefore(renderer);
    const today = { id: "codex-live-token-cost-settings" };
    const menu = { id: "codex-plus-menu" };
    const nativeButton = { id: "native-header-button" };

    assert.equal(insertionBefore([today, menu], menu), null);
    assert.equal(insertionBefore([menu, today], menu), null);
    assert.equal(insertionBefore([today, menu, nativeButton], menu), nativeButton);
    assert.equal(insertionBefore([menu, today, nativeButton], menu), nativeButton);
    assert.match(renderer, /nativeMenuInsertionBefore\(Array\.from\(headerActionSlot\.children/);
    assert.match(renderer, /const todayButton = menuBarChildren\.find/);
    assert.match(renderer, /function setCodexPlusTriggerLabel\(trigger\)/);
    assert.match(renderer, /function ensureCodexPlusTriggerIndicator\(trigger\)/);
  });

  it("adds the session copy shortcut through the native fork action", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    assert.match(renderer, /原地复制会话 - Codex\+\+/);
    assert.match(renderer, /createSessionMoreMenuItem\("原地复制会话 - Codex\+\+"/);
    assert.match(renderer, /getAttribute\("aria-label"\)[\s\S]*聊天操作/);
    assert.match(renderer, /从这里创建聊天分支/);
    assert.match(renderer, /data-app-action-sidebar-thread-selected/);
    assert.match(renderer, /sessionCopyMenuActivationTimeoutMs/);
    assert.doesNotMatch(renderer, /\n\s*refreshSessionCopyMenuItems\(\);/);
  });

  it("adds an encrypted session sharing button to the active Codex conversation", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    assert.match(renderer, /sessionShareButtonClass\s*=\s*"codex-session-share-button"/);
    assert.match(renderer, /function installSessionShareButton\(\)/);
    assert.match(renderer, /function sessionShareMarkdown\(\)/);
    assert.match(renderer, /crypto\.subtle\.generateKey\(\{ name: "AES-GCM", length: 256 \}/);
    assert.match(renderer, /https:\/\/share\.codexpp\.cc/);
    assert.match(renderer, /postJson\("\/share\/create", payload\)/);
    assert.match(renderer, /postJson\("\/session\/export"/);
    assert.match(renderer, /postJson\("\/session\/import"/);
    assert.match(renderer, /codex-rollout/);
    assert.match(renderer, /function sessionImportMarkdown\(session\)/);
    assert.match(renderer, /codexpp-import-session/);
    assert.match(renderer, /nativeShare\?\.closest\?\.\("\.ms-auto"\)/);
    assert.match(renderer, /#k=\$\{encrypted\.key\}/);
    assert.match(renderer, /navigator\.clipboard\.writeText\(shareUrl\)/);
    assert.match(renderer, /data-testid\*=\"message\"/);
    assert.match(renderer, /function sessionActionTrigger\(row\)/);
    assert.match(renderer, /const sessionMenuEnabled = codexPlusBackendSettings\.enhancementsEnabled !== false/);
    assert.doesNotMatch(renderer, /window\.location\.(?:href|assign)\s*=\s*[^;]*markdown/);
  });

  it("automatically renames a session through the native title suggestion", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    assert.match(renderer, /自动重命名当前会话/);
    assert.match(renderer, /activateSessionAutoRenameMenuItem/);
    assert.match(renderer, /input\[aria-label="聊天标题"\], input\[aria-label="Chat title"\]/);
    assert.match(renderer, /button\.classList\.contains\("text-info"\)/);
    assert.match(renderer, /\^\(保存\|Save\)\$/);
    assert.match(renderer, /Codex 未能生成新名称/);
  });

  it("does not install Codex++ UI in embedded browser documents", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    assert.match(renderer, /window\.top\s*!==\s*window/);
    assert.match(renderer, /!window\.electronBridge/);
    assert.ok(renderer.includes("/^app:\\\/\\\/\\-\\//i.test(window.location.href)"));
    assert.match(renderer, /codexPlusIsNodeTestHarness/);
  });

  it("initializes renderer styles without unresolved template identifiers", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    const appended = installRendererStyle(renderer);

    assert.equal(appended.length, 1);
    assert.match(appended[0].textContent ?? "", /\.codex-plus-modal-overlay/);
  });

  it("keeps the settings modal readable in explicit light and dark host themes", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const [style] = installRendererStyle(renderer);
    const css = style.textContent ?? "";

    assert.match(css, /html\.light[\s\S]*--codex-plus-bg-primary:[^;]*#fff/);
    assert.match(css, /html\.dark[\s\S]*--codex-plus-bg-primary:[^;]*#202020/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)[\s\S]*html:not\(\.light\):not\(\[data-theme="light"\]\)/);
    assert.match(css, /\.codex-plus-modal-content[\s\S]*background: var\(--codex-plus-bg-primary\)/);
    assert.match(css, /\.codex-plus-row-description[\s\S]*color: var\(--codex-plus-text-secondary\)/);
  });

  it("hides only the official usage alert and restores it without changing upstream styles", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const wrapper = new FakeElement({ className: "w-full", styleDisplay: "grid" });
    const usageAlert = new FakeElement({ dismissLabel: "Dismiss usage alert", hasProgress: true });
    const otherStatus = new FakeElement({ dismissLabel: "Dismiss sync status", hasProgress: true });
    wrapper.appendChild(usageAlert);
    const { runtime, selectors, windowValue } = usageAlertRuntime(renderer, [usageAlert, otherStatus], [wrapper]);

    windowValue.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ = true;
    runtime.refreshOfficialUsageAlertVisibility();

    assert.equal(wrapper.dataset.codexPlusUsageAlertHidden, "true");
    assert.equal(wrapper.style.display, "grid");
    assert.equal(otherStatus.dataset.codexPlusUsageAlertHidden, undefined);
    assert.deepEqual(selectors, [
      '[data-codex-plus-usage-alert-hidden="true"]',
      'aside.app-shell-left-panel [role="status"][aria-live="polite"]',
    ]);

    windowValue.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ = false;
    runtime.refreshOfficialUsageAlertVisibility();

    assert.equal(wrapper.dataset.codexPlusUsageAlertHidden, undefined);
    assert.equal(wrapper.style.display, "grid");
    assert.equal(wrapper.children[0], usageAlert);
    assert.equal(selectors.at(-1), '[data-codex-plus-usage-alert-hidden="true"]');
  });

  it("refreshes active-profile usage alert settings through the existing backend heartbeat", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

    assert.match(renderer, /typeof nextStatus\.hideOfficialUsageAlert === "boolean"/);
    assert.match(renderer, /window\.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ = nextStatus\.hideOfficialUsageAlert/);
    assert.match(renderer, /\[data-codex-plus-usage-alert-hidden="true"\] \{ display: none !important; \}/);
    assert.doesNotMatch(renderer, /container\.style\.(?:setProperty|removeProperty)\("display"/);
  });

  it("keeps the Codex++ trigger pill-shaped across checkout line endings", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const lfRenderer = renderer.replace(/\r\n/g, "\n");

    for (const source of [lfRenderer, lfRenderer.replace(/\n/g, "\r\n")]) {
      const normalize = loadCodexPlusTriggerClassNormalizer(source);
      const classNames = normalize("flex h-7 rounded-lg rounded-l-none border-l-0 px-1.5").split(/\s+/);

      assert.ok(classNames.includes("rounded-full"));
      assert.ok(!classNames.includes("rounded-lg"));
      assert.ok(!classNames.includes("rounded-l-none"));
    }
  });

  it("keeps Windows Dream Skin compatible with the modern Codex main surface", async () => {
    const windowsRenderers = await Promise.all([
      readFile(new URL("../../../assets/inject/upstream/dream-skin/windows/renderer-inject.js", import.meta.url), "utf8"),
      readFile(new URL("../../../assets/inject/upstream/cidala-tiger/windows/renderer-inject.js", import.meta.url), "utf8"),
    ]);

    for (const renderer of windowsRenderers) {
      assert.match(renderer, /MainContentSurface/);
      assert.match(renderer, /data-codex-plus-dream-surface/);
      assert.match(renderer, /ensureShellMain/);
    }
  });
});
