import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import vm from "node:vm";

type Listener = (event: FakeEvent) => void;
type BridgeCall = { at: number; path: string; payload: any };

class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly detail: any;
  target: FakeElement | FakeDocument | null;
  currentTarget: FakeElement | FakeDocument | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  key = "";

  constructor(type: string, init: Record<string, any> = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this.detail = init.detail;
    this.target = init.target || null;
    this.key = init.key || "";
  }

  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

function dataAttribute(name: string) {
  return `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function matchesSimple(element: FakeElement, selector: string): boolean {
  const source = selector.trim();
  if (!source || source.includes(" ") || source.includes(",")) return false;
  const tag = source.match(/^[a-z][a-z0-9-]*/i)?.[0];
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  const id = source.match(/#([\w-]+)/)?.[1];
  if (id && element.id !== id) return false;
  for (const name of [...source.matchAll(/\.([\w-]+)/g)].map((match) => match[1])) {
    if (!element.classList.contains(name)) return false;
  }
  for (const match of source.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g)) {
    const [, name, value] = match;
    if (!element.hasAttribute(name)) return false;
    if (value !== undefined && element.getAttribute(name) !== value) return false;
  }
  return Boolean(tag || id || source.includes(".") || source.includes("["));
}

class FakeStyle {
  private readonly values = new Map<string, string>();
  setProperty(name: string, value: string) { this.values.set(name, String(value)); }
  getPropertyValue(name: string) { return this.values.get(name) || ""; }
  removeProperty(name: string) { this.values.delete(name); }
  get cssText() { return [...this.values].map(([name, value]) => `${name}: ${value}`).join("; "); }
  set cssText(value: string) {
    this.values.clear();
    for (const declaration of String(value).split(";")) {
      const index = declaration.indexOf(":");
      if (index > 0) this.setProperty(declaration.slice(0, index).trim(), declaration.slice(index + 1).trim());
    }
  }
}

class FakeElement {
  readonly ownerDocument: FakeDocument;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly style = new FakeStyle() as FakeStyle & Record<string, any>;
  readonly dataset: Record<string, string>;
  id = "";
  className = "";
  parentElement: FakeElement | null = null;
  type = "";
  value = "";
  checked = false;
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  src = "";
  alt = "";
  attributeWrites = 0;
  propertyWrites = 0;
  textWrites = 0;
  private disabledValue = false;
  private hiddenValue = false;
  private titleValue = "";
  private ownText = "";

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.dataset = new Proxy({}, {
      get: (_target, key) => typeof key === "string" ? this.getAttribute(dataAttribute(key)) ?? undefined : undefined,
      set: (_target, key, value) => {
        if (typeof key === "string") this.setAttribute(dataAttribute(key), String(value));
        return true;
      },
      deleteProperty: (_target, key) => {
        if (typeof key === "string") this.removeAttribute(dataAttribute(key));
        return true;
      },
    });
  }

  get classList() {
    return {
      contains: (name: string) => this.className.split(/\s+/).filter(Boolean).includes(name),
      add: (...names: string[]) => {
        const next = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => next.add(name));
        this.className = [...next].join(" ");
      },
      remove: (...names: string[]) => {
        const removed = new Set(names);
        this.className = this.className.split(/\s+/).filter((name) => name && !removed.has(name)).join(" ");
      },
    };
  }

  get childNodes() { return this.children; }
  get disabled() { return this.disabledValue; }
  set disabled(value: boolean) { this.propertyWrites += 1; this.ownerDocument.propertyWrites += 1; this.ownerDocument.domOperations += 1; this.disabledValue = Boolean(value); }
  get hidden() { return this.hiddenValue; }
  set hidden(value: boolean) { this.propertyWrites += 1; this.ownerDocument.propertyWrites += 1; this.ownerDocument.domOperations += 1; this.hiddenValue = Boolean(value); }
  get title() { return this.titleValue; }
  set title(value: string) { this.propertyWrites += 1; this.ownerDocument.propertyWrites += 1; this.ownerDocument.domOperations += 1; this.titleValue = String(value); }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling(): FakeElement | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index < 0 ? null : this.parentElement.children[index + 1] || null;
  }
  get isConnected() {
    let current: FakeElement | null = this;
    while (current) {
      if (current === this.ownerDocument.documentElement) return true;
      current = current.parentElement;
    }
    return false;
  }
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) {
    const text = String(value ?? "");
    if (this.ownText === text && this.children.length === 0) return;
    this.ownerDocument.textWrites += 1;
    this.ownerDocument.domOperations += 1;
    this.textWrites += 1;
    this.children.splice(0).forEach((child) => { child.parentElement = null; });
    this.ownText = text;
  }
  get innerHTML() { return this.textContent; }
  set innerHTML(value: string) {
    this.ownerDocument.innerHtmlWrites += 1;
    this.textContent = String(value);
  }

  setAttribute(name: string, value: string) {
    this.attributeWrites += 1;
    this.ownerDocument.attributeWrites += 1;
    this.ownerDocument.domOperations += 1;
    const key = name.toLowerCase();
    const text = String(value);
    this.attributes.set(key, text);
    if (key === "id") this.id = text;
    if (key === "class") this.className = text;
    if (key === "hidden") this.hidden = true;
    if (key === "disabled") this.disabled = true;
    if (key === "src") this.src = text;
    if (key === "alt") this.alt = text;
  }
  getAttribute(name: string) {
    const key = name.toLowerCase();
    if (key === "id") return this.id || null;
    if (key === "class") return this.className || null;
    return this.attributes.get(key) ?? null;
  }
  hasAttribute(name: string) {
    const key = name.toLowerCase();
    if (key === "id") return Boolean(this.id);
    if (key === "class") return Boolean(this.className);
    return this.attributes.has(key);
  }
  removeAttribute(name: string) {
    const key = name.toLowerCase();
    if (this.hasAttribute(key)) this.ownerDocument.domOperations += 1;
    this.attributes.delete(key);
    if (key === "id") this.id = "";
    if (key === "class") this.className = "";
    if (key === "hidden") this.hidden = false;
    if (key === "disabled") this.disabled = false;
    if (key === "checked") this.checked = false;
  }
  append(...nodes: FakeElement[]) { nodes.forEach((node) => this.appendChild(node)); }
  appendChild<T extends FakeElement>(node: T): T {
    node.remove();
    this.ownText = "";
    this.children.push(node);
    node.parentElement = this;
    this.ownerDocument.domOperations += 1;
    return node;
  }
  insertBefore<T extends FakeElement>(node: T, before: FakeElement | null): T {
    node.remove();
    this.ownText = "";
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    node.parentElement = this;
    this.ownerDocument.domOperations += 1;
    return node;
  }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
    this.ownerDocument.domOperations += 1;
  }
  matches(selector: string) { return selector.split(",").some((part) => matchesSimple(this, part)); }
  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  contains(node: FakeElement | null) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }
  focus() { this.ownerDocument.activeElement = this; }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((value) => value !== listener));
  }
  dispatchEvent(event: FakeEvent) {
    event.target ||= this;
    let current: FakeElement | null = this;
    while (current && !event.propagationStopped) {
      event.currentTarget = current;
      for (const listener of current.listeners.get(event.type) || []) listener.call(current, event);
      current = event.bubbles ? current.parentElement : null;
    }
    if (!event.propagationStopped && event.bubbles) this.ownerDocument.invoke(event);
    return !event.defaultPrevented;
  }
  click() { this.dispatchEvent(new FakeEvent("click")); }
}

class FakeDocument {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  readonly listeners = new Map<string, Listener[]>();
  readonly dispatched: FakeEvent[] = [];
  readyState = "loading";
  innerHtmlWrites = 0;
  attributeWrites = 0;
  propertyWrites = 0;
  textWrites = 0;
  domOperations = 0;
  observerCount = 0;
  activeElement: FakeElement;

  constructor() {
    this.documentElement = new FakeElement(this, "html");
    this.head = new FakeElement(this, "head");
    this.body = new FakeElement(this, "body");
    this.activeElement = this.body;
    this.documentElement.append(this.head, this.body);
  }
  createElement(tagName: string) { this.domOperations += 1; return new FakeElement(this, tagName); }
  getElementById(id: string) {
    if (this.documentElement.id === id) return this.documentElement;
    return this.documentElement.querySelector(`#${id}`);
  }
  querySelectorAll(selector: string) {
    const result = this.documentElement.matches(selector) ? [this.documentElement] : [];
    return result.concat(this.documentElement.querySelectorAll(selector));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((value) => value !== listener));
  }
  invoke(event: FakeEvent) {
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
  }
  dispatchEvent(event: FakeEvent) {
    event.target ||= this;
    this.dispatched.push(event);
    this.invoke(event);
    return !event.defaultPrevented;
  }
}

class FakeClock {
  now = 0;
  nextId = 1;
  readonly tasks = new Map<number, { at: number; callback: () => void }>();
  readonly delays: number[] = [];
  setTimeout = (callback: () => void, delay = 0) => {
    const id = this.nextId++;
    const boundedDelay = Math.max(0, Number(delay) || 0);
    this.delays.push(boundedDelay);
    this.tasks.set(id, { at: this.now + boundedDelay, callback });
    return id;
  };
  clearTimeout = (id: number) => { this.tasks.delete(id); };
  runDue() {
    while (true) {
      const due = [...this.tasks].filter(([, task]) => task.at <= this.now).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!due.length) break;
      const [id, task] = due[0];
      this.tasks.delete(id);
      task.callback();
    }
  }
  advance(ms: number) { this.now += ms; this.runDue(); }
}

function baseSnapshot(revision = 1, overrides: Record<string, any> = {}) {
  return {
    revision, running: false, model: "gpt-5.6-sol", fast: false, turns: 12, steps: 34,
    llm_ms: 68_000, tool_ms: 24_000, first_token_average_ms: 1_200,
    output_rate_milli_tokens_per_second: 52_000, input: 128_000, cached_input: 92_160,
    output: 18_000, cost_nanos: 123_000_000, hub_visible: true,
    output_rate_visible: true, profile_visible: true, ...overrides,
  };
}

function baseConfig(overrides: Record<string, any> = {}) {
  return {
    schema_version: 1, hub_visible: true, output_rate_visible: true, profile_visible: true,
    price_overrides: {},
    profile: {
      display_name: "Local Usage", username: "codex-local-usage", email: "sama@openai.com",
      plan_type: "pro_20x", plan_label: "Pro 20x", workspace_name: "", avatar_data_url: null,
    },
    ...overrides,
  };
}

function successfulBootstrap(instanceId: string, overrides: Record<string, any> = {}) {
  return { status: "ok", instance_id: instanceId, config: baseConfig(), snapshot: baseSnapshot(), ...overrides };
}

type Harness = {
  clock: FakeClock;
  document: FakeDocument;
  bridgeCalls: BridgeCall[];
  window: Record<string, any>;
  run: () => void;
  runSettings: () => void;
  settle: () => Promise<void>;
  settleBridgeCalls: () => Promise<void>;
  setBridge: (handler: (path: string, payload: any) => any) => void;
};

