// ==UserScript==
// @name         Codex Live Token Cost
// @namespace    codex-plus-plus
// @version      1.0.1
// @description  Native-backed token usage HUD for Codex++
// @match        app://-/*
// @run-at       document-start
// ==/UserScript==

(() => {
  "use strict";

  const VERSION = "1.0.1";
  const ROOT_ID = "codex-live-token-cost";
  const SETTINGS_BUTTON_ID = "codex-live-token-cost-settings";
  const STYLE_ID = "codex-live-token-cost-style";
  const PROFILE_MARKER = "data-codex-plus-token-cost-profile-entry";
  const LIFECYCLE_EVENT = "codex-plus:token-cost-lifecycle";
  const MODULE_NAMES = ["settings", "analytics", "profile", "flatpickr"];
  const MAX_UPDATE_DURATION_SAMPLES = 256;
  const ACTION_NAMES = [
    "set_visibility", "save_price", "delete_price", "reset_price", "save_profile",
    "query_analytics", "sync_cc_switch", "query_diagnostics", "dispose_instance",
  ];

  if (window.__codexLiveTokenCostVersion === VERSION && window.__codexLiveTokenCostV1) return;

  const staleV1 = window.__codexLiveTokenCostV1;
  const staleLegacy = window.__codexLiveTokenCost;
  if (staleV1 && typeof staleV1.destroy === "function") {
    try { staleV1.destroy(); } catch {}
  } else if (staleLegacy && typeof staleLegacy.destroy === "function") {
    try { staleLegacy.destroy(); } catch {}
  }

  const instanceId = `token-cost-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const modules = { settings: null, analytics: null, profile: null, flatpickr: null };
  const counters = {
    bridgeCalls: 0,
    domWrites: 0,
    lazyListeners: 0,
    snapshotCount: 0,
    updateDurationsMs: [],
  };
  const state = {
    alive: true,
    activated: false,
    activeModule: null,
    bootstrapAttempts: 0,
    bootstrapCycleStartedAt: 0,
    bootstrapInFlight: false,
    config: null,
    configRevision: -1,
    generation: 1,
    pendingOpen: null,
    profileTrigger: null,
    retryTimer: 0,
    revision: -1,
    root: null,
    settingsButton: null,
    snapshot: null,
    style: null,
  };

  function utf8Length(value) {
    try { return new TextEncoder().encode(String(value)).length; } catch { return Number.MAX_SAFE_INTEGER; }
  }

  function boundedString(value, limit) {
    return typeof value === "string" && value.length > 0 && utf8Length(value) <= limit;
  }

  function boundedProfileString(value, limit) {
    return typeof value === "string" && utf8Length(value) <= limit;
  }

  function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function incrementCounter(name, amount = 1) {
    counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + amount);
  }

  function recordDomWrite(amount = 1) {
    if (!Number.isSafeInteger(amount) || amount < 1) return;
    incrementCounter("domWrites", amount);
  }

  function recordListenerDelta(amount) {
    if (!Number.isSafeInteger(amount) || amount === 0) return;
    counters.lazyListeners = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, counters.lazyListeners + amount));
  }

  function monotonicNow() {
    return typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now();
  }

  function recordUpdateDuration(startedAt) {
    const duration = Math.max(0, monotonicNow() - startedAt);
    if (counters.updateDurationsMs.length >= MAX_UPDATE_DURATION_SAMPLES) counters.updateDurationsMs.shift();
    counters.updateDurationsMs.push(duration);
  }

  function validAvatar(value) {
    return value == null || (
      typeof value === "string"
      && utf8Length(value) <= 256 * 1024
      && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    );
  }

  function validProfile(profile) {
    return Boolean(
      profile
      && typeof profile === "object"
      && boundedProfileString(profile.display_name, 128)
      && validAvatar(profile.avatar_data_url),
    );
  }

  function validConfig(config) {
    return Boolean(
      config
      && typeof config === "object"
      && typeof config.hub_visible === "boolean"
      && typeof config.output_rate_visible === "boolean"
      && typeof config.profile_visible === "boolean"
      && validProfile(config.profile),
    );
  }

  function validSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return false;
    const counts = [
      snapshot.revision, snapshot.turns, snapshot.steps, snapshot.llm_ms, snapshot.tool_ms,
      snapshot.output_rate_milli_tokens_per_second, snapshot.input, snapshot.cached_input,
      snapshot.output, snapshot.cost_nanos,
    ];
    return counts.every(safeCount)
      && (snapshot.first_token_average_ms == null || safeCount(snapshot.first_token_average_ms))
      && typeof snapshot.running === "boolean"
      && typeof snapshot.fast === "boolean"
      && typeof snapshot.hub_visible === "boolean"
      && typeof snapshot.output_rate_visible === "boolean"
      && typeof snapshot.profile_visible === "boolean"
      && (snapshot.model === "" || boundedString(snapshot.model, 128))
      && snapshot.cached_input <= snapshot.input;
  }

  function postJson(path, payload) {
    incrementCounter("bridgeCalls");
    const bridge = window.__codexPlusPostJson;
    if (typeof bridge !== "function") return Promise.reject(new Error("Codex++ bridge unavailable"));
    try { return Promise.resolve(bridge(path, payload)); } catch (error) { return Promise.reject(error); }
  }

  function dispatch(type) {
    try {
      document.dispatchEvent(new CustomEvent(type, { detail: { instanceId } }));
    } catch {}
  }

  function setCapture(enabled) {
    if (!state.alive && enabled) return;
    window.__codexLiveTokenCostCaptureV1 = { enabled: enabled === true, instanceId };
  }

  function makeElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
      recordDomWrite();
    }
    if (text != null) {
      node.textContent = text;
      recordDomWrite();
    }
    return node;
  }

  function valueNode(key) {
    const node = makeElement("span", "cltc-value", "--");
    node.setAttribute("data-cltc-value-key", key);
    recordDomWrite();
    return node;
  }

  function appendParts(parent, parts) {
    for (const part of parts) {
      if (typeof part === "string") parent.appendChild(makeElement("span", "", part));
      else parent.appendChild(part);
      recordDomWrite();
    }
  }

  function buildSkeleton(root) {
    const first = makeElement("span", "cltc-pill cltc-current-pill");
    const flow = makeElement("span", "cltc-current-flow");
    appendParts(flow, [valueNode("session-turns"), "轮 · ", valueNode("session-steps"), "步"]);
    first.appendChild(flow);
    recordDomWrite();

    const second = makeElement("span", "cltc-pill");
    appendParts(second, ["LLM ", valueNode("session-llm-duration"), " · 工具调用 ", valueNode("session-tool-duration")]);

    const third = makeElement("span", "cltc-pill");
    appendParts(third, ["首 token 平均 ", valueNode("session-first-token")]);
    const rate = makeElement("span", "cltc-output-rate");
    rate.setAttribute("data-cltc-output-rate", "session");
    appendParts(rate, [" · ", valueNode("session-output-rate"), " tok/s"]);
    third.appendChild(rate);
    recordDomWrite();

    const fourth = makeElement("span", "cltc-pill");
    appendParts(fourth, ["缓存命中 ", valueNode("session-cache-percent")]);

    const fifth = makeElement("span", "cltc-pill");
    appendParts(fifth, ["输入 ", valueNode("session-input"), " tok · 输出 ", valueNode("session-output"), " tok"]);
    root.append(first, second, third, fourth, fifth);
    recordDomWrite(5);
  }

  function ensureStyle() {
    if (state.style) {
      const duplicate = document.getElementById(STYLE_ID);
      if (duplicate && duplicate !== state.style) duplicate.remove();
      if (!state.style.isConnected && document.head) document.head.appendChild(state.style);
      return state.style;
    }
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        --cltc-text: var(--color-token-text-primary, light-dark(#111827, #f4f4f5));
        --cltc-muted: light-dark(rgba(26, 28, 31, .494), #a1a1aa);
        --cltc-border: var(--color-token-border-light, light-dark(#d1d5db, #3f3f46));
        --cltc-surface: var(--color-token-main-surface-primary, light-dark(#ffffff, #18181b));
        --cltc-arc-bg: light-dark(rgb(246, 246, 246), rgba(255, 255, 255, .08));
        --cltc-arc-radius: var(--radius-2xl, 20px);
        --cltc-hover: var(--color-token-list-hover-background, light-dark(rgba(0, 0, 0, .06), rgba(255, 255, 255, .08)));
        box-sizing: border-box;
        color-scheme: light dark;
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, .72fr) minmax(0, 1.18fr) minmax(0, 1.35fr) minmax(0, .75fr) minmax(0, 1.32fr);
        align-items: center;
        gap: 0;
        width: min(100%, 1100px);
        height: 61px;
        margin: 0 auto -18px;
        padding: 8px 10px 25px;
        border-radius: var(--cltc-arc-radius) var(--cltc-arc-radius) 0 0;
        background: var(--cltc-arc-bg);
        color: var(--cltc-muted);
        font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        z-index: 0;
      }
      @supports (corner-shape: superellipse(1.5)) {
        #${ROOT_ID} { corner-shape: var(--codex-corner-shape, round); }
      }
      #${ROOT_ID}[hidden] { display: none; }
      #${ROOT_ID} .cltc-pill {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        position: relative;
        width: 100%;
        min-width: 0;
        min-height: 28px;
        max-width: 100%;
        padding: 0 8px;
        border: 0;
        border-radius: 0;
        background: transparent;
        overflow: hidden;
        text-align: center;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} .cltc-pill + .cltc-pill::before {
        content: "";
        position: absolute;
        left: 0;
        top: 50%;
        display: block;
        width: 1px;
        height: 11px;
        background: color-mix(in srgb, var(--cltc-muted) 30%, transparent);
        transform: translateY(-50%);
      }
      #${ROOT_ID} .cltc-current-flow {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${ROOT_ID} .cltc-value {
        display: inline-block;
        min-width: 0;
        height: 16px;
        line-height: 16px;
        font-variant-numeric: tabular-nums;
      }
      #${ROOT_ID}[data-cltc-output-rate-visible="true"] {
        grid-template-columns: minmax(0, .72fr) minmax(0, 1.18fr) minmax(0, 1.48fr) minmax(0, .75fr) minmax(0, 1.32fr);
      }
      #${ROOT_ID} .cltc-output-rate[hidden] { display: none; }
      .cltc-header-settings {
        --cltc-muted: var(--color-token-text-tertiary, light-dark(#6b7280, #a1a1aa));
        --cltc-hover: var(--color-token-list-hover-background, light-dark(rgba(0, 0, 0, .06), rgba(255, 255, 255, .08)));
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 72px;
        height: 30px;
        margin-left: 4px;
        padding: 0 8px;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--cltc-muted);
        cursor: pointer;
        pointer-events: auto;
        -webkit-app-region: no-drag;
        white-space: nowrap;
        font: 13px/18px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }
      .cltc-header-settings:focus-visible { background: var(--cltc-hover); outline: none; }
      @media (hover: hover) { .cltc-header-settings:hover { background: var(--cltc-hover); } }
      @media (max-width: 900px) {
        #${ROOT_ID}, #${ROOT_ID}[data-cltc-output-rate-visible="true"] {
          grid-template-columns: repeat(5, minmax(128px, 1fr));
          width: 100%;
          overflow-x: auto;
        }
      }
    `;
    recordDomWrite(2);
    document.head && document.head.appendChild(style);
    if (document.head) recordDomWrite();
    state.style = style;
    return style;
  }

  function removeDuplicateId(id, keep) {
    for (const node of document.querySelectorAll(`#${id}`)) {
      if (node !== keep) node.remove();
    }
  }

  function findComposerAnchor() {
    // The host composer is either a textarea or a contenteditable region
    // (newer Codex builds use a formless ProseMirror div). Prefer the last
    // editable in document order and use only structural queries, never
    // layout reads.
    const editables = document.querySelectorAll("textarea,[contenteditable='true']");
    for (let index = editables.length - 1; index >= 0; index--) {
      const editable = editables[index];
      const form = editable.closest("form");
      if (form?.parentElement) return form.parentElement;
      const surface = editable.closest("[data-testid*='composer'],[data-codex-composer]");
      if (surface?.parentElement) return surface;
    }
    return null;
  }

  function ensureRoot() {
    ensureStyle();
    const composer = findComposerAnchor();
    if (!composer || !composer.parentElement) return null;
    if (!state.root) {
      const root = document.createElement("div");
      root.id = ROOT_ID;
      root.dataset.cltcVersion = VERSION;
      root.dataset.cltcOutputRateVisible = "true";
      root.dataset.running = "false";
      recordDomWrite(4);
      buildSkeleton(root);
      state.root = root;
    }
    if (state.root.parentElement !== composer.parentElement || state.root.nextElementSibling !== composer) {
      composer.parentElement.insertBefore(state.root, composer);
      recordDomWrite();
    }
    removeDuplicateId(ROOT_ID, state.root);
    return state.root;
  }

  function ensureSettingsButton() {
    ensureStyle();
    const menu = document.getElementById("codex-plus-menu");
    if (!menu || !menu.parentElement) return null;
    const waiting = menu.hidden === true
      || menu.dataset?.codexPlusNativePlacement === "waiting"
      || menu.parentElement === document.documentElement
      || menu.parentElement === document.body
      || String(menu.className || "").split(/\s+/).includes("codex-plus-menu-floating");
    if (waiting) {
      if (state.settingsButton) state.settingsButton.remove();
      return null;
    }
    if (!state.settingsButton) {
      const button = makeElement("button", "cltc-header-settings no-drag cursor-interaction text-token-text-tertiary", "今日 --");
      button.id = SETTINGS_BUTTON_ID;
      button.type = "button";
      button.title = "Codex Token Cost 设置";
      button.setAttribute("aria-label", "打开 Codex Token Cost 设置");
      button.dataset.floating = "false";
      recordDomWrite(5);
      state.settingsButton = button;
    }
    if (state.settingsButton.parentElement !== menu.parentElement || state.settingsButton.nextElementSibling !== menu) {
      menu.parentElement.insertBefore(state.settingsButton, menu);
      recordDomWrite();
    }
    removeDuplicateId(SETTINGS_BUTTON_ID, state.settingsButton);
    return state.settingsButton;
  }

  function mountOnce() {
    if (!state.alive) return;
    ensureRoot();
    ensureSettingsButton();
    if (state.snapshot) renderSnapshot(state.snapshot);
  }

  function formatCount(value) {
    if (value >= 1_000_000_000) return `${Math.round(value / 100_000_000) / 10}B`;
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
    if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
    return String(value);
  }

  function formatDuration(value) {
    if (value == null) return "--";
    if (value >= 60_000) return `${Math.floor(value / 60_000)}m${Math.round((value % 60_000) / 1000)}s`;
    if (value >= 1_000) return `${Math.round(value / 100) / 10}s`;
    return `${value}ms`;
  }

  function formatRate(value) {
    return formatCount(Math.round(value / 1000));
  }

  function formatPercent(cached, input) {
    return input > 0 ? `${Math.round((cached * 100) / input)}%` : "--";
  }

  function setText(key, value) {
    const node = state.root?.querySelector(`[data-cltc-value-key='${key}']`);
    const text = String(value);
    if (node && node.textContent !== text) {
      node.textContent = text;
      recordDomWrite();
    }
  }

  function renderSnapshot(snapshot) {
    const root = state.root;
    if (root) {
      const running = String(snapshot.running);
      const outputRateVisible = String(snapshot.output_rate_visible);
      const hidden = !snapshot.hub_visible;
      const ariaHidden = String(hidden);
      if (root.dataset.running !== running) { root.dataset.running = running; recordDomWrite(); }
      if (root.dataset.cltcOutputRateVisible !== outputRateVisible) { root.dataset.cltcOutputRateVisible = outputRateVisible; recordDomWrite(); }
      if (root.hidden !== hidden) { root.hidden = hidden; recordDomWrite(); }
      if (root.getAttribute("aria-hidden") !== ariaHidden) { root.setAttribute("aria-hidden", ariaHidden); recordDomWrite(); }
      const rate = root.querySelector("[data-cltc-output-rate='session']");
      if (rate && rate.hidden !== !snapshot.output_rate_visible) { rate.hidden = !snapshot.output_rate_visible; recordDomWrite(); }
      setText("session-turns", formatCount(snapshot.turns));
      setText("session-steps", formatCount(snapshot.steps));
      setText("session-llm-duration", formatDuration(snapshot.llm_ms));
      setText("session-tool-duration", formatDuration(snapshot.tool_ms));
      setText("session-first-token", formatDuration(snapshot.first_token_average_ms));
      setText("session-output-rate", formatRate(snapshot.output_rate_milli_tokens_per_second));
      setText("session-cache-percent", formatPercent(snapshot.cached_input, snapshot.input));
      setText("session-input", formatCount(snapshot.input));
      setText("session-output", formatCount(snapshot.output));
    }
    if (state.settingsButton) {
      const totalTokens = Math.min(Number.MAX_SAFE_INTEGER, snapshot.input + snapshot.output);
      const label = `今日 ${formatCount(totalTokens)}`;
      if (state.settingsButton.textContent !== label) { state.settingsButton.textContent = label; recordDomWrite(); }
      const title = `${label} · Codex Token Cost 设置`;
      const ariaLabel = `${label}，打开 Codex Token Cost 设置`;
      if (state.settingsButton.title !== title) { state.settingsButton.title = title; recordDomWrite(); }
      if (state.settingsButton.getAttribute("aria-label") !== ariaLabel) { state.settingsButton.setAttribute("aria-label", ariaLabel); recordDomWrite(); }
    }
    if (!snapshot.profile_visible) restoreConnectedProfiles();
  }

  function applySnapshot(snapshot) {
    if (!state.alive || !validSnapshot(snapshot) || snapshot.revision <= state.revision) return false;
    const startedAt = monotonicNow();
    state.revision = snapshot.revision;
    state.snapshot = snapshot;
    syncConfigVisibility(snapshot);
    if (!snapshot.profile_visible) closeProfileOwner();
    renderSnapshot(snapshot);
    incrementCounter("snapshotCount");
    recordUpdateDuration(startedAt);
    return true;
  }

  function syncConfigVisibility(snapshot) {
    const config = state.config;
    if (!config || (
      config.hub_visible === snapshot.hub_visible
      && config.output_rate_visible === snapshot.output_rate_visible
      && config.profile_visible === snapshot.profile_visible
    )) return false;
    state.config = {
      ...config,
      hub_visible: snapshot.hub_visible,
      output_rate_visible: snapshot.output_rate_visible,
      profile_visible: snapshot.profile_visible,
    };
    return true;
  }

  function applyUpdatedConfig(config, revision) {
    if (!validConfig(config) || !Number.isSafeInteger(revision) || revision < 0 || revision <= state.configRevision) return false;
    state.config = config;
    state.configRevision = revision;
    if (state.snapshot && state.snapshot.revision > revision) syncConfigVisibility(state.snapshot);
    return true;
  }

  const ORIGINAL_ATTRIBUTES = [
    "class", "aria-disabled", "data-disabled", "tabindex", "label-text", "avatar-class",
    "avatar-text", "avatar-src", "avatar-alt", "avatar-style", "disabled-property",
  ];

  function originalName(name) { return `data-cltc-original-${name}`; }
  function presentName(name) { return `data-cltc-original-${name}-present`; }
  function saveOriginal(node, name, present, value) {
    node.setAttribute(presentName(name), String(present));
    node.setAttribute(originalName(name), String(value ?? ""));
  }
  function restoreAttribute(node, name) {
    if (node.getAttribute(presentName(name)) === "true") node.setAttribute(name, node.getAttribute(originalName(name)) || "");
    else node.removeAttribute(name);
  }
  function profileParts(item) {
    const row = item.firstElementChild;
    if (!row || row.children.length < 2) return null;
    return { avatar: row.children[0], label: row.children[row.children.length - 1] };
  }

  function restoreProfileItem(item) {
    const parts = profileParts(item);
    item.className = item.getAttribute(originalName("class")) || "";
    restoreAttribute(item, "aria-disabled");
    restoreAttribute(item, "data-disabled");
    restoreAttribute(item, "tabindex");
    item.disabled = item.getAttribute(originalName("disabled-property")) === "true";
    if (parts) {
      parts.label.textContent = item.getAttribute(originalName("label-text")) || "";
      parts.avatar.className = item.getAttribute(originalName("avatar-class")) || "";
      parts.avatar.textContent = item.getAttribute(originalName("avatar-text")) || "";
      if (item.getAttribute(presentName("avatar-src")) === "true") parts.avatar.setAttribute("src", item.getAttribute(originalName("avatar-src")) || "");
      else parts.avatar.removeAttribute("src");
      if (item.getAttribute(presentName("avatar-alt")) === "true") parts.avatar.setAttribute("alt", item.getAttribute(originalName("avatar-alt")) || "");
      else parts.avatar.removeAttribute("alt");
      parts.avatar.style.cssText = item.getAttribute(originalName("avatar-style")) || "";
    }
    item.removeAttribute(PROFILE_MARKER);
    for (const name of ORIGINAL_ATTRIBUTES) {
      item.removeAttribute(originalName(name));
      item.removeAttribute(presentName(name));
    }
  }

  function restoreAvatarVisual(item, parts) {
    parts.avatar.className = item.getAttribute(originalName("avatar-class")) || "";
    parts.avatar.textContent = item.getAttribute(originalName("avatar-text")) || "";
    if (item.getAttribute(presentName("avatar-src")) === "true") parts.avatar.setAttribute("src", item.getAttribute(originalName("avatar-src")) || "");
    else parts.avatar.removeAttribute("src");
    if (item.getAttribute(presentName("avatar-alt")) === "true") parts.avatar.setAttribute("alt", item.getAttribute(originalName("avatar-alt")) || "");
    else parts.avatar.removeAttribute("alt");
    parts.avatar.style.cssText = item.getAttribute(originalName("avatar-style")) || "";
  }

  function applyProfilePresentation(item, parts, profile) {
    parts.label.textContent = profile.display_name;
    restoreAvatarVisual(item, parts);
    const avatar = profile.avatar_data_url;
    if (!avatar) return;
    parts.avatar.textContent = "";
    if (parts.avatar.tagName === "IMG") {
      parts.avatar.setAttribute("src", avatar);
      parts.avatar.setAttribute("alt", profile.display_name);
    } else {
      parts.avatar.style.setProperty("background-image", `url("${avatar}")`);
      parts.avatar.style.setProperty("background-position", "center");
      parts.avatar.style.setProperty("background-size", "cover");
    }
  }

  function restoreProfileTrigger() {
    const owner = state.profileTrigger;
    state.profileTrigger = null;
    if (!owner) return;
    owner.avatar.remove();
    if (!owner.trigger.isConnected) return;
    if (owner.label.isConnected) owner.label.textContent = owner.labelText;
    if (owner.gear.isConnected) owner.gear.style.display = owner.gearDisplay;
  }

  function profileTriggerParts(trigger) {
    const labels = Array.from(trigger.querySelectorAll("span.min-w-0.flex-1.truncate"));
    const gears = Array.from(trigger.querySelectorAll("svg"));
    if (labels.length !== 1 || gears.length !== 1) return null;
    const labelText = labels[0].textContent;
    const gearDisplay = gears[0].style.display || "";
    if (utf8Length(labelText) > 1024 || utf8Length(gearDisplay) > 1024) return null;
    return { label: labels[0], labelText, gear: gears[0], gearDisplay };
  }

  function applyProfileTriggerPresentation(owner, profile) {
    const displayName = profile.display_name || profile.username || "Local Usage";
    owner.label.textContent = displayName;
    owner.gear.style.display = "none";
    owner.avatar.className = "icon-sm flex shrink-0 items-center justify-center rounded-full bg-token-charts-purple/10 text-[10px] leading-none font-medium text-token-charts-purple";
    owner.avatar.textContent = profile.avatar_data_url ? "" : displayName.slice(0, 1);
    owner.avatar.style.cssText = "";
    if (profile.avatar_data_url) {
      owner.avatar.style.setProperty("background-image", `url("${profile.avatar_data_url}")`);
      owner.avatar.style.setProperty("background-position", "center");
      owner.avatar.style.setProperty("background-size", "cover");
    }
  }

  function projectProfileTrigger(trigger, parts, profile) {
    const avatar = document.createElement("span");
    avatar.setAttribute("data-cltc-profile-identity-avatar", "");
    const owner = { trigger, avatar, ...parts };
    trigger.insertBefore(avatar, parts.gear);
    state.profileTrigger = owner;
    applyProfileTriggerPresentation(owner, profile);
  }

  function restoreConnectedProfiles() {
    restoreProfileTrigger();
    for (const item of document.querySelectorAll(`[${PROFILE_MARKER}='true']`)) {
      if (item.isConnected) restoreProfileItem(item);
    }
  }

  function saveProfileItem(item, parts) {
    const values = [item.className, parts.label.textContent, parts.avatar.className, parts.avatar.textContent, parts.avatar.style.cssText];
    if (values.some((value) => utf8Length(value) > 1024)) return false;
    const avatarSrc = parts.avatar.getAttribute("src");
    const avatarAlt = parts.avatar.getAttribute("alt");
    if (utf8Length(avatarSrc || "") > 256 * 1024 || utf8Length(avatarAlt || "") > 128) return false;
    saveOriginal(item, "class", true, item.className);
    for (const name of ["aria-disabled", "data-disabled", "tabindex"]) saveOriginal(item, name, item.hasAttribute(name), item.getAttribute(name));
    saveOriginal(item, "disabled-property", true, item.disabled);
    saveOriginal(item, "label-text", true, parts.label.textContent);
    saveOriginal(item, "avatar-class", true, parts.avatar.className);
    saveOriginal(item, "avatar-text", true, parts.avatar.textContent);
    saveOriginal(item, "avatar-src", parts.avatar.hasAttribute("src"), avatarSrc);
    saveOriginal(item, "avatar-alt", parts.avatar.hasAttribute("alt"), avatarAlt);
    saveOriginal(item, "avatar-style", true, parts.avatar.style.cssText);
    return true;
  }

  function itemDisabled(item) {
    return item.disabled === true || item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled");
  }

  function projectProfile(menuId) {
    restoreConnectedProfiles();
    const config = state.config;
    if (!state.activated || !config || state.snapshot?.profile_visible !== true || !boundedString(menuId, 160)) return false;
    const menu = document.getElementById(menuId);
    if (!menu || menu.getAttribute("role") !== "menu") return false;
    const labelledBy = menu.getAttribute("aria-labelledby");
    if (!boundedString(labelledBy, 160)) return false;
    const trigger = labelledBy && document.getElementById(labelledBy);
    if (!trigger || !boundedString(trigger.id, 160) || trigger.id !== labelledBy || trigger.getAttribute("aria-controls") !== menuId) return false;
    const triggerParts = profileTriggerParts(trigger);
    if (!triggerParts) return false;
    const items = Array.from(menu.querySelectorAll("[role='menuitem']"));
    const disabled = items.filter(itemDisabled);
    const settings = items.filter((item) => !itemDisabled(item) && ["Settings", "设置"].includes(item.textContent.trim()));
    if (
      disabled.length !== 1
      || disabled[0].getAttribute("aria-disabled") !== "true"
      || !disabled[0].hasAttribute("data-disabled")
      || settings.length !== 1
      || disabled[0].parentElement !== settings[0].parentElement
    ) return false;
    const item = disabled[0];
    const parts = profileParts(item);
    if (!parts || !parts.avatar.classList.contains("size-8") || !saveProfileItem(item, parts)) return false;
    item.className = settings[0].className;
    item.disabled = false;
    item.removeAttribute("disabled");
    item.removeAttribute("aria-disabled");
    item.removeAttribute("data-disabled");
    item.setAttribute("tabindex", "0");
    applyProfilePresentation(item, parts, config.profile);
    item.setAttribute(PROFILE_MARKER, "true");
    projectProfileTrigger(trigger, triggerParts, config.profile);
    return true;
  }

  function updateProjectedProfiles() {
    if (!state.config?.profile_visible) {
      restoreConnectedProfiles();
      return;
    }
    for (const item of document.querySelectorAll(`[${PROFILE_MARKER}='true']`)) {
      if (!item.isConnected) continue;
      const parts = profileParts(item);
      if (parts) applyProfilePresentation(item, parts, state.config.profile);
    }
    if (state.profileTrigger?.trigger.isConnected) applyProfileTriggerPresentation(state.profileTrigger, state.config.profile);
  }

  function acceptNativePush(push) {
    if (!state.alive || !state.activated || !push || push.type !== "snapshot" || push.instance_id !== instanceId) return false;
    return applySnapshot(push.snapshot);
  }

  function validBootstrap(response) {
    return Boolean(
      response
      && response.status === "ok"
      && response.instance_id === instanceId
      && validConfig(response.config)
      && validSnapshot(response.snapshot),
    );
  }

  function bootstrapFailed(generation) {
    if (!state.alive || generation !== state.generation) return;
    state.bootstrapInFlight = false;
    if (state.bootstrapAttempts >= 3) return;
    const targetElapsed = state.bootstrapAttempts === 1 ? 250 : 1000;
    const elapsed = Math.max(0, Date.now() - state.bootstrapCycleStartedAt);
    const delay = Math.max(0, targetElapsed - elapsed);
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = 0;
      attemptBootstrap(generation);
    }, delay);
  }

  function attemptBootstrap(generation = state.generation) {
    if (!state.alive || state.activated || state.bootstrapInFlight || state.retryTimer || generation !== state.generation) return;
    state.bootstrapAttempts += 1;
    state.bootstrapInFlight = true;
    postJson("/token-cost/bootstrap", { instance_id: instanceId }).then((response) => {
      if (!state.alive || generation !== state.generation) return;
      if (!validBootstrap(response)) {
        bootstrapFailed(generation);
        return;
      }
      state.bootstrapInFlight = false;
      state.config = response.config;
      state.configRevision = response.snapshot.revision;
      if (!applySnapshot(response.snapshot)) {
        bootstrapFailed(generation);
        return;
      }
      state.activated = true;
      setCapture(true);
      dispatch("codex-plus:token-cost-activate");
    }, () => bootstrapFailed(generation));
  }

  function resetBootstrapIfExhausted() {
    if (!state.alive || state.activated || state.bootstrapInFlight || state.retryTimer || state.bootstrapAttempts < 3) return false;
    state.bootstrapAttempts = 0;
    state.bootstrapCycleStartedAt = Date.now();
    state.generation += 1;
    attemptBootstrap(state.generation);
    return true;
  }

  function rootClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    if (target.closest(`#${SETTINGS_BUTTON_ID}`)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      mountOnce();
      resetBootstrapIfExhausted();
      if (state.activated) requestModuleOpen("settings");
    }
  }

  function rootChange() {}

  function closeProfileOwner() {
    if (state.pendingOpen?.name === "profile") state.pendingOpen = null;
    if (state.activeModule?.name === "profile") closeActiveModule();
  }

  function lifecycle(event) {
    if (!state.alive) return;
    mountOnce();
    resetBootstrapIfExhausted();
    const detail = event?.detail;
    if (detail?.profile === false) {
      closeProfileOwner();
      restoreConnectedProfiles();
      return;
    }
    if (detail?.reason === "profile_menu") {
      projectProfile(detail.profileMenuId);
      return;
    }
    if (detail?.reason !== "profile_entry" || detail.profile !== true || !state.activated || !state.config?.profile_visible) return;
    const mountTarget = document.querySelector("main");
    if (!mountTarget) return;
    if (state.pendingOpen && state.pendingOpen.name !== "profile") state.pendingOpen = null;
    if (state.activeModule && state.activeModule.name !== "profile") closeActiveModule();
    requestModuleOpen("profile", mountTarget);
  }

  function registerModule(name, factory) {
    if (!state.alive || !MODULE_NAMES.includes(name)) return false;
    if (typeof factory !== "function") {
      const error = new Error("invalid lazy module factory");
      if (!clearPendingOpen(name)) {
        const active = state.activeModule;
        if (!clearPendingChild(active, name, error)) clearPendingChild(active?.child, name, error);
      }
      return false;
    }
    modules[name] = factory;
    const pending = state.pendingOpen;
    if (pending && pending.name === name && pending.generation === state.generation) {
      state.pendingOpen = null;
      const opened = openModule(name, pending.mountTarget);
      if (!opened) delete modules[name];
      return opened;
    }
    const active = state.activeModule;
    const childPending = active?.pendingChild;
    if (childPending && childPending.name === name && childPending.generation === state.generation) {
      active.pendingChild = null;
      const opened = openChildModule(active, name, childPending.mountTarget, childPending.onError, childPending.onApply);
      if (!opened) delete modules[name];
      return opened;
    }
    const nestedPending = active?.child?.pendingChild;
    if (nestedPending && nestedPending.name === name && nestedPending.generation === state.generation) {
      active.child.pendingChild = null;
      const opened = openChildModule(active.child, name, nestedPending.mountTarget, nestedPending.onError, nestedPending.onApply);
      if (!opened) delete modules[name];
      return opened;
    }
    return true;
  }

  function liveModule(record) {
    return Boolean(record && (state.activeModule === record || state.activeModule?.child === record));
  }

  function closeChildModule(parent, owner) {
    if (!liveModule(parent)) return false;
    const child = parent.child;
    if (!child || (owner && child.owner !== owner)) return false;
    parent.child = null;
    child.pendingChild = null;
    if (child.child) {
      const nested = child.child;
      child.child = null;
      try { nested.instance.unmount(); } catch {}
    }
    try { child.instance.unmount(); } catch {}
    return true;
  }

  function clearPendingChild(parent, name, error) {
    const pending = parent?.pendingChild;
    if (!pending || (name && pending.name !== name)) return false;
    parent.pendingChild = null;
    if (error && state.alive && liveModule(parent) && pending.generation === state.generation) {
      try { pending.onError?.(error); } catch {}
    }
    return true;
  }

  function closeActiveModule(owner) {
    const active = state.activeModule;
    if (!active || (owner && active.owner !== owner)) return false;
    state.activeModule = null;
    active.pendingChild = null;
    if (active.child) {
      const child = active.child;
      active.child = null;
      child.pendingChild = null;
      if (child.child) {
        const nested = child.child;
        child.child = null;
        try { nested.instance.unmount(); } catch {}
      }
      try { child.instance.unmount(); } catch {}
    }
    try { active.instance.unmount(); } catch {}
    if (state.alive && active.name === "settings" && state.settingsButton?.isConnected) state.settingsButton.focus?.();
    return true;
  }

  function defineChildContext(context, parent, name) {
    if (name === "settings") {
      Object.defineProperties(context, {
        requestAnalytics: { value: (target, onError) => requestChildModule(parent, "analytics", target, onError), enumerable: true },
        closeAnalytics: { value: () => closeRequestedChild(parent, "analytics"), enumerable: true },
      });
    } else if (name === "analytics") {
      Object.defineProperties(context, {
        requestFlatpickr: { value: (target, onApply, onError) => requestChildModule(parent, "flatpickr", target, onError, onApply), enumerable: true },
        closeFlatpickr: { value: () => closeRequestedChild(parent, "flatpickr"), enumerable: true },
      });
    }
  }

  function openModule(name, mountTarget) {
    if (!state.alive || state.activeModule || typeof modules[name] !== "function") return false;
    const owner = {};
    const parent = { name, instance: null, owner, child: null, pendingChild: null };
    const context = {};
    Object.defineProperties(context, {
      config: { get: () => state.config, enumerable: true },
      snapshot: { get: () => state.snapshot, enumerable: true },
      emitAction: { value: emitAction, enumerable: true },
      close: { value: () => closeActiveModule(owner), enumerable: true },
      mountTarget: { value: mountTarget || null, enumerable: true },
      recordDomWrite: { value: recordDomWrite, enumerable: true },
      recordListenerDelta: { value: recordListenerDelta, enumerable: true },
    });
    defineChildContext(context, parent, name);
    Object.freeze(context);
    let instance;
    try { instance = modules[name](context); } catch { return false; }
    if (!instance || typeof instance.mount !== "function" || typeof instance.unmount !== "function") return false;
    parent.instance = instance;
    state.activeModule = parent;
    try {
      instance.mount();
      return true;
    } catch {
      state.activeModule = null;
      try { instance.unmount(); } catch {}
      return false;
    }
  }

  function openChildModule(parent, name, mountTarget, onError, onApply) {
    if (!state.alive || !liveModule(parent) || parent.child || typeof modules[name] !== "function") return false;
    const owner = {};
    const child = { name, instance: null, owner, child: null, pendingChild: null };
    const context = {};
    Object.defineProperties(context, {
      config: { get: () => state.config, enumerable: true },
      snapshot: { get: () => state.snapshot, enumerable: true },
      emitAction: { value: emitAction, enumerable: true },
      close: { value: () => closeChildModule(parent, owner), enumerable: true },
      mountTarget: { value: mountTarget || null, enumerable: true },
      onApply: { value: typeof onApply === "function" ? onApply : null, enumerable: true },
      recordDomWrite: { value: recordDomWrite, enumerable: true },
      recordListenerDelta: { value: recordListenerDelta, enumerable: true },
    });
    defineChildContext(context, child, name);
    Object.freeze(context);
    let instance;
    try { instance = modules[name](context); } catch (error) {
      try { onError?.(error); } catch {}
      return false;
    }
    if (!instance || typeof instance.mount !== "function" || typeof instance.unmount !== "function") {
      try { onError?.(new Error("invalid lazy module instance")); } catch {}
      return false;
    }
    child.instance = instance;
    parent.child = child;
    try {
      instance.mount();
      return true;
    } catch (error) {
      parent.child = null;
      try { instance.unmount(); } catch {}
      try { onError?.(error); } catch {}
      return false;
    }
  }

  function childEdge(parent, name) {
    return parent?.name === "settings" && name === "analytics"
      || parent?.name === "analytics" && name === "flatpickr";
  }

  function closeRequestedChild(parent, name) {
    if (!childEdge(parent, name) || !liveModule(parent)) return false;
    clearPendingChild(parent, name);
    return parent.child?.name === name ? closeChildModule(parent) : true;
  }

  function requestChildModule(parent, name, mountTarget, onError, onApply) {
    if (!state.alive || !state.activated || !liveModule(parent) || !childEdge(parent, name) || !mountTarget?.isConnected) return false;
    if (parent.child) {
      if (parent.child.name !== name) return false;
      if (name === "flatpickr" && typeof parent.child.instance.reopen === "function") {
        try { return parent.child.instance.reopen() !== false; } catch (error) {
          try { onError?.(error); } catch {}
          return false;
        }
      }
      return true;
    }
    if (typeof modules[name] === "function") {
      const opened = openChildModule(parent, name, mountTarget, onError, onApply);
      if (!opened) delete modules[name];
      return opened;
    }
    if (parent.pendingChild) return parent.pendingChild.name === name;
    const pending = { name, generation: state.generation, mountTarget, onError, onApply };
    parent.pendingChild = pending;
    postJson("/token-cost/lazy-asset", { instance_id: instanceId, asset: name }).then((response) => {
      if (!state.alive || !liveModule(parent) || parent.pendingChild !== pending) return;
      if (!response || response.status !== "ok") clearPendingChild(parent, name, new Error("lazy asset rejected"));
    }, (error) => {
      if (state.alive && liveModule(parent) && parent.pendingChild === pending) clearPendingChild(parent, name, error);
    });
    return true;
  }

  function clearPendingOpen(name) {
    if (!state.pendingOpen || (name && state.pendingOpen.name !== name)) return false;
    state.pendingOpen = null;
    return true;
  }

  function requestModuleOpen(name, mountTarget) {
    if (!state.alive || !state.activated || !["settings", "profile"].includes(name)) return false;
    if (state.activeModule) return state.activeModule.name === name;
    if (typeof modules[name] === "function") {
      const opened = openModule(name, mountTarget);
      if (!opened) delete modules[name];
      return opened;
    }
    if (state.pendingOpen) return state.pendingOpen.name === name;
    const pending = { name, generation: state.generation, mountTarget: mountTarget || null };
    state.pendingOpen = pending;
    postJson("/token-cost/lazy-asset", { instance_id: instanceId, asset: name }).then((response) => {
      if (!state.alive || state.pendingOpen !== pending) return;
      if (!response || response.status !== "ok") state.pendingOpen = null;
    }, () => {
      if (state.alive && state.pendingOpen === pending) state.pendingOpen = null;
    });
    return true;
  }

  function acceptLazyError(error) {
    if (!state.alive || !error || !MODULE_NAMES.includes(error.asset)) return false;
    if (clearPendingOpen(error.asset)) return true;
    const active = state.activeModule;
    if (active && clearPendingChild(active, error.asset, error)) return true;
    return Boolean(active?.child && clearPendingChild(active.child, error.asset, error));
  }

  function emitAction(action) {
    if (!state.alive || !action || typeof action !== "object" || !ACTION_NAMES.includes(action.type)) {
      return Promise.reject(new Error("invalid token cost action"));
    }
    const payload = { ...action, instance_id: instanceId };
    return postJson("/token-cost/action", { action: payload }).then((result) => {
      if (!state.alive) return result;
      const updated = result?.status === "ok" && result.response?.type === "updated" ? result.response : null;
      if (updated && validConfig(updated.config) && validSnapshot(updated.snapshot)) {
        const configChanged = applyUpdatedConfig(updated.config, updated.snapshot.revision);
        applySnapshot(updated.snapshot);
        if (configChanged) updateProjectedProfiles();
      }
      return result;
    });
  }

  function mountedModules() {
    const mounted = [];
    let current = state.activeModule;
    while (current && mounted.length < MODULE_NAMES.length) {
      if (MODULE_NAMES.includes(current.name)) mounted.push(current.name);
      current = current.child;
    }
    return mounted;
  }

  function ownedNodeCount() {
    const roots = [state.root, state.settingsButton, state.style, state.profileTrigger?.avatar];
    for (const selector of [".cltc-settings-overlay", ".cltc-profile-page", ".flatpickr-" + "calendar"]) {
      const root = document.querySelector(selector);
      if (root) roots.push(root);
    }
    const unique = new Set();
    let count = 0;
    for (const root of roots) {
      if (!root || !root.isConnected || unique.has(root)) continue;
      unique.add(root);
      count = Math.min(Number.MAX_SAFE_INTEGER, count + 1 + root.querySelectorAll("*").length);
    }
    return count;
  }

  async function diagnostics() {
    let native = null;
    try {
      const result = await emitAction({ type: "query_diagnostics" });
      if (result?.status === "ok" && result.response?.type === "diagnostics") native = result.response.diagnostics;
    } catch {}
    const mounted = mountedModules();
    return {
      instanceId,
      revision: state.revision,
      captureEnabled: state.alive && state.activated,
      bootstrapAttempts: state.bootstrapAttempts,
      bootstrapInFlight: state.bootstrapInFlight,
      exhausted: !state.activated && state.bootstrapAttempts >= 3 && !state.bootstrapInFlight && !state.retryTimer,
      moduleCount: MODULE_NAMES.reduce((count, name) => count + (typeof modules[name] === "function" ? 1 : 0), 0),
      listenerCount: state.alive ? Math.min(Number.MAX_SAFE_INTEGER, 3 + counters.lazyListeners) : 0,
      outstandingTimers: state.retryTimer ? 1 : 0,
      observerCount: 0,
      bridgeCalls: counters.bridgeCalls,
      snapshotCount: counters.snapshotCount,
      domWrites: counters.domWrites,
      updateDurationsMs: counters.updateDurationsMs.slice(),
      mountedModules: mounted,
      ownedNodeCount: ownedNodeCount(),
      native,
    };
  }

  function destroy() {
    if (!state.alive) return;
    state.alive = false;
    state.generation += 1;
    state.pendingOpen = null;
    closeActiveModule();
    state.bootstrapInFlight = false;
    if (state.retryTimer) window.clearTimeout(state.retryTimer);
    state.retryTimer = 0;
    state.activated = false;
    setCapture(false);
    dispatch("codex-plus:token-cost-deactivate");
    try {
      const request = postJson("/token-cost/action", { action: { type: "dispose_instance", instance_id: instanceId } });
      request.catch(() => {});
    } catch {}
    restoreConnectedProfiles();
    document.removeEventListener("click", rootClick);
    document.removeEventListener("change", rootChange);
    document.removeEventListener(LIFECYCLE_EVENT, lifecycle);
    state.root?.remove();
    state.settingsButton?.remove();
    state.style?.remove();
    state.config = null;
    state.configRevision = -1;
    state.snapshot = null;
    state.root = null;
    state.settingsButton = null;
    state.style = null;
    for (const name of MODULE_NAMES) modules[name] = null;
    if (window.__codexLiveTokenCostV1 === api) delete window.__codexLiveTokenCostV1;
    if (window.__codexLiveTokenCostCaptureV1?.instanceId === instanceId) delete window.__codexLiveTokenCostCaptureV1;
    if (window.__codexLiveTokenCostVersion === VERSION) delete window.__codexLiveTokenCostVersion;
  }

  const api = { instanceId, acceptNativePush, registerModule, emitAction, diagnostics, destroy };
  Object.defineProperty(api, "acceptLazyError", { value: acceptLazyError, enumerable: false });
  restoreConnectedProfiles();
  window.__codexLiveTokenCostVersion = VERSION;
  window.__codexLiveTokenCostV1 = api;
  setCapture(false);
  document.addEventListener("click", rootClick);
  document.addEventListener("change", rootChange);
  document.addEventListener(LIFECYCLE_EVENT, lifecycle);
  mountOnce();
  state.bootstrapCycleStartedAt = Date.now();
  attemptBootstrap();
})();
