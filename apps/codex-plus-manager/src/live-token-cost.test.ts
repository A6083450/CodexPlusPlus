import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import vm from "node:vm";

type ScriptTestApi = Record<string, (...args: any[]) => any>;

function mockElement(tagName = "div"): any {
  const attributes = new Map<string, string>();
  const styleValues = new Map<string, string>();
  const element: any = {
    tagName: tagName.toUpperCase(),
    id: "",
    className: "",
    textContent: "",
    dataset: {},
    children: [] as any[],
    parentElement: null,
    replaceChildrenCalls: 0,
    style: {
      setProperty(name: string, value: string) {
        styleValues.set(name, String(value));
      },
      getPropertyValue(name: string) {
        return styleValues.get(name) ?? "";
      },
      removeProperty(name: string) {
        styleValues.delete(name);
        delete (this as Record<string, any>)[name];
      },
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, String(value));
      if (name === "id") this.id = String(value);
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    addEventListener() {},
    append(...nodes: any[]) {
      nodes.forEach((node) => this.appendChild(node));
    },
    appendChild(node: any) {
      node.remove?.();
      this.children.push(node);
      node.parentElement = this;
      return node;
    },
    insertBefore(node: any, before: any) {
      node.remove?.();
      const index = before ? this.children.indexOf(before) : -1;
      if (index >= 0) this.children.splice(index, 0, node);
      else this.children.push(node);
      node.parentElement = this;
      return node;
    },
    replaceChildren(...nodes: any[]) {
      this.replaceChildrenCalls += 1;
      this.children.forEach((child: any) => {
        if (child.parentElement === this) child.parentElement = null;
      });
      this.children = [];
      nodes.forEach((node) => this.appendChild(node));
    },
    remove() {
      const parent = this.parentElement;
      if (!parent?.children) return;
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
      this.parentElement = null;
    },
    querySelectorAll(selector: string) {
      const results: any[] = [];
      const visit = (node: any) => {
        node.children?.forEach((child: any) => {
          const classes = String(child.className || "").split(/\s+/);
          if (selector.startsWith(".") && classes.includes(selector.slice(1))) results.push(child);
          if (selector === "button" && child.tagName === "BUTTON") results.push(child);
          visit(child);
        });
      };
      visit(this);
      return results;
    },
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    closest(selector: string) {
      let current: any = this;
      while (current) {
        if (String(selector).includes(`#${current.id}`) && current.id) return current;
        const classes = String(current.className || "").split(/\s+/).filter(Boolean);
        if (classes.some((name) => String(selector).includes(`.${name}`))) return current;
        current = current.parentElement;
      }
      return null;
    },
  };
  element.classList = {
    contains(name: string) {
      return String(element.className || "").split(/\s+/).includes(name);
    },
    add(name: string) {
      if (!this.contains(name)) element.className = `${element.className} ${name}`.trim();
    },
    remove(name: string) {
      element.className = String(element.className || "").split(/\s+/).filter((value) => value && value !== name).join(" ");
    },
  };
  Object.defineProperties(element, {
    firstElementChild: { get: () => element.children[0] ?? null },
    childNodes: { get: () => element.children },
    nextSibling: {
      get: () => {
        const siblings = element.parentElement?.children || [];
        const index = siblings.indexOf(element);
        return index >= 0 ? siblings[index + 1] ?? null : null;
      },
    },
    isConnected: { get: () => Boolean(element.parentElement) },
  });
  return element;
}