async function createHarness(initialBridge?: (path: string, payload: any) => any): Promise<Harness> {
  const source = await readFile(new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url), "utf8");
  const settingsSource = await readFile(new URL("../../../assets/live_token_cost/settings.js", import.meta.url), "utf8");
  const document = new FakeDocument();
  const clock = new FakeClock();
  const bridgeCalls: BridgeCall[] = [];
  const bridgePromises: Promise<any>[] = [];
  let bridge = initialBridge || ((_path: string, payload: any) => successfulBootstrap(payload.instance_id));

  const header = document.createElement("header");
  const actions = document.createElement("div");
  const codexPlus = document.createElement("button");
  codexPlus.id = "codex-plus-menu";
  codexPlus.textContent = "Codex++";
  actions.appendChild(codexPlus);
  header.appendChild(actions);
  const main = document.createElement("main");
  const composerWrap = document.createElement("div");
  const composer = document.createElement("form");
  composer.appendChild(document.createElement("textarea"));
  composerWrap.appendChild(composer);
  main.appendChild(composerWrap);
  document.body.append(header, main);

  const windowObject: Record<string, any> = {
    __CODEX_LIVE_TOKEN_COST_TEST__: true,
    document,
    location: { href: "app://-/index.html", protocol: "app:", pathname: "/index.html", search: "", hash: "" },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval() { throw new Error("the thin bootstrap must never install an interval"); },
    clearInterval() {},
    requestAnimationFrame(callback: () => void) { callback(); return 1; },
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    postMessage() {},
    __codexPlusPostJson(path: string, payload: any) {
      bridgeCalls.push({ at: clock.now, path, payload: structuredClone(payload) });
      const promise = Promise.resolve().then(() => bridge(path, payload));
      bridgePromises.push(promise);
      return promise;
    },
  };
  windowObject.window = windowObject;
  windowObject.self = windowObject;
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
  };
  const ClockDate = class extends Date {
    static now() { return clock.now; }
  };
  const context = {
    window: windowObject, self: windowObject, document, localStorage, location: windowObject.location,
    console, URL, Blob, TextEncoder, TextDecoder, CustomEvent: FakeEvent, Event: FakeEvent,
    Date: ClockDate,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: windowObject.setInterval, clearInterval: windowObject.clearInterval,
    MutationObserver: class { constructor() { document.observerCount += 1; } },
  };
  const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
  return {
    clock, document, bridgeCalls, window: windowObject,
    run: () => vm.runInNewContext(source, context), settle,
    settleBridgeCalls: async () => { await Promise.allSettled(bridgePromises); },
    runSettings: () => {
      (context as Record<string, any>).api = windowObject.__codexLiveTokenCostV1;
      vm.runInNewContext(settingsSource, context);
      delete (context as Record<string, any>).api;
    },
    setBridge(handler) { bridge = handler; },
  };
}

function listenerCount(document: FakeDocument, type: string) { return (document.listeners.get(type) || []).length; }
function events(document: FakeDocument, type: string) { return document.dispatched.filter((event) => event.type === type); }

function installProfileMenu(document: FakeDocument, menuId = "profile-menu") {
  const trigger = document.createElement("button");
  trigger.id = `${menuId}-trigger`;
  trigger.setAttribute("aria-controls", menuId);
  const menu = document.createElement("div");
  menu.id = menuId;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-labelledby", trigger.id);
  const identityItem = document.createElement("button");
  identityItem.className = "menu-disabled";
  identityItem.setAttribute("role", "menuitem");
  identityItem.setAttribute("aria-disabled", "true");
  identityItem.setAttribute("data-disabled", "");
  identityItem.setAttribute("tabindex", "-1");
  const row = document.createElement("div");
  const avatar = document.createElement("span");
  avatar.className = "size-8 rounded-full";
  avatar.textContent = "A";
  const label = document.createElement("span");
  label.className = "flex-1 min-w-0 truncate";
  label.textContent = "Account";
  row.append(avatar, label);
  identityItem.appendChild(row);
  const settings = document.createElement("button");
  settings.className = "menu-enabled";
  settings.setAttribute("role", "menuitem");
  settings.textContent = "Settings";
  const group = document.createElement("div");
  group.append(identityItem, settings);
  menu.appendChild(group);
  document.body.append(trigger, menu);
  return { trigger, menu, group, identityItem, settings, avatar, label };
}

function actionCalls(harness: Harness, type?: string) {
  return harness.bridgeCalls.filter((call) => call.path === "/token-cost/action" && (!type || call.payload.action.type === type));
}

function lazyCalls(harness: Harness) {
  return harness.bridgeCalls.filter((call) => call.path === "/token-cost/lazy-asset");
}

// 150ms asset delivery leaves a deterministic 500-operation mount allowance in the 200ms cold budget.
const DOM_OPERATION_COST_MS = 0.1;

function measuredUiDuration(elapsedClockMs: number, domOperations: number) {
  return elapsedClockMs + (domOperations * DOM_OPERATION_COST_MS);
}

function assertWithinUiBudget(actualMs: number, budgetMs: number, label: string) {
  assert.ok(actualMs < budgetMs, `${label}: ${actualMs.toFixed(1)}ms must stay below ${budgetMs}ms`);
}

function cssDeclarations(source: string, selector: string) {
  const declarations = new Map<string, string>();
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].split(",").map((value) => value.trim()).includes(selector)) continue;
    for (const declaration of match[2].split(";")) {
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      declarations.set(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim());
    }
  }
  return declarations;
}

function resolveSettingsCssValue(value: string | undefined, root: Map<string, string>) {
  const variable = value && value.match(/^var\((--cltc-[\w-]+)\)$/)?.[1];
  return variable ? root.get(variable) : value;
}

function updatedResponse(config: Record<string, any>, revision: number) {
  return {
    status: "ok",
    response: {
      type: "updated",
      config: structuredClone(config),
      snapshot: baseSnapshot(revision, {
        hub_visible: config.hub_visible,
        output_rate_visible: config.output_rate_visible,
        profile_visible: config.profile_visible,
      }),
    },
  };
}

