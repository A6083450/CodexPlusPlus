import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import vm from "node:vm";

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type Listener = { callback: (event: FakeEvent) => void; capture: boolean };

const VOID_TAGS = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"]);

function rectangle(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height, top: y, right: x + width, bottom: y + height, left: x };
}

function dataAttribute(name: string): string {
  return `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly detail: any;
  readonly key: string;
  readonly shiftKey: boolean;
  target: FakeElement | null;
  currentTarget: FakeElement | FakeDocument | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  immediatePropagationStopped = false;

  constructor(type: string, options: Record<string, unknown> = {}) {
    this.type = type;
    this.bubbles = options.bubbles !== false;
    this.detail = options.detail;
    this.key = String(options.key || "");
    this.shiftKey = Boolean(options.shiftKey);
    this.target = (options.target as FakeElement | undefined) || null;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  stopImmediatePropagation() {
    this.immediatePropagationStopped = true;
    this.propagationStopped = true;
  }
}

class FakeStyle {
  private readonly values = new Map<string, string>();

  setProperty(name: string, value: string) {
    this.values.set(name, String(value));
  }

  getPropertyValue(name: string) {
    return this.values.get(name) || "";
  }

  removeProperty(name: string) {
    const previous = this.getPropertyValue(name);
    this.values.delete(name);
    return previous;
  }

  entries() {
    return this.values.entries();
  }

  get cssText() {
    return Array.from(this.values.entries()).map(([name, value]) => `${name}: ${value}`).join("; ");
  }

  set cssText(value: string) {
    this.values.clear();
    parseDeclarations(String(value)).forEach((entry, property) => this.values.set(property, entry));
  }
}

function createStyle(): FakeStyle & Record<string, any> {
  const style = new FakeStyle();
  return new Proxy(style as FakeStyle & Record<string, any>, {
    get(target, property, receiver) {
      if (typeof property === "string" && !(property in target)) return target.getPropertyValue(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`));
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (typeof property === "string" && !(property in target)) {
        target.setProperty(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), String(value));
        return true;
      }
      return Reflect.set(target, property, value, receiver);
    },
  });
}

class FakeText {
  readonly nodeType = 3;
  parentElement: FakeElement | null = null;
  textContent: string;

  constructor(textContent: string) {
    this.textContent = textContent;
  }

  get parentNode() {
    return this.parentElement;
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.childNodes.indexOf(this);
    if (index >= 0) this.parentElement.childNodes.splice(index, 1);
    this.parentElement = null;
  }
}

type FakeChild = FakeElement | FakeText;