async function loadScriptTestApi(): Promise<ScriptTestApi> {
  const source = await readFile(new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url), "utf8");
  const storage = new Map<string, string>();
  const localStorage = {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, String(value));
    },
    removeItem(key: string) {
      storage.delete(key);
    },
  };
  const head = mockElement("head");
  const body = mockElement("body");
  const documentElement = mockElement("html");
  const document = {
    readyState: "loading",
    head,
    body,
    documentElement,
    getElementById() {
      return null;
    },
    createElement(tagName: string) {
      return mockElement(tagName);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject: Record<string, any> = {
    __CODEX_LIVE_TOKEN_COST_TEST__: true,
    document,
    localStorage,
    location: { href: "app://-/index.html", protocol: "app:", pathname: "/index.html", search: "", hash: "" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    setInterval() {
      return 0;
    },
    clearInterval() {},
  };
  windowObject.window = windowObject;

  vm.runInNewContext(source, {
    window: windowObject,
    document,
    localStorage,
    console,
    URL,
    Blob,
    TextEncoder,
    TextDecoder,
    setTimeout: windowObject.setTimeout,
    clearTimeout: windowObject.clearTimeout,
    setInterval: windowObject.setInterval,
    clearInterval: windowObject.clearInterval,
  });

  return windowObject.__codexLiveTokenCostTest as ScriptTestApi;
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("Codex Live Token Cost session performance HUD", () => {
  it("merges concurrent tool time and derives LLM, first-token, and output-rate metrics", async () => {
    const api = await loadScriptTestApi();
    const turn = { startedAt: 1_000, calls: [] };

    api.ensureTurnPerformance(turn, 1_000);
    api.recordTurnFirstToken(turn, 2_000);
    api.recordTurnUsageStep(turn, { output: 100 }, 3_000);
    api.recordTurnToolStarted(turn, "tool-a", 4_000);
    api.recordTurnToolStarted(turn, "tool-b", 5_000);
    api.recordTurnToolCompleted(turn, "tool-a", 8_000);
    api.recordTurnToolCompleted(turn, "tool-b", 9_000);
    api.recordTurnFirstToken(turn, 10_000);
    api.recordTurnUsageStep(turn, { output: 200 }, 12_000);

    assert.deepEqual(JSON.parse(JSON.stringify(api.turnPerformanceSnapshot(turn, 12_000))), {
      llmMs: 6_000,
      toolMs: 5_000,
      firstTokenTotalMs: 2_000,
      firstTokenSamples: 2,
      firstTokenAverageMs: 1_000,
      generationMs: 3_000,
      generationOutputTokens: 300,
      outputRate: 100,
    });
  });

  it("uses the per-second output rate while a turn is running", async () => {
    const api = await loadScriptTestApi();
    const outputStartedAt = 1_786_000_000_000;
    const turn = {
      usage: { input: 0, output: 100, cached: 0, total: 100, exact: true },
      outputStartedAt,
    };
    const afterOneSecond = api.outputTokenRate(turn, true, outputStartedAt + 1_000);
    const afterTwoSeconds = api.outputTokenRate(turn, true, outputStartedAt + 2_000);

    assert.deepEqual(
      [
        api.hudOutputRate({ running: true, rate: afterOneSecond, performance: { outputRate: 25 } }),
        api.hudOutputRate({ running: true, rate: afterTwoSeconds, performance: { outputRate: 25 } }),
      ],
      [100, 50],
    );
  });

  it("starts the live output rate from the first agent text delta", async () => {
    const api = await loadScriptTestApi();
    const outputStartedAt = 1_786_000_000_000;
    const turn: any = { startedAt: outputStartedAt - 1_000, calls: [] };

    const changed = api.recordTurnOutputDelta(turn, "hello world", outputStartedAt);
    const rate = api.outputTokenRate(turn, true, outputStartedAt);

    assert.equal(changed, true);
    assert.equal(turn.outputStartedAt, outputStartedAt);
    assert.deepEqual(JSON.parse(JSON.stringify(rate)), { active: true, visible: true, value: 3 });
  });

  it("connects app-server agent message deltas to the live output rate", async () => {
    const api = await loadScriptTestApi();
    const turn = api.beginLocalTurn({
      sessionKey: "thread-live-rate",
      turnId: "turn-live-rate",
      startedAt: Date.now() - 1_000,
    });

    api.observeTurnPerformancePayload({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-live-rate",
        turnId: "turn-live-rate",
        itemId: "message-live-rate",
        delta: "hello world",
      },
    });

    assert.ok(turn.outputStartedAt > 0);
    assert.equal(api.outputTokenRate(turn, true, turn.outputStartedAt).value, 3);
  });

  it("replaces pending delta estimates with exact output usage", async () => {
    const api = await loadScriptTestApi();
    const outputStartedAt = 1_786_000_000_000;
    const turn: any = { startedAt: outputStartedAt - 1_000, calls: [] };

    api.recordTurnOutputDelta(turn, "hello world", outputStartedAt);
    turn.calls.push({ usage: { input: 0, output: 10, cached: 0, total: 10, exact: true } });
    api.recordTurnUsageStep(turn, turn.calls[0].usage, outputStartedAt + 1_000);

    assert.equal(api.outputTokenRate(turn, true, outputStartedAt + 2_000).value, 5);

    api.recordTurnOutputDelta(turn, "next", outputStartedAt + 2_000);
    assert.equal(api.outputTokenRate(turn, true, outputStartedAt + 3_000).value, 4);
  });

  it("keeps the session output-rate average after the turn stops", async () => {
    const api = await loadScriptTestApi();

    assert.equal(
      api.hudOutputRate({ running: false, rate: { active: false, visible: false, value: 0 }, performance: { outputRate: 25 } }),
      25,
    );
  });

  it("aggregates session counts and tokens while excluding untimed history from timing averages", async () => {
    const api = await loadScriptTestApi();
    const summary = api.sessionPerformance([
      {
        callCount: 2,
        durationMs: 11_000,
        usage: { input: 1_000, output: 300, cached: 900, total: 1_300, exact: true },
        performance: {
          llmMs: 6_000,
          toolMs: 5_000,
          firstTokenTotalMs: 2_000,
          firstTokenSamples: 2,
          generationMs: 3_000,
          generationOutputTokens: 300,
        },
      },
      {
        callCount: 1,
        durationMs: 4_000,
        usage: { input: 500, output: 50, cached: 200, total: 550, exact: true },
      },
    ]);

    assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
      turns: 2,
      steps: 3,
      llmMs: 6_000,
      toolMs: 5_000,
      firstTokenAverageMs: 1_000,
      outputRate: 100,
      input: 1_500,
      output: 350,
      cached: 1_100,
      timedTurns: 1,
    });
  });

  it("renders the five screenshot metric groups instead of cost and model pills", async () => {
    const api = await loadScriptTestApi();
    const text = plainText(api.hubSkeletonHtml(true));

    assert.match(text, /轮 · 步/);
    assert.match(text, /LLM · 工具调用/);
    assert.match(text, /首 token 平均 · tok\/s/);
    assert.match(text, /缓存命中/);
    assert.match(text, /输入 tok · 输出 tok/);
    assert.doesNotMatch(text, /花费|今日|模型/);
  });

  it("keeps the settings button disconnected until the Codex++ menu is native", async () => {
    const api = await loadScriptTestApi();
    const body = mockElement("body");
    const documentElement = mockElement("html");
    const menu = mockElement("div");
    menu.id = "codex-plus-menu";
    menu.className = "codex-plus-menu-floating";
    menu.hidden = true;
    documentElement.appendChild(menu);
    const doc = {
      body,
      documentElement,
      getElementById: (id: string) => id === "codex-plus-menu" ? menu : null,
      querySelectorAll: () => [],
      createElement: (tagName: string) => mockElement(tagName),
    };

    const button = api.ensureHeaderSettingsButton(doc);

    assert.equal(button.parentElement, null);
  });

  it("places the settings button immediately before a native Codex++ menu", async () => {
    const api = await loadScriptTestApi();
    const nativeGroup = mockElement("div");
    const menu = mockElement("div");
    menu.id = "codex-plus-menu";
    nativeGroup.appendChild(menu);
    const doc = {
      body: mockElement("body"),
      documentElement: mockElement("html"),
      getElementById: (id: string) => id === "codex-plus-menu" ? menu : null,
      querySelectorAll: () => [],
      createElement: (tagName: string) => mockElement(tagName),
    };

    const button = api.ensureHeaderSettingsButton(doc);

    assert.deepEqual(nativeGroup.children, [button, menu]);
    assert.equal(button.dataset.floating, "false");
    assert.equal(button.style.position ?? "", "");
    assert.equal(button.style.left ?? "", "");
    assert.equal(button.style.top ?? "", "");
  });

  it("does not replace rolling children when text and node order are unchanged", async () => {
    const api = await loadScriptTestApi();
    const slot = mockElement("span");

    api.updateRollingValueSlot(slot, "session-input", "12M");
    const roll = slot.firstElementChild;
    const initialReplacements = roll.replaceChildrenCalls;
    api.updateRollingValueSlot(slot, "session-input", "12M");
    api.updateRollingValueSlot(slot, "session-input", "13M");

    assert.equal(roll.replaceChildrenCalls, initialReplacements);
  });

  it("ignores mutations whose targets belong to the live-token-cost UI", async () => {
    const api = await loadScriptTestApi();
    const root = mockElement("div");
    root.id = "codex-live-token-cost";
    const child = mockElement("span");
    root.appendChild(child);
    const external = mockElement("main");

    assert.equal(api.shouldScheduleObservedUiSync([{ target: child }]), false);
    assert.equal(api.shouldScheduleObservedUiSync([{ target: external }]), true);
  });

  it("limits the active output-rate refresh loop to once per second", async () => {
    const api = await loadScriptTestApi();

    assert.equal(api.outputRateRefreshIntervalMs(), 1_000);
  });
});
