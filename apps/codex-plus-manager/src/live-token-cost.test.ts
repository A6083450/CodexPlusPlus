import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { performance as nodePerformance } from "node:perf_hooks";
import vm from "node:vm";

type Listener = (event: FakeEvent) => void;
type BridgeCall = { at: number; path: string; payload: any };

class FakeEvent {
  type: string;
  bubbles: boolean;
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
  initEvent(type: string, bubbles: boolean) { this.type = type; this.bubbles = bubbles; }
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
  private readonly owner: FakeElement;
  private readonly values = new Map<string, string>();
  constructor(owner: FakeElement) { this.owner = owner; }
  setProperty(name: string, value: string) {
    this.values.set(name, String(value));
    if (this.owner.isConnected) this.owner.ownerDocument.recordConnectedMutation(`style:${name}`, this.owner);
  }
  getPropertyValue(name: string) { return this.values.get(name) || ""; }
  removeProperty(name: string) {
    if (this.values.delete(name) && this.owner.isConnected) this.owner.ownerDocument.recordConnectedMutation(`remove-style:${name}`, this.owner);
  }
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
  readonly namespaceURI: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly style: FakeStyle & Record<string, any>;
  readonly dataset: Record<string, string>;
  id = "";
  className = "";
  parentElement: FakeElement | null = null;
  type = "";
  private valueValue = "";
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

  constructor(ownerDocument: FakeDocument, tagName: string, namespaceURI = "http://www.w3.org/1999/xhtml") {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = namespaceURI;
    this.style = new FakeStyle(this) as FakeStyle & Record<string, any>;
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
  get firstChild(): FakeElement | null { return this.children[0] || null; }
  get lastChild(): FakeElement | null { return this.children.at(-1) || null; }
  get parentNode() { return this.parentElement; }
  get nodeName() { return this.tagName; }
  get nodeType() { return 1; }
  get offsetWidth() { return 280; }
  get offsetHeight() { return 36; }
  get disabled() { return this.disabledValue; }
  set disabled(value: boolean) { this.propertyWrites += 1; this.ownerDocument.propertyWrites += 1; this.ownerDocument.domOperations += 1; if (this.isConnected) this.ownerDocument.recordConnectedMutation("property:disabled", this); this.disabledValue = Boolean(value); }
  get hidden() { return this.hiddenValue; }
  set hidden(value: boolean) { this.propertyWrites += 1; this.ownerDocument.propertyWrites += 1; this.ownerDocument.domOperations += 1; if (this.isConnected) this.ownerDocument.recordConnectedMutation("property:hidden", this); this.hiddenValue = Boolean(value); }
  get title() { return this.titleValue; }
  set title(value: string) { this.propertyWrites += 1; this.ownerDocument.propertyWrites += 1; this.ownerDocument.domOperations += 1; this.titleValue = String(value); }
  get value() { return this.valueValue; }
  set value(value: string) {
    if (this.isConnected) this.ownerDocument.recordConnectedMutation("property:value", this);
    this.valueValue = String(value);
  }
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
    if (this.isConnected) this.ownerDocument.recordConnectedMutation("text", this);
    this.textWrites += 1;
    if (this.children.length > 0) this.ownerDocument.structuralMutations += 1;
    this.children.splice(0).forEach((child) => { child.parentElement = null; });
    this.ownText = text;
  }
  get innerHTML() { return this.textContent; }
  set innerHTML(value: string) {
    this.ownerDocument.innerHtmlWrites += 1;
    this.ownerDocument.structuralMutations += 1;
    this.textContent = String(value);
  }

  setAttribute(name: string, value: string) {
    this.attributeWrites += 1;
    this.ownerDocument.attributeWrites += 1;
    this.ownerDocument.domOperations += 1;
    if (this.isConnected) this.ownerDocument.recordConnectedMutation(`attribute:${name.toLowerCase()}`, this);
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
    if (this.hasAttribute(key)) {
      this.ownerDocument.domOperations += 1;
      if (this.isConnected) this.ownerDocument.recordConnectedMutation(`remove-attribute:${key}`, this);
    }
    this.attributes.delete(key);
    if (key === "id") this.id = "";
    if (key === "class") this.className = "";
    if (key === "hidden") this.hidden = false;
    if (key === "disabled") this.disabled = false;
    if (key === "checked") this.checked = false;
  }
  append(...nodes: FakeElement[]) { nodes.forEach((node) => this.appendChild(node)); }
  appendChild<T extends FakeElement>(node: T): T {
    if (node.tagName === "#DOCUMENT-FRAGMENT") {
      for (const child of [...node.children]) this.appendChild(child);
      return node;
    }
    node.remove();
    this.ownText = "";
    this.children.push(node);
    node.parentElement = this;
    this.ownerDocument.domOperations += 1;
    this.ownerDocument.structuralMutations += 1;
    if (this.isConnected) this.ownerDocument.recordConnectedMutation("append", this, node);
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
    this.ownerDocument.structuralMutations += 1;
    if (this.isConnected) this.ownerDocument.recordConnectedMutation("insert", this, node);
    return node;
  }
  remove() {
    if (!this.parentElement) return;
    const wasConnected = this.isConnected;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
    this.ownerDocument.domOperations += 1;
    this.ownerDocument.structuralMutations += 1;
    if (wasConnected) this.ownerDocument.recordConnectedMutation("remove", this);
  }
  removeChild<T extends FakeElement>(node: T): T { node.remove(); return node; }
  replaceChildren(...nodes: FakeElement[]) {
    for (const child of [...this.children]) child.remove();
    this.ownText = "";
    for (const node of nodes) this.appendChild(node);
  }
  getRootNode() { return this.ownerDocument; }
  getBoundingClientRect() { return { top: 80, right: 280, bottom: 116, left: 20, width: 260, height: 36, x: 20, y: 80 }; }
  getElementsByTagName(tagName: string) { return this.querySelectorAll(tagName); }
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
  connectedDomMutations = 0;
  readonly connectedMutationRecords: Array<{ kind: string; target: FakeElement; targetClass: string; node?: FakeElement }> = [];
  structuralMutations = 0;
  observerCount = 0;
  activeElement: FakeElement;