class FakeElement {
  readonly nodeType = 1;
  readonly attributes = new Map<string, string>();
  readonly childNodes: FakeChild[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly style = createStyle();
  readonly dataset: Record<string, string>;
  readonly classList: {
    contains: (name: string) => boolean;
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    toggle: (name: string, force?: boolean) => boolean;
  };
  parentElement: FakeElement | null = null;
  id = "";
  className = "";
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  type = "";
  title = "";
  src = "";
  alt = "";
  scrollTop = 0;
  offsetWidth = 0;
  rect: Rect | null = null;
  readonly ownerDocument: FakeDocument;
  readonly tagName: string;

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.dataset = new Proxy({}, {
      get: (_target, property) => typeof property === "string" ? this.attributes.get(dataAttribute(property)) : undefined,
      set: (_target, property, value) => {
        if (typeof property === "string") this.attributes.set(dataAttribute(property), String(value));
        return true;
      },
      deleteProperty: (_target, property) => {
        if (typeof property === "string") this.attributes.delete(dataAttribute(property));
        return true;
      },
    });
    this.classList = {
      contains: (name) => this.className.split(/\s+/).filter(Boolean).includes(name),
      add: (...names) => {
        const next = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => next.add(name));
        this.className = Array.from(next).join(" ");
      },
      remove: (...names) => {
        const removed = new Set(names);
        this.className = this.className.split(/\s+/).filter((name) => name && !removed.has(name)).join(" ");
      },
      toggle: (name, force) => {
        const next = force ?? !this.classList.contains(name);
        if (next) this.classList.add(name);
        else this.classList.remove(name);
        return next;
      },
    };
  }

  get nodeName() {
    return this.tagName;
  }

  get parentNode() {
    return this.parentElement;
  }

  get children() {
    return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get nextSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.childNodes.indexOf(this);
    return index < 0 ? null : this.parentElement.childNodes[index + 1] || null;
  }

  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    return index < 0 ? null : siblings[index + 1] || null;
  }

  get isConnected() {
    let current: FakeElement | null = this;
    while (current) {
      if (current === this.ownerDocument.documentElement) return true;
      current = current.parentElement;
    }
    return false;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.replaceChildren(String(value) ? new FakeText(String(value)) : undefined);
  }

  get innerText() {
    return this.textContent;
  }

  set innerText(value: string) {
    this.textContent = value;
  }

  get innerHTML() {
    return this.textContent;
  }

  set innerHTML(value: string) {
    this.replaceChildren(...parseHtml(this.ownerDocument, String(value)));
  }

  get tabIndex() {
    return Number(this.getAttribute("tabindex") || -1);
  }

  set tabIndex(value: number) {
    this.setAttribute("tabindex", String(value));
  }

  setAttribute(name: string, value: string) {
    const normalized = name.toLowerCase();
    const text = String(value);
    this.attributes.set(normalized, text);
    if (normalized === "id") this.id = text;
    if (normalized === "class") this.className = text;
    if (normalized === "hidden") this.hidden = true;
    if (normalized === "disabled") this.disabled = true;
    if (normalized === "checked") this.checked = true;
    if (normalized === "value") this.value = text;
    if (normalized === "type") this.type = text;
    if (normalized === "title") this.title = text;
    if (normalized === "src") this.src = text;
    if (normalized === "alt") this.alt = text;
    if (normalized === "style") parseDeclarations(text).forEach((entry, property) => this.style.setProperty(property, entry));
  }

  getAttribute(name: string) {
    const normalized = name.toLowerCase();
    if (normalized === "id") return this.id || null;
    if (normalized === "class") return this.className || null;
    return this.attributes.get(normalized) ?? null;
  }

  hasAttribute(name: string) {
    const normalized = name.toLowerCase();
    if (normalized === "id") return Boolean(this.id);
    if (normalized === "class") return Boolean(this.className);
    return this.attributes.has(normalized);
  }

  removeAttribute(name: string) {
    const normalized = name.toLowerCase();
    this.attributes.delete(normalized);
    if (normalized === "id") this.id = "";
    if (normalized === "class") this.className = "";
    if (normalized === "hidden") this.hidden = false;
    if (normalized === "disabled") this.disabled = false;
    if (normalized === "checked") this.checked = false;
  }

  append(...nodes: Array<FakeChild | string | undefined>) {
    nodes.forEach((node) => {
      if (node == null) return;
      this.appendChild(typeof node === "string" ? new FakeText(node) : node);
    });
  }

  appendChild<T extends FakeChild>(node: T): T {
    if (node.parentElement) node.remove();
    this.childNodes.push(node);
    node.parentElement = this;
    return node;
  }

  insertBefore<T extends FakeChild>(node: T, before: FakeChild | null): T {
    if (node.parentElement) node.remove();
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    node.parentElement = this;
    return node;
  }

  replaceChildren(...nodes: Array<FakeChild | undefined>) {
    this.childNodes.forEach((child) => {
      child.parentElement = null;
    });
    this.childNodes.length = 0;
    nodes.forEach((node) => {
      if (node) this.appendChild(node);
    });
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.childNodes.indexOf(this);
    if (index >= 0) this.parentElement.childNodes.splice(index, 1);
    this.parentElement = null;
  }

  contains(node: FakeElement | FakeText | null): boolean {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  matches(selector: string) {
    return splitSelectorList(selector).some((part) => matchesSelectorChain(this, part));
  }

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

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type: string, callback: (event: FakeEvent) => void, options: boolean | { capture?: boolean } = false) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ callback, capture: typeof options === "boolean" ? options : Boolean(options.capture) });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, callback: (event: FakeEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((listener) => listener.callback !== callback));
  }

  dispatchEvent(event: FakeEvent) {
    event.target ||= this;
    const path: Array<FakeElement | FakeDocument> = [];
    let current: FakeElement | null = this;
    while (current) {
      path.push(current);
      current = current.parentElement;
    }
    path.push(this.ownerDocument);
    for (const target of path.slice().reverse()) {
      if (event.propagationStopped) break;
      target.invoke(event, true);
    }
    if (!event.propagationStopped) {
      for (const target of path) {
        target.invoke(event, false);
        if (event.propagationStopped || !event.bubbles) break;
      }
    }
    return !event.defaultPrevented;
  }

  invoke(event: FakeEvent, capture: boolean) {
    event.currentTarget = this;
    event.immediatePropagationStopped = false;
    for (const listener of this.listeners.get(event.type) || []) {
      if (listener.capture !== capture) continue;
      listener.callback.call(this, event);
      if (event.immediatePropagationStopped) break;
    }
  }

  click() {
    this.dispatchEvent(new FakeEvent("click", { bubbles: true }));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  getBoundingClientRect(): Rect {
    if (this.rect) return this.rect;
    return rectangle(0, 0, 0, 0);
  }
}

