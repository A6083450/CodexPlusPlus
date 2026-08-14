import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const TEXT_NODE = 3 as const;
const ELEMENT_NODE = 1 as const;
type TestNode = TextNode | ElementNode;
type TestMutation = { type: string; target: TestNode; addedNodes: TestNode[] };
type TestObserverCallback = (mutations: TestMutation[]) => void;

class TextNode {
  nodeType = TEXT_NODE;
  parentElement: ElementNode | null = null;
  nodeValue: string;

  constructor(value: string) {
    this.nodeValue = value;
  }

  get textContent() {
    return this.nodeValue;
  }

  set textContent(value) {
    this.nodeValue = String(value);
  }
}

class ElementNode {
  nodeType = ELEMENT_NODE;
  parentElement: ElementNode | null = null;
  childNodes: TestNode[] = [];
  attributes = new Map<string, string>();
  tagName: string;

  constructor(tagName: string, attributes: Record<string, string | boolean> = {}) {
    this.tagName = String(tagName).toUpperCase();
    for (const [name, value] of Object.entries(attributes)) {
      this.setAttribute(name, value);
    }
  }

  append(...nodes: Array<TestNode | string>) {
    for (const value of nodes) {
      const node: TestNode = typeof value === "string" ? new TextNode(value) : value;
      node.parentElement = this;
      this.childNodes.push(node);
    }
    return this;
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === ELEMENT_NODE);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent || "").join("");
  }

  set textContent(value: string) {
    this.childNodes = [];
    this.append(String(value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string | boolean) {
    this.attributes.set(name, String(value));
  }

  matches(selector: string) {
    return String(selector)
      .split(",")
      .map((part) => part.trim())
      .some((part) => matchesSimpleSelector(this, part));
  }

  closest(selector: string) {
    let current: ElementNode | null = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string) {
    const matches: ElementNode[] = [];
    walkElements(this, (element) => {
      if (element !== this && element.matches(selector)) matches.push(element);
    });
    return matches;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function matchesSimpleSelector(element: ElementNode, selector: string) {
  if (!selector) return false;
  if (selector === "[contenteditable='true']" || selector === '[contenteditable="true"]') {
    return element.getAttribute("contenteditable") === "true";
  }
  const attribute = selector.match(/^\[([\w-]+)(?:=(['"]?)(.*?)\2)?\]$/);
  if (attribute) {
    const actual = element.getAttribute(attribute[1]);
    return attribute[3] === undefined ? actual !== null : actual === attribute[3];
  }
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function walkElements(root: ElementNode | null | undefined, visit: (element: ElementNode) => void) {
  if (root?.nodeType !== ELEMENT_NODE) return;
  visit(root);
  for (const child of root.children) walkElements(child, visit);
}

function textNodes(root: TestNode) {
  const result: TextNode[] = [];
  const visit = (node: TestNode) => {
    if (node.nodeType === TEXT_NODE) {
      result.push(node);
      return;
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(root);
  return result;
}

function element(
  tagName: string,
  attributes: Record<string, string | boolean> = {},
  ...children: Array<TestNode | string>
) {
  return new ElementNode(tagName, attributes).append(...children);
}

function reasoningOption(effort: string, label: string, checked = false, description = "") {
  const labelNode = new TextNode(label);
  const item = element(
    "div",
    {
      role: "menuitem",
      "data-value": effort,
      "aria-checked": String(checked),
    },
    element("span", {}, labelNode),
    ...(description ? [element("span", {}, description)] : []),
  );
  return { effort, item, labelNode };
}

async function runTranslationScript() {
  const source = await readFile(
    new URL("../../../assets/user_scripts/market-codex-zhcn-translate.js", import.meta.url),
    "utf8",
  );
  const body = element("body");
  const unrelatedMedium = new TextNode("中");
  const unrelatedHigh = new TextNode("高");
  body.append(element("section", {}, unrelatedMedium, unrelatedHigh));

  const parentSummary = new TextNode("极高");
  const parentItem = element(
    "div",
    { role: "menuitem" },
    element("span", {}, "推理强度"),
    element("span", {}, parentSummary),
  );
  body.append(element("div", { role: "menu" }, parentItem));

  const composerSummary = new TextNode("极高");
  const composerTrigger = element(
    "button",
    { "data-selected-reasoning-effort": "xhigh" },
    element("span", {}, "5.6 Sol"),
    element("span", {}, composerSummary),
  );
  body.append(composerTrigger);

  const options = [
    reasoningOption("low", "轻度"),
    reasoningOption("medium", "中"),
    reasoningOption("high", "高"),
    reasoningOption("xhigh", "极高", true),
    reasoningOption("max", "最高"),
    reasoningOption("ultra", "极高", false, "更快消耗使用额度"),
  ];
  body.append(
    element(
      "div",
      { role: "menu" },
      element("div", {}, "推理强度"),
      ...options.map((option) => option.item),
    ),
  );

  let observerCallback: TestObserverCallback | null = null;
  let observerOptions: MutationObserverInit | null = null;
  class TestMutationObserver {
    constructor(callback: TestObserverCallback) {
      observerCallback = callback;
    }

    observe(_root: TestNode, options: MutationObserverInit) {
      observerOptions = options;
    }

    disconnect() {}
  }

  const document = {
    body,
    documentElement: body,
    readyState: "complete",
    addEventListener() {},
    createTreeWalker(root: TestNode) {
      const nodes = textNodes(root);
      let index = 0;
      return {
        nextNode() {
          return nodes[index++] || null;
        },
      };
    },
    querySelectorAll(selector: string) {
      const matches: ElementNode[] = [];
      walkElements(body, (candidate) => {
        if (candidate.matches(selector)) matches.push(candidate);
      });
      return matches;
    },
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] || null;
    },
  };
  const window: Record<string, unknown> = {};
  vm.runInNewContext(source, {
    console,
    document,
    MutationObserver: TestMutationObserver,
    Node: { TEXT_NODE },
    NodeFilter: { SHOW_TEXT: 4 },
    window,
  });

  return {
    body,
    options,
    parentSummary,
    composerSummary,
    composerTrigger,
    unrelatedMedium,
    unrelatedHigh,
    get observerCallback() {
      return observerCallback;
    },
    get observerOptions() {
      return observerOptions;
    },
  };
}

test("renders bilingual reasoning options and the selected xhigh summary", async () => {
  const harness = await runTranslationScript();

  assert.deepEqual(
    harness.options.map((option) => option.labelNode.nodeValue),
    ["轻度(low)", "中(medium)", "高(high)", "极高(xhigh)", "最高(max)", "极高(ultra)"],
  );
  assert.equal(harness.parentSummary.nodeValue, "极高(xhigh)");
  assert.equal(harness.unrelatedMedium.nodeValue, "中");
  assert.equal(harness.unrelatedHigh.nodeValue, "高");
});

test("updates the selected summary when ultra becomes checked", async () => {
  const harness = await runTranslationScript();
  const xhigh = harness.options.find((option) => option.effort === "xhigh");
  const ultra = harness.options.find((option) => option.effort === "ultra");
  const observerCallback = harness.observerCallback;
  const observerOptions = harness.observerOptions;
  assert.ok(xhigh);
  assert.ok(ultra);
  assert.ok(observerCallback);
  assert.ok(observerOptions);

  xhigh.item.setAttribute("aria-checked", "false");
  ultra.item.setAttribute("aria-checked", "true");
  observerCallback([
    { type: "attributes", target: xhigh.item, addedNodes: [] },
    { type: "attributes", target: ultra.item, addedNodes: [] },
  ]);

  assert.equal(harness.parentSummary.nodeValue, "极高(ultra)");
  assert.equal(ultra.labelNode.nodeValue, "极高(ultra)");
  assert.equal(observerOptions.attributes, true);

  observerCallback([
    { type: "attributes", target: ultra.item, addedNodes: [] },
  ]);
  assert.equal(harness.parentSummary.nodeValue, "极高(ultra)");
  assert.equal(ultra.labelNode.nodeValue, "极高(ultra)");
});

test("synchronizes the composer summary when its selected reasoning effort changes", async () => {
  const harness = await runTranslationScript();
  const observerCallback = harness.observerCallback;
  const observerOptions = harness.observerOptions;
  assert.ok(observerCallback);
  assert.ok(observerOptions);

  assert.equal(harness.composerSummary.nodeValue, "极高(xhigh)");

  harness.composerTrigger.setAttribute("data-selected-reasoning-effort", "ultra");
  harness.composerSummary.nodeValue = "极高";
  observerCallback([
    { type: "attributes", target: harness.composerTrigger, addedNodes: [] },
  ]);

  assert.equal(harness.composerSummary.nodeValue, "极高(ultra)");
  assert.ok(observerOptions.attributeFilter?.includes("data-selected-reasoning-effort"));
});