  constructor() {
    this.documentElement = new FakeElement(this, "html");
    this.head = new FakeElement(this, "head");
    this.body = new FakeElement(this, "body");
    this.activeElement = this.body;
    this.documentElement.append(this.head, this.body);
  }
  recordConnectedMutation(kind: string, target: FakeElement, node?: FakeElement) {
    this.connectedDomMutations += 1;
    this.connectedMutationRecords.push({ kind, target, targetClass: target.className, node });
  }
  createElement(tagName: string) { this.domOperations += 1; return new FakeElement(this, tagName); }
  createElementNS(namespaceURI: string, tagName: string) { this.domOperations += 1; return new FakeElement(this, tagName, namespaceURI); }
  createDocumentFragment() { this.domOperations += 1; return new FakeElement(this, "#document-fragment"); }
  createEvent(type: string) { return new FakeEvent(type); }
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

function nativeDiagnostics(overrides: Record<string, number> = {}) {
  return {
    events_ingested: 100,
    events_coalesced: 20,
    events_rejected: 0,
    queue_depth: 0,
    queue_high_water: 1,
    recent_turns: 12,
    dedupe_fingerprints: 4,
    snapshots_published: 8,
    snapshots_sent: 7,
    lazy_commands_sent: 0,
    ...overrides,
  };
}

function nativeDiagnosticsResponse(overrides: Record<string, number> = {}) {
  return { status: "ok", response: { type: "diagnostics", diagnostics: nativeDiagnostics(overrides) } };
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
  runAnalytics: () => void;
  runProfile: () => void;
  runFlatpickr: () => void;
  evaluate: (source: string) => any;
  settle: () => Promise<void>;
  settleBridgeCalls: () => Promise<void>;
  setBridge: (handler: (path: string, payload: any) => any) => void;
};

async function createHarness(initialBridge?: (path: string, payload: any) => any): Promise<Harness> {
  const [source, settingsSource, analyticsSource, profileSource, flatpickrSource, flatpickrCss] = await Promise.all([
    readFile(new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url), "utf8"),
    readFile(new URL("../../../assets/live_token_cost/settings.js", import.meta.url), "utf8"),
    readFile(new URL("../../../assets/live_token_cost/analytics.js", import.meta.url), "utf8"),
    readFile(new URL("../../../assets/live_token_cost/profile.js", import.meta.url), "utf8"),
    readFile(new URL("../../../assets/live_token_cost/flatpickr.js", import.meta.url), "utf8"),
    readFile(new URL("../../../assets/live_token_cost/flatpickr.css", import.meta.url), "utf8"),
  ]);
  const document = new FakeDocument();
  const clock = new FakeClock();
  const bridgeCalls: BridgeCall[] = [];
  const bridgePromises: Promise<any>[] = [];
  const windowListeners = new Map<string, Listener[]>();
  let bridge = initialBridge || ((path: string, payload: any) => {
    if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
    if (path === "/token-cost/action" && payload.action?.type === "query_diagnostics") return nativeDiagnosticsResponse();
    return { status: "ok" };
  });

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
    listeners: windowListeners,
    addEventListener(type: string, listener: Listener) {
      windowListeners.set(type, [...(windowListeners.get(type) || []), listener]);
    },
    removeEventListener(type: string, listener: Listener) {
      windowListeners.set(type, (windowListeners.get(type) || []).filter((value) => value !== listener));
    },
    dispatchEvent() { return true; },
    postMessage() {},
    navigator: { userAgent: "CodexPlusPlus test" },
    innerWidth: 1280,
    innerHeight: 800,
    pageXOffset: 0,
    pageYOffset: 0,
    fetch: function hostFetch() {},
    XMLHttpRequest: class HostXMLHttpRequest {},
    WebSocket: class HostWebSocket {},
    electronBridge: Object.freeze({ invoke() {} }),
    __hostReactContext: Object.freeze({ name: "react-context" }),
    __hostStatsig: Object.freeze({ name: "statsig" }),
    __hostAuth: Object.freeze({ name: "auth" }),
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
    Date: ClockDate, performance: nodePerformance,
    navigator: windowObject.navigator,
    HTMLElement: FakeElement, Node: FakeElement, HTMLCollection: Array, NodeList: Array,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: windowObject.setInterval, clearInterval: windowObject.clearInterval,
    MutationObserver: class { constructor() { document.observerCount += 1; } },
    fetch: windowObject.fetch, XMLHttpRequest: windowObject.XMLHttpRequest, WebSocket: windowObject.WebSocket,
    electronBridge: windowObject.electronBridge,
  };
  const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
  return {
    clock, document, bridgeCalls, window: windowObject,
    run: () => vm.runInNewContext(source, context), settle,
    evaluate: (snippet) => vm.runInNewContext(snippet, context),
    settleBridgeCalls: async () => { await Promise.allSettled(bridgePromises); },
    runSettings: () => {
      (context as Record<string, any>).api = windowObject.__codexLiveTokenCostV1;
      vm.runInNewContext(settingsSource, context);
      delete (context as Record<string, any>).api;
    },
    runAnalytics: () => {
      (context as Record<string, any>).api = windowObject.__codexLiveTokenCostV1;
      vm.runInNewContext(analyticsSource, context);
      delete (context as Record<string, any>).api;
    },
    runProfile: () => {
      (context as Record<string, any>).api = windowObject.__codexLiveTokenCostV1;
      vm.runInNewContext(profileSource, context);
      delete (context as Record<string, any>).api;
    },
    runFlatpickr: () => {
      (context as Record<string, any>).api = windowObject.__codexLiveTokenCostV1;
      (context as Record<string, any>).css = flatpickrCss;
      vm.runInNewContext(flatpickrSource, context);
      delete (context as Record<string, any>).api;
      delete (context as Record<string, any>).css;
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
  trigger.setAttribute("aria-label", "Open profile menu and settings");
  const gear = document.createElement("svg");
  const triggerLabel = document.createElement("span");
  triggerLabel.className = "min-w-0 flex-1 truncate";
  triggerLabel.textContent = "Settings";
  trigger.append(gear, triggerLabel);
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
  return { trigger, triggerLabel, gear, menu, group, identityItem, settings, avatar, label };
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

function analyticsTotals(overrides: Record<string, number> = {}) {
  return {
    turns: 0, steps: 0, input: 0, cached_input: 0, cache_write: 0, output: 0,
    cost_nanos: 0, llm_ms: 0, tool_ms: 0, first_token_total_ms: 0,
    first_token_samples: 0, generation_ms: 0, generation_output_tokens: 0,
    ...overrides,
  };
}

function analyticsSnapshot(overrides: Record<string, any> = {}) {
  return {
    from_day: "2026-08-15", to_day: "2026-08-15",
    totals: analyticsTotals({ turns: 12, steps: 34, input: 128_000, cached_input: 92_160, output: 18_000, cost_nanos: 123_000_000 }),
    days: [{ day: "2026-08-15", totals: analyticsTotals({ turns: 12, input: 128_000, output: 18_000 }) }],
    models: [{ model: "gpt-5.6-sol", totals: analyticsTotals({ turns: 12, steps: 34, input: 128_000, output: 18_000, cost_nanos: 123_000_000 }) }],
    ...overrides,
  };
}

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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
    const diagnostics = await api.diagnostics();
    assert.equal(diagnostics.captureEnabled, true);
    assert.equal(diagnostics.moduleCount, 0);
    assert.equal(diagnostics.listenerCount, 3);
    assert.equal(diagnostics.outstandingTimers, 0);
    assert.equal(diagnostics.observerCount, 0);
    assert.equal(diagnostics.bridgeCalls, 2);
    assert.equal(diagnostics.snapshotCount, 1);
    assert.ok(diagnostics.domWrites > 0);
    assert.ok(diagnostics.ownedNodeCount > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(diagnostics.mountedModules)), []);
    assert.ok(diagnostics.updateDurationsMs.length <= 256);
    assert.deepEqual(JSON.parse(JSON.stringify(diagnostics.native)), nativeDiagnostics());
    assert.equal(actionCalls(harness, "query_diagnostics").length, 1);
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
    assert.equal((await harness.window.__codexLiveTokenCostV1.diagnostics()).bootstrapAttempts, 3);
    harness.clock.advance(60_000);
    await harness.settle();
    assert.equal(harness.bridgeCalls.filter((call) => call.path === "/token-cost/bootstrap").length, 3);
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    await harness.settle();
    const bootstrapCalls = harness.bridgeCalls.filter((call) => call.path === "/token-cost/bootstrap");
    assert.equal(bootstrapCalls.length, 4);
    assert.equal(bootstrapCalls[3].at, 61_000);
  });

  it("resets an exhausted bootstrap cycle from an explicit lifecycle event", async () => {
    const harness = await createHarness(() => Promise.reject(new Error("offline")));
    harness.run();
    await harness.settle();
    harness.clock.advance(250);
    await harness.settle();
    harness.clock.advance(750);
    await harness.settle();
    assert.equal((await harness.window.__codexLiveTokenCostV1.diagnostics()).exhausted, true);
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
    assert.equal((await api.diagnostics()).moduleCount, 4);
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

  it("repaints General when a delayed visibility save hides the currently selected Profile panel", async () => {
    const visibility = deferred<any>();
    const hiddenConfig = baseConfig({ profile_visible: false });
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/action" && payload.action.type === "set_visibility") return visibility.promise;
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    overlay.querySelector("[data-settings-panel='general']")!.click();
    const profileToggle = overlay.querySelector("[data-misc-field='profileUnlockEnabled']")!;
    profileToggle.checked = false;
    profileToggle.dispatchEvent(new FakeEvent("change"));
    assert.equal(actionCalls(harness, "set_visibility").length, 1);
    overlay.querySelector("[data-settings-panel='profile']")!.click();
    assert.ok(overlay.querySelector("[data-profile-field='email']"));
    visibility.resolve(updatedResponse(hiddenConfig, 2));
    await harness.settle();
    assert.equal((await harness.window.__codexLiveTokenCostV1.diagnostics()).revision, 2);
    assert.equal(overlay.querySelector(".cltc-settings-modal")!.dataset.settingsActive, "general");
    assert.equal(overlay.querySelector("[data-settings-panel='profile']"), null);
    assert.ok(overlay.querySelector("[data-misc-field='profileUnlockEnabled']"), "General body must replace the now-hidden Profile body");
    assert.equal(overlay.querySelector("[data-profile-field='email']"), null);
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
    assert.equal((await harness.window.__codexLiveTokenCostV1.diagnostics()).revision, 3);

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
    assert.equal((await harness.window.__codexLiveTokenCostV1.diagnostics()).revision, 3);
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
    assert.equal((await harness.window.__codexLiveTokenCostV1.diagnostics()).revision, 2);
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
    assert.equal((await harness.window.__codexLiveTokenCostV1.diagnostics()).revision, 3);
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
    assert.equal((await api.diagnostics()).revision, 4);

    resolvePrice(updatedResponse(priceConfig, 2));
    await harness.settleBridgeCalls();
    await harness.settle();
    assert.equal((await api.diagnostics()).revision, 4);
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
    assert.equal(root.has("font"), false, "the frozen overlay inherits the host font metrics");
    const closeStyle = cssDeclarations(style.textContent, ".cltc-price-head button");
    assert.equal(closeStyle.get("font"), "20px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif");
    assert.equal(closeStyle.get("min-height"), "0");
    assert.equal(closeStyle.get("padding"), "0");
    assert.equal(
      closeStyle.get("transition"),
      "transform .16s cubic-bezier(.23,1,.32,1),background .16s cubic-bezier(.23,1,.32,1),color .16s cubic-bezier(.23,1,.32,1),border-color .16s cubic-bezier(.23,1,.32,1)",
    );
    const focusedCloseStyle = cssDeclarations(style.textContent, ".cltc-price-head button:focus-visible");
    assert.equal(resolveSettingsCssValue(focusedCloseStyle.get("background"), root), root.get("--cltc-hover"));
    assert.equal(focusedCloseStyle.get("outline"), "none");
    const profileSelect = cssDeclarations(style.textContent, ".cltc-profile-select");
    assert.equal(profileSelect.get("appearance"), "base-select");
    assert.equal(profileSelect.get("cursor"), "pointer");
    const profilePicker = cssDeclarations(style.textContent, ".cltc-profile-select::picker(select)");
    assert.equal(profilePicker.get("appearance"), "base-select");
    assert.equal(profilePicker.get("margin-top"), "5px");
    assert.equal(profilePicker.get("padding"), "5px");
    assert.equal(profilePicker.get("border-radius"), "10px");
    assert.equal(resolveSettingsCssValue(profilePicker.get("background"), root), root.get("--cltc-popover"));
    assert.equal(resolveSettingsCssValue(profilePicker.get("color"), root), root.get("--cltc-text"));
    const profilePickerIcon = cssDeclarations(style.textContent, ".cltc-profile-select::picker-icon");
    assert.equal(resolveSettingsCssValue(profilePickerIcon.get("color"), root), root.get("--cltc-muted"));
    assert.equal(profilePickerIcon.has("transition"), false, "the rewritten picker keeps static parity without animation work");
    assert.equal(overlay.querySelector(".cltc-settings-version")!.textContent, "v0.8.3");

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
    const triggerAvatar = profile.trigger.querySelector("[data-cltc-profile-identity-avatar]")!;
    assert.ok(triggerAvatar);
    assert.equal(triggerAvatar.classList.contains("icon-sm"), true);
    assert.equal(triggerAvatar.textContent, "L");
    assert.equal(profile.triggerLabel.textContent, "Local Usage");
    assert.equal(profile.gear.style.display, "none");
    assert.equal(decoy.label.textContent, "Account");
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_menu", profile: true, profileMenuId: "missing-menu" },
    }));
    assert.equal(profile.identityItem.className, "menu-disabled", "each explicit projection restores earlier connected rows first");
    assert.equal(profile.label.textContent, "Account");
    assert.equal(profile.identityItem.getAttribute("aria-disabled"), "true");
    assert.equal(profile.identityItem.hasAttribute("data-disabled"), true);
    assert.equal(profile.identityItem.getAttribute("tabindex"), "-1");
    assert.equal(profile.trigger.querySelector("[data-cltc-profile-identity-avatar]"), null);
    assert.equal(profile.triggerLabel.textContent, "Settings");
    assert.equal(profile.gear.style.display, "");
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
    assert.equal(profile.triggerLabel.textContent, "Settings");
    assert.equal(profile.trigger.querySelector("[data-cltc-profile-identity-avatar]"), null);
    assert.equal(profile.gear.style.display, "");
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

describe("lazy analytics calendar and profile views", () => {
  async function openAnalytics(harness: Harness) {
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    overlay.querySelector("[data-settings-panel='usage']")!.click();
    return overlay;
  }

  it("reports exact lazy listener and independently counted owned DOM write lifecycles", async () => {
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot() } };
      }
      if (path === "/token-cost/action" && payload.action.type === "query_diagnostics") return nativeDiagnosticsResponse();
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.runAnalytics();
    harness.runProfile();
    harness.runFlatpickr();
    const api = harness.window.__codexLiveTokenCostV1;
    const baseline = await api.diagnostics();
    assert.equal(baseline.listenerCount, 3);
    let previousDiagnostics = baseline;
    let previousMutationRecord = harness.document.connectedMutationRecords.length;
    const isLazyOwned = (node?: FakeElement) => {
      let current = node || null;
      while (current) {
        if (current.id.startsWith("codex-live-token-cost-settings")
          || current.id.startsWith("codex-live-token-cost-analytics")
          || current.id.startsWith("codex-live-token-cost-flatpickr")
          || current.id.startsWith("codex-live-token-cost-profile")
          || current.className.split(/\s+/).some((name) => name.startsWith("cltc-") || name.startsWith("flatpickr-"))) return true;
        current = current.parentElement;
      }
      return false;
    };
    const assertMutationDelta = async (label: string) => {
      const next = await api.diagnostics();
      const records = harness.document.connectedMutationRecords.slice(previousMutationRecord);
      const ownedMutations = records.filter((record) => {
        if (record.targetClass.split(/\s+/).includes("flatpickr-input") || record.kind.endsWith(":readonly")) return false;
        return isLazyOwned(record.target) || isLazyOwned(record.node);
      }).length;
      assert.equal(
        next.domWrites - previousDiagnostics.domWrites,
        ownedMutations,
        `${label} diagnostics must equal independent connected DOM mutations: ${records.map((record) => `${record.kind}:${record.target.id || record.target.className || record.target.tagName}->${record.node?.id || record.node?.className || record.node?.tagName || ""}`).join(", ")}`,
      );
      previousDiagnostics = next;
      previousMutationRecord = harness.document.connectedMutationRecords.length;
      return next;
    };

    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const settings = await assertMutationDelta("settings mount");
    assert.deepEqual(Array.from(settings.mountedModules), ["settings"]);
    assert.equal(settings.listenerCount, 7);
    assert.ok(settings.domWrites > baseline.domWrites);

    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    overlay.querySelector("[data-settings-panel='pricing']")!.click();
    await assertMutationDelta("pricing panel render");
    overlay.querySelectorAll("[data-price-pick]")[0]!.click();
    await assertMutationDelta("pricing selection refresh");
    overlay.querySelector("[data-action='new-price']")!.click();
    await assertMutationDelta("pricing field clear");
    overlay.querySelector("[data-settings-panel='usage']")!.click();
    await harness.settle();
    const analytics = await assertMutationDelta("analytics mount");
    assert.deepEqual(Array.from(analytics.mountedModules), ["settings", "analytics"]);
    assert.equal(analytics.listenerCount, 8);
    assert.ok(analytics.domWrites > settings.domWrites);

    overlay.querySelector("[data-analytics-preset='custom']")!.click();
    overlay.querySelector("[data-action='open-analytics-calendar']")!.click();
    const calendar = await assertMutationDelta("calendar mount");
    assert.deepEqual(Array.from(calendar.mountedModules), ["settings", "analytics", "flatpickr"]);
    assert.equal(calendar.listenerCount, 20);
    assert.ok(calendar.domWrites > analytics.domWrites);
    overlay.querySelector("[data-analytics-preset='today']")!.click();
    await harness.settle();
    await assertMutationDelta("calendar cleanup");
    overlay.querySelector("[data-action='close-price']")!.click();
    const settingsClosed = await assertMutationDelta("settings and analytics cleanup");
    assert.deepEqual(Array.from(settingsClosed.mountedModules), []);
    assert.equal(settingsClosed.listenerCount, 3);
    assert.ok(settingsClosed.domWrites > calendar.domWrites);

    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_entry", profile: true },
    }));
    const profile = await assertMutationDelta("profile mount");
    assert.deepEqual(Array.from(profile.mountedModules), ["profile"]);
    assert.equal(profile.listenerCount, 4);
    harness.document.querySelector("[data-profile-action='edit']")!.click();
    await assertMutationDelta("profile editor mount");
    harness.document.querySelector("[data-profile-action='cancel']")!.click();
    await assertMutationDelta("profile editor cleanup");
    harness.document.querySelector("[data-profile-tab='数据控制']")!.click();
    await assertMutationDelta("profile data tab");
    harness.document.querySelector("[data-profile-tab='个人资料']")!.click();
    await assertMutationDelta("profile identity tab");
    harness.document.querySelector("[data-profile-action='close']")!.click();
    const cleaned = await assertMutationDelta("profile cleanup");
    assert.deepEqual(Array.from(cleaned.mountedModules), []);
    assert.equal(cleaned.listenerCount, 3);
    assert.ok(cleaned.domWrites > profile.domWrites);
  });

  it("loads analytics only from Usage and renders bounded native results with monotonic queries", async () => {
    const seven = deferred<any>();
    const thirty = deferred<any>();
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        if (payload.action.range.type === "last_seven_days") return seven.promise;
        if (payload.action.range.type === "last_thirty_days") return thirty.promise;
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot() } };
      }
      return { status: "ok" };
    });

    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
    for (const panel of ["general", "profile", "pricing"]) overlay.querySelector(`[data-settings-panel='${panel}']`)!.click();
    assert.equal(lazyCalls(harness).filter((call) => call.payload.asset === "analytics").length, 0);
    assert.equal(actionCalls(harness, "query_analytics").length, 0);

    overlay.querySelector("[data-settings-panel='usage']")!.click();
    overlay.querySelector("[data-settings-panel='usage']")!.click();
    assert.deepEqual(lazyCalls(harness).map((call) => call.payload.asset), ["analytics"]);
    harness.runAnalytics();
    await harness.settle();
    assert.deepEqual(actionCalls(harness, "query_analytics").map((call) => call.payload.action.range), [{ type: "today" }]);
    const analytics = overlay.querySelector(".cltc-analytics")!;
    assert.ok(analytics);
    assert.equal(analytics.classList.contains("cltc-settings-section"), true);
    assert.equal(analytics.querySelector("h2")!.textContent, "使用统计");
    assert.equal(analytics.querySelector(".cltc-settings-section-heading")!.querySelector("p")!.textContent, "基于 HUD、Profile 与 CC Switch 相同的本地去重口径。");
    assert.deepEqual(analytics.querySelectorAll(".cltc-analytics-metric").map((node) => node.children[0].textContent), ["总 Token", "总花费", "模型调用", "缓存命中率"]);
    assert.equal(analytics.querySelectorAll(".cltc-analytics-section").length, 3);
    assert.ok(analytics.querySelector(".cltc-composition-bar"));
    const chart = analytics.querySelector("[data-analytics-chart]")!;
    assert.equal(chart.tagName, "SVG");
    assert.equal(chart.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(chart.getAttribute("viewBox"), "0 0 720 230");
    assert.equal(chart.querySelector("rect")!.namespaceURI, "http://www.w3.org/2000/svg");
    assert.match(
      harness.document.getElementById("codex-live-token-cost-analytics-style")!.textContent,
      /\.cltc-analytics-control\{[^}]*text-align:center/,
    );
    assert.deepEqual(analytics.querySelector(".cltc-analytics-model-head")!.children.map((node) => node.textContent), ["模型", "Token", "模型调用", "花费", "占比"]);
    assert.match(analytics.textContent, /146K/);
    assert.match(analytics.textContent, /\$0\.12/);
    assert.match(analytics.textContent, /72%/);

    const hostileDays = Array.from({ length: 40 }, (_, index) => ({
      day: `2026-07-${String((index % 31) + 1).padStart(2, "0")}`,
      totals: analyticsTotals({ turns: 1, input: index + 1 }),
    }));
    const hostileModels = Array.from({ length: 30 }, (_, index) => ({
      model: `model-${String(index).padStart(2, "0")}`,
      totals: analyticsTotals({ turns: 1, input: 100 - index, cost_nanos: index + 1 }),
    }));
    overlay.querySelector("[data-analytics-preset='7d']")!.click();
    overlay.querySelector("[data-analytics-preset='30d']")!.click();
    assert.deepEqual(actionCalls(harness, "query_analytics").slice(-2).map((call) => call.payload.action.range), [
      { type: "last_seven_days" }, { type: "last_thirty_days" },
    ]);
    thirty.resolve({ status: "ok", response: { type: "analytics", analytics: analyticsSnapshot({ from_day: "2026-07-17", to_day: "2026-08-15", days: hostileDays, models: hostileModels }) } });
    await harness.settle();
    assert.equal(overlay.querySelectorAll("[data-chart-index]").length, 31);
    assert.equal(overlay.querySelectorAll(".cltc-analytics-model-row").length, 20);
    assert.equal(overlay.querySelectorAll(".cltc-analytics-model-row[data-hidden='true']").length, 10);
    assert.equal(overlay.querySelector("[data-analytics-result]")!.dataset.toDay, "2026-08-15");
    seven.resolve({ status: "ok", response: { type: "analytics", analytics: analyticsSnapshot({ to_day: "2026-01-01" }) } });
    await harness.settle();
    assert.equal(overlay.querySelector("[data-analytics-result]")!.dataset.toDay, "2026-08-15", "late analytics response must be inert");

    overlay.querySelector(".cltc-analytics-model-row")!.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "query_analytics").at(-1)!.payload.action.model, "model-00");
    const filter = overlay.querySelector("[data-action='clear-analytics-model']")!;
    assert.match(filter.textContent, /model-00.*×/);
    overlay.querySelector("[data-analytics-preset='today']")!.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "query_analytics").at(-1)!.payload.action.model, "model-00", "range changes preserve the explicit model filter");
    overlay.querySelector("[data-action='clear-analytics-model']")!.click();
    await harness.settle();
    assert.equal(Object.hasOwn(actionCalls(harness, "query_analytics").at(-1)!.payload.action, "model"), false);
    overlay.querySelector("[data-settings-panel='general']")!.click();
    assert.equal(overlay.querySelector(".cltc-analytics"), null);
    assert.equal(harness.document.getElementById("codex-live-token-cost-analytics-style"), null);
    const lazyCount = lazyCalls(harness).length;
    overlay.querySelector("[data-settings-panel='usage']")!.click();
    await harness.settle();
    assert.equal(lazyCalls(harness).length, lazyCount, "warm analytics reuses its cached factory");
    overlay.querySelector("[data-action='close-price']")!.click();
    assert.equal(harness.document.querySelector(".cltc-analytics"), null);
  });

  it("keeps analytics empty and manual CC Switch paths bounded and explicit", async () => {
    let syncMode: "success" | "error" = "success";
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot({ totals: analyticsTotals(), days: [], models: [] }) } };
      }
      if (path === "/token-cost/action" && payload.action.type === "sync_cc_switch") {
        if (syncMode === "error") throw new Error("offline");
        return { status: "ok", response: { type: "synced", imported_turns: 3, analytics: analyticsSnapshot() } };
      }
      return { status: "ok" };
    });
    const overlay = await openAnalytics(harness);
    harness.runAnalytics();
    await harness.settle();
    assert.equal(overlay.querySelectorAll(".cltc-analytics-empty").length, 1);
    assert.equal(harness.clock.tasks.size, 0);

    overlay.querySelector("[data-action='sync-analytics-cc-switch']")!.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "sync_cc_switch").length, 1);
    assert.match(overlay.querySelector("[data-analytics-status='sync']")!.textContent, /已同步 3 条/);
    assert.equal(harness.clock.tasks.size, 0);
    syncMode = "error";
    overlay.querySelector("[data-action='sync-analytics-cc-switch']")!.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "sync_cc_switch").length, 2);
    assert.equal(overlay.querySelectorAll(".cltc-analytics-error").length, 1);
    assert.equal(harness.clock.tasks.size, 0);
    assert.equal(actionCalls(harness).some((call) => ["set_visibility", "save_price", "save_profile"].includes(call.payload.action.type)), false);
  });

  it("coalesces repeated CC Switch sync clicks until the owner request settles", async () => {
    const pendingSync = deferred<any>();
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot() } };
      }
      if (path === "/token-cost/action" && payload.action.type === "sync_cc_switch") return pendingSync.promise;
      return { status: "ok" };
    });
    const overlay = await openAnalytics(harness);
    harness.runAnalytics();
    await harness.settle();
    const sync = overlay.querySelector("[data-action='sync-analytics-cc-switch']")!;

    sync.click();
    sync.click();
    assert.equal(actionCalls(harness, "sync_cc_switch").length, 1);
    assert.equal(sync.disabled, true);
    assert.equal(harness.clock.tasks.size, 0);

    pendingSync.resolve({
      status: "ok",
      response: {
        type: "synced",
        imported_turns: 6,
        analytics: analyticsSnapshot({ from_day: "2026-06-01", to_day: "2026-06-30" }),
      },
    });
    await harness.settle();
    assert.equal(overlay.querySelector("[data-analytics-result]")!.dataset.toDay, "2026-06-30");
    assert.match(overlay.querySelector("[data-analytics-status='sync']")!.textContent, /已同步 6 条/);
    assert.equal(sync.disabled, false);
    assert.equal(actionCalls(harness, "sync_cc_switch").length, 1);
    assert.equal(harness.clock.tasks.size, 0);
  });

  it("aligns filters and range controls to the authoritative CC Switch snapshot", async () => {
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot() } };
      }
      if (path === "/token-cost/action" && payload.action.type === "sync_cc_switch") {
        return {
          status: "ok",
          response: {
            type: "synced",
            imported_turns: 4,
            analytics: analyticsSnapshot({ from_day: "2026-06-01", to_day: "2026-06-30" }),
          },
        };
      }
      return { status: "ok" };
    });
    const overlay = await openAnalytics(harness);
    harness.runAnalytics();
    await harness.settle();

    overlay.querySelector("[data-analytics-preset='7d']")!.click();
    await harness.settle();
    overlay.querySelector(".cltc-analytics-model-row")!.click();
    await harness.settle();
    assert.equal(overlay.querySelector("[data-analytics-preset='7d']")!.dataset.active, "true");
    assert.equal(overlay.querySelector("[data-action='clear-analytics-model']")!.hidden, false);

    overlay.querySelector("[data-action='sync-analytics-cc-switch']")!.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "sync_cc_switch").length, 1);
    assert.equal(overlay.querySelector("[data-analytics-result]")!.dataset.toDay, "2026-06-30");
    assert.equal(overlay.querySelector("[data-analytics-preset='custom']")!.dataset.active, "true");
    assert.equal(overlay.querySelector("[data-analytics-preset='7d']")!.dataset.active, "false");
    assert.equal(overlay.querySelector("[data-action='open-analytics-calendar']")!.hidden, false);
    assert.equal(overlay.querySelector("[data-action='open-analytics-calendar']")!.textContent, "2026-06-01 – 2026-06-30");
    assert.equal(overlay.querySelector("[data-action='clear-analytics-model']")!.hidden, true);

    overlay.querySelector("[data-analytics-preset='today']")!.click();
    await harness.settle();
    assert.equal(Object.hasOwn(actionCalls(harness, "query_analytics").at(-1)!.payload.action, "model"), false);
  });

  it("keeps the latest explicit Analytics action authoritative across sync and range queries", async () => {
    const pendingSync = deferred<any>();
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "sync_cc_switch") return pendingSync.promise;
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        const toDay = payload.action.range.type === "last_seven_days" ? "2026-08-20" : "2026-08-15";
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot({ to_day: toDay }) } };
      }
      return { status: "ok" };
    });
    const overlay = await openAnalytics(harness);
    harness.runAnalytics();
    await harness.settle();
    overlay.querySelector("[data-action='sync-analytics-cc-switch']")!.click();
    overlay.querySelector("[data-analytics-preset='7d']")!.click();
    await harness.settle();
    assert.equal(overlay.querySelector("[data-analytics-result]")!.dataset.toDay, "2026-08-20");
    pendingSync.resolve({
      status: "ok",
      response: { type: "synced", imported_turns: 9, analytics: analyticsSnapshot({ to_day: "2026-01-01" }) },
    });
    await harness.settle();
    assert.equal(overlay.querySelector("[data-analytics-result]")!.dataset.toDay, "2026-08-20", "late sync must not replace a newer range query");
    assert.equal(overlay.querySelector("[data-analytics-status='sync']"), null);
  });

  it("loads calendar only from the custom trigger with one explicit retry and cached cleanup", async () => {
    const bridge = (path: string, payload: any) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot() } };
      }
      return { status: "ok" };
    };
    const failed = await createHarness(bridge);
    const failedOverlay = await openAnalytics(failed);
    failed.runAnalytics();
    await failed.settle();
    assert.equal(lazyCalls(failed).some((call) => call.payload.asset === "flatpickr"), false);
    assert.equal(failed.window.flatpickr, undefined);
    failedOverlay.querySelector("[data-analytics-preset='7d']")!.click();
    await failed.settle();
    assert.equal(lazyCalls(failed).some((call) => call.payload.asset === "flatpickr"), false);
    failedOverlay.querySelector("[data-analytics-preset='custom']")!.click();
    assert.equal(lazyCalls(failed).some((call) => call.payload.asset === "flatpickr"), false);
    const trigger = failedOverlay.querySelector("[data-action='open-analytics-calendar']")!;
    trigger.click();
    trigger.click();
    assert.equal(lazyCalls(failed).filter((call) => call.payload.asset === "flatpickr").length, 1);
    assert.equal(failed.window.__codexLiveTokenCostV1.registerModule("flatpickr", null), false);
    assert.equal(failedOverlay.querySelectorAll(".cltc-analytics-error").length, 1);
    trigger.click();
    assert.equal(lazyCalls(failed).filter((call) => call.payload.asset === "flatpickr").length, 2);
    failed.window.__codexLiveTokenCostV1.acceptLazyError({ asset: "flatpickr" });
    trigger.click();
    assert.equal(lazyCalls(failed).filter((call) => call.payload.asset === "flatpickr").length, 2, "second owner failure exhausts retries");
    assert.equal(failed.clock.tasks.size, 0);

    const invalidInstance = await createHarness(bridge);
    const invalidOverlay = await openAnalytics(invalidInstance);
    invalidInstance.runAnalytics();
    await invalidInstance.settle();
    invalidOverlay.querySelector("[data-analytics-preset='custom']")!.click();
    invalidOverlay.querySelector("[data-action='open-analytics-calendar']")!.click();
    assert.equal(invalidInstance.window.__codexLiveTokenCostV1.registerModule("flatpickr", () => ({ mount() {} })), false);
    assert.equal(invalidOverlay.querySelectorAll(".cltc-analytics-error").length, 1);
    invalidOverlay.querySelector("[data-action='open-analytics-calendar']")!.click();
    assert.equal(lazyCalls(invalidInstance).filter((call) => call.payload.asset === "flatpickr").length, 2, "invalid instances are not retained as cached factories");

    const failedInitialization = await createHarness(bridge);
    const failedInitializationOverlay = await openAnalytics(failedInitialization);
    failedInitialization.runAnalytics();
    await failedInitialization.settle();
    failedInitialization.evaluate("window.__hostDateIncrement = function hostDateIncrement() {}; Object.defineProperty(Date.prototype, 'fp_incr', { configurable: true, enumerable: false, writable: false, value: window.__hostDateIncrement }); delete HTMLElement.prototype.flatpickr;");
    const failedDatePrototypeBefore = failedInitialization.evaluate("Date.prototype.fp_incr");
    failedInitializationOverlay.querySelector("[data-analytics-preset='custom']")!.click();
    failedInitializationOverlay.querySelector("[data-action='open-analytics-calendar']")!.click();
    failedInitialization.runFlatpickr();
    assert.equal(failedInitialization.evaluate("Date.prototype.fp_incr"), failedDatePrototypeBefore);
    assert.equal(failedInitialization.evaluate("HTMLElement.prototype.flatpickr"), undefined, "partial library initialization restores host prototypes");
    assert.equal(failedInitializationOverlay.querySelectorAll(".cltc-analytics-error").length, 1);

    const success = await createHarness(bridge);
    const successOverlay = await openAnalytics(success);
    success.runAnalytics();
    await success.settle();
    success.evaluate("window.__flatpickrLibraryWrites = 0; window.__hostDateIncrement = function hostDateIncrement() {}; Object.defineProperty(Date.prototype, 'fp_incr', { configurable: true, get() { return window.__hostDateIncrement; }, set() { window.__flatpickrLibraryWrites += 1; } }); HTMLElement.prototype.flatpickr = function hostElementFlatpickr() {};");
    const datePrototypeBefore = success.evaluate("Date.prototype.fp_incr");
    const elementPrototypeBefore = success.evaluate("HTMLElement.prototype.flatpickr");
    successOverlay.querySelector("[data-analytics-preset='custom']")!.click();
    successOverlay.querySelector("[data-action='open-analytics-calendar']")!.click();
    success.runFlatpickr();
    const libraryWritesAfterColdOpen = success.evaluate("window.__flatpickrLibraryWrites");
    assert.equal(success.document.querySelectorAll(".flatpickr-calendar").length, 1);
    assert.equal(success.document.querySelector(".flatpickr-calendar")!.classList.contains("animate"), true,
      "the frozen calendar retains its one-shot open animation class");
    assert.equal(success.document.querySelectorAll("#codex-live-token-cost-flatpickr-style").length, 1);
    assert.equal(success.window.flatpickr, undefined, "library globals are restored after instance creation");
    assert.equal(success.evaluate("Date.prototype.fp_incr"), datePrototypeBefore);
    assert.equal(success.evaluate("HTMLElement.prototype.flatpickr"), elementPrototypeBefore);
    const calendarTarget = successOverlay.querySelector("[data-analytics-date-input]")! as any;
    const calendarInstance = calendarTarget._flatpickr;
    assert.equal(calendarInstance.l10n.firstDayOfWeek, 1, "the frozen calendar starts weeks on Monday");
    assert.equal(calendarInstance.config.disableMobile, true);
    assert.equal(calendarInstance.config.allowInput, false);
    assert.equal(calendarInstance.config.appendTo, successOverlay, "the calendar remains owned by the settings overlay");
    assert.equal(calendarInstance.selectedDates.length, 2, "the current custom range seeds the calendar");
    assert.equal(Math.floor((calendarInstance.config.maxDate.getTime() - calendarInstance.config.minDate.getTime()) / 86_400_000), 364,
      "the frozen calendar exposes the latest 365 local days");
    const firstDay = success.document.querySelectorAll(".flatpickr-day").find((node) => !node.classList.contains("flatpickr-disabled"))!;
    const firstTime = (firstDay as any).dateObj.getTime();
    firstDay.click();
    const secondDay = success.document.querySelectorAll(".flatpickr-day").find((node) => !node.classList.contains("flatpickr-disabled") && (node as any).dateObj.getTime() > firstTime)!;
    secondDay.click();
    await success.settle();
    const customAction = actionCalls(success, "query_analytics").at(-1)!.payload.action;
    assert.equal(customAction.range.type, "custom");
    assert.match(customAction.range.from_day, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(customAction.range.to_day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(customAction.range.from_day <= customAction.range.to_day);
    assert.equal(success.document.querySelector(".flatpickr-calendar"), null, "range apply destroys the owned instance");
    assert.equal(success.document.getElementById("codex-live-token-cost-flatpickr-style"), null);
    successOverlay.querySelector("[data-analytics-preset='custom']")!.click();
    successOverlay.querySelector("[data-action='open-analytics-calendar']")!.click();
    assert.equal(success.document.querySelectorAll(".flatpickr-calendar").length, 1);
    assert.equal(success.evaluate("window.__flatpickrLibraryWrites"), libraryWritesAfterColdOpen, "warm open reuses the initialized Flatpickr factory");
    successOverlay.querySelector("[data-analytics-preset='today']")!.click();
    await success.settle();
    assert.equal(success.document.querySelector(".flatpickr-calendar"), null);
    assert.equal(success.document.getElementById("codex-live-token-cost-flatpickr-style"), null);
    const calls = lazyCalls(success).filter((call) => call.payload.asset === "flatpickr").length;
    successOverlay.querySelector("[data-analytics-preset='custom']")!.click();
    successOverlay.querySelector("[data-action='open-analytics-calendar']")!.click();
    assert.equal(lazyCalls(success).filter((call) => call.payload.asset === "flatpickr").length, calls);
    assert.equal(success.document.querySelectorAll(".flatpickr-calendar").length, 1);
    successOverlay.querySelector("[data-settings-panel='general']")!.click();
    assert.equal(success.document.querySelector(".flatpickr-calendar"), null);
    assert.equal(success.document.getElementById("codex-live-token-cost-flatpickr-style"), null);
  });

  it("reopens the existing Flatpickr child after a natural calendar close", async () => {
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot() } };
      }
      return { status: "ok" };
    });
    const overlay = await openAnalytics(harness);
    harness.runAnalytics();
    await harness.settle();
    overlay.querySelector("[data-analytics-preset='custom']")!.click();
    const trigger = overlay.querySelector("[data-action='open-analytics-calendar']")!;
    trigger.click();
    harness.runFlatpickr();

    const target = overlay.querySelector("[data-analytics-date-input]")! as any;
    const instance = target._flatpickr;
    assert.ok(instance);
    let reopenCalls = 0;
    const open = instance.open.bind(instance);
    instance.open = () => { reopenCalls += 1; return open(); };
    instance.close();
    assert.equal(instance.isOpen, false);
    const lazyCount = lazyCalls(harness).filter((call) => call.payload.asset === "flatpickr").length;

    trigger.click();
    assert.equal(reopenCalls, 1, "the live child must reopen instead of treating the click as a no-op");
    assert.equal(target._flatpickr, instance);
    assert.equal(harness.document.querySelectorAll(".flatpickr-calendar").length, 1);
    assert.equal(lazyCalls(harness).filter((call) => call.payload.asset === "flatpickr").length, lazyCount);
  });

  it("destroys real partial Flatpickr instances exactly once when mounting fails", async () => {
    const bridge = (path: string, payload: any) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot() } };
      }
      if (path === "/token-cost/action" && payload.action.type === "query_diagnostics") return nativeDiagnosticsResponse();
      return { status: "ok" };
    };
    const lazyMutationCount = (harness: Harness, from: number) => harness.document.connectedMutationRecords
      .slice(from)
      .filter((record) => {
        if (record.targetClass.split(/\s+/).includes("flatpickr-input") || record.kind.endsWith(":readonly")) return false;
        const owned = (node?: FakeElement) => Boolean(node && (
          node.id === "codex-live-token-cost-flatpickr-style"
          || node.id.startsWith("codex-live-token-cost-")
          || node.className.split(/\s+/).some((name) => name.startsWith("cltc-") || name.startsWith("flatpickr-"))
        ));
        return owned(record.target) || owned(record.node);
      }).length;

    const lateAssignment = await createHarness(bridge);
    const lateOverlay = await openAnalytics(lateAssignment);
    lateAssignment.runAnalytics();
    await lateAssignment.settle();
    lateOverlay.querySelector("[data-analytics-preset='custom']")!.click();
    lateOverlay.querySelector("[data-action='open-analytics-calendar']")!.click();
    const lateTarget = lateOverlay.querySelector("[data-analytics-date-input]")! as any;
    const lateListeners = [...lateAssignment.document.listeners.values()].reduce((total, listeners) => total + listeners.length, 0);
    const lateDatePrototype = lateAssignment.evaluate("Date.prototype.fp_incr");
    let lateInstance: any;
    let lateDestroyCalls = 0;
    Object.defineProperty(lateTarget, "_flatpickr", {
      configurable: true,
      get: () => lateInstance,
      set: (value) => {
        lateInstance = value;
        const destroy = value.destroy.bind(value);
        value.destroy = () => { lateDestroyCalls += 1; return destroy(); };
        throw new Error("late target assignment failure");
      },
    });
    const lateDiagnosticsBefore = await lateAssignment.window.__codexLiveTokenCostV1.diagnostics();
    const lateMutationStart = lateAssignment.document.connectedMutationRecords.length;
    lateAssignment.runFlatpickr();
    const lateDiagnosticsAfter = await lateAssignment.window.__codexLiveTokenCostV1.diagnostics();
    assert.equal(
      lateDiagnosticsAfter.domWrites - lateDiagnosticsBefore.domWrites,
      lazyMutationCount(lateAssignment, lateMutationStart),
      "late factory failure diagnostics must equal its independent owned DOM mutations",
    );
    assert.equal(lateDestroyCalls, 1);
    assert.equal(lateAssignment.document.querySelectorAll(".flatpickr-calendar").length, 0);
    assert.equal(Boolean(lateAssignment.document.getElementById("codex-live-token-cost-flatpickr-style")), false);
    assert.equal([...lateAssignment.document.listeners.values()].reduce((total, listeners) => total + listeners.length, 0), lateListeners);
    assert.equal(lateAssignment.window.flatpickr, undefined);
    assert.equal(lateAssignment.evaluate("Date.prototype.fp_incr"), lateDatePrototype);

    const openFailure = await createHarness(bridge);
    const openOverlay = await openAnalytics(openFailure);
    openFailure.runAnalytics();
    await openFailure.settle();
    openOverlay.querySelector("[data-analytics-preset='custom']")!.click();
    openOverlay.querySelector("[data-action='open-analytics-calendar']")!.click();
    const openTarget = openOverlay.querySelector("[data-analytics-date-input]")! as any;
    let openInstance: any;
    let openDestroyCalls = 0;
    Object.defineProperty(openTarget, "_flatpickr", {
      configurable: true,
      get: () => openInstance,
      set: (value) => {
        openInstance = value;
        const destroy = value.destroy.bind(value);
        value.destroy = () => {
          openDestroyCalls += 1;
          destroy();
          throw new Error("late destroy failure after calendar removal");
        };
        value.open = () => { throw new Error("late open failure"); };
      },
    });
    const openDiagnosticsBefore = await openFailure.window.__codexLiveTokenCostV1.diagnostics();
    const openMutationStart = openFailure.document.connectedMutationRecords.length;
    openFailure.runFlatpickr();
    const openDiagnosticsAfter = await openFailure.window.__codexLiveTokenCostV1.diagnostics();
    assert.equal(
      openDiagnosticsAfter.domWrites - openDiagnosticsBefore.domWrites,
      lazyMutationCount(openFailure, openMutationStart),
      "late open failure diagnostics must equal its independent owned DOM mutations",
    );
    assert.equal(openDestroyCalls, 1, "the returned instance and target fallback are the same owner");
    assert.equal(openFailure.document.querySelectorAll(".flatpickr-calendar").length, 0);
    assert.equal(Boolean(openFailure.document.getElementById("codex-live-token-cost-flatpickr-style")), false);
  });

  it("falls back to exact-once owned Flatpickr cleanup when vendor destroy throws immediately", async () => {
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot() } };
      }
      if (path === "/token-cost/action" && payload.action.type === "query_diagnostics") return nativeDiagnosticsResponse();
      return { status: "ok" };
    });
    const overlay = await openAnalytics(harness);
    harness.runAnalytics();
    await harness.settle();
    overlay.querySelector("[data-analytics-preset='custom']")!.click();
    const target = overlay.querySelector("[data-analytics-date-input]")! as any;
    const sumListeners = (listeners: Map<string, Listener[]>) => [...listeners.values()]
      .reduce((total, entries) => total + entries.length, 0);
    const subtreeListeners = (root: FakeElement | null): number => root
      ? sumListeners(root.listeners) + root.children.reduce((total, child) => total + subtreeListeners(child), 0)
      : 0;
    const realListenerCount = (calendar: FakeElement | null) => sumListeners(harness.document.listeners)
      + sumListeners(harness.window.listeners)
      + subtreeListeners(target)
      + subtreeListeners(calendar);
    const lazyMutationCount = (from: number) => harness.document.connectedMutationRecords
      .slice(from)
      .filter((record) => {
        if (record.targetClass.split(/\s+/).includes("flatpickr-input") || record.kind.endsWith(":readonly")) return false;
        const owned = (node?: FakeElement) => Boolean(node && (
          node.id === "codex-live-token-cost-flatpickr-style"
          || node.id.startsWith("codex-live-token-cost-")
          || node.className.split(/\s+/).some((name) => name.startsWith("cltc-") || name.startsWith("flatpickr-"))
        ));
        return owned(record.target) || owned(record.node);
      }).length;

    const diagnosticsBefore = await harness.window.__codexLiveTokenCostV1.diagnostics();
    const listenersBefore = realListenerCount(null);
    overlay.querySelector("[data-action='open-analytics-calendar']")!.click();
    harness.runFlatpickr();
    const instance = target._flatpickr;
    const calendar = instance.calendarContainer as FakeElement;
    const diagnosticsMounted = await harness.window.__codexLiveTokenCostV1.diagnostics();
    const listenersMounted = realListenerCount(calendar);
    assert.equal(diagnosticsMounted.listenerCount - diagnosticsBefore.listenerCount, listenersMounted - listenersBefore);
    assert.equal(instance._handlers.length, 12, "fixture must exercise the real bundled listener paths");

    let destroyCalls = 0;
    instance.destroy = () => {
      destroyCalls += 1;
      throw new Error("vendor destroy failed before cleanup");
    };
    const mutationStart = harness.document.connectedMutationRecords.length;
    overlay.querySelector("[data-analytics-preset='today']")!.click();
    await harness.settle();
    const diagnosticsAfter = await harness.window.__codexLiveTokenCostV1.diagnostics();
    assert.equal(destroyCalls, 1);
    assert.equal(diagnosticsAfter.listenerCount, diagnosticsBefore.listenerCount);
    assert.equal(realListenerCount(calendar), listenersBefore);
    assert.equal(instance._handlers.length, 0, "fallback must release each real vendor listener owner");
    assert.equal(harness.document.querySelectorAll(".flatpickr-calendar").length, 0);
    assert.equal(harness.document.getElementById("codex-live-token-cost-flatpickr-style"), null);
    assert.equal(
      diagnosticsAfter.domWrites - diagnosticsMounted.domWrites,
      lazyMutationCount(mutationStart),
      "fallback diagnostics must equal independent connected DOM mutations",
    );

    overlay.querySelector("[data-analytics-preset='today']")!.click();
    await harness.settle();
    const diagnosticsRepeated = await harness.window.__codexLiveTokenCostV1.diagnostics();
    assert.equal(destroyCalls, 1, "repeated cleanup must not re-enter the failed vendor destroy");
    assert.equal(diagnosticsRepeated.listenerCount, diagnosticsBefore.listenerCount);
    assert.equal(realListenerCount(calendar), listenersBefore);
    assert.equal(harness.document.querySelectorAll(".flatpickr-calendar").length, 0);
  });

  it("opens a single local profile only from exact lifecycle and guards save and cleanup ownership", async () => {
    let revision = 1;
    let config = baseConfig({
      profile: { ...baseConfig().profile, display_name: "Local Usage", username: "local-usage", email: "local@example.com", plan_label: "Pro 20x" },
    });
    let saveMode: "success" | "error" | "pending" = "success";
    let pendingSave = deferred<any>();
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id, { config: structuredClone(config) });
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "save_profile") {
        if (saveMode === "error") throw new Error("save failed");
        if (saveMode === "pending") return pendingSave.promise;
        config = { ...config, profile: structuredClone(payload.action.profile) };
        return updatedResponse(config, ++revision);
      }
      return { status: "ok" };
    });
    const menu = installProfileMenu(harness.document);
    const before = harness.evaluate("({filter:Array.prototype.filter,test:RegExp.prototype.test,fetch,XMLHttpRequest,WebSocket,electronBridge,react:window.__hostReactContext,statsig:window.__hostStatsig,auth:window.__hostAuth})");
    harness.run();
    await harness.settle();
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", { detail: { reason: "profile_menu", profile: true, profileMenuId: menu.menu.id } }));
    for (const detail of [null, {}, { reason: "profile_entry" }, { reason: "profile_entry", profile: false }, { reason: "other", profile: true }]) {
      harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", { detail }));
    }
    assert.equal(lazyCalls(harness).filter((call) => call.payload.asset === "profile").length, 0);
    harness.runSettings();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    assert.ok(harness.document.querySelector(".cltc-settings-modal"));
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", { detail: { reason: "profile_entry", profile: true } }));
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", { detail: { reason: "profile_entry", profile: true } }));
    assert.equal(lazyCalls(harness).filter((call) => call.payload.asset === "profile").length, 1);
    assert.equal(harness.document.querySelector(".cltc-settings-modal"), null, "Profile replaces the prior top-level owner");
    harness.runProfile();
    const page = harness.document.getElementById("codex-live-token-cost-profile-page")!;
    assert.ok(page);
    assert.equal(page.parentElement!.tagName, "MAIN");
    assert.equal(page.querySelector(".cltc-profile-head"), null, "frozen Profile page has no injected duplicate heading");
    assert.equal(harness.document.querySelectorAll("#codex-live-token-cost-profile-page").length, 1);
    assert.deepEqual(page.querySelectorAll("[data-profile-tab]").map((tab) => tab.textContent), ["个人资料", "通知", "数据控制"]);
    assert.match(page.textContent, /Local Usage/);
    assert.match(page.textContent, /@local-usage/);
    assert.match(page.textContent, /local@example\.com/);
    assert.match(page.textContent, /Codex Pro 20x/);
    assert.match(page.textContent, /12/);
    assert.match(page.textContent, /146K/);
    assert.ok(page.querySelector(".profile-card"));
    const activity = page.querySelector(".cltc-profile-activity")!;
    assert.equal(activity.hidden, true, "the frozen default Profile viewport remains empty below the card");
    page.querySelector("[data-profile-tab='数据控制']")!.click();
    assert.equal(activity.hidden, false, "bounded runtime activity is available from the explicit data tab");
    assert.equal(page.querySelector(".profile-card")!.hidden, true);
    page.querySelector("[data-profile-tab='个人资料']")!.click();
    assert.equal(activity.hidden, true);
    assert.equal(page.querySelector(".profile-card")!.hidden, false);
    const profileStyle = harness.document.getElementById("codex-live-token-cost-profile-style")!.textContent;
    assert.doesNotMatch(profileStyle, /main:has\(> #codex-live-token-cost-profile-page\)\{[^}]*position:/);
    assert.match(profileStyle, /#codex-live-token-cost-profile-page\{[^}]*font:inherit/);
    assert.match(profileStyle, /#codex-live-token-cost-profile-page\{[^}]*color:inherit/);
    assert.match(profileStyle, /--profile-nav-border:light-dark\(#e5e7eb,#34343a\)/);
    assert.match(profileStyle, /\.cltc-profile-tabs\{[^}]*border-bottom:1px solid var\(--profile-nav-border\)/);
    assert.match(profileStyle, /\.cltc-profile-tab\{[^}]*border:0;[^}]*background:/);
    assert.doesNotMatch(profileStyle, /\.cltc-profile-tab\{[^}]*border-bottom:2px solid transparent/);
    assert.match(profileStyle, /\.cltc-profile-tab\[data-active='true'\]\{[^}]*border-bottom:2px solid var\(--profile-text\)/);
    assert.match(profileStyle, /\.cltc-profile-name\{[^}]*font-weight:inherit/);
    assert.doesNotMatch(profileStyle, /\.cltc-profile-tab\[data-active='true'\]\{[^}]*font-weight:/);
    assert.match(profileStyle, /width:min\(940px,calc\(100% - 64px\)\);margin:54px auto/);
    const profileCard = page.querySelector(".profile-card")!;
    assert.deepEqual(profileCard.children.map((node) => node.tagName), ["BUTTON", "DIV", "SPAN", "DL"]);
    assert.deepEqual(profileCard.querySelector(".cltc-profile-details")!.children.map((node) => node.children.map((child) => child.tagName)), [["DT", "DD"], ["DT", "DD"]]);
    assert.match(profileStyle, /\.profile-card\{[^}]*grid-template-columns:72px minmax\(0,1fr\) auto;[^}]*gap:20px;[^}]*padding:28px/);
    assert.match(profileStyle, /\.cltc-profile-details\{[^}]*grid-column:1\/-1;[^}]*margin:14px 0 0/);
    assert.match(profileStyle, /width:64px;height:64px/);

    page.querySelector("[data-profile-action='edit']")!.click();
    page.querySelector("[data-profile-field='display_name']")!.value = "Updated Local";
    page.querySelector("[data-profile-field='username']")!.value = "updated-local";
    page.querySelector("[data-profile-action='save']")!.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "save_profile").length, 1);
    assert.deepEqual(actionCalls(harness, "save_profile")[0].payload.action.profile, {
      ...baseConfig().profile,
      display_name: "Updated Local", username: "updated-local", email: "local@example.com", plan_label: "Pro 20x",
    });
    assert.match(page.textContent, /Updated Local/);
    assert.equal(menu.label.textContent, "Account", "a closed Profile menu stays restored until its next exact lifecycle");
    assert.equal(menu.triggerLabel.textContent, "Settings");

    page.querySelector("[data-profile-action='edit']")!.click();
    page.querySelector("[data-profile-field='email']")!.value = "";
    page.querySelector("[data-profile-field='avatar_data_url']")!.value = "data:image/png;base64,AAAA";
    page.querySelector("[data-profile-action='save']")!.click();
    assert.equal(actionCalls(harness, "save_profile").length, 1, "mismatched avatar MIME/header stays local");
    assert.equal(page.querySelectorAll(".cltc-profile-error").length, 1);
    page.querySelector("[data-profile-field='avatar_data_url']")!.value = "data:image/png;base64,iVBORw0KGgo=";
    page.querySelector("[data-profile-action='save']")!.click();
    await harness.settle();
    assert.equal(actionCalls(harness, "save_profile").length, 2, "native permits an empty bounded email");
    assert.equal(actionCalls(harness, "save_profile").at(-1)!.payload.action.profile.email, "");

    saveMode = "error";
    page.querySelector("[data-profile-action='edit']")!.click();
    const retained = page.querySelector("[data-profile-field='display_name']")!;
    retained.value = "Retain Me";
    page.querySelector("[data-profile-action='save']")!.click();
    await harness.settle();
    assert.equal(retained.value, "Retain Me");
    assert.equal(page.querySelectorAll(".cltc-profile-error").length, 1);
    assert.equal(harness.clock.tasks.size, 0);

    saveMode = "pending";
    pendingSave = deferred<any>();
    page.querySelector("[data-profile-action='save']")!.click();
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", { detail: { reason: "route", profile: false } }));
    assert.equal(Boolean(harness.document.getElementById("codex-live-token-cost-profile-page")), false);
    assert.equal(Boolean(harness.document.getElementById("codex-live-token-cost-profile-style")), false);
    pendingSave.resolve(updatedResponse(config, ++revision));
    await harness.settle();
    assert.equal(harness.document.getElementById("codex-live-token-cost-profile-page"), null, "late save cannot revive a disposed owner");

    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", { detail: { reason: "profile_entry", profile: true } }));
    assert.equal(lazyCalls(harness).filter((call) => call.payload.asset === "profile").length, 1, "warm profile uses cached factory");
    assert.ok(harness.document.getElementById("codex-live-token-cost-profile-page"));
    harness.document.querySelector("[data-profile-action='close']")!.click();
    assert.equal(harness.document.getElementById("codex-live-token-cost-profile-page"), null);
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", { detail: { reason: "profile_entry", profile: true } }));
    assert.ok(harness.document.getElementById("codex-live-token-cost-profile-page"));
    harness.window.__codexLiveTokenCostV1.destroy();
    assert.equal(Boolean(harness.document.getElementById("codex-live-token-cost-profile-page")), false);
    assert.equal(Boolean(harness.document.getElementById("codex-live-token-cost-profile-style")), false);
    const after = harness.evaluate("({filter:Array.prototype.filter,test:RegExp.prototype.test,fetch,XMLHttpRequest,WebSocket,electronBridge,react:window.__hostReactContext,statsig:window.__hostStatsig,auth:window.__hostAuth})");
    for (const key of Object.keys(before)) assert.equal(after[key], before[key], `${key} reference`);
  });

  it("keeps Profile plan type and label aligned for known and custom edits", async () => {
    let revision = 1;
    let config = baseConfig();
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id, { config: structuredClone(config) });
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "save_profile") {
        config = { ...config, profile: structuredClone(payload.action.profile) };
        return updatedResponse(config, ++revision);
      }
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_entry", profile: true },
    }));
    harness.runProfile();
    const page = harness.document.getElementById("codex-live-token-cost-profile-page")!;

    page.querySelector("[data-profile-action='edit']")!.click();
    page.querySelector("[data-profile-field='plan_label']")!.value = "Plus";
    page.querySelector("[data-profile-action='save']")!.click();
    await harness.settle();
    const known = actionCalls(harness, "save_profile").at(-1)!.payload.action.profile;
    assert.deepEqual({ plan_type: known.plan_type, plan_label: known.plan_label }, {
      plan_type: "plus", plan_label: "Plus",
    });

    page.querySelector("[data-profile-action='edit']")!.click();
    page.querySelector("[data-profile-field='plan_label']")!.value = "  Team Enterprise  ";
    page.querySelector("[data-profile-action='save']")!.click();
    await harness.settle();
    const custom = actionCalls(harness, "save_profile").at(-1)!.payload.action.profile;
    assert.deepEqual({ plan_type: custom.plan_type, plan_label: custom.plan_label }, {
      plan_type: "Team Enterprise", plan_label: "Team Enterprise",
    });
  });

  it("closes an active Profile and restores projection on a profile_menu false lifecycle", async () => {
    const harness = await createHarness();
    const menu = installProfileMenu(harness.document);
    harness.run();
    await harness.settle();
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_entry", profile: true },
    }));
    harness.runProfile();
    assert.ok(harness.document.getElementById("codex-live-token-cost-profile-page"));

    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_menu", profile: false, profileMenuId: menu.menu.id },
    }));
    assert.equal(Boolean(harness.document.getElementById("codex-live-token-cost-profile-page")), false);
    assert.equal(Boolean(harness.document.getElementById("codex-live-token-cost-profile-style")), false);
    assert.equal(menu.identityItem.getAttribute("data-codex-plus-token-cost-profile-entry"), null);
    assert.equal(menu.identityItem.className, "menu-disabled");
    assert.equal(menu.triggerLabel.textContent, "Settings");
    assert.equal(menu.trigger.querySelector("[data-cltc-profile-identity-avatar]"), null);
  });

  it("closes only Profile ownership when a native snapshot hides it", async () => {
    const active = await createHarness();
    active.run();
    await active.settle();
    active.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_entry", profile: true },
    }));
    active.runProfile();
    const activeApi = active.window.__codexLiveTokenCostV1;
    assert.equal(activeApi.acceptNativePush({
      type: "snapshot", instance_id: activeApi.instanceId, snapshot: baseSnapshot(2, { profile_visible: false }),
    }), true);
    assert.equal(Boolean(active.document.getElementById("codex-live-token-cost-profile-page")), false);

    const pending = await createHarness();
    pending.run();
    await pending.settle();
    pending.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_entry", profile: true },
    }));
    assert.equal(lazyCalls(pending).filter((call) => call.payload.asset === "profile").length, 1);
    const pendingApi = pending.window.__codexLiveTokenCostV1;
    assert.equal(pendingApi.acceptNativePush({
      type: "snapshot", instance_id: pendingApi.instanceId, snapshot: baseSnapshot(2, { profile_visible: false }),
    }), true);
    pending.runProfile();
    assert.equal(Boolean(pending.document.getElementById("codex-live-token-cost-profile-page")), false, "late registration cannot consume a hidden Profile intent");

    const settings = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot() } };
      }
      return { status: "ok" };
    });
    const overlay = await openAnalytics(settings);
    settings.runAnalytics();
    await settings.settle();
    const settingsApi = settings.window.__codexLiveTokenCostV1;
    assert.equal(settingsApi.acceptNativePush({
      type: "snapshot", instance_id: settingsApi.instanceId, snapshot: baseSnapshot(2, { profile_visible: false }),
    }), true);
    assert.ok(overlay.isConnected);
    assert.ok(overlay.querySelector(".cltc-analytics"), "Profile visibility must not close Settings or Analytics");
  });

  it("does not retain a profile intent when the fixed local mount anchor is absent", async () => {
    const harness = await createHarness();
    harness.document.querySelector("main")!.remove();
    harness.run();
    await harness.settle();
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", { detail: { reason: "profile_entry", profile: true } }));
    assert.equal(lazyCalls(harness).filter((call) => call.payload.asset === "profile").length, 0);
    harness.runProfile();
    assert.equal(harness.document.getElementById("codex-live-token-cost-profile-page"), null);

    const disabled = await createHarness((path, payload) => path === "/token-cost/bootstrap"
      ? successfulBootstrap(payload.instance_id, { config: baseConfig({ profile_visible: false }), snapshot: baseSnapshot(1, { profile_visible: false }) })
      : { status: "ok" });
    disabled.run();
    await disabled.settle();
    disabled.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", { detail: { reason: "profile_entry", profile: true } }));
    assert.equal(lazyCalls(disabled).filter((call) => call.payload.asset === "profile").length, 0);
  });

  it("lets an exact Profile lifecycle replace a pending Settings top-level intent", async () => {
    const harness = await createHarness((path, payload) => path === "/token-cost/bootstrap"
      ? successfulBootstrap(payload.instance_id)
      : { status: "ok" });
    harness.run();
    await harness.settle();
    harness.document.getElementById("codex-live-token-cost-settings")!.click();
    assert.deepEqual(lazyCalls(harness).map((call) => call.payload.asset), ["settings"]);
    harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
      detail: { reason: "profile_entry", profile: true },
    }));
    assert.deepEqual(lazyCalls(harness).map((call) => call.payload.asset), ["settings", "profile"]);
    harness.runSettings();
    assert.equal(harness.document.querySelector(".cltc-settings-modal"), null, "late Settings registration cannot steal Profile ownership");
    harness.runProfile();
    assert.ok(harness.document.getElementById("codex-live-token-cost-profile-page"));
  });

  it("keeps the real VM runtime bounded under lifecycle, reinjection, view and snapshot pressure", async () => {
    const harness = await createHarness((path, payload) => {
      if (path === "/token-cost/bootstrap") return successfulBootstrap(payload.instance_id);
      if (path === "/token-cost/lazy-asset") return { status: "ok" };
      if (path === "/token-cost/action" && payload.action.type === "query_analytics") {
        return { status: "ok", response: { type: "analytics", analytics: analyticsSnapshot() } };
      }
      if (path === "/token-cost/action" && payload.action.type === "query_diagnostics") {
        return nativeDiagnosticsResponse();
      }
      return { status: "ok" };
    });
    harness.run();
    await harness.settle();
    harness.runSettings();
    harness.runAnalytics();
    harness.runProfile();
    harness.runFlatpickr();

    const api = harness.window.__codexLiveTokenCostV1;
    const root = harness.document.getElementById("codex-live-token-cost")!;
    const settingsButton = harness.document.getElementById("codex-live-token-cost-settings")!;
    const representativeChildren = ["session-turns", "session-output", "session-input"].map((key) => (
      root.querySelector(`[data-cltc-value-key='${key}']`)!
    ));
    assert.ok(representativeChildren.every(Boolean));
    const before = await api.diagnostics();
    assert.equal(actionCalls(harness, "query_diagnostics").length, 1);

    for (let index = 0; index < 1_000; index += 1) {
      harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
        detail: { reason: "route", profile: false, route: `/pressure/${index}` },
      }));
    }
    for (let index = 0; index < 200; index += 1) harness.run();
    assert.equal(harness.window.__codexLiveTokenCostV1, api);
    assert.equal(harness.document.getElementById("codex-live-token-cost"), root);
    assert.equal(actionCalls(harness, "query_diagnostics").length, 1, "ordinary paths never poll diagnostics");

    for (let index = 0; index < 100; index += 1) {
      settingsButton.click();
      const overlay = harness.document.querySelector(".cltc-settings-overlay")!;
      overlay.querySelector("[data-settings-panel='usage']")!.click();
      await harness.settle();
      overlay.querySelector("[data-analytics-preset='custom']")!.click();
      overlay.querySelector("[data-action='open-analytics-calendar']")!.click();
      assert.equal(harness.document.querySelectorAll(".flatpickr-calendar").length, 1);
      overlay.querySelector("[data-analytics-preset='today']")!.click();
      await harness.settle();
      assert.equal(harness.document.querySelector(".flatpickr-calendar"), null);
      overlay.querySelector("[data-action='close-price']")!.click();

      harness.document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
        detail: { reason: "profile_entry", profile: true },
      }));
      assert.ok(harness.document.getElementById("codex-live-token-cost-profile-page"));
      harness.document.querySelector("[data-profile-action='close']")!.click();
    }

    for (const [index, key] of ["session-turns", "session-output", "session-input"].entries()) {
      assert.equal(root.querySelector(`[data-cltc-value-key='${key}']`), representativeChildren[index]);
    }
    assert.ok(Number.isSafeInteger(harness.document.structuralMutations));
    const structuralMutationsBeforeSnapshots = harness.document.structuralMutations;
    const writesBeforeSnapshots = (await api.diagnostics()).domWrites;
    for (let index = 0; index < 300; index += 1) {
      assert.equal(api.acceptNativePush({
        type: "snapshot",
        instance_id: api.instanceId,
        snapshot: baseSnapshot(index + 2, { turns: index + 100 }),
      }), true);
    }
    const after = await api.diagnostics();
    const sortedDurations = [...after.updateDurationsMs].sort((left, right) => left - right);
    const p95 = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1];

    assert.equal(after.domWrites - writesBeforeSnapshots, 300, "changed-only HUD snapshots write one owned field each");
    assert.equal(harness.document.structuralMutations, structuralMutationsBeforeSnapshots, "snapshot updates never reconstruct HUD children");
    for (const [index, key] of ["session-turns", "session-output", "session-input"].entries()) {
      assert.equal(root.querySelector(`[data-cltc-value-key='${key}']`), representativeChildren[index]);
    }
    assert.equal(after.updateDurationsMs.length, 256);
    assert.ok(p95 <= 4, `HUD update p95 ${p95}ms exceeds 4ms`);
    assert.ok(Math.max(...sortedDurations) < 16, "every HUD update stays under one 16ms frame");
    assert.equal(after.ownedNodeCount, before.ownedNodeCount);
    assert.equal(harness.document.getElementById("codex-live-token-cost"), root);
    assert.equal(listenerCount(harness.document, "click"), 1);
    assert.equal(listenerCount(harness.document, "change"), 1);
    assert.equal(listenerCount(harness.document, "codex-plus:token-cost-lifecycle"), 1);
    assert.equal(harness.document.observerCount, 0);
    assert.equal(harness.clock.tasks.size, 0);
    assert.equal(actionCalls(harness, "query_diagnostics").length, 3);
  });

  it("keeps lazy view sources inert, bounded and visually tied to the frozen contract", async () => {
    const [startup, settings, analytics, profile, flatpickr, flatpickrCss] = await Promise.all([
      readFile(new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url), "utf8"),
      readFile(new URL("../../../assets/live_token_cost/settings.js", import.meta.url), "utf8"),
      readFile(new URL("../../../assets/live_token_cost/analytics.js", import.meta.url), "utf8"),
      readFile(new URL("../../../assets/live_token_cost/profile.js", import.meta.url), "utf8"),
      readFile(new URL("../../../assets/live_token_cost/flatpickr.js", import.meta.url), "utf8"),
      readFile(new URL("../../../assets/live_token_cost/flatpickr.css", import.meta.url), "utf8"),
    ]);
    assert.ok(Buffer.byteLength(startup) <= 61_440);
    for (const lazySentinel of ["cltc-analytics-metrics", "profile-card", "flatpickr v4.6.13", "flatpickr-calendar"]) assert.equal(startup.includes(lazySentinel), false, lazySentinel);
    for (const source of [analytics, profile]) {
      assert.equal((source.match(/registerModule\(/g) || []).length, 1);
      for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "MutationObserver", "ResizeObserver", "setInterval", "requestAnimationFrame", "offsetWidth", "getBoundingClientRect", "fetch(", "XMLHttpRequest", "WebSocket", "__reactFiber", "eval(", "new Function", ".innerHTML"]) {
        assert.equal(source.includes(forbidden), false, forbidden);
      }
    }
    assert.match(analytics, /使用统计[\s\S]*基于 HUD、Profile 与 CC Switch 相同的本地去重口径/);
    assert.match(analytics, /cltc-segmented[\s\S]*Token 构成[\s\S]*cltc-analytics-model-head/);
    assert.match(analytics, /gap:26px/);
    assert.match(analytics, /border-top:1px solid var\(--cltc-border-subtle\);border-bottom:1px solid var\(--cltc-border-subtle\)/);
    assert.doesNotMatch(analytics, /\.cltc-analytics-metric\{[^}]*border:/);
    assert.equal((analytics.match(/\.cltc-analytics \[data-tone=/g) || []).length, 4, "composition tones stay scoped to the owned analytics root");
    assert.match(profile, /个人资料[\s\S]*通知[\s\S]*数据控制[\s\S]*电子邮箱[\s\S]*订阅计划/);
    assert.doesNotMatch(profile, /[},]\.cltc-profile-/, "profile CSS selectors stay scoped to the owned root");
    assert.match(flatpickr, /Flatpickr 4\.6\.13 \+ zh locale/);
    assert.match(flatpickr, /@license MIT/);
    assert.match(flatpickr, /rangeSeparator: " 至 "/);
    assert.doesNotMatch(flatpickr, /eval\(|new Function/);
    assert.doesNotMatch(flatpickrCss, /animation\s*:[^;]*infinite/i);
    assert.match(flatpickrCss, /\.flatpickr-calendar\{[^}]*animation:none/);
    assert.match(settings, /data-settings-panel/);

    const expectedHashes: Record<string, string> = {
      "hud-idle.png": "bf36885a7b502f3555dd653861c5997ce79cdbdd790328ef40dd850fb28840fc",
      "hud-running.png": "bf36885a7b502f3555dd653861c5997ce79cdbdd790328ef40dd850fb28840fc",
      "profile-page.png": "507ca262fc7066a5b9b3f48ced95fb020cd9d46acef9ec1dba33d8436bba3a98",
      "settings-calendar.png": "fb387ae20493f566c64946f0862ec12fe514c8f612d1a66f421e3de9e50704cf",
      "settings-general.png": "1fb762abf9cae06a28b9dab3c8bc9b1d1382f62a499cb2bab67e05cd17fad941",
      "settings-pricing.png": "2d828c09fdf0e72d588b945e90534629694de4672d10ac1ad6c8516edd3726ec",
      "settings-profile.png": "54232737ae184c358d57eed24106066a1294463b22c7bee012e055f4ae55bb1e",
      "settings-usage.png": "f25f88e353e17257784e1440c61bdc64f9f7548654a2c088acaccef6db79569a",
    };
    for (const [name, expected] of Object.entries(expectedHashes)) {
      const bytes = await readFile(new URL(`../../../docs/superpowers/evidence/ds-style-cost-baseline/${name}`, import.meta.url));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name);
    }
  });
});