class FakeDocument {
  readonly listeners = new Map<string, Listener[]>();
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  readyState = "complete";
  activeElement: FakeElement;

  constructor() {
    this.documentElement = new FakeElement(this, "HTML");
    this.head = new FakeElement(this, "HEAD");
    this.body = new FakeElement(this, "BODY");
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
  }

  createElement(tagName: string) {
    return new FakeElement(this, tagName.toUpperCase());
  }

  createTextNode(text: string) {
    return new FakeText(text);
  }

  getElementById(id: string) {
    if (this.documentElement.id === id) return this.documentElement;
    return this.documentElement.querySelector(`#${id}`);
  }

  querySelectorAll(selector: string) {
    const result = this.documentElement.matches(selector) ? [this.documentElement] : [];
    return result.concat(this.documentElement.querySelectorAll(selector));
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type: string, callback: (event: FakeEvent) => void, options: boolean | { capture?: boolean } = false) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ callback, capture: typeof options === "boolean" ? options : Boolean(options.capture) });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, callback: (event: FakeEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((listener) => listener.callback !== callback));
  }

  invoke(event: FakeEvent, capture: boolean) {
    event.currentTarget = this;
    event.immediatePropagationStopped = false;
    for (const listener of this.listeners.get(event.type) || []) {
      if (listener.capture !== capture) continue;
      listener.callback.call(this, event);
      if (event.immediatePropagationStopped) break;
    }
  }

  dispatchEvent(event: FakeEvent) {
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener.callback.call(this, event);
    return !event.defaultPrevented;
  }
}

