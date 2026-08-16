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

const TOKEN_COST_BEGIN = "  // TOKEN_COST_BEGIN";
const TOKEN_COST_END = "  // TOKEN_COST_END";
const ACCOUNT_TRIGGER_SELECTOR =
  "button[aria-label='打开个人资料菜单'], button[aria-label='Open profile menu'], button[aria-label='Open profile menu and settings']";
const PROFILE_ENTRY_SELECTOR = "[data-codex-plus-token-cost-profile-entry]";

type Listener = (event: FakeTokenCostEvent) => unknown;

class FakeTokenCostEvent {
  defaultPrevented = false;
  propagationStopped = false;
  readonly type: string;
  readonly options: { detail?: unknown; target?: FakeTokenCostNode; key?: string };

  constructor(type: string, options: { detail?: unknown; target?: FakeTokenCostNode; key?: string } = {}) {
    this.type = type;
    this.options = options;
  }

  get detail() {
    return this.options.detail;
  }

  get target() {
    return this.options.target;
  }

  get key() {
    return this.options.key;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

class FakeTokenCostCustomEvent extends FakeTokenCostEvent {
  constructor(type: string, options: { detail?: unknown } = {}) {
    super(type, options);
  }
}

class FakeTokenCostNode {
  readonly attributes = new Map<string, string>();
  readonly menuItems: FakeTokenCostNode[] = [];
  readonly closestMatches = new Map<string, FakeTokenCostNode>();
  closestCalls: string[] = [];
  closestMatch: FakeTokenCostNode | null = null;
  clickCount = 0;
  id = "";
  textContent = "";

  constructor(attributes: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
    this.id = attributes.id ?? "";
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
  }

  getAttribute(name: string) {
    return name === "id" ? this.id || null : this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  closest(selector: string) {
    this.closestCalls.push(selector);
    return this.closestMatches.get(selector) ?? this.closestMatch;
  }

  click() {
    this.clickCount += 1;
  }

  querySelectorAll(selector: string) {
    assert.equal(selector, "[role='menuitem']");
    return this.menuItems;
  }
}

class FakeTokenCostDocument {
  readonly listeners = new Map<string, Listener[]>();
  readonly nodes = new Map<string, FakeTokenCostNode>();
  readonly dispatched: FakeTokenCostEvent[] = [];
  getElementByIdCalls: string[] = [];

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  dispatchEvent(event: FakeTokenCostEvent) {
    this.dispatched.push(event);
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
    return !event.defaultPrevented;
  }

  getElementById(id: string) {
    this.getElementByIdCalls.push(id);
    return this.nodes.get(id) ?? null;
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.length ?? 0;
  }
}

type TokenCostBridgeCall = { path: string; payload: unknown };
type TokenCostLifecycleDetail = {
  route: string;
  reason: string;
  profile: boolean;
  profileMenuId: string;
};

type TokenCostRuntime = {
  window: Record<string, any>;
  document: FakeTokenCostDocument;
  location: { pathname: string; search: string; hash: string };
  bridgeCalls: TokenCostBridgeCall[];
  pendingFrames: Map<number, () => void>;
  cancelledFrames: number[];
  api: {
    eventFromAppServer: (method: string, params: unknown) => any;
    forwardIfEnabled: (method: string, params: unknown) => any;
    dispatchMessage: (dispatcher: any, type: string, payload: unknown) => unknown;
    emitLifecycle: (reason: string, profile?: boolean, profileMenuId?: string) => boolean;
    emitNavigationLifecycle: () => boolean;
    state: () => any;
  };
  flushFrames: () => void;
};

function sourceFunction(renderer: string, name: string, nextName: string) {
  const start = renderer.indexOf(`  function ${name}(`);
  const end = renderer.indexOf(`\n\n  function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} should exist before ${nextName}`);
  return renderer.slice(start, end);
}

function tokenCostBlock(renderer: string) {
  const start = renderer.indexOf(TOKEN_COST_BEGIN);
  const end = renderer.indexOf(TOKEN_COST_END, start);
  assert.ok(start >= 0 && end > start, "renderer should contain one bounded TOKEN_COST block");
  assert.equal(renderer.indexOf(TOKEN_COST_BEGIN, start + TOKEN_COST_BEGIN.length), -1);
  assert.equal(renderer.indexOf(TOKEN_COST_END, end + TOKEN_COST_END.length), -1);
  return renderer.slice(start, end + TOKEN_COST_END.length);
}

async function createTokenCostRuntime(options: { rejectBridge?: boolean } = {}): Promise<TokenCostRuntime> {
  const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
  const block = tokenCostBlock(renderer);
  const dispatch = sourceFunction(renderer, "dispatchCodexPlusMessage", "objectGlobalState");
  const document = new FakeTokenCostDocument();
  const location = { pathname: "/thread/one", search: "?mode=work", hash: "#tail" };
  const bridgeCalls: TokenCostBridgeCall[] = [];
  const pendingFrames = new Map<number, () => void>();
  const cancelledFrames: number[] = [];
  let nextFrame = 1;
  const windowValue: Record<string, any> = { __CODEX_PLUS_TEST_SERVICE_TIER__: true };
  const postJson = (path: string, payload: unknown) => {
    bridgeCalls.push({ path, payload: structuredClone(payload) });
    return options.rejectBridge ? Promise.reject(new Error("bridge unavailable")) : Promise.resolve({ status: "ok" });
  };
  const factory = new Function(
    "window",
    "document",
    "location",
    "CustomEvent",
    "TextEncoder",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "postJson",
    "codexServiceTierRequestOverride",
    "observeCodexRemoteSessionNotification",
    `${block}\n${dispatch}\nreturn {\n` +
      "  eventFromAppServer: tokenCostEventFromAppServer,\n" +
      "  forwardIfEnabled: tokenCostForwardAppServerEventIfEnabled,\n" +
      "  dispatchMessage: dispatchCodexPlusMessage,\n" +
      "  emitLifecycle: tokenCostEmitLifecycle,\n" +
      "  emitNavigationLifecycle: tokenCostEmitNavigationLifecycle,\n" +
      "  state: tokenCostTestState,\n" +
      "};",
  ) as (...args: any[]) => TokenCostRuntime["api"];
  const api = factory(
    windowValue,
    document,
    location,
    FakeTokenCostCustomEvent,
    TextEncoder,
    (callback: () => void) => {
      const id = nextFrame++;
      pendingFrames.set(id, callback);
      return id;
    },
    (id: number) => {
      cancelledFrames.push(id);
      pendingFrames.delete(id);
    },
    postJson,
    (message: unknown) => message,
    () => false,
  );
  return {
    window: windowValue,
    document,
    location,
    bridgeCalls,
    pendingFrames,
    cancelledFrames,
    api,
    flushFrames() {
      const frames = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const frame of frames) frame();
    },
  };
}

function baseAppServerParams(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    eventId: "host-event-1",
    correlationId: "correlation-1",
    occurredAtMs: 1_000,
    itemId: "item-1",
    model: "gpt-5.6-sol",
    serviceTier: "priority",
    ...overrides,
  };
}

function lifecycleDetails(runtime: TokenCostRuntime): TokenCostLifecycleDetail[] {
  return runtime.document.dispatched
    .filter((event) => event.type === "codex-plus:token-cost-lifecycle")
    .map((event) => structuredClone(event.detail) as TokenCostLifecycleDetail);
}

function activate(runtime: TokenCostRuntime, instanceId = "page-1") {
  runtime.window.__codexLiveTokenCostCaptureV1 = { enabled: true, instanceId };
  runtime.document.dispatchEvent(new FakeTokenCostCustomEvent("codex-plus:token-cost-activate", {
    detail: { instanceId },
  }));
}

function triggerNode(label: string, buttonId = "profile-trigger", menuId = "profile-menu") {
  const button = new FakeTokenCostNode({
    id: buttonId,
    "aria-label": label,
    "aria-controls": menuId,
  });
  button.closestMatch = button;
  return button;
}

function validMenu(button: FakeTokenCostNode, menuId = button.getAttribute("aria-controls")!) {
  const menu = new FakeTokenCostNode({
    id: menuId,
    role: "menu",
    "aria-labelledby": button.id,
  });
  const identity = new FakeTokenCostNode({ role: "menuitem", "aria-disabled": "true", "data-disabled": "" });
  identity.textContent = "Account";
  const settings = new FakeTokenCostNode({ role: "menuitem" });
  settings.textContent = "设置";
  menu.menuItems.push(identity, settings);
  return menu;
}

describe("renderer token-cost AppServer allowlist", () => {
  it("does no token-cost work while capture is disabled and keeps dispatcher behavior", async () => {
    const runtime = await createTokenCostRuntime();
    let touched = 0;
    const params = new Proxy({}, {
      get() {
        touched += 1;
        return undefined;
      },
      ownKeys() {
        touched += 1;
        return [];
      },
    });
    assert.equal(runtime.api.forwardIfEnabled("turn/started", params), null);
    assert.equal(touched, 0);
    assert.equal(runtime.bridgeCalls.length, 0);
    assert.equal(runtime.api.state().turns, 0);

    const originalCalls: unknown[][] = [];
    const dispatcher = {
      __codexServiceTierOriginalDispatchMessage(...args: unknown[]) {
        originalCalls.push(args);
        return "original-result";
      },
    };
    const payload = { untouched: true };
    assert.equal(runtime.api.dispatchMessage(dispatcher, "unknown/method", payload), "original-result");
    assert.deepEqual(originalCalls, [["unknown/method", payload]]);
    assert.equal(runtime.bridgeCalls.length, 0);
    assert.equal(runtime.document.listenerCount("click"), 0);
    assert.equal(runtime.document.listenerCount("keydown"), 0);
  });

  it("normalizes every allowed event variant from direct documented fields", async () => {
    const runtime = await createTokenCostRuntime();
    const started = runtime.api.eventFromAppServer("turn/started", baseAppServerParams());
    assert.deepEqual(structuredClone(started), {
      type: "turn_started",
      meta: {
        source: "renderer",
        session_id: "thread-1",
        turn_id: "turn-1",
        event_id: "host-event-1",
        correlation_id: "correlation-1",
        occurred_at_ms: 1_000,
      },
      model: "gpt-5.6-sol",
      fast: true,
    });

    const first = runtime.api.eventFromAppServer("item/agentMessage/delta", baseAppServerParams({
      eventId: undefined,
      delta: "a你",
    }));
    const second = runtime.api.eventFromAppServer("item/reasoning/summary_text_delta", baseAppServerParams({
      eventId: undefined,
      itemId: undefined,
      item: { id: "reasoning-1" },
      delta: "bc",
    }));
    assert.equal(first.type, "output_delta");
    assert.equal(first.estimated_output_tokens, 1);
    assert.equal(second.estimated_output_tokens, 2);
    assert.notEqual(first.meta.event_id, second.meta.event_id);
    assert.ok(first.meta.event_id.length <= 160);

    const toolStarted = runtime.api.eventFromAppServer("item/started", baseAppServerParams({
      item: { id: "call-1", type: "command_execution", name: "shell" },
    }));
    const toolCompleted = runtime.api.eventFromAppServer("item/completed", baseAppServerParams({
      item: { id: "call-1", type: "command-execution", name: "shell" },
    }));
    assert.deepEqual(structuredClone(toolStarted), {
      type: "tool_started",
      meta: started.meta,
      call_id: "call-1",
      name: "shell",
    });
    assert.deepEqual(structuredClone(toolCompleted), {
      type: "tool_completed",
      meta: started.meta,
      call_id: "call-1",
    });

    const usage = runtime.api.eventFromAppServer("thread/tokenUsage/updated", baseAppServerParams({
      usage: { inputTokens: 40, cachedInputTokens: 10, cacheWriteTokens: 2, outputTokens: 8 },
    }));
    assert.deepEqual(structuredClone(usage), {
      type: "usage",
      meta: started.meta,
      usage: { input: 40, cached_input: 10, cache_write: 2, output: 8 },
      exact: true,
    });

    const completed = runtime.api.eventFromAppServer("turn/completed", baseAppServerParams({
      status: "completed",
      usage: { input: 40, cached_input: 10, cache_write: 2, output: 8 },
    }));
    assert.deepEqual(structuredClone(completed), {
      type: "turn_completed",
      meta: started.meta,
      usage: { input: 40, cached_input: 10, cache_write: 2, output: 8 },
    });

    const failed = runtime.api.eventFromAppServer("turn/completed", baseAppServerParams({ status: "cancelled" }));
    assert.deepEqual(structuredClone(failed), { type: "turn_failed", meta: started.meta });
    assert.equal(runtime.api.state().turns, 0);
    assert.doesNotMatch(JSON.stringify(runtime.api.state()), /a你|bc/);
  });

  it("accepts only fixed direct camel/snake fields and fixed tool types", async () => {
    const runtime = await createTokenCostRuntime();
    const snake = runtime.api.eventFromAppServer("turn/started", {
      thread_id: "thread-snake",
      turn_id: "turn-snake",
      event_id: "event-snake",
      correlation_id: "correlation-snake",
      occurred_at_ms: 2_000,
      model: "gpt-5.5",
      fast_mode: false,
    });
    assert.equal(snake.meta.session_id, "thread-snake");
    assert.equal(snake.fast, false);
    assert.equal(runtime.api.eventFromAppServer("item/reasoning/summary_text_delta", {
      thread_id: "thread-snake",
      turn_id: "turn-snake",
      correlation_id: "correlation-snake",
      occurred_at_ms: 2_001,
      item_id: "reasoning-snake",
      delta: "snake",
    })?.type, "output_delta");

    const types = ["toolCall", "commandExecution", "fileChange", "webSearch", "computer", "imageGeneration"];
    for (const [index, type] of types.entries()) {
      const event = runtime.api.eventFromAppServer("item/started", {
        ...baseAppServerParams({ turnId: "turn-snake" }),
        item: { id: `call-${index}`, type, name: `tool-${index}` },
      });
      assert.equal(event?.type, "tool_started", type);
    }
    for (const type of ["TOOL_CALL", "command-execution", "file_change", "web-search", "COMPUTER", "image_generation"]) {
      assert.equal(runtime.api.eventFromAppServer("item/completed", {
        ...baseAppServerParams({ turnId: "turn-snake" }),
        item: { id: `call-${type}`, type },
      })?.type, "tool_completed", type);
    }

    const toolOne = runtime.api.eventFromAppServer("item/started", baseAppServerParams({
      eventId: undefined,
      item: { id: "call-one", type: "toolCall", name: "first" },
    }));
    const toolTwo = runtime.api.eventFromAppServer("item/started", baseAppServerParams({
      eventId: undefined,
      item: { id: "call-two", type: "toolCall", name: "second" },
    }));
    const toolOneDuplicate = runtime.api.eventFromAppServer("item/started", baseAppServerParams({
      eventId: undefined,
      item: { id: "call-one", type: "toolCall", name: "first" },
    }));
    assert.notEqual(toolOne.meta.event_id, toolTwo.meta.event_id);
    assert.equal(toolOne.meta.event_id, toolOneDuplicate.meta.event_id);

    const usageOne = runtime.api.eventFromAppServer("thread/tokenUsage/updated", baseAppServerParams({
      eventId: undefined,
      usage: { input: 10, output: 1 },
    }));
    const usageTwo = runtime.api.eventFromAppServer("thread/tokenUsage/updated", baseAppServerParams({
      eventId: undefined,
      usage: { input: 10, output: 2 },
    }));
    const usageTwoDuplicate = runtime.api.eventFromAppServer("thread/tokenUsage/updated", baseAppServerParams({
      eventId: undefined,
      usage: { input: 10, output: 2 },
    }));
    assert.notEqual(usageOne.meta.event_id, usageTwo.meta.event_id);
    assert.equal(usageTwo.meta.event_id, usageTwoDuplicate.meta.event_id);
  });

  it("rejects unknown, nested, unsafe, missing, and oversized values", async () => {
    const runtime = await createTokenCostRuntime();
    runtime.api.eventFromAppServer("turn/started", baseAppServerParams());
    const invalid = [
      ["unknown/method", baseAppServerParams()],
      ["turn/started", { payload: baseAppServerParams() }],
      ["turn/started", baseAppServerParams({ threadId: "" })],
      ["turn/started", baseAppServerParams({ turnId: "x".repeat(161) })],
      ["turn/started", baseAppServerParams({ model: undefined })],
      ["turn/started", baseAppServerParams({ model: "界".repeat(43) })],
      ["turn/started", baseAppServerParams({ occurredAtMs: -1 })],
      ["item/agentMessage/delta", baseAppServerParams({ delta: { text: "hidden" } })],
      ["item/agentMessage/delta", baseAppServerParams({ itemId: undefined, delta: "missing-item" })],
      ["item/agentMessage/delta", baseAppServerParams({ itemId: undefined, payload: { itemId: "nested" }, delta: "nested-item" })],
      ["item/reasoning/summary_text_delta", baseAppServerParams({ itemId: "x".repeat(161), delta: "oversized-item" })],
      ["item/reasoning/summary_text_delta", baseAppServerParams({ itemId: undefined, item: { id: "x".repeat(161) }, delta: "oversized-item" })],
      ["item/started", baseAppServerParams({ item: { id: "call", type: "unknown", name: "tool" } })],
      ["item/started", baseAppServerParams({ item: { id: "call", type: "toolCall" } })],
      ["item/started", baseAppServerParams({ item: { id: "x".repeat(161), type: "toolCall", name: "tool" } })],
      ["item/started", baseAppServerParams({ item: { id: "call", type: "toolCall", name: "界".repeat(43) } })],
      ["thread/tokenUsage/updated", baseAppServerParams({ usage: { input: -1, output: 1 } })],
      ["thread/tokenUsage/updated", baseAppServerParams({ usage: { input: 1.5, output: 1 } })],
      ["thread/tokenUsage/updated", baseAppServerParams({ usage: { input: "1", output: 1 } })],
      ["thread/tokenUsage/updated", baseAppServerParams({ usage: { input: 1, cachedInput: 2, output: 1 } })],
      ["thread/tokenUsage/updated", baseAppServerParams({ usage: { input: Number.MAX_SAFE_INTEGER, output: 1 } })],
      ["thread/tokenUsage/updated", baseAppServerParams({ usage: null, input: 1, output: 1 })],
      ["thread/tokenUsage/updated", baseAppServerParams({ payload: { usage: { input: 1, output: 1 } } })],
      ["turn/completed", baseAppServerParams({ status: "mysterious" })],
    ] as const;
    for (const [method, params] of invalid) {
      assert.equal(runtime.api.eventFromAppServer(method, params), null, `${method}: ${JSON.stringify(params)}`);
    }

    const completionRuntime = await createTokenCostRuntime();
    completionRuntime.api.eventFromAppServer("turn/started", baseAppServerParams({ turnId: "still-active" }));
    assert.equal(completionRuntime.api.state().turns, 1);
    assert.equal(completionRuntime.api.eventFromAppServer("turn/completed", baseAppServerParams({
      turnId: "still-active",
      status: "completed",
      usage: { input: 1, cachedInput: 2, output: 1 },
    })), null);
    assert.equal(completionRuntime.api.state().turns, 1, "an invalid completion must not mutate active-turn state");

    activate(runtime);
    const throwingParams = Object.defineProperty({}, "threadId", {
      get() {
        throw new Error("sensitive getter");
      },
    });
    assert.doesNotThrow(() => runtime.api.forwardIfEnabled("turn/started", throwingParams));
    assert.equal(runtime.bridgeCalls.length, 0);
  });

  it("keeps cumulative delta counters isolated and bounded without retaining text", async () => {
    const runtime = await createTokenCostRuntime();
    for (let index = 0; index < 257; index += 1) {
      runtime.api.eventFromAppServer("turn/started", baseAppServerParams({
        threadId: `thread-${index}`,
        turnId: `turn-${index}`,
        eventId: `event-${index}`,
      }));
    }
    assert.equal(runtime.api.state().turns, 256);

    runtime.api.eventFromAppServer("turn/started", baseAppServerParams({ threadId: "s-a", turnId: "t-a" }));
    runtime.api.eventFromAppServer("turn/started", baseAppServerParams({ threadId: "s-b", turnId: "t-b" }));
    const a = runtime.api.eventFromAppServer("item/agentMessage/delta", baseAppServerParams({
      threadId: "s-a", turnId: "t-a", delta: "12345", eventId: undefined,
    }));
    const b = runtime.api.eventFromAppServer("item/agentMessage/delta", baseAppServerParams({
      threadId: "s-b", turnId: "t-b", delta: "你", eventId: undefined,
    }));
    assert.equal(a.estimated_output_tokens, 2);
    assert.equal(b.estimated_output_tokens, 1);
    assert.equal(runtime.api.state().turns, 256);
    assert.doesNotMatch(JSON.stringify(runtime.api.state()), /12345|你/);

    const maxId = `${"界".repeat(53)}a`;
    runtime.api.eventFromAppServer("turn/started", baseAppServerParams({
      threadId: maxId,
      turnId: maxId,
      eventId: undefined,
    }));
    const maxFirst = runtime.api.eventFromAppServer("item/agentMessage/delta", baseAppServerParams({
      threadId: maxId, turnId: maxId, eventId: undefined, delta: "a",
    }));
    const maxSecond = runtime.api.eventFromAppServer("item/agentMessage/delta", baseAppServerParams({
      threadId: maxId, turnId: maxId, eventId: undefined, delta: "b",
    }));
    assert.notEqual(maxFirst.meta.event_id, maxSecond.meta.event_id);
    assert.match(maxFirst.meta.event_id, /^od:1:/);
    assert.match(maxSecond.meta.event_id, /^od:2:/);
    assert.ok(new TextEncoder().encode(maxSecond.meta.event_id).byteLength <= 160);

    const identityA = await createTokenCostRuntime();
    const identityB = await createTokenCostRuntime();
    identityA.api.eventFromAppServer("turn/started", baseAppServerParams());
    identityB.api.eventFromAppServer("turn/started", baseAppServerParams());
    const identityDeltaA = identityA.api.eventFromAppServer("item/agentMessage/delta", baseAppServerParams({
      eventId: undefined, itemId: "message-a", delta: "same",
    }));
    const identityDeltaB = identityB.api.eventFromAppServer("item/agentMessage/delta", baseAppServerParams({
      eventId: undefined, itemId: "message-b", delta: "same",
    }));
    assert.notEqual(identityDeltaA.meta.event_id, identityDeltaB.meta.event_id);
  });

  for (const [label, installThrowingCapture] of [
    ["capture global", (runtime: TokenCostRuntime) => {
      Object.defineProperty(runtime.window, "__codexLiveTokenCostCaptureV1", {
        configurable: true,
        get() {
          throw new Error("capture global getter");
        },
      });
    }],
    ["capture enabled", (runtime: TokenCostRuntime) => {
      runtime.window.__codexLiveTokenCostCaptureV1 = Object.defineProperty({}, "enabled", {
        get() {
          throw new Error("capture enabled getter");
        },
      });
    }],
    ["capture instanceId", (runtime: TokenCostRuntime) => {
      runtime.window.__codexLiveTokenCostCaptureV1 = Object.defineProperty({ enabled: true }, "instanceId", {
        get() {
          throw new Error("capture instance getter");
        },
      });
    }],
  ] as const) {
    it(`treats a throwing ${label} getter as disabled without changing dispatcher semantics`, async () => {
      const runtime = await createTokenCostRuntime();
      installThrowingCapture(runtime);
      const payload = { untouched: true };
      const originalCalls: unknown[][] = [];
      const dispatcher = {
        __codexServiceTierOriginalDispatchMessage(...args: unknown[]) {
          originalCalls.push(args);
          return "original-result";
        },
      };
      assert.equal(runtime.api.dispatchMessage(dispatcher, "unknown/method", payload), "original-result");
      assert.deepEqual(originalCalls, [["unknown/method", payload]]);

      const expectedError = new Error("original dispatcher failure");
      let errorCalls = 0;
      const errorArgs: unknown[][] = [];
      let caught: unknown;
      try {
        runtime.api.dispatchMessage({
          __codexServiceTierOriginalDispatchMessage(...args: unknown[]) {
            errorCalls += 1;
            errorArgs.push(args);
            throw expectedError;
          },
        }, "unknown/method", payload);
      } catch (error) {
        caught = error;
      }
      assert.equal(caught, expectedError);
      assert.equal(errorCalls, 1);
      assert.deepEqual(errorArgs, [["unknown/method", payload]]);
      assert.equal(runtime.bridgeCalls.length, 0);
      assert.deepEqual(lifecycleDetails(runtime), []);
      assert.deepEqual(structuredClone(runtime.api.state()), {
        active: false,
        turns: 0,
        accountListeners: 0,
        pendingFrame: 0,
      });
    });
  }

  it("forwards once without blocking or changing original dispatcher output", async () => {
    const runtime = await createTokenCostRuntime();
    activate(runtime);
    const calls: unknown[][] = [];
    const dispatcher = {
      __codexServiceTierOriginalDispatchMessage(...args: unknown[]) {
        calls.push(args);
        return { native: true };
      },
    };
    const params = baseAppServerParams();
    const result = runtime.api.dispatchMessage(dispatcher, "turn/started", params);
    assert.deepEqual(result, { native: true });
    assert.deepEqual(calls, [["turn/started", params]]);
    assert.equal(runtime.bridgeCalls.length, 1);
    assert.deepEqual(runtime.bridgeCalls[0], {
      path: "/token-cost/event",
      payload: { instance_id: "page-1", event: runtime.api.eventFromAppServer("turn/started", params) },
    });
    assert.equal(lifecycleDetails(runtime).at(-1)?.reason, "turn_started");

    const delta = baseAppServerParams({ eventId: undefined, delta: "secret delta text" });
    runtime.api.dispatchMessage(dispatcher, "item/agentMessage/delta", delta);
    assert.equal(runtime.bridgeCalls.length, 2);
    assert.equal(runtime.bridgeCalls[1].path, "/token-cost/event");
    assert.doesNotMatch(JSON.stringify(runtime.bridgeCalls[1]), /secret|delta text/);

    const rejecting = await createTokenCostRuntime({ rejectBridge: true });
    activate(rejecting);
    assert.doesNotThrow(() => rejecting.api.dispatchMessage(dispatcher, "turn/started", params));
    await Promise.resolve();
    assert.equal(rejecting.bridgeCalls.length, 1);
  });
});

describe("renderer token-cost lifecycle and account boundary", () => {
  it("installs fixed inert lifecycle listeners and coalesces activation/navigation", async () => {
    const runtime = await createTokenCostRuntime();
    assert.equal(runtime.document.listenerCount("codex-plus:token-cost-activate"), 1);
    assert.equal(runtime.document.listenerCount("codex-plus:token-cost-deactivate"), 1);
    assert.equal(runtime.document.listenerCount("click"), 0);
    assert.equal(runtime.document.listenerCount("keydown"), 0);

    let instanceReads = 0;
    runtime.window.__codexLiveTokenCostCaptureV1 = {
      enabled: false,
      get instanceId() {
        instanceReads += 1;
        return "page-1";
      },
    };
    runtime.document.dispatchEvent(new FakeTokenCostCustomEvent("codex-plus:token-cost-activate", {
      detail: { instanceId: "page-1" },
    }));
    assert.equal(instanceReads, 0);
    assert.deepEqual(lifecycleDetails(runtime), []);

    activate(runtime);
    activate(runtime);
    assert.deepEqual(lifecycleDetails(runtime), [{
      route: "/thread/one?mode=work#tail",
      reason: "activate",
      profile: false,
      profileMenuId: "",
    }]);
    assert.equal(runtime.document.listenerCount("click"), 1);
    assert.equal(runtime.document.listenerCount("keydown"), 1);

    assert.equal(runtime.api.emitNavigationLifecycle(), false);
    runtime.location.pathname = "/thread/two";
    assert.equal(runtime.api.emitNavigationLifecycle(), true);
    assert.equal(runtime.api.emitNavigationLifecycle(), false);
    assert.equal(lifecycleDetails(runtime).length, 2);
    assert.equal(lifecycleDetails(runtime)[1].reason, "navigation");

    runtime.api.forwardIfEnabled("turn/started", baseAppServerParams());
    runtime.api.forwardIfEnabled("turn/started", baseAppServerParams());
    assert.equal(lifecycleDetails(runtime).filter((detail) => detail.reason === "turn_started").length, 1);
    runtime.api.forwardIfEnabled("turn/completed", baseAppServerParams({ status: "completed" }));
    runtime.api.forwardIfEnabled("turn/completed", baseAppServerParams({ status: "completed" }));
    assert.equal(lifecycleDetails(runtime).filter((detail) => detail.reason === "turn_completed").length, 1);
  });

  for (const label of ["打开个人资料菜单", "Open profile menu", "Open profile menu and settings"]) {
    it(`emits one menu lifecycle for ${label} through one explicit frame`, async () => {
      const runtime = await createTokenCostRuntime();
      activate(runtime);
      const button = triggerNode(label, "trigger:[]#", "menu:[]#");
      runtime.document.nodes.set("menu:[]#", validMenu(button));
      const first = new FakeTokenCostEvent("click", { target: button });
      const second = new FakeTokenCostEvent("click", { target: button });
      runtime.document.dispatchEvent(first);
      runtime.document.dispatchEvent(second);
      assert.equal(runtime.pendingFrames.size, 1);
      assert.deepEqual(button.closestCalls, [
        `${PROFILE_ENTRY_SELECTOR}, ${ACCOUNT_TRIGGER_SELECTOR}`,
        `${PROFILE_ENTRY_SELECTOR}, ${ACCOUNT_TRIGGER_SELECTOR}`,
      ]);
      runtime.flushFrames();
      assert.deepEqual(runtime.document.getElementByIdCalls, ["menu:[]#"]);
      assert.equal(lifecycleDetails(runtime).at(-1)?.reason, "profile_menu");
      assert.equal(lifecycleDetails(runtime).at(-1)?.profileMenuId, "menu:[]#");
    });
  }

  it("supports Enter/Space triggers and intercepts only valid marked Profile entries", async () => {
    const runtime = await createTokenCostRuntime();
    activate(runtime);
    const button = triggerNode("Open profile menu");
    runtime.document.nodes.set("profile-menu", validMenu(button));
    const enter = new FakeTokenCostEvent("keydown", { target: button, key: "Enter" });
    runtime.document.dispatchEvent(enter);
    runtime.flushFrames();
    assert.equal(enter.defaultPrevented, false);
    const space = new FakeTokenCostEvent("keydown", { target: button, key: " " });
    const repeatedSpace = new FakeTokenCostEvent("keydown", { target: button, key: " " });
    runtime.document.dispatchEvent(space);
    runtime.document.dispatchEvent(repeatedSpace);
    assert.equal(space.defaultPrevented, true);
    assert.equal(repeatedSpace.defaultPrevented, true);
    assert.equal(runtime.pendingFrames.size, 1);
    runtime.flushFrames();

    const menu = validMenu(button);
    const unrelatedTrigger = triggerNode("Open profile menu", "unrelated-trigger", "unrelated-menu");
    const unrelatedMenu = validMenu(unrelatedTrigger);
    runtime.document.nodes.set("profile-trigger", button);
    runtime.document.nodes.set("unrelated-trigger", unrelatedTrigger);
    runtime.document.nodes.set("unrelated-menu", unrelatedMenu);
    const entry = new FakeTokenCostNode({ "data-codex-plus-token-cost-profile-entry": "", role: "menuitem" });
    entry.closestMatch = entry;
    entry.closestMatches.set("[role='menu']", menu);
    const entryClick = new FakeTokenCostEvent("click", { target: entry });
    runtime.document.dispatchEvent(entryClick);
    assert.equal(entryClick.defaultPrevented, true);
    assert.equal(entryClick.propagationStopped, true);
    assert.equal(button.clickCount, 1, "the exact aria-labelledby trigger closes the owning menu");
    assert.equal(unrelatedTrigger.clickCount, 0, "an unrelated menu trigger is never clicked");
    assert.equal(lifecycleDetails(runtime).at(-1)?.reason, "profile_entry");
    assert.equal(lifecycleDetails(runtime).at(-1)?.profile, true);

    entry.setAttribute("aria-disabled", "true");
    const disabled = new FakeTokenCostEvent("keydown", { target: entry, key: " " });
    const count = lifecycleDetails(runtime).length;
    runtime.document.dispatchEvent(disabled);
    assert.equal(disabled.defaultPrevented, false);
    assert.equal(lifecycleDetails(runtime).length, count);
  });

  it("rejects malformed account structures without retrying", async () => {
    const unrelatedRuntime = await createTokenCostRuntime();
    activate(unrelatedRuntime);
    const unrelated = new FakeTokenCostNode();
    unrelatedRuntime.document.dispatchEvent(new FakeTokenCostEvent("click", { target: unrelated }));
    assert.deepEqual(unrelated.closestCalls, [`${PROFILE_ENTRY_SELECTOR}, ${ACCOUNT_TRIGGER_SELECTOR}`]);
    assert.equal(unrelatedRuntime.pendingFrames.size, 0);

    const missingRuntime = await createTokenCostRuntime();
    activate(missingRuntime);
    const missingButton = triggerNode("Open profile menu");
    missingRuntime.document.dispatchEvent(new FakeTokenCostEvent("click", { target: missingButton }));
    missingRuntime.flushFrames();
    assert.deepEqual(missingRuntime.document.getElementByIdCalls, ["profile-menu"]);
    assert.equal(missingRuntime.pendingFrames.size, 0);
    assert.equal(lifecycleDetails(missingRuntime).filter((detail) => detail.reason === "profile_menu").length, 0);

    const cases: Array<(button: FakeTokenCostNode, menu: FakeTokenCostNode) => void> = [
      (_button, menu) => menu.setAttribute("role", "dialog"),
      (_button, menu) => menu.setAttribute("aria-labelledby", "other"),
      (_button, menu) => menu.menuItems.push(new FakeTokenCostNode({ role: "menuitem", "aria-disabled": "true", "data-disabled": "" })),
      (_button, menu) => menu.menuItems.splice(0, 1),
      (_button, menu) => menu.menuItems.splice(1, 1),
      (_button, menu) => menu.menuItems[1].setAttribute("aria-disabled", "true"),
    ];
    for (const mutate of cases) {
      const runtime = await createTokenCostRuntime();
      activate(runtime);
      const button = triggerNode("Open profile menu");
      const menu = validMenu(button);
      mutate(button, menu);
      runtime.document.nodes.set("profile-menu", menu);
      runtime.document.dispatchEvent(new FakeTokenCostEvent("click", { target: button }));
      runtime.flushFrames();
      assert.equal(lifecycleDetails(runtime).filter((detail) => detail.reason === "profile_menu").length, 0);
      assert.equal(runtime.pendingFrames.size, 0);
    }

    for (const [buttonId, menuId] of [["", "menu"], ["trigger", ""], ["x".repeat(161), "menu"], ["trigger", "界".repeat(54)]]) {
      const runtime = await createTokenCostRuntime();
      activate(runtime);
      const button = triggerNode("Open profile menu", buttonId, menuId);
      const space = new FakeTokenCostEvent("keydown", { target: button, key: " " });
      runtime.document.dispatchEvent(space);
      assert.equal(space.defaultPrevented, false);
      assert.equal(runtime.pendingFrames.size, 0);
    }
  });

  it("ignores stale deactivation and matching teardown removes all active work", async () => {
    const runtime = await createTokenCostRuntime();
    activate(runtime);
    const button = triggerNode("Open profile menu");
    runtime.document.nodes.set("profile-menu", validMenu(button));
    runtime.document.dispatchEvent(new FakeTokenCostEvent("click", { target: button }));
    assert.equal(runtime.pendingFrames.size, 1);

    runtime.document.dispatchEvent(new FakeTokenCostCustomEvent("codex-plus:token-cost-deactivate", {
      detail: { instanceId: "stale-page" },
    }));
    assert.equal(runtime.pendingFrames.size, 1);
    assert.equal(runtime.document.listenerCount("click"), 1);

    runtime.window.__codexLiveTokenCostCaptureV1.enabled = false;
    runtime.document.dispatchEvent(new FakeTokenCostCustomEvent("codex-plus:token-cost-deactivate", {
      detail: { instanceId: "page-1" },
    }));
    assert.equal(runtime.pendingFrames.size, 0);
    assert.equal(runtime.cancelledFrames.length, 1);
    assert.equal(runtime.document.listenerCount("click"), 0);
    assert.equal(runtime.document.listenerCount("keydown"), 0);
    assert.equal(runtime.api.state().turns, 0);
    const count = lifecycleDetails(runtime).length;
    runtime.flushFrames();
    assert.equal(lifecycleDetails(runtime).length, count);
  });

  it("uses the existing navigation boundary and keeps the marked block free of background or global hooks", async () => {
    const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
    const block = tokenCostBlock(renderer);
    const navigation = sourceFunction(renderer, "captureThreadScrollNavigation", "editableThreadScrollTarget");
    assert.match(navigation, /tokenCostEmitNavigationLifecycle\(\)/);
    let lifecycleCalls = 0;
    const captureNavigation = new Function(
      "tokenCostEmitNavigationLifecycle",
      "codexPlusSettings",
      `${navigation}\nreturn captureThreadScrollNavigation;`,
    )(
      () => {
        lifecycleCalls += 1;
      },
      () => ({ threadScrollRestore: false }),
    ) as (targetSessionId: string) => void;
    captureNavigation("thread-navigation");
    assert.equal(lifecycleCalls, 1);
    for (const forbidden of [
      "MutationObserver",
      "setInterval",
      "setTimeout",
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
      "eval(",
      "new Function",
      ".prototype",
      "Object.keys",
      "Object.values",
      "Object.entries",
      "getBoundingClientRect",
      "offsetWidth",
      "offsetHeight",
    ]) {
      assert.ok(!block.includes(forbidden), `TOKEN_COST block must not contain ${forbidden}`);
    }
  });
});
