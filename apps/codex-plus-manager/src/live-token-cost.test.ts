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

  constructor(type: string, init: Record<string, any> = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this.detail = init.detail;
    this.target = init.target || null;
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
  set disabled(value: boolean) { this.propertyWrites += 1; this.ownerDocument.propertyWrites += 1; this.disabledValue = Boolean(value); }
  get hidden() { return this.hiddenValue; }
  set hidden(value: boolean) { this.propertyWrites += 1; this.ownerDocument.propertyWrites += 1; this.hiddenValue = Boolean(value); }
  get title() { return this.titleValue; }
  set title(value: string) { this.propertyWrites += 1; this.ownerDocument.propertyWrites += 1; this.titleValue = String(value); }
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
    this.attributes.delete(key);
    if (key === "id") this.id = "";
    if (key === "class") this.className = "";
    if (key === "hidden") this.hidden = false;
    if (key === "disabled") this.disabled = false;
  }
  append(...nodes: FakeElement[]) { nodes.forEach((node) => this.appendChild(node)); }
  appendChild<T extends FakeElement>(node: T): T {
    node.remove();
    this.ownText = "";
    this.children.push(node);
    node.parentElement = this;
    return node;
  }
  insertBefore<T extends FakeElement>(node: T, before: FakeElement | null): T {
    node.remove();
    this.ownText = "";
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    node.parentElement = this;
    return node;
  }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
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
  observerCount = 0;

  constructor() {
    this.documentElement = new FakeElement(this, "html");
    this.head = new FakeElement(this, "head");
    this.body = new FakeElement(this, "body");
    this.documentElement.append(this.head, this.body);
  }
  createElement(tagName: string) { return new FakeElement(this, tagName); }
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
  settle: () => Promise<void>;
  setBridge: (handler: (path: string, payload: any) => any) => void;
};

async function createHarness(initialBridge?: (path: string, payload: any) => any): Promise<Harness> {
  const source = await readFile(new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url), "utf8");
  const document = new FakeDocument();
  const clock = new FakeClock();
  const bridgeCalls: BridgeCall[] = [];
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
      return Promise.resolve().then(() => bridge(path, payload));
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