function splitSelectorList(selector: string): string[] {
  const result: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote = "";
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      if (char === quote && selector[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "(") parenthesisDepth += 1;
    else if (char === ")") parenthesisDepth -= 1;
    else if (char === "," && bracketDepth === 0 && parenthesisDepth === 0) {
      result.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(selector.slice(start).trim());
  return result.filter(Boolean);
}

function selectorParts(selector: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote = "";
  for (let index = 0; index <= selector.length; index += 1) {
    const char = selector[index] || " ";
    if (quote) {
      if (char === quote && selector[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "(") parenthesisDepth += 1;
    else if (char === ")") parenthesisDepth -= 1;
    else if (/\s|>/.test(char) && bracketDepth === 0 && parenthesisDepth === 0) {
      const part = selector.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  return parts;
}

function matchesSelectorChain(element: FakeElement, selector: string): boolean {
  const parts = selectorParts(selector);
  if (!parts.length || !matchesCompound(element, parts.at(-1)!)) return false;
  let ancestor = element.parentElement;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesCompound(ancestor, parts[index])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

function matchesCompound(element: FakeElement, selector: string): boolean {
  const pseudoNot = Array.from(selector.matchAll(/:not\(([^)]+)\)/g));
  if (pseudoNot.some((match) => matchesCompound(element, match[1]))) return false;
  const cleaned = selector.replace(/:not\([^)]+\)/g, "").replace(/::?[\w-]+(?:\([^)]*\))?/g, "");
  const tag = cleaned.match(/^[a-zA-Z*][\w-]*/)?.[0];
  if (tag && tag !== "*" && element.tagName !== tag.toUpperCase()) return false;
  for (const match of cleaned.matchAll(/#([\w-]+)/g)) {
    if (element.id !== match[1]) return false;
  }
  for (const match of cleaned.matchAll(/\.([\w-]+)/g)) {
    if (!element.classList.contains(match[1])) return false;
  }
  for (const match of cleaned.matchAll(/\[\s*([^\s~|^$*!=\]]+)\s*(?:([*^$]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/g)) {
    const name = match[1];
    const operator = match[2];
    const expected = match[3] ?? match[4] ?? match[5] ?? "";
    const actual = element.getAttribute(name);
    if (!operator && actual == null) return false;
    if (operator === "=" && actual !== expected) return false;
    if (operator === "*=" && !String(actual || "").includes(expected)) return false;
    if (operator === "^=" && !String(actual || "").startsWith(expected)) return false;
    if (operator === "$=" && !String(actual || "").endsWith(expected)) return false;
  }
  return true;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&times;/g, "×")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function parseHtml(document: FakeDocument, html: string): FakeChild[] {
  const container = document.createElement("template");
  const stack = [container];
  for (const token of html.match(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g) || []) {
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token.startsWith("<")) {
      const tagName = token.match(/^<\s*([\w-]+)/)?.[1];
      if (!tagName) continue;
      const element = document.createElement(tagName);
      const attributeText = token.slice(token.indexOf(tagName) + tagName.length, token.lastIndexOf(">"));
      for (const match of attributeText.matchAll(/([:@\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        element.setAttribute(match[1], decodeHtml(match[2] ?? match[3] ?? match[4] ?? ""));
      }
      stack.at(-1)!.appendChild(element);
      if (!VOID_TAGS.has(element.tagName) && !token.endsWith("/>")) stack.push(element);
      continue;
    }
    stack.at(-1)!.appendChild(new FakeText(decodeHtml(token)));
  }
  const children = container.childNodes.slice();
  children.forEach((child) => {
    child.parentElement = null;
  });
  return children;
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  body.split(";").forEach((entry) => {
    const separator = entry.indexOf(":");
    if (separator < 0) return;
    const property = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim().replace(/\s*!important\s*$/, "");
    if (property) declarations.set(property, value);
  });
  return declarations;
}

type CascadeDeclaration = { property: string; value: string; important: boolean; order: number };
type Specificity = [number, number, number];
type CascadeValue = { value: string; important: boolean; specificity: Specificity; order: number };

function cascadeDeclarations(body: string): CascadeDeclaration[] {
  const declarations: CascadeDeclaration[] = [];
  body.split(";").forEach((entry, order) => {
    const separator = entry.indexOf(":");
    if (separator < 0) return;
    const property = entry.slice(0, separator).trim();
    const rawValue = entry.slice(separator + 1).trim();
    const important = /\s*!important\s*$/.test(rawValue);
    const value = rawValue.replace(/\s*!important\s*$/, "");
    if (property) declarations.push({ property, value, important, order });
  });
  return declarations;
}

function cssConditionActive(header: string): boolean {
  if (header.startsWith("@supports")) return true;
  if (!header.startsWith("@media")) return false;
  if (/prefers-color-scheme\s*:\s*dark/.test(header)) return false;
  if (/prefers-color-scheme\s*:\s*light/.test(header)) return true;
  if (/prefers-reduced-motion\s*:\s*reduce/.test(header)) return false;
  const maxWidth = header.match(/max-width\s*:\s*(\d+)px/);
  if (maxWidth) return 1440 <= Number(maxWidth[1]);
  if (/hover\s*:\s*hover/.test(header) || /pointer\s*:\s*fine/.test(header)) return true;
  return true;
}

function cssRules(css: string): Array<{ selectors: string[]; declarations: CascadeDeclaration[]; order: number }> {
  const rules: Array<{ selectors: string[]; declarations: CascadeDeclaration[]; order: number }> = [];
  let order = 0;
  const visit = (segment: string) => {
    let cursor = 0;
    while (cursor < segment.length) {
      const open = segment.indexOf("{", cursor);
      if (open < 0) break;
      const header = segment.slice(cursor, open).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      let depth = 1;
      let close = open + 1;
      while (close < segment.length && depth) {
        if (segment[close] === "{") depth += 1;
        else if (segment[close] === "}") depth -= 1;
        close += 1;
      }
      if (depth) break;
      const body = segment.slice(open + 1, close - 1);
      if (header.startsWith("@media") || header.startsWith("@supports")) {
        if (cssConditionActive(header)) visit(body);
      } else if (!header.startsWith("@")) {
        rules.push({ selectors: splitSelectorList(header), declarations: cascadeDeclarations(body), order: order++ });
      }
      cursor = close;
    }
  };
  visit(css);
  return rules;
}

function selectorSpecificity(selector: string): Specificity {
  const withoutWhere = selector.replace(/:where\([^)]*\)/g, "");
  const ids = withoutWhere.match(/#[\w-]+/g)?.length || 0;
  const classes = withoutWhere.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g)?.length || 0;
  const stripped = withoutWhere
    .replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?/g, " ")
    .replace(/[>+~*]/g, " ");
  const elements = stripped.match(/(^|\s)[a-zA-Z][\w-]*/g)?.length || 0;
  return [ids, classes, elements];
}

function compareSpecificity(left: Specificity, right: Specificity): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function cascadeWins(candidate: CascadeValue, current: CascadeValue | undefined): boolean {
  if (!current) return true;
  if (candidate.important !== current.important) return candidate.important;
  const specificity = compareSpecificity(candidate.specificity, current.specificity);
  return specificity > 0 || (specificity === 0 && candidate.order >= current.order);
}

function splitCssArguments(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const char = value[index] || ",";
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  return result;
}

function resolveCssValue(value: string, variables: Map<string, string>): string {
  let resolved = value.trim();
  for (let attempts = 0; attempts < 20; attempts += 1) {
    const start = resolved.indexOf("var(");
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let index = start + 4; index < resolved.length; index += 1) {
      if (resolved[index] === "(") depth += 1;
      else if (resolved[index] === ")" && depth === 0) {
        end = index;
        break;
      } else if (resolved[index] === ")") depth -= 1;
    }
    if (end < 0) break;
    const [name, ...fallback] = splitCssArguments(resolved.slice(start + 4, end));
    const replacement = variables.get(name) || fallback.join(", ");
    resolved = `${resolved.slice(0, start)}${replacement}${resolved.slice(end + 1)}`.trim();
  }
  for (let attempts = 0; attempts < 10; attempts += 1) {
    const start = resolved.indexOf("light-dark(");
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let index = start + 11; index < resolved.length; index += 1) {
      if (resolved[index] === "(") depth += 1;
      else if (resolved[index] === ")" && depth === 0) {
        end = index;
        break;
      } else if (resolved[index] === ")") depth -= 1;
    }
    if (end < 0) break;
    const [light] = splitCssArguments(resolved.slice(start + 11, end));
    resolved = `${resolved.slice(0, start)}${light}${resolved.slice(end + 1)}`.trim();
  }
  return resolved;
}

function computedStyle(document: FakeDocument, element: FakeElement): Record<string, any> {
  const winners = new Map<string, CascadeValue>();
  if (element.parentElement) {
    const parent = computedStyle(document, element.parentElement);
    for (const name of parent.__variables.keys()) {
      if (name.startsWith("--")) winners.set(name, { value: parent.getPropertyValue(name), important: false, specificity: [-1, -1, -1], order: -1 });
    }
  }
  let styleSheetOrder = 0;
  for (const styleElement of document.querySelectorAll("style")) {
    for (const rule of cssRules(styleElement.textContent)) {
      const matching = rule.selectors.filter((selector) => element.matches(selector));
      if (!matching.length) continue;
      const specificity = matching.map(selectorSpecificity).sort(compareSpecificity).at(-1)!;
      for (const declaration of rule.declarations) {
        const candidate = {
          value: declaration.value,
          important: declaration.important,
          specificity,
          order: styleSheetOrder + rule.order * 1000 + declaration.order,
        };
        if (cascadeWins(candidate, winners.get(declaration.property))) winners.set(declaration.property, candidate);
      }
    }
    styleSheetOrder += 1_000_000;
  }
  for (const [property, value] of element.style.entries()) {
    winners.set(property, { value, important: false, specificity: [1_000_000, 0, 0], order: Number.MAX_SAFE_INTEGER });
  }
  const values = new Map(Array.from(winners, ([property, winner]) => [property, winner.value]));
  const getPropertyValue = (name: string) => resolveCssValue(values.get(name) || "", values);
  return new Proxy({ getPropertyValue, __variables: values }, {
    get(target, property, receiver) {
      if (typeof property === "string" && !(property in target)) {
        const cssName = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        return getPropertyValue(cssName) || (cssName === "display" ? "block" : "");
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

type VisualHarness = {
  document: FakeDocument;
  flushTimers: () => void;
  getComputedStyle: (element: FakeElement) => Record<string, any>;
  profileClicks: { settings: number; profile: number };
  window: Record<string, any>;
};

function appendTextElement(document: FakeDocument, parent: FakeElement, tag: string, text: string, className = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function installControlledFixtures(document: FakeDocument, accountLabel: string, profileClicks: { settings: number; profile: number }) {
  const header = document.createElement("header");
  const headerActions = document.createElement("div");
  const codexPlusMenu = appendTextElement(document, headerActions, "button", "Codex++");
  codexPlusMenu.id = "codex-plus-menu";
  header.appendChild(headerActions);

  const main = document.createElement("main");
  main.rect = rectangle(120, 60, 1200, 760);
  const composerWrap = document.createElement("div");
  composerWrap.rect = rectangle(300, 690, 840, 150);
  const composer = document.createElement("form");
  composer.rect = rectangle(320, 710, 800, 110);
  const editable = document.createElement("textarea");
  editable.rect = rectangle(340, 730, 760, 60);
  composer.appendChild(editable);
  composerWrap.appendChild(composer);
  main.appendChild(composerWrap);

  const profileButton = document.createElement("button");
  profileButton.id = "profile-trigger";
  profileButton.setAttribute("aria-label", accountLabel);
  profileButton.setAttribute("aria-controls", "profile-menu");
  profileButton.rect = rectangle(24, 820, 216, 44);
  const gear = document.createElement("svg");
  const triggerLabel = appendTextElement(document, profileButton, "span", "Settings", "min-w-0 flex-1 truncate");
  profileButton.insertBefore(gear, triggerLabel);

  const menu = document.createElement("div");
  menu.id = "profile-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-labelledby", profileButton.id);
  const profileItem = document.createElement("button");
  profileItem.className = "menu-disabled";
  profileItem.setAttribute("role", "menuitem");
  profileItem.setAttribute("aria-disabled", "true");
  profileItem.setAttribute("data-disabled", "");
  const identityRow = document.createElement("div");
  appendTextElement(document, identityRow, "span", "L", "size-8 rounded-full");
  appendTextElement(document, identityRow, "span", "Account", "flex-1 min-w-0 truncate");
  profileItem.appendChild(identityRow);
  const settingsItem = appendTextElement(document, menu, "button", "设置");
  settingsItem.className = "menu-enabled";
  settingsItem.setAttribute("role", "menuitem");
  settingsItem.addEventListener("click", () => {
    profileClicks.settings += 1;
  });
  menu.insertBefore(profileItem, settingsItem);

  const officialProfile = appendTextElement(document, document.body, "button", "个人资料");
  officialProfile.setAttribute("role", "tab");
  officialProfile.rect = rectangle(320, 120, 120, 36);
  officialProfile.addEventListener("click", () => {
    profileClicks.profile += 1;
  });

  document.body.append(header, main, profileButton, menu);
}

async function executeScriptInDom(accountLabel = "Open profile menu"): Promise<VisualHarness> {
  const document = new FakeDocument();
  const profileClicks = { settings: 0, profile: 0 };
  installControlledFixtures(document, accountLabel, profileClicks);
  [
    ["--color-token-text-primary", "#111827"],
    ["--color-token-text-tertiary", "#6b7280"],
    ["--color-token-border-light", "#d1d5db"],
    ["--color-token-main-surface-primary", "#ffffff"],
    ["--color-token-main-surface-secondary", "#f3f4f6"],
    ["--color-token-dropdown-background", "#ffffff"],
    ["--color-token-input-background", "#ffffff"],
    ["--color-token-list-hover-background", "rgba(0, 0, 0, .06)"],
    ["--radius-2xl", "20px"],
  ].forEach(([property, value]) => document.documentElement.style.setProperty(property, value));

  const storage = new Map<string, string>([
    ["__codexLiveTokenCostHubVisibleV1", "true"],
    ["__codexLiveTokenCostOutputRateVisibleV1", "true"],
    ["__codexLiveTokenCostProfileUnlockEnabledV1", "true"],
    ["__codexLiveTokenCostProfilePrefsV1", JSON.stringify({ displayName: "Local Usage", username: "local-usage", email: "local@example.com", planType: "pro", planLabel: "Pro 20x", imageUrl: "" })],
  ]);
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const setTimeout = (callback: () => void) => {
    const id = nextTimer++;
    timers.set(id, callback);
    return id;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  const flushTimers = () => {
    while (timers.size) {
      const pending = Array.from(timers.values());
      timers.clear();
      pending.forEach((callback) => callback());
    }
  };
  const windowListeners = new Map<string, Array<(event: FakeEvent) => void>>();
  const location = { href: "app://-/index.html", origin: "app://-", protocol: "app:", pathname: "/index.html", search: "", hash: "" };
  const getComputedStyle = (element: FakeElement) => computedStyle(document, element);
  const windowObject: Record<string, any> = {
    __CODEX_LIVE_TOKEN_COST_TEST__: true,
    document,
    localStorage,
    location,
    innerHeight: 900,
    innerWidth: 1440,
    getComputedStyle,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener(type: string, callback: (event: FakeEvent) => void) {
      windowListeners.set(type, [...(windowListeners.get(type) || []), callback]);
    },
    removeEventListener(type: string, callback: (event: FakeEvent) => void) {
      windowListeners.set(type, (windowListeners.get(type) || []).filter((listener) => listener !== callback));
    },
    dispatchEvent(event: FakeEvent) {
      (windowListeners.get(event.type) || []).forEach((listener) => listener(event));
    },
    postMessage() {},
    setTimeout,
    clearTimeout,
    setInterval: setTimeout,
    clearInterval: clearTimeout,
    requestAnimationFrame(callback: () => void) {
      callback();
      return 0;
    },
    cancelAnimationFrame() {},
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
  };
  windowObject.__codexPlusPostJson = (path: string, payload: any) => {
    if (path !== "/token-cost/bootstrap") return Promise.resolve({ status: "ok", response: { type: "disposed" } });
    return Promise.resolve({
      status: "ok",
      instance_id: payload.instance_id,
      config: {
        schema_version: 1,
        hub_visible: true,
        output_rate_visible: true,
        profile_visible: true,
        price_overrides: {},
        profile: {
          display_name: "Local Usage",
          username: "codex-local-usage",
          email: "sama@openai.com",
          plan_type: "pro_20x",
          plan_label: "Pro 20x",
          workspace_name: "",
          avatar_data_url: null,
        },
      },
      snapshot: {
        revision: 1,
        running: false,
        model: "gpt-5.6-sol",
        fast: false,
        turns: 12,
        steps: 34,
        llm_ms: 68_000,
        tool_ms: 24_000,
        first_token_average_ms: 1_200,
        output_rate_milli_tokens_per_second: 52_000,
        input: 128_000,
        cached_input: 92_160,
        output: 18_000,
        cost_nanos: 123_000_000,
        hub_visible: true,
        output_rate_visible: true,
        profile_visible: true,
      },
    });
  };
  windowObject.window = windowObject;
  windowObject.self = windowObject;

  const source = await readFile(new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    window: windowObject,
    self: windowObject,
    document,
    localStorage,
    location,
    console,
    URL,
    Blob,
    TextEncoder,
    TextDecoder,
    Request,
    Response,
    Headers,
    AbortController,
    Event: FakeEvent,
    CustomEvent: FakeEvent,
    MessageEvent: FakeEvent,
    getComputedStyle,
    setTimeout,
    clearTimeout,
    setInterval: setTimeout,
    clearInterval: clearTimeout,
  });

  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  document.dispatchEvent(new FakeEvent("codex-plus:token-cost-lifecycle", {
    detail: { reason: "profile_menu", profile: true, profileMenuId: "profile-menu" },
  }));

  return { document, flushTimers, getComputedStyle, profileClicks, window: windowObject };
}

function normalizedText(node: FakeElement): string {
  return node.textContent.replace(/\s+/g, " ").trim();
}

function renderedLabel(node: FakeElement | FakeText): string {
  if (node instanceof FakeText) return node.textContent;
  if (node.classList.contains("cltc-value")) return " ";
  return node.childNodes.map(renderedLabel).join("");
}

const DEFERRED_TASK_10_11_ORACLE = {
  nav: ["个人资料", "数据与显示", "使用统计", "模型价格"],
  headings: ["个人资料", "数据与显示", "使用统计", "模型价格"],
  modalBounds: "(260, 140, 920, 620)",
  profileBounds: "(374, 205, 940, 271)",
  images: [
    ["hud-idle.png", "bf36885a7b502f3555dd653861c5997ce79cdbdd790328ef40dd850fb28840fc"],
    ["hud-running.png", "bf36885a7b502f3555dd653861c5997ce79cdbdd790328ef40dd850fb28840fc"],
    ["profile-page.png", "507ca262fc7066a5b9b3f48ced95fb020cd9d46acef9ec1dba33d8436bba3a98"],
    ["settings-calendar.png", "fb387ae20493f566c64946f0862ec12fe514c8f612d1a66f421e3de9e50704cf"],
    ["settings-general.png", "1fb762abf9cae06a28b9dab3c8bc9b1d1382f62a499cb2bab67e05cd17fad941"],
    ["settings-pricing.png", "2d828c09fdf0e72d588b945e90534629694de4672d10ac1ad6c8516edd3726ec"],
    ["settings-profile.png", "54232737ae184c358d57eed24106066a1294463b22c7bee012e055f4ae55bb1e"],
    ["settings-usage.png", "f25f88e353e17257784e1440c61bdc64f9f7548654a2c088acaccef6db79569a"],
  ],
} as const;

describe("Codex Live Token Cost 1.0.0 visual contract", () => {
  it("renders the preserved HUD labels, order, IDs, and computed visual tokens", async () => {
    const harness = await executeScriptInDom();
    const root = harness.document.getElementById("codex-live-token-cost");
    const settings = harness.document.getElementById("codex-live-token-cost-settings");

    assert.equal(harness.window.__codexLiveTokenCostVersion, "1.0.0");
    assert.ok(root, "the executed script must mount the HUD");
    assert.ok(settings, "the executed script must mount the settings trigger");
    assert.equal(settings.textContent, "今日 146K");
    assert.equal(settings.title, "今日 146K · Codex Token Cost 设置");
    assert.equal(settings.getAttribute("aria-label"), "今日 146K，打开 Codex Token Cost 设置");
    assert.deepEqual(root.querySelectorAll(".cltc-pill").map((node) => renderedLabel(node).replace(/\s+/g, " ").trim()), [
      "轮 · 步",
      "LLM · 工具调用",
      "首 token 平均 · tok/s",
      "缓存命中",
      "输入 tok · 输出 tok",
    ]);

    const style = harness.getComputedStyle(root);
    assert.deepEqual(
      Object.fromEntries(["--cltc-text", "--cltc-muted", "--cltc-border", "--cltc-surface", "--cltc-arc-bg", "--cltc-arc-radius"].map((name) => [name, style.getPropertyValue(name)])),
      {
        "--cltc-text": "#111827",
        "--cltc-muted": "rgba(26, 28, 31, .494)",
        "--cltc-border": "#d1d5db",
        "--cltc-surface": "#ffffff",
        "--cltc-arc-bg": "rgb(246, 246, 246)",
        "--cltc-arc-radius": "20px",
      },
    );
    assert.equal(style.padding, "8px 10px 25px");
    assert.equal(style.gap, "0");
    assert.equal(style.borderRadius, "20px 20px 0 0");
    assert.equal(harness.getComputedStyle(root.querySelector(".cltc-value")!).height, "16px");
    assert.equal(root.querySelectorAll(".cltc-roll").length, 0);
    assert.equal(root.querySelectorAll(".cltc-cadenced-shimmer").length, 0);
  });

  it("applies light media, source order, specificity, and important in the style oracle", () => {
    const document = new FakeDocument();
    const style = document.createElement("style");
    style.textContent = `
      #cascade { --specific: id; --important: id; }
      .cascade { --ordered: first; }
      @media (prefers-color-scheme: light) {
        .cascade { --media: light; --ordered: media; }
      }
      @media (prefers-color-scheme: dark) {
        #cascade { --media: dark; }
      }
      .cascade { --ordered: last; --specific: class; --important: class !important; }
    `;
    document.head.appendChild(style);
    const element = document.createElement("div");
    element.id = "cascade";
    element.className = "cascade";
    document.body.appendChild(element);

    const computed = computedStyle(document, element);
    assert.equal(computed.getPropertyValue("--media"), "light");
    assert.equal(computed.getPropertyValue("--ordered"), "last");
    assert.equal(computed.getPropertyValue("--specific"), "id");
    assert.equal(computed.getPropertyValue("--important"), "class");
  });

  it("keeps the Task 10/11 Settings, Analytics, Calendar, and Profile page oracle immutable", async () => {
    const baseline = new URL("../../../docs/superpowers/evidence/ds-style-cost-baseline/", import.meta.url);
    const manifest = await readFile(new URL("manifest.md", baseline), "utf8");
    assert.deepEqual(DEFERRED_TASK_10_11_ORACLE.nav, DEFERRED_TASK_10_11_ORACLE.headings);
    assert.match(manifest, new RegExp(DEFERRED_TASK_10_11_ORACLE.modalBounds.replace(/[()]/g, "\\$&")));
    assert.match(manifest, new RegExp(DEFERRED_TASK_10_11_ORACLE.profileBounds.replace(/[()]/g, "\\$&")));
    for (const [file, sha256] of DEFERRED_TASK_10_11_ORACLE.images) {
      const image = await readFile(new URL(file, baseline));
      assert.equal(createHash("sha256").update(image).digest("hex"), sha256, `${file} bytes must match the frozen baseline`);
      assert.match(manifest, new RegExp(`${file.replace(".", "\\.")}[^\\n]*${sha256}`));
    }
    assert.deepEqual(DEFERRED_TASK_10_11_ORACLE.nav, ["个人资料", "数据与显示", "使用统计", "模型价格"]);
  });

  for (const accountLabel of ["打开个人资料菜单", "Open profile menu", "Open profile menu and settings"]) {
    it(`keeps the enabled Profile entry contract for ${accountLabel}`, async () => {
      const harness = await executeScriptInDom(accountLabel);
      const trigger = harness.document.getElementById("profile-trigger")!;
      const menu = harness.document.getElementById("profile-menu")!;
      const profileItem = menu.querySelector("[role='menuitem']")!;
      const identityRow = profileItem.firstElementChild!;
      const identityAvatar = identityRow.querySelector(".size-8")!;

      assert.equal(normalizedText(trigger.querySelector("span.min-w-0.flex-1.truncate")!), "Settings");
      assert.equal(profileItem.getAttribute("role"), "menuitem");
      assert.equal(profileItem.hasAttribute("aria-disabled"), false);
      assert.equal(profileItem.hasAttribute("data-disabled"), false);
      assert.equal(profileItem.getAttribute("tabindex"), "0");
      assert.equal(profileItem.className, "menu-enabled");
      assert.equal(profileItem.getAttribute("data-codex-plus-token-cost-profile-entry"), "true");
      assert.equal(normalizedText(identityRow.querySelector("span.flex-1.min-w-0.truncate")!), "Local Usage");
      assert.ok(identityAvatar, "the enhanced menu entry must retain its host avatar");
      assert.equal(identityAvatar.classList.contains("size-8"), true);
      assert.equal(menu.children[1].className, "menu-enabled", "the host Settings sibling remains enabled");
    });
  }
});
