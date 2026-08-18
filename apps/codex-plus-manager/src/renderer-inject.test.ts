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
  });

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
});