describe("Codex Live Token Cost 1.0.0 thin HUD bootstrap", () => {
  it("installs one bounded runtime and activates capture only after bootstrap", async () => {
    const harness = await createHarness();
    harness.run();
    const api = harness.window.__codexLiveTokenCostV1;
    assert.deepEqual(Object.keys(api).sort(), ["acceptNativePush", "destroy", "diagnostics", "emitAction", "instanceId", "registerModule"]);
    assert.equal(harness.window.__codexLiveTokenCostVersion, "1.0.0");
    assert.deepEqual(JSON.parse(JSON.stringify(harness.window.__codexLiveTokenCostCaptureV1)), { enabled: false, instanceId: api.instanceId });
    assert.equal(harness.bridgeCalls.length, 1);
    assert.deepEqual(harness.bridgeCalls[0].payload, { instance_id: api.instanceId });
    assert.equal(listenerCount(harness.document, "click"), 1);
    assert.equal(listenerCount(harness.document, "change"), 1);
    assert.equal(listenerCount(harness.document, "codex-plus:token-cost-lifecycle"), 1);
    assert.equal(harness.document.querySelectorAll("#codex-live-token-cost").length, 1);
    assert.equal(harness.document.querySelectorAll("#codex-live-token-cost-settings").length, 1);
    assert.equal(harness.document.querySelectorAll("#codex-live-token-cost-style").length, 1);
    await harness.settle();
    assert.deepEqual(JSON.parse(JSON.stringify(harness.window.__codexLiveTokenCostCaptureV1)), { enabled: true, instanceId: api.instanceId });
    assert.equal(events(harness.document, "codex-plus:token-cost-activate").length, 1);
    assert.equal(harness.clock.tasks.size, 0);
    assert.equal(harness.document.observerCount, 0);
    assert.equal(harness.document.innerHtmlWrites, 0);
    const diagnostics = api.diagnostics();
    assert.equal(diagnostics.captureEnabled, true);
    assert.equal(diagnostics.moduleCount, 0);
    assert.equal(diagnostics.listenerCount, 3);
    assert.equal(diagnostics.timerCount, 0);
    assert.equal(Object.values(diagnostics).every((value) => ["string", "number", "boolean"].includes(typeof value)), true);
  });

  it("accepts a native-valid empty Profile display name without retrying bootstrap", async () => {
    const harness = await createHarness((_path, payload) => successfulBootstrap(payload.instance_id, {
      config: baseConfig({ profile: { ...baseConfig().profile, display_name: "" } }),
    }));
    harness.run();
    const api = harness.window.__codexLiveTokenCostV1;
    await harness.settle();
    assert.deepEqual(JSON.parse(JSON.stringify(harness.window.__codexLiveTokenCostCaptureV1)), { enabled: true, instanceId: api.instanceId });
    assert.equal(events(harness.document, "codex-plus:token-cost-activate").length, 1);
    assert.deepEqual(harness.bridgeCalls.map((call) => call.at), [0]);
    assert.equal(harness.clock.tasks.size, 0);
  });

  it("retries missing host anchors only from an explicit lifecycle event", async () => {
    const harness = await createHarness();
    const composer = harness.document.querySelector("textarea")!.closest("form")!;
    const composerParent = composer.parentElement!;
    const codexPlus = harness.document.getElementById("codex-plus-menu")!;
    const headerActions = codexPlus.parentElement!;
    composer.remove();
    codexPlus.remove();
    harness.run();
    assert.equal(harness.document.getElementById("codex-live-token-cost"), null);
    assert.equal(harness.document.getElementById("codex-live-token-cost-settings"), null);
    composerParent.appendChild(composer);
    headerActions.appendChild(codexPlus);

    await harness.settle();
    assert.equal(harness.document.getElementById("codex-live-token-cost"), null, "bootstrap completion must not retry DOM mounting");
    assert.equal(harness.document.getElementById("codex-live-token-cost-settings"), null);
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "navigation", route: "/" },
    }));
    assert.equal(harness.document.querySelector("[data-cltc-value-key='session-turns']")!.textContent, "12");
    assert.equal(harness.document.getElementById("codex-live-token-cost-settings")!.textContent, "今日 146K");
  });

  it("makes identical reinjection a no-op and replaces stale public runtimes", async () => {
    const harness = await createHarness();
    harness.run();
    const first = harness.window.__codexLiveTokenCostV1;
    harness.run();
    assert.equal(harness.window.__codexLiveTokenCostV1, first);
    assert.equal(harness.bridgeCalls.length, 1);
    assert.equal(listenerCount(harness.document, "click"), 1);
    first.destroy();
    let staleDestroyed = 0;
    harness.window.__codexLiveTokenCostVersion = "0.9.0";
    harness.window.__codexLiveTokenCostV1 = { destroy: () => { staleDestroyed += 1; } };
    harness.run();
    assert.equal(staleDestroyed, 1);
    assert.notEqual(harness.window.__codexLiveTokenCostV1, first);
    assert.equal(harness.document.querySelectorAll("#codex-live-token-cost").length, 1);
  });

  it("retries at 0, 250, and 1000ms, then sleeps until an explicit action", async () => {
    const harness = await createHarness(() => Promise.reject(new Error("offline")));
    harness.run();
    await harness.settle();
    assert.deepEqual(harness.bridgeCalls.map((call) => call.at), [0]);
    assert.deepEqual(harness.clock.delays, [250]);
    harness.clock.advance(250);
    await harness.settle();
    assert.deepEqual(harness.bridgeCalls.map((call) => call.at), [0, 250]);
    harness.clock.advance(750);
    await harness.settle();
    assert.deepEqual(harness.bridgeCalls.map((call) => call.at), [0, 250, 1000]);
    assert.deepEqual(harness.clock.delays, [250, 750]);
    assert.equal(harness.clock.tasks.size, 0);
    assert.equal(harness.window.__codexLiveTokenCostV1.diagnostics().bootstrapAttempts, 3);
    harness.clock.advance(60_000);
    await harness.settle();
    assert.equal(harness.bridgeCalls.length, 3);
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    await harness.settle();
    assert.equal(harness.bridgeCalls.length, 4);
    assert.equal(harness.bridgeCalls[3].at, 61_000);
  });

  it("resets an exhausted bootstrap cycle from an explicit lifecycle event", async () => {
    const harness = await createHarness(() => Promise.reject(new Error("offline")));
    harness.run();
    await harness.settle();
    harness.clock.advance(250);
    await harness.settle();
    harness.clock.advance(750);
    await harness.settle();
    assert.equal(harness.window.__codexLiveTokenCostV1.diagnostics().exhausted, true);
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "navigation", route: "/" },
    }));
    await harness.settle();
    assert.deepEqual(harness.bridgeCalls.filter((call) => call.path === "/token-cost/bootstrap").map((call) => call.at), [0, 250, 1000, 1000]);
  });

  it("applies only newer valid snapshots and changes only changed scalar nodes", async () => {
    const harness = await createHarness();
    harness.run();
    await harness.settle();
    const api = harness.window.__codexLiveTokenCostV1;
    const turns = harness.document.querySelector("[data-cltc-value-key='session-turns']")!;
    const steps = harness.document.querySelector("[data-cltc-value-key='session-steps']")!;
    const turnsWrites = turns.textWrites;
    const stepsWrites = steps.textWrites;
    const root = harness.document.getElementById("codex-live-token-cost")!;
    const rate = root.querySelector("[data-cltc-output-rate='session']")!;
    const settings = harness.document.getElementById("codex-live-token-cost-settings")!;
    const rootAttributeWrites = root.attributeWrites;
    const rootPropertyWrites = root.propertyWrites;
    const ratePropertyWrites = rate.propertyWrites;
    const settingsAttributeWrites = settings.attributeWrites;
    const settingsPropertyWrites = settings.propertyWrites;
    assert.equal(turns.textContent, "12");
    assert.equal(steps.textContent, "34");
    assert.equal(api.acceptNativePush({ type: "snapshot", instance_id: api.instanceId, snapshot: baseSnapshot(1, { turns: 99 }) }), false);
    assert.equal(api.acceptNativePush({ type: "snapshot", instance_id: "stale", snapshot: baseSnapshot(2, { turns: 99 }) }), false);
    assert.equal(api.acceptNativePush({ type: "snapshot", instance_id: api.instanceId, snapshot: { ...baseSnapshot(2), output: -1 } }), false);
    assert.equal(api.acceptNativePush({ type: "snapshot", instance_id: api.instanceId, snapshot: baseSnapshot(2, { turns: 13 }) }), true);
    assert.equal(turns.textContent, "13");
    assert.equal(turns.textWrites, turnsWrites + 1);
    assert.equal(steps.textWrites, stepsWrites);
    assert.equal(root.attributeWrites, rootAttributeWrites);
    assert.equal(root.propertyWrites, rootPropertyWrites);
    assert.equal(rate.propertyWrites, ratePropertyWrites);
    assert.equal(settings.attributeWrites, settingsAttributeWrites);
    assert.equal(settings.propertyWrites, settingsPropertyWrites);
    assert.equal(harness.document.querySelectorAll(".cltc-roll").length, 0);
    assert.equal(harness.document.querySelectorAll(".cltc-cadenced-shimmer").length, 0);
    assert.equal(harness.document.innerHtmlWrites, 0);
  });

  it("bounds lazy registrations and attaches the current instance to strict actions", async () => {
    const harness = await createHarness();
    harness.run();
    await harness.settle();
    const api = harness.window.__codexLiveTokenCostV1;
    let executions = 0;
    for (const name of ["settings", "analytics", "profile", "flatpickr"]) {
      assert.equal(api.registerModule(name, () => { executions += 1; }), true);
    }
    assert.equal(api.registerModule("unknown", () => {}), false);
    assert.equal(api.registerModule("settings", null), false);
    assert.equal(executions, 0);
    assert.equal(api.diagnostics().moduleCount, 4);
    await api.emitAction({ type: "query_diagnostics", instance_id: "forged" });
    const action = harness.bridgeCalls.at(-1)!;
    assert.equal(action.path, "/token-cost/action");
    assert.deepEqual(action.payload, { action: { type: "query_diagnostics", instance_id: api.instanceId } });
  });

  it("lazy settings consumes one cold intent and warm reopens without another request", async () => {
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action") return { status: "ok", response: { type: "disposed" } };
      throw new Error(`unexpected path ${path}`);
    });
    harness.run();
    await harness.settle();
    const api = harness.window.__codexLiveTokenCostV1;
    const settingsButton = harness.document.getElementById("codex-live-token-cost-settings")!;
    const coldIntentAt = harness.clock.now;
    settingsButton.click();
    settingsButton.click();
    await harness.settle();
    assert.deepEqual(lazyCalls(harness).map((call) => call.payload), [
      { instance_id: api.instanceId, asset: "settings" },
    ]);
    assert.deepEqual(Object.keys(api).sort(), ["acceptNativePush", "destroy", "diagnostics", "emitAction", "instanceId", "registerModule"]);
    assert.equal(typeof api.acceptLazyError, "function");

    harness.clock.advance(150);
    const coldOperationsAt = harness.document.domOperations;
    harness.runSettings();
    assert.ok(harness.document.querySelector(".cltc-settings-modal"));
    assertWithinUiBudget(
      measuredUiDuration(harness.clock.now - coldIntentAt, harness.document.domOperations - coldOperationsAt),
      200,
      "cold settings open",
    );
    assert.equal(harness.document.querySelectorAll(".cltc-settings-modal").length, 1);

    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    overlay.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    assert.equal(harness.document.querySelector(".cltc-settings-modal"), null);
    assert.equal(harness.document.getElementById("codex-live-token-cost-settings"), harness.document.activeElement);
    for (const type of ["click", "change", "input", "keydown"]) {
      assert.equal((overlay.listeners.get(type) || []).length, 0, `${type} listener must be removed`);
    }

    harness.clock.advance(99);
    const warmAt = harness.clock.now;
    const warmOperationsAt = harness.document.domOperations;
    settingsButton.click();
    assert.ok(harness.document.querySelector(".cltc-settings-modal"));
    assertWithinUiBudget(
      measuredUiDuration(harness.clock.now - warmAt, harness.document.domOperations - warmOperationsAt),
      100,
      "warm settings open",
    );
    assert.equal(lazyCalls(harness).length, 1);
  });

  it("performance budget rejects a deliberately bloated lazy settings fixture", async () => {
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      throw new Error(`unexpected path ${path}`);
    });
    harness.run();
    await harness.settle();
    const intentAt = harness.clock.now;
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    await harness.settle();
    harness.clock.advance(150);
    const operationsAt = harness.document.domOperations;
    let overlay: FakeElement | null = null;
    assert.equal(harness.window.__codexLiveTokenCostV1.registerModule("settings", () => ({
      mount() {
        overlay = harness.document.createElement("div");
        for (let index = 0; index < 600; index += 1) {
          overlay.appendChild(harness.document.createElement("div"));
        }
        harness.document.body.appendChild(overlay);
      },
      unmount() { overlay?.remove(); },
    })), true);
    const bloatedDuration = measuredUiDuration(
      harness.clock.now - intentAt,
      harness.document.domOperations - operationsAt,
    );
    assert.throws(
      () => assertWithinUiBudget(bloatedDuration, 200, "bloated cold settings open"),
      /must stay below 200ms/,
    );
  });

  it("lazy settings registration is inert without intent and rejected or lagged intents stay cleared", async () => {
    const inert = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      return { status: "ok" };
    });
    inert.run();
    await inert.settle();
    const writes = inert.document.attributeWrites + inert.document.propertyWrites + inert.document.textWrites;
    inert.runSettings();
    assert.equal(inert.document.querySelector(".cltc-settings-modal"), null);
    assert.equal(inert.document.attributeWrites + inert.document.propertyWrites + inert.document.textWrites, writes);
    inert.document.getElementById("codex-live-token-cost-settings")!.click();
    assert.ok(inert.document.querySelector(".cltc-settings-modal"), "registered source must warm-open synchronously");
    assert.equal(lazyCalls(inert).length, 0);

    const rejected = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return Promise.reject(new Error("asset unavailable"));
      return { status: "ok" };
    });
    rejected.run();
    await rejected.settle();
    rejected.document.getElementById("codex-live-token-cost-settings")!.click();
    await rejected.settle();
    rejected.runSettings();
    assert.equal(rejected.document.querySelector(".cltc-settings-modal"), null);

    const lagged = await createHarness((path, payload) => path === "/token-cost/bootstrap"
      ? successfulBootstrap(payload.instance_id)
      : { status: "ok" });
    lagged.run();
    await lagged.settle();
    const laggedApi = lagged.window.__codexLiveTokenCostV1;
    lagged.document.getElementById("codex-live-token-cost-settings")!.click();
    laggedApi.acceptLazyError({ asset: "settings", category: "lagged", message: "superseded" });
    lagged.runSettings();
    assert.equal(lagged.document.querySelector(".cltc-settings-modal"), null);
    laggedApi.destroy();
    assert.equal(lagged.document.querySelector(".cltc-settings-modal"), null);

    const invalid = await createHarness((path, payload) => path === "/token-cost/bootstrap"
      ? successfulBootstrap(payload.instance_id)
      : { status: "ok" });
    invalid.run();
    await invalid.settle();
    const invalidApi = invalid.window.__codexLiveTokenCostV1;
    invalid.document.getElementById("codex-live-token-cost-settings")!.click();
    assert.equal(invalidApi.registerModule("settings", null), false);
    invalid.runSettings();
    assert.equal(Boolean(invalid.document.querySelector(".cltc-settings-modal")), false, "invalid factory must clear the pending intent");
  });

  it("settings shell preserves baseline panels, root delegation, cleanup, and focused input on HUD pushes", async () => {
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const api = harness.window.__codexLiveTokenCostV1;
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    const modal = harness.document.querySelector(".cltc-settings-modal")!;
    const style = harness.document.getElementById("codex-live-token-cost-settings-style")!;
    assert.equal(modal.getAttribute("role"), "dialog");
    assert.equal(modal.getAttribute("aria-label"), "Codex Token Cost 设置");
    assert.match(style.textContent, /width:\s*min\(920px, calc\(100vw - 40px\)\)/);
    assert.match(style.textContent, /height:\s*min\(620px, calc\(100vh - 96px\)\)/);
    assert.match(style.textContent, /border-radius:\s*12px/);
    assert.match(style.textContent, /padding:\s*48px 20px/);
    assert.match(style.textContent, /grid-template-columns:\s*176px minmax\(0,\s*1fr\)/);
    assert.match(style.textContent, /padding:\s*18px 10px/);
    assert.match(style.textContent, /max-height:\s*210px/);
    assert.match(style.textContent, /width:\s*34px;\s*height:\s*20px/);
    assert.deepEqual(
      overlay.querySelectorAll("[data-settings-panel]").map((node) => node.textContent),
      ["个人资料", "数据与显示", "使用统计", "模型价格"],
    );
    assert.equal(listenerCount(harness.document, "keydown"), 0);
    for (const type of ["click", "change", "input", "keydown"]) {
      assert.equal((overlay.listeners.get(type) || []).length, 1, `${type} uses one overlay listener`);
    }

    overlay.querySelector("[data-settings-panel='general']")!.click();
    assert.equal(
      overlay.querySelector(".cltc-link-button")!.getAttribute("href"),
      "https://github.com/Tianzora/codex-token-cost/blob/main/scripts/codex-local-usage-helper.cjs",
    );
    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    assert.equal(modal.dataset.settingsActive, "pricing");
    const model = overlay.querySelector("[data-price-field='model']")!;
    model.value = "focused-model";
    model.selectionStart = 4;
    model.selectionEnd = 7;
    model.focus();
    const modelWrites = model.propertyWrites;
    assert.equal(api.acceptNativePush({
      type: "snapshot",
      instance_id: api.instanceId,
      snapshot: baseSnapshot(2, { turns: 99 }),
    }), true);
    assert.equal(overlay.querySelector("[data-price-field='model']"), model);
    assert.equal(model.value, "focused-model");
    assert.equal(model.selectionStart, 4);
    assert.equal(model.selectionEnd, 7);
    assert.equal(model.propertyWrites, modelWrites);

    modal.click();
    assert.ok(harness.document.querySelector(".cltc-settings-modal"), "inner click must not close");
    overlay.click();
    assert.equal(harness.document.querySelector(".cltc-settings-modal"), null);
    assert.equal(harness.document.getElementById("codex-live-token-cost-settings-style"), null);
  });

  it("settings reproduces the frozen general profile and native-default pricing controls", async () => {
    let config = baseConfig();
    let revision = 1;
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id, { config: structuredClone(config) });
      if (path === "/token-cost/action" && payload.action.type === "set_visibility") {
        config = {
          ...config,
          hub_visible: payload.action.hub_visible,
          output_rate_visible: payload.action.output_rate_visible,
          profile_visible: payload.action.profile_visible,
        };
        return updatedResponse(config, ++revision);
      }
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;

    overlay.querySelector("[data-settings-panel='profile']")!.click();
    assert.match(overlay.querySelector(".cltc-settings-section-heading")!.textContent, /这些资料只保存在本地，用于 Codex 个人资料与账号菜单。/);
    const email = overlay.querySelector("[data-profile-field='email']")!;
    assert.equal(email.parentElement!.classList.contains("cltc-price-field-full"), true);
    assert.match(email.parentElement!.querySelector(".cltc-profile-field-note")!.textContent, /官方新版本的账号菜单不再显示邮箱/);
    const accountStructure = overlay.querySelector("[data-profile-field='accountStructure']")!;
    assert.equal(accountStructure.tagName, "SELECT");
    assert.equal(accountStructure.disabled, true);
    assert.equal(accountStructure.getAttribute("aria-disabled"), "true");
    const workspace = overlay.querySelector("[data-profile-field='workspaceName']")!;
    assert.equal(workspace.disabled, true);
    assert.equal(workspace.getAttribute("placeholder"), "Codex Workspace");
    const plan = overlay.querySelector("[data-profile-field='planType']")!;
    assert.equal(plan.tagName, "SELECT");
    assert.deepEqual(plan.children.map((option) => option.textContent), [
      "Free", "Go", "Plus", "Pro 5x", "Pro 20x", "Business", "Enterprise", "Edu", "Staff", "Founder", "自定义",
    ]);
    assert.equal(plan.value, "pro_20x");
    assert.equal(overlay.querySelector("[data-profile-field='planCustom']")!.getAttribute("placeholder"), "Team Enterprise");
    assert.equal(overlay.querySelector("[data-action='save-profile']")!.getAttribute("data-variant"), "primary");

    overlay.querySelector("[data-settings-panel='general']")!.click();
    assert.equal(overlay.querySelector("[data-action='save-visibility']"), null);
    const profileToggle = overlay.querySelector("[data-misc-field='profileUnlockEnabled']")!;
    assert.match(profileToggle.parentElement!.textContent, /关闭后停止资料伪装与 Profile 补丁；如界面未完全恢复，请重启 Codex。/);
    const outputToggle = overlay.querySelector("[data-misc-field='outputRateVisible']")!;
    outputToggle.focus();
    profileToggle.checked = false;
    profileToggle.dispatchEvent(new FakeEvent("change"));
    await harness.settle();
    assert.equal(actionCalls(harness, "set_visibility").length, 1);
    assert.equal(actionCalls(harness, "set_visibility")[0].payload.action.profile_visible, false);
    assert.deepEqual(
      overlay.querySelectorAll("[data-settings-panel]").map((node) => node.textContent),
      ["数据与显示", "使用统计", "模型价格"],
    );
    assert.equal(harness.document.activeElement, outputToggle, "visibility success keeps an unrelated focused control");

    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    const defaultRow = overlay.querySelectorAll("[data-price-pick]").find((row) => row.dataset.pricePick === "gpt-5.3-codex")!;
    assert.ok(defaultRow, overlay.textContent);
    assert.deepEqual(defaultRow.children.map((cell) => cell.textContent), ["gpt-5.3-codex", "1.75", "0.175", "-", "14"]);
    assert.ok(overlay.querySelectorAll("[data-price-pick]").length >= 10);
    assert.match(overlay.querySelector(".cltc-price-meta")!.textContent, /默认/);
    assert.equal(overlay.querySelector("[data-action='delete-price']")!.getAttribute("data-variant"), "danger");
    assert.equal(overlay.querySelector("[data-action='save-price']")!.getAttribute("data-variant"), "primary");

    const hiddenProfile = await createHarness((path, payload) => path === "/token-cost/bootstrap"
      ? successfulBootstrap(payload.instance_id, {
        config: baseConfig({ profile_visible: false }),
        snapshot: baseSnapshot(1, { profile_visible: false }),
      })
      : { status: "ok" });
    hiddenProfile.run();
    await hiddenProfile.settle();
    hiddenProfile.runSettings();
    hiddenProfile.document.getElementById("codex-live-token-cost-settings")!.click();
    const hiddenModal = hiddenProfile.document.querySelector(".cltc-settings-modal")!;
    assert.equal(hiddenModal.dataset.settingsActive, "general");
    assert.deepEqual(
      hiddenModal.querySelectorAll("[data-settings-panel]").map((node) => node.textContent),
      ["数据与显示", "使用统计", "模型价格"],
    );
  });

  it("settings focuses the accessible close control and handles Escape from the real active element", async () => {
    const harness = await createHarness();
    harness.run();
    await harness.settle();
    harness.runSettings();
    const settingsButton = harness.document.getElementById("codex-live-token-cost-settings")!;
    settingsButton.click();
    const close = harness.document.querySelector("[data-action='close-price']")!;
    assert.ok(close);
    assert.equal(close.getAttribute("aria-label"), "关闭");
    assert.equal(harness.document.activeElement, close);
    harness.document.activeElement.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    assert.equal(harness.document.querySelector(".cltc-settings-modal"), null);
    assert.equal(harness.document.activeElement, settingsButton);
  });

  it("keeps startup and mounted settings config monotonic across out-of-order action responses", async () => {
    type Deferred = { promise: Promise<any>; resolve: (value: any) => void };
    const deferred = (): Deferred => {
      let resolve!: (value: any) => void;
      const promise = new Promise<any>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const stale = deferred();
    const fresh = deferred();
    let saveCount = 0;
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/action" && payload.action.type === "save_profile") {
        saveCount += 1;
        return saveCount === 1 ? stale.promise : fresh.promise;
      }
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    const settingsButton = harness.document.getElementById("codex-live-token-cost-settings")!;
    settingsButton.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    const email = overlay.querySelector("[data-profile-field='email']")!;
    email.value = "stale@example.com";
    overlay.querySelector("[data-action='save-profile']")!.click();
    email.value = "fresh@example.com";
    overlay.querySelector("[data-action='save-profile']")!.click();

    const freshConfig = baseConfig({ profile: { ...baseConfig().profile, email: "fresh@example.com" } });
    fresh.resolve(updatedResponse(freshConfig, 3));
    await harness.settle();
    const staleConfig = baseConfig({ profile: { ...baseConfig().profile, email: "stale@example.com" } });
    stale.resolve(updatedResponse(staleConfig, 2));
    await harness.settle();
    assert.equal(harness.window.__codexLiveTokenCostV1.diagnostics().revision, 3);

    overlay.querySelector("[data-settings-panel='general']")!.click();
    overlay.querySelector("[data-settings-panel='profile']")!.click();
    assert.equal(overlay.querySelector("[data-profile-field='email']")!.value, "fresh@example.com");
    overlay.querySelector("[data-action='close-price']")!.click();
    settingsButton.click();
    assert.equal(harness.document.querySelector("[data-profile-field='email']")!.value, "fresh@example.com");
  });

  it("ignores superseded older successful price callbacks after a newer revision", async () => {
    type Deferred = { promise: Promise<any>; resolve: (value: any) => void };
    const deferred = (): Deferred => {
      let resolve!: (value: any) => void;
      const promise = new Promise<any>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const stale = deferred();
    const fresh = deferred();
    let saveCount = 0;
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/action" && payload.action.type === "save_price") {
        saveCount += 1;
        return saveCount === 1 ? stale.promise : fresh.promise;
      }
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    const setEditor = (model: string, input: string, output: string) => {
      overlay.querySelector("[data-price-field='model']")!.value = model;
      overlay.querySelector("[data-price-field='input']")!.value = input;
      overlay.querySelector("[data-price-field='cachedInput']")!.value = "";
      overlay.querySelector("[data-price-field='cacheWrite']")!.value = "";
      overlay.querySelector("[data-price-field='output']")!.value = output;
    };
    const stalePrice = {
      input_nanos_per_million: 1_000_000_000, cached_input_nanos_per_million: null,
      cache_write_nanos_per_million: null, output_nanos_per_million: 3_000_000_000,
    };
    const freshPrice = {
      input_nanos_per_million: 2_000_000_000, cached_input_nanos_per_million: null,
      cache_write_nanos_per_million: null, output_nanos_per_million: 4_000_000_000,
    };
    setEditor("stale-price", "1", "3");
    overlay.querySelector("[data-action='save-price']")!.click();
    setEditor("fresh-price", "2", "4");
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();

    const freshConfig = baseConfig({ price_overrides: { "stale-price": stalePrice, "fresh-price": freshPrice } });
    fresh.resolve(updatedResponse(freshConfig, 3));
    await harness.settle();
    assert.equal(overlay.querySelector(".cltc-price-meta")!.textContent, "fresh-price · 自定义");
    assert.equal(overlay.querySelector("[data-price-field='model']")!.value, "fresh-price");
    assert.equal(overlay.querySelector("[data-price-field='input']")!.value, "2");

    stale.resolve(updatedResponse(baseConfig({ price_overrides: { "stale-price": stalePrice } }), 2));
    await harness.settle();
    assert.equal(harness.window.__codexLiveTokenCostV1.diagnostics().revision, 3);
    assert.equal(overlay.querySelector(".cltc-price-meta")!.textContent, "fresh-price · 自定义");
    assert.equal(overlay.querySelector("[data-price-field='model']")!.value, "fresh-price");
    assert.equal(overlay.querySelector("[data-price-field='input']")!.value, "2");
  });

  it("ignores superseded older price failures after a newer success", async () => {
    type Deferred = { promise: Promise<any>; resolve: (value: any) => void };
    const deferred = (): Deferred => {
      let resolve!: (value: any) => void;
      const promise = new Promise<any>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const stale = deferred();
    const fresh = deferred();
    let saveCount = 0;
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/action" && payload.action.type === "save_price") {
        saveCount += 1;
        return saveCount === 1 ? stale.promise : fresh.promise;
      }
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    const content = overlay.querySelector(".cltc-settings-content")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    const setEditor = (model: string, input: string) => {
      overlay.querySelector("[data-price-field='model']")!.value = model;
      overlay.querySelector("[data-price-field='input']")!.value = input;
      overlay.querySelector("[data-price-field='cachedInput']")!.value = "";
      overlay.querySelector("[data-price-field='cacheWrite']")!.value = "";
      overlay.querySelector("[data-price-field='output']")!.value = "4";
    };
    setEditor("old-failure", "1");
    overlay.querySelector("[data-action='save-price']")!.click();
    setEditor("new-success", "2");
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();

    const freshPrice = {
      input_nanos_per_million: 2_000_000_000, cached_input_nanos_per_million: null,
      cache_write_nanos_per_million: null, output_nanos_per_million: 4_000_000_000,
    };
    fresh.resolve(updatedResponse(baseConfig({ price_overrides: { "new-success": freshPrice } }), 3));
    await harness.settle();
    stale.resolve({ status: "error", error: "old native failure" });
    await harness.settleBridgeCalls();
    await harness.settle();
    assert.equal(overlay.querySelector(".cltc-price-meta")!.textContent, "new-success · 自定义");
    assert.equal(overlay.querySelector("[data-settings-status='saved']")!.textContent, "已保存模型价格。");
    assert.equal(content.children.some((node) => node.classList.contains("cltc-settings-error")), false);
  });

  it("shows the current pricing failure after another action family advances revision", async () => {
    let resolvePrice!: (value: any) => void;
    const pendingPrice = new Promise<any>((resolve) => { resolvePrice = resolve; });
    const visibilityConfig = baseConfig({ hub_visible: false });
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/action" && payload.action.type === "save_price") return pendingPrice;
      if (path === "/token-cost/action" && payload.action.type === "set_visibility") {
        return updatedResponse(visibilityConfig, 2);
      }
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    const content = overlay.querySelector(".cltc-settings-content")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    overlay.querySelector("[data-price-field='model']")!.value = "failure-after-visibility";
    overlay.querySelector("[data-price-field='input']")!.value = "1";
    overlay.querySelector("[data-price-field='cachedInput']")!.value = "";
    overlay.querySelector("[data-price-field='cacheWrite']")!.value = "";
    overlay.querySelector("[data-price-field='output']")!.value = "2";
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();

    overlay.querySelector("[data-settings-panel='general']")!.click();
    const hub = overlay.querySelector("[data-misc-field='hubVisible']")!;
    hub.checked = false;
    hub.dispatchEvent(new FakeEvent("change"));
    await harness.settle();
    assert.equal(harness.window.__codexLiveTokenCostV1.diagnostics().revision, 2);
    overlay.querySelector("[data-settings-panel='pricing']")!.click();

    resolvePrice({ status: "error", error: "price write failed" });
    await harness.settleBridgeCalls();
    await harness.settle();
    const errors = content.children.filter((node) => node.classList.contains("cltc-settings-error"));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].textContent, "保存失败，请重试。");
  });

  it("runs the current pricing success callback without rolling back newer cross-family config", async () => {
    let resolvePrice!: (value: any) => void;
    let resolveVisibility!: (value: any) => void;
    const pendingPrice = new Promise<any>((resolve) => { resolvePrice = resolve; });
    const pendingVisibility = new Promise<any>((resolve) => { resolveVisibility = resolve; });
    const price = {
      input_nanos_per_million: 2_000_000_000,
      cached_input_nanos_per_million: null,
      cache_write_nanos_per_million: null,
      output_nanos_per_million: 4_000_000_000,
    };
    const priceConfig = baseConfig({ price_overrides: { "cross-family-price": price } });
    const visibilityConfig = baseConfig({ hub_visible: false, price_overrides: { "cross-family-price": price } });
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/action" && payload.action.type === "save_price") return pendingPrice;
      if (path === "/token-cost/action" && payload.action.type === "set_visibility") return pendingVisibility;
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    const settingsButton = harness.document.getElementById("codex-live-token-cost-settings")!;
    settingsButton.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    const content = overlay.querySelector(".cltc-settings-content")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    overlay.querySelector("[data-price-field='model']")!.value = "cross-family-price";
    overlay.querySelector("[data-price-field='input']")!.value = "2";
    overlay.querySelector("[data-price-field='cachedInput']")!.value = "";
    overlay.querySelector("[data-price-field='cacheWrite']")!.value = "";
    overlay.querySelector("[data-price-field='output']")!.value = "4";
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();

    overlay.querySelector("[data-settings-panel='general']")!.click();
    const hub = overlay.querySelector("[data-misc-field='hubVisible']")!;
    hub.checked = false;
    hub.dispatchEvent(new FakeEvent("change"));
    await harness.settle();
    resolveVisibility(updatedResponse(visibilityConfig, 3));
    await harness.settle();
    overlay.querySelector("[data-settings-panel='pricing']")!.click();

    resolvePrice(updatedResponse(priceConfig, 2));
    await harness.settleBridgeCalls();
    await harness.settle();
    assert.equal(harness.window.__codexLiveTokenCostV1.diagnostics().revision, 3);
    assert.equal(overlay.querySelector(".cltc-price-meta")!.textContent, "cross-family-price · 自定义");
    const saved = content.children.find((node) => node.dataset.settingsStatus === "saved");
    assert.equal(saved?.textContent, "已保存模型价格。");

    overlay.querySelector("[data-action='close-price']")!.click();
    settingsButton.click();
    const reopened = harness.document.querySelector(".cltc-settings-overlay")!;
    reopened.querySelector("[data-settings-panel='general']")!.click();
    assert.equal(reopened.querySelector("[data-misc-field='hubVisible']")!.checked, false);
    reopened.querySelector("[data-settings-panel='pricing']")!.click();
    assert.ok(reopened.querySelectorAll("[data-price-pick]").some((row) => row.dataset.pricePick === "cross-family-price"));
  });

  it("keeps snapshot visibility while accepting a current pricing action config on its own revision track", async () => {
    let resolvePrice!: (value: any) => void;
    const pendingPrice = new Promise<any>((resolve) => { resolvePrice = resolve; });
    const price = {
      input_nanos_per_million: 3_000_000_000,
      cached_input_nanos_per_million: null,
      cache_write_nanos_per_million: null,
      output_nanos_per_million: 6_000_000_000,
    };
    const priceConfig = baseConfig({ price_overrides: { "snapshot-race-price": price } });
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/action" && payload.action.type === "save_price") return pendingPrice;
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    const api = harness.window.__codexLiveTokenCostV1;
    const settingsButton = harness.document.getElementById("codex-live-token-cost-settings")!;
    settingsButton.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    const content = overlay.querySelector(".cltc-settings-content")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    overlay.querySelector("[data-price-field='model']")!.value = "snapshot-race-price";
    overlay.querySelector("[data-price-field='input']")!.value = "3";
    overlay.querySelector("[data-price-field='cachedInput']")!.value = "";
    overlay.querySelector("[data-price-field='cacheWrite']")!.value = "";
    overlay.querySelector("[data-price-field='output']")!.value = "6";
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();

    assert.equal(api.acceptNativePush({
      type: "snapshot",
      instance_id: api.instanceId,
      snapshot: baseSnapshot(4, {
        model: "snapshot-newer-model",
        hub_visible: false,
        output_rate_visible: false,
        profile_visible: false,
      }),
    }), true);
    assert.equal(api.diagnostics().revision, 4);

    resolvePrice(updatedResponse(priceConfig, 2));
    await harness.settleBridgeCalls();
    await harness.settle();
    assert.equal(api.diagnostics().revision, 4);
    assert.equal(overlay.querySelector(".cltc-price-meta")!.textContent, "snapshot-race-price · 自定义");
    const saved = content.children.find((node) => node.dataset.settingsStatus === "saved");
    assert.equal(saved?.textContent, "已保存模型价格。");

    overlay.querySelector("[data-action='close-price']")!.click();
    settingsButton.click();
    const reopened = harness.document.querySelector(".cltc-settings-overlay")!;
    const reopenedModal = reopened.querySelector(".cltc-settings-modal")!;
    assert.equal(reopenedModal.dataset.settingsActive, "general");
    assert.equal(reopened.querySelector("[data-settings-panel='profile']"), null);
    assert.equal(reopened.querySelector("[data-misc-field='hubVisible']")!.checked, false);
    assert.equal(reopened.querySelector("[data-misc-field='outputRateVisible']")!.checked, false);
    assert.equal(reopened.querySelector("[data-misc-field='profileUnlockEnabled']")!.checked, false);
    reopened.querySelector("[data-settings-panel='pricing']")!.click();
    assert.ok(reopened.querySelectorAll("[data-price-pick]").some((row) => row.dataset.pricePick === "snapshot-race-price"));
  });

  it("does not let a disposed settings owner callback refresh the warm-reopened owner", async () => {
    let resolvePrice!: (value: any) => void;
    const pendingPrice = new Promise<any>((resolve) => { resolvePrice = resolve; });
    const price = {
      input_nanos_per_million: 4_000_000_000,
      cached_input_nanos_per_million: null,
      cache_write_nanos_per_million: null,
      output_nanos_per_million: 8_000_000_000,
    };
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/action" && payload.action.type === "save_price") return pendingPrice;
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    const settingsButton = harness.document.getElementById("codex-live-token-cost-settings")!;
    settingsButton.click();
    const first = harness.document.querySelector(".cltc-settings-overlay")!;
    first.querySelector("[data-settings-panel='pricing']")!.click();
    first.querySelector("[data-price-field='model']")!.value = "disposed-owner-price";
    first.querySelector("[data-price-field='input']")!.value = "4";
    first.querySelector("[data-price-field='cachedInput']")!.value = "";
    first.querySelector("[data-price-field='cacheWrite']")!.value = "";
    first.querySelector("[data-price-field='output']")!.value = "8";
    first.querySelector("[data-action='save-price']")!.click();
    await harness.settle();
    first.querySelector("[data-action='close-price']")!.click();

    settingsButton.click();
    const second = harness.document.querySelector(".cltc-settings-overlay")!;
    second.querySelector("[data-settings-panel='pricing']")!.click();
    const secondMeta = second.querySelector(".cltc-price-meta")!.textContent;
    resolvePrice(updatedResponse(baseConfig({ price_overrides: { "disposed-owner-price": price } }), 2));
    await harness.settleBridgeCalls();
    await harness.settle();
    assert.equal(harness.document.querySelector(".cltc-settings-overlay"), second);
    assert.equal(second.querySelector(".cltc-price-meta")!.textContent, secondMeta);
    assert.equal(second.querySelector("[data-settings-status='saved']"), null);
    assert.equal(second.querySelector(".cltc-settings-error"), null);

    second.querySelector("[data-action='close-price']")!.click();
    settingsButton.click();
    const third = harness.document.querySelector(".cltc-settings-overlay")!;
    third.querySelector("[data-settings-panel='pricing']")!.click();
    assert.ok(third.querySelectorAll("[data-price-pick]").some((row) => row.dataset.pricePick === "disposed-owner-price"));
  });

  it("refreshes pricing meta list and editor in place after every successful price mutation", async () => {
    let config = baseConfig();
    let revision = 1;
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id, { config: structuredClone(config) });
      if (path === "/token-cost/action" && payload.action.type === "save_price") {
        config = {
          ...config,
          price_overrides: { ...config.price_overrides, [payload.action.model]: structuredClone(payload.action.price) },
        };
        return updatedResponse(config, ++revision);
      }
      if (path === "/token-cost/action" && ["delete_price", "reset_price"].includes(payload.action.type)) {
        const price_overrides: Record<string, any> = { ...config.price_overrides };
        delete price_overrides[payload.action.model];
        config = { ...config, price_overrides };
        return updatedResponse(config, ++revision);
      }
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    const modal = overlay.querySelector(".cltc-settings-modal")!;
    const content = overlay.querySelector(".cltc-settings-content")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    const modelInput = overlay.querySelector("[data-price-field='model']")!;
    const inputPrice = overlay.querySelector("[data-price-field='input']")!;
    const setEditor = (model: string, input: string, cached: string, write: string, output: string) => {
      modelInput.value = model;
      inputPrice.value = input;
      overlay.querySelector("[data-price-field='cachedInput']")!.value = cached;
      overlay.querySelector("[data-price-field='cacheWrite']")!.value = write;
      overlay.querySelector("[data-price-field='output']")!.value = output;
    };
    const rowFor = (model: string) => overlay.querySelectorAll("[data-price-pick]").find((row) => row.dataset.pricePick === model) || null;
    const assertShellIdentity = () => {
      assert.equal(harness.document.querySelector(".cltc-settings-overlay"), overlay);
      assert.equal(overlay.querySelector(".cltc-settings-modal"), modal);
      assert.equal(overlay.querySelector(".cltc-settings-content"), content);
    };

    setEditor("custom-price", "1.25", "0.25", "", "9");
    modelInput.selectionStart = 2;
    modelInput.selectionEnd = 6;
    modelInput.focus();
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();
    assertShellIdentity();
    assert.equal(overlay.querySelector("[data-price-field='model']"), modelInput);
    assert.equal(modelInput.value, "custom-price");
    assert.equal(modelInput.selectionStart, 2);
    assert.equal(modelInput.selectionEnd, 6);
    assert.equal(overlay.querySelector(".cltc-price-meta")!.textContent, "custom-price · 自定义");
    assert.deepEqual(rowFor("custom-price")!.children.map((cell) => cell.textContent), ["custom-price", "1.25", "0.25", "-", "9"]);

    inputPrice.value = "2";
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();
    assertShellIdentity();
    assert.equal(overlay.querySelector("[data-price-field='input']"), inputPrice);
    assert.equal(rowFor("custom-price")!.children[1].textContent, "2");

    overlay.querySelector("[data-action='delete-price']")!.click();
    await harness.settle();
    assertShellIdentity();
    assert.equal(rowFor("custom-price"), null);
    assert.equal(overlay.querySelector("[data-price-field='model']")!.value, "gpt-5.6-sol");
    assert.equal(overlay.querySelector(".cltc-price-meta")!.textContent, "gpt-5.6-sol · 默认");

    const currentModel = overlay.querySelector("[data-price-field='model']")!;
    setEditor("gpt-5.6-sol", "9", "0.9", "7", "40");
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();
    assert.equal(rowFor("gpt-5.6-sol")!.children[1].textContent, "9");
    overlay.querySelector("[data-action='reset-price']")!.click();
    await harness.settle();
    assertShellIdentity();
    assert.equal(overlay.querySelector("[data-price-field='model']"), currentModel);
    assert.deepEqual(rowFor("gpt-5.6-sol")!.children.map((cell) => cell.textContent), ["gpt-5.6-sol", "5", "0.5", "6.25", "30"]);
    assert.equal(overlay.querySelector(".cltc-price-meta")!.textContent, "gpt-5.6-sol · 默认");
    assert.equal(overlay.querySelector("[data-price-field='input']")!.value, "5");
  });

  it("binds each lazy context close to only the module record that owns it", async () => {
    const harness = await createHarness();
    harness.run();
    await harness.settle();
    const closes: Array<() => boolean> = [];
    const unmounts: number[] = [];
    let factories = 0;
    harness.window.__codexLiveTokenCostV1.registerModule("settings", (context: any) => {
      const index = factories++;
      closes.push(context.close);
      unmounts[index] = 0;
      return {
        mount() {},
        unmount() { unmounts[index] += 1; },
      };
    });
    const settingsButton = harness.document.getElementById("codex-live-token-cost-settings")!;
    settingsButton.click();
    assert.equal(factories, 1);
    assert.equal(closes[0](), true);
    assert.deepEqual(unmounts, [1]);

    settingsButton.click();
    assert.equal(factories, 2);
    assert.equal(closes[0](), false, "a stale owner close must be inert");
    assert.deepEqual(unmounts, [1, 0]);
    settingsButton.click();
    assert.equal(factories, 2, "the second record must still be active");
    assert.equal(closes[1](), true);
    assert.deepEqual(unmounts, [1, 1]);
  });

  it("processes only the native-valid 64-override config boundary", async () => {
    let ownKeysCalls = 0;
    let enumeratedKeys = 0;
    let descriptors = 0;
    let reads = 0;
    const target: Record<string, any> = {};
    const price = {
      input_nanos_per_million: 1_000_000_000,
      cached_input_nanos_per_million: null,
      cache_write_nanos_per_million: null,
      output_nanos_per_million: 2_000_000_000,
    };
    for (let index = 0; index < 64; index += 1) target[`override-${String(index).padStart(2, "0")}`] = price;
    const priceOverrides = new Proxy(target, {
      ownKeys(object) {
        const keys = Reflect.ownKeys(object);
        ownKeysCalls += 1;
        enumeratedKeys += keys.length;
        return keys;
      },
      get(object, key, receiver) { reads += 1; return Reflect.get(object, key, receiver); },
      getOwnPropertyDescriptor(object, key) { descriptors += 1; return Reflect.getOwnPropertyDescriptor(object, key); },
    });
    const config = baseConfig({ profile_visible: false, price_overrides: priceOverrides });
    const harness = await createHarness((path, payload) => path === "/token-cost/bootstrap"
      ? successfulBootstrap(payload.instance_id, { config, snapshot: baseSnapshot(1, { model: "", profile_visible: false }) })
      : { status: "ok" });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();

    assert.equal(overlay.querySelector("[data-price-field='model']")!.value, "override-00");
    assert.ok(overlay.querySelectorAll("[data-price-pick]").length <= 64);
    assert.equal(ownKeysCalls, 1);
    assert.equal(enumeratedKeys, 64);
    assert.ok(descriptors <= 256, `descriptor budget ${descriptors}`);
    assert.ok(reads <= 256, `read budget ${reads}`);
  });

  it("settings and pricing emit exact typed mutations once and surface one retained native error", async () => {
    let config = baseConfig();
    let revision = 1;
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id, { config: structuredClone(config) });
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path !== "/token-cost/action") throw new Error(`unexpected path ${path}`);
      const action = payload.action;
      if (action.type === "set_visibility") {
        config = { ...config, hub_visible: action.hub_visible, output_rate_visible: action.output_rate_visible, profile_visible: action.profile_visible };
        return updatedResponse(config, ++revision);
      }
      if (action.type === "save_profile") {
        config = { ...config, profile: structuredClone(action.profile) };
        return updatedResponse(config, ++revision);
      }
      if (action.type === "save_price") {
        config = { ...config, price_overrides: { ...config.price_overrides, [action.model]: structuredClone(action.price) } };
        return updatedResponse(config, ++revision);
      }
      if (action.type === "delete_price" || action.type === "reset_price") {
        const price_overrides: Record<string, any> = { ...config.price_overrides };
        delete price_overrides[action.model];
        config = { ...config, price_overrides };
        return updatedResponse(config, ++revision);
      }
      if (action.type === "sync_cc_switch") return { status: "ok", response: { type: "synced", imported_turns: 3, analytics: { from_day: "2026-08-15", to_day: "2026-08-15", totals: {}, days: [], models: [] } } };
      if (action.type === "dispose_instance") return { status: "ok", response: { type: "disposed" } };
      throw new Error(`unexpected action ${action.type}`);
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;

    overlay.querySelector("[data-settings-panel='general']")!.click();
    overlay.querySelector("[data-misc-field='hubVisible']")!.checked = false;
    overlay.querySelector("[data-misc-field='outputRateVisible']")!.checked = false;
    const profileVisibility = overlay.querySelector("[data-misc-field='profileUnlockEnabled']")!;
    profileVisibility.checked = true;
    profileVisibility.dispatchEvent(new FakeEvent("change"));
    await harness.settle();
    assert.deepEqual(actionCalls(harness, "set_visibility").map((call) => call.payload.action), [{
      type: "set_visibility", hub_visible: false, output_rate_visible: false, profile_visible: true,
      instance_id: harness.window.__codexLiveTokenCostV1.instanceId,
    }]);
    overlay.querySelector("[data-action='sync-cc-switch']")!.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "sync_cc_switch").length, 1);
    assert.match(overlay.querySelector("[data-settings-status='sync']")!.textContent, /已同步 3 条/);

    overlay.querySelector("[data-settings-panel='profile']")!.click();
    overlay.querySelector("[data-profile-field='email']")!.value = "local@example.com";
    overlay.querySelector("[data-profile-field='planType']")!.value = "custom";
    overlay.querySelector("[data-profile-field='planCustom']")!.value = "Team Enterprise";
    overlay.querySelector("[data-action='save-profile']")!.click();
    await harness.settle();
    assert.deepEqual(actionCalls(harness, "save_profile").at(-1)!.payload.action.profile, {
      ...baseConfig().profile,
      email: "local@example.com",
      plan_type: "Team Enterprise",
      plan_label: "Team Enterprise",
    });

    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    const values: Record<string, string> = {
      model: "gpt-5.6-sol-custom", input: "1.25", cachedInput: "", cacheWrite: "0.000000001", output: "12.345678901",
    };
    for (const [field, value] of Object.entries(values)) overlay.querySelector(`[data-price-field='${field}']`)!.value = value;
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();
    assert.deepEqual(actionCalls(harness, "save_price").at(-1)!.payload.action, {
      type: "save_price",
      instance_id: harness.window.__codexLiveTokenCostV1.instanceId,
      model: "gpt-5.6-sol-custom",
      price: {
        input_nanos_per_million: 1_250_000_000,
        cached_input_nanos_per_million: null,
        cache_write_nanos_per_million: 1,
        output_nanos_per_million: 12_345_678_901,
      },
    });
    overlay.querySelector("[data-action='delete-price']")!.click();
    overlay.querySelector("[data-action='reset-price']")!.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "delete_price").length, 1);
    assert.equal(actionCalls(harness, "reset_price").length, 1);

    const input = overlay.querySelector("[data-price-field='input']")!;
    input.value = "7.125";
    overlay.querySelector("[data-price-field='output']")!.value = "1";
    harness.setBridge((path, payload) => {
      if (path === "/token-cost/action" && payload.action.type === "save_price") return Promise.reject(new Error("disk full"));
      return { status: "ok" };
    });
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();
    assert.equal(input.value, "7.125");
    assert.equal(overlay.querySelectorAll(".cltc-settings-error").length, 1);
    assert.match(overlay.querySelector(".cltc-settings-error")!.textContent, /保存失败/);

    harness.setBridge((path, payload) => path === "/token-cost/action" && payload.action.type === "save_price"
      ? updatedResponse(config, ++revision)
      : { status: "ok" });
    overlay.querySelector("[data-action='save-price']")!.click();
    await harness.settle();
    assert.equal(Boolean(overlay.querySelector(".cltc-settings-error")), false, "an explicit successful retry clears the old error");
  });

  it("pricing exposes bounded native override rows for explicit editing", async () => {
    const price = {
      input_nanos_per_million: 1_500_000_000,
      cached_input_nanos_per_million: 250_000_000,
      cache_write_nanos_per_million: null,
      output_nanos_per_million: 9_000_000_000,
    };
    const config = baseConfig({ price_overrides: { "existing-model": price } });
    const harness = await createHarness((path, payload) => path === "/token-cost/bootstrap"
      ? successfulBootstrap(payload.instance_id, { config, snapshot: baseSnapshot(1, { model: "gpt-5.6-sol" }) })
      : { status: "ok" });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    const row = overlay.querySelector("[data-price-pick='existing-model']")!;
    assert.ok(row);
    row.click();
    assert.equal(overlay.querySelector("[data-price-field='model']")!.value, "existing-model");
    assert.equal(overlay.querySelector("[data-price-field='input']")!.value, "1.5");
    assert.equal(overlay.querySelector("[data-price-field='cachedInput']")!.value, "0.25");
    assert.equal(overlay.querySelector("[data-price-field='cacheWrite']")!.value, "");
    assert.equal(overlay.querySelector("[data-price-field='output']")!.value, "9");
    assert.ok(overlay.querySelectorAll("[data-price-pick]").length <= 64);
  });

  it("pricing keeps the current model and native defaults ahead of bounded overrides", async () => {
    const price = {
      input_nanos_per_million: 1_000_000_000,
      cached_input_nanos_per_million: null,
      cache_write_nanos_per_million: null,
      output_nanos_per_million: 2_000_000_000,
    };
    const price_overrides = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
      `a-model-${String(index).padStart(2, "0")}`,
      price,
    ]));
    const config = baseConfig({ price_overrides });
    const harness = await createHarness((path, payload) => path === "/token-cost/bootstrap"
      ? successfulBootstrap(payload.instance_id, { config, snapshot: baseSnapshot(1, { model: "zz-current" }) })
      : { status: "ok" });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();

    const models = overlay.querySelectorAll("[data-price-pick]").map((row) => row.dataset.pricePick);
    assert.ok(models.length <= 64);
    assert.ok(models.includes("zz-current"));
    for (const model of [
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.3-codex", "gpt-5.4",
      "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro",
    ]) assert.ok(models.includes(model), model);
  });

  it("matches the frozen 0.8.3 settings DOM copy and computed CSS contract", async () => {
    const harness = await createHarness();
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    const style = harness.document.getElementById("codex-live-token-cost-settings-style")!;
    const root = cssDeclarations(style.textContent, ".cltc-settings-overlay");
    assert.deepEqual(Object.fromEntries([...root].filter(([name]) => name.startsWith("--cltc-")).slice(0, 12)), {
      "--cltc-text": "var(--color-token-text-primary, light-dark(#111827, #f4f4f5))",
      "--cltc-muted": "var(--color-token-text-tertiary, light-dark(#6b7280, #a1a1aa))",
      "--cltc-border": "var(--color-token-border-light, light-dark(#d1d5db, #3f3f46))",
      "--cltc-border-subtle": "var(--color-token-border-light, light-dark(#e5e7eb, #323238))",
      "--cltc-surface": "var(--color-token-main-surface-primary, light-dark(#ffffff, #18181b))",
      "--cltc-surface-secondary": "var(--color-token-main-surface-secondary, light-dark(#f3f4f6, #27272a))",
      "--cltc-popover": "var(--color-token-dropdown-background, var(--color-token-main-surface-primary, light-dark(#ffffff, #18181b)))",
      "--cltc-input": "var(--color-token-input-background, var(--color-token-main-surface-primary, light-dark(#ffffff, #18181b)))",
      "--cltc-hover": "var(--color-token-list-hover-background, light-dark(rgba(0, 0, 0, .06), rgba(255, 255, 255, .08)))",
      "--cltc-shadow": "light-dark(rgba(0, 0, 0, .18), rgba(0, 0, 0, .48))",
      "--cltc-primary": "var(--color-token-text-primary, light-dark(#171717, #f4f4f5))",
      "--cltc-primary-text": "var(--color-token-main-surface-primary, light-dark(#ffffff, #18181b))",
    });
    assert.equal(root.get("--cltc-danger"), "light-dark(#b42318, #f97066)");

    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    const activeRow = overlay.querySelector(".cltc-price-row[data-active='true']")!;
    assert.equal(activeRow.className, "cltc-price-row");
    assert.equal(activeRow.dataset.active, "true");
    assert.equal(activeRow.dataset.pricePick, "gpt-5.6-sol");
    const active = cssDeclarations(style.textContent, ".cltc-settings-overlay .cltc-price-row[data-active=\"true\"]");
    assert.equal(resolveSettingsCssValue(active.get("background"), root), root.get("--cltc-hover"));
    assert.equal(active.get("font-weight"), "650");
    const meta = cssDeclarations(style.textContent, ".cltc-settings-overlay .cltc-price-meta");
    assert.equal(meta.get("margin-top"), "-12px");
    assert.equal(resolveSettingsCssValue(meta.get("color"), root), root.get("--cltc-muted"));
    assert.equal(meta.get("font-size"), "12px");
    assert.equal(cssDeclarations(style.textContent, ".cltc-settings-overlay .cltc-price-list").has("color"), false);

    overlay.querySelector("[data-settings-panel='general']")!.click();
    const helper = overlay.querySelector("[data-field='helper-status']")!;
    assert.ok(helper);
    assert.equal(helper.className, "cltc-sync-status");
    assert.equal(helper.getAttribute("data-helper-unavailable"), "false");
    assert.equal(helper.textContent, "Helper 可选：未连接时使用本地 Profile ledger；CC Switch 同步不可用。");
  });

  it("pricing validates exact nanodollar boundaries before any bridge action", async () => {
    const savedPrices: Record<string, any> = {};
    const savedConfig = baseConfig({ price_overrides: savedPrices });
    let revision = 1;
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (payload.action.type === "save_price") {
        savedPrices[payload.action.model] = structuredClone(payload.action.price);
      }
      return updatedResponse(savedConfig, revision += 1);
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    overlay.querySelector("[data-price-field='model']")!.value = "boundary-model";
    overlay.querySelector("[data-price-field='cachedInput']")!.value = "";
    overlay.querySelector("[data-price-field='cacheWrite']")!.value = "";
    overlay.querySelector("[data-price-field='output']")!.value = "0";
    const input = overlay.querySelector("[data-price-field='input']")!;
    const save = overlay.querySelector("[data-action='save-price']")!;

    for (const [text, expected] of [["0", 0], ["0.000000001", 1], ["1.25", 1_250_000_000], ["9007199.254740991", 9_007_199_254_740_991]] as const) {
      input.value = text;
      save.click();
      await harness.settle();
      assert.equal(actionCalls(harness, "save_price").at(-1)!.payload.action.price.input_nanos_per_million, expected, text);
    }
    overlay.querySelector("[data-price-field='model']")!.value = "deepseek-v4-pro[1M]";
    input.value = "1";
    save.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "save_price").at(-1)!.payload.action.model, "deepseek-v4-pro[1M]");
    const validCount = actionCalls(harness, "save_price").length;
    for (const text of ["", "-1", "+1", "1e2", " 1", "1 ", "0.0000000001", "9007199.254740992"]) {
      input.value = text;
      save.click();
      await harness.settle();
      assert.equal(actionCalls(harness, "save_price").length, validCount, text);
      assert.equal(overlay.querySelectorAll(".cltc-settings-error").length, 1, text);
    }
    overlay.querySelector("[data-price-field='model']")!.value = "";
    input.value = "1";
    save.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "save_price").length, validCount);
  });

  it("settings lazy source stays inert and startup retains its performance boundary", async () => {
    const [startup, settings] = await Promise.all([
      readFile(new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url), "utf8"),
      readFile(new URL("../../../assets/live_token_cost/settings.js", import.meta.url), "utf8"),
    ]);
    assert.ok(Buffer.byteLength(startup) <= 61_440);
    assert.doesNotMatch(startup, /\.cltc-settings-modal|data-price-field|input_nanos_per_million/);
    assert.match(settings, /registerModule\("settings"/);
    assert.match(settings, /个人资料[\s\S]*数据与显示[\s\S]*使用统计[\s\S]*模型价格/);
    for (const forbidden of [
      "localStorage", "sessionStorage", "setInterval", "MutationObserver", "ResizeObserver",
      "requestAnimationFrame", "XMLHttpRequest", "WebSocket", "new Function", ".innerHTML", "offsetWidth", "__reactFiber",
      "fetch(", "eval(",
    ]) assert.equal(settings.includes(forbidden), false, forbidden);
  });

  it("projects and restores only the exact lifecycle-supplied Profile menu", async () => {
    const harness = await createHarness();
    const profile = installProfileMenu(harness.document);
    const decoy = installProfileMenu(harness.document, "decoy-menu");
    harness.run();
    await harness.settle();
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_menu", profile: true, profileMenuId: profile.menu.id },
    }));
    assert.equal(profile.identityItem.getAttribute("data-codex-plus-token-cost-profile-entry"), "true");
    assert.equal(profile.identityItem.className, "menu-enabled");
    assert.equal(profile.identityItem.hasAttribute("aria-disabled"), false);
    assert.equal(profile.identityItem.hasAttribute("data-disabled"), false);
    assert.equal(profile.identityItem.getAttribute("tabindex"), "0");
    assert.equal(profile.label.textContent, "Local Usage");
    assert.equal(profile.avatar.classList.contains("size-8"), true);
    assert.equal(decoy.label.textContent, "Account");
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_menu", profile: true, profileMenuId: "missing-menu" },
    }));
    assert.equal(profile.identityItem.className, "menu-disabled", "each explicit projection restores earlier connected rows first");
    assert.equal(profile.label.textContent, "Account");
    assert.equal(profile.identityItem.getAttribute("aria-disabled"), "true");
    assert.equal(profile.identityItem.hasAttribute("data-disabled"), true);
    assert.equal(profile.identityItem.getAttribute("tabindex"), "-1");
  });

  it("rejects malformed Profile menu structures without partial mutation", async () => {
    const harness = await createHarness();
    const profile = installProfileMenu(harness.document);
    harness.run();
    await harness.settle();
    const project = () => harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_menu", profile: true, profileMenuId: profile.menu.id },
    }));
    const assertUntouched = () => {
      assert.equal(profile.identityItem.getAttribute("data-codex-plus-token-cost-profile-entry"), null);
      assert.equal(profile.identityItem.className, "menu-disabled");
      assert.equal(profile.label.textContent, "Account");
    };

    profile.menu.setAttribute("role", "dialog");
    project();
    assertUntouched();
    profile.menu.setAttribute("role", "menu");
    profile.menu.setAttribute("aria-labelledby", "wrong-trigger");
    project();
    assertUntouched();
    profile.menu.setAttribute("aria-labelledby", profile.trigger.id);
    const duplicateIdentity = harness.document.createElement("button");
    duplicateIdentity.setAttribute("role", "menuitem");
    duplicateIdentity.setAttribute("aria-disabled", "true");
    profile.group.appendChild(duplicateIdentity);
    project();
    assertUntouched();
    duplicateIdentity.remove();
    profile.settings.textContent = "Preferences";
    project();
    assertUntouched();
  });

  it("requires both identity disabled markers, one enabled Settings sibling, and bounded trigger identity", async (context) => {
    const cases: Array<[string, (profile: ReturnType<typeof installProfileMenu>, document: FakeDocument) => void]> = [
      ["missing data-disabled", (profile) => profile.identityItem.removeAttribute("data-disabled")],
      ["missing aria-disabled", (profile) => profile.identityItem.removeAttribute("aria-disabled")],
      ["second enabled Settings", (profile, document) => {
        const duplicateSettings = document.createElement("button");
        duplicateSettings.setAttribute("role", "menuitem");
        duplicateSettings.textContent = "Settings";
        profile.group.appendChild(duplicateSettings);
      }],
      ["oversized trigger identity", (profile) => {
        profile.trigger.id = "t".repeat(161);
        profile.menu.setAttribute("aria-labelledby", profile.trigger.id);
      }],
    ];

    for (const [name, mutate] of cases) {
      await context.test(name, async () => {
        const harness = await createHarness();
        const profile = installProfileMenu(harness.document);
        mutate(profile, harness.document);
        harness.run();
        await harness.settle();
        harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
          detail: { reason: "profile_menu", profile: true, profileMenuId: profile.menu.id },
        }));
        assert.equal(profile.identityItem.getAttribute("data-codex-plus-token-cost-profile-entry"), null);
        assert.equal(profile.identityItem.className, "menu-disabled");
        assert.equal(profile.label.textContent, "Account");
      });
    }
  });

  it("updates a connected projected Profile name and avatar while preserving its original restore state", async () => {
    const harness = await createHarness();
    const profile = installProfileMenu(harness.document);
    harness.run();
    await harness.settle();
    const api = harness.window.__codexLiveTokenCostV1;
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_menu", profile: true, profileMenuId: profile.menu.id },
    }));
    harness.setBridge((path) => path === "/token-cost/action" ? {
      status: "ok",
      response: {
        type: "updated",
        config: baseConfig({
          profile: { ...baseConfig().profile, display_name: "New Local", avatar_data_url: "data:image/png;base64,AAAA" },
        }),
        snapshot: baseSnapshot(2),
      },
    } : null);

    await api.emitAction({ type: "save_profile", profile: baseConfig().profile });
    assert.equal(profile.label.textContent, "New Local");
    assert.match(profile.avatar.style.getPropertyValue("background-image"), /^url\("data:image\/png;base64,AAAA"\)$/);
    api.destroy();
    assert.equal(profile.label.textContent, "Account");
    assert.equal(profile.avatar.textContent, "A");
    assert.equal(profile.avatar.style.cssText, "");
  });

  it("restores and skips Profile projection when native visibility is disabled", async () => {
    const harness = await createHarness();
    const profile = installProfileMenu(harness.document);
    harness.run();
    await harness.settle();
    const api = harness.window.__codexLiveTokenCostV1;
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_menu", profile: true, profileMenuId: profile.menu.id },
    }));
    assert.equal(profile.label.textContent, "Local Usage");
    harness.setBridge((path) => path === "/token-cost/action" ? {
      status: "ok",
      response: {
        type: "updated",
        config: baseConfig({ profile_visible: false }),
        snapshot: baseSnapshot(2, { profile_visible: false }),
      },
    } : null);

    await api.emitAction({ type: "set_visibility", profile_visible: false });
    assert.equal(profile.identityItem.getAttribute("data-codex-plus-token-cost-profile-entry"), null);
    assert.equal(profile.identityItem.className, "menu-disabled");
    assert.equal(profile.label.textContent, "Account");
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_menu", profile: true, profileMenuId: profile.menu.id },
    }));
    assert.equal(profile.identityItem.getAttribute("data-codex-plus-token-cost-profile-entry"), null);
    assert.equal(profile.label.textContent, "Account");
  });

  it("uses the latest native snapshot visibility when a Profile lifecycle follows a direct push", async () => {
    const harness = await createHarness();
    const profile = installProfileMenu(harness.document);
    harness.run();
    await harness.settle();
    const api = harness.window.__codexLiveTokenCostV1;
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_menu", profile: true, profileMenuId: profile.menu.id },
    }));
    assert.equal(profile.label.textContent, "Local Usage");
    assert.equal(api.acceptNativePush({
      type: "snapshot",
      instance_id: api.instanceId,
      snapshot: baseSnapshot(2, { profile_visible: false }),
    }), true);
    assert.equal(profile.label.textContent, "Account");

    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_menu", profile: true, profileMenuId: profile.menu.id },
    }));
    assert.equal(profile.identityItem.getAttribute("data-codex-plus-token-cost-profile-entry"), null);
    assert.equal(profile.label.textContent, "Account");
  });

  it("cancels a pending bootstrap retry during destroy", async () => {
    const harness = await createHarness(() => Promise.reject(new Error("offline")));
    harness.run();
    await harness.settle();
    assert.equal(harness.clock.tasks.size, 1);
    const api = harness.window.__codexLiveTokenCostV1;
    api.destroy();
    assert.equal(harness.clock.tasks.size, 0);
    harness.clock.advance(60_000);
    await harness.settle();
    assert.equal(harness.bridgeCalls.filter((call) => call.path === "/token-cost/bootstrap").length, 1);
  });

  it("destroys idempotently, restores connected rows, and ignores stale async work", async () => {
    let resolveBootstrap!: (value: any) => void;
    const pending = new Promise((resolve) => { resolveBootstrap = resolve; });
    const harness = await createHarness(() => pending);
    const profile = installProfileMenu(harness.document);
    harness.run();
    const api = harness.window.__codexLiveTokenCostV1;
    api.destroy();
    api.destroy();
    resolveBootstrap(successfulBootstrap(api.instanceId));
    await harness.settle();
    assert.equal(harness.window.__codexLiveTokenCostV1, undefined);
    assert.equal(harness.window.__codexLiveTokenCostCaptureV1, undefined);
    assert.equal(harness.document.getElementById("codex-live-token-cost"), null);
    assert.equal(harness.document.getElementById("codex-live-token-cost-settings"), null);
    assert.equal(harness.document.getElementById("codex-live-token-cost-style"), null);
    assert.equal(listenerCount(harness.document, "click"), 0);
    assert.equal(listenerCount(harness.document, "change"), 0);
    assert.equal(listenerCount(harness.document, "codex-plus:token-cost-lifecycle"), 0);
    assert.equal(events(harness.document, "codex-plus:token-cost-deactivate").length, 1);
    assert.equal(events(harness.document, "codex-plus:token-cost-activate").length, 0);
    assert.equal(harness.bridgeCalls.filter((call) => call.path === "/token-cost/action").length, 1);
    assert.deepEqual(harness.bridgeCalls.find((call) => call.path === "/token-cost/action")!.payload, {
      action: { type: "dispose_instance", instance_id: api.instanceId },
    });
    assert.equal(profile.identityItem.getAttribute("data-codex-plus-token-cost-profile-entry"), null);
    assert.equal(api.acceptNativePush({ type: "snapshot", instance_id: api.instanceId, snapshot: baseSnapshot(9) }), false);
  });
});
