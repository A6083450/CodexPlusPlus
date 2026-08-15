"use strict";

api.registerModule("settings", (context) => {
  const STYLE_ID = "codex-live-token-cost-settings-style";
  const MAX_SAFE_NANOS = BigInt(Number.MAX_SAFE_INTEGER);
  const PROFILE_PLAN_OPTIONS = Object.freeze([
    ["free", "Free"], ["go", "Go"], ["plus", "Plus"], ["pro_5x", "Pro 5x"], ["pro_20x", "Pro 20x"],
    ["business", "Business"], ["enterprise", "Enterprise"], ["edu", "Edu"], ["staff", "Staff"], ["founder", "Founder"],
  ]);
  const DEFAULT_MODEL_PRICES = Object.freeze([
    ["gpt-5.6-sol", 5_000_000_000, 500_000_000, 6_250_000_000, 30_000_000_000],
    ["gpt-5.6-terra", 2_500_000_000, 250_000_000, 3_125_000_000, 15_000_000_000],
    ["gpt-5.6-luna", 1_000_000_000, 100_000_000, 1_250_000_000, 6_000_000_000],
    ["gpt-5.3-codex", 1_750_000_000, 175_000_000, null, 14_000_000_000],
    ["gpt-5.4", 2_500_000_000, 250_000_000, null, 15_000_000_000],
    ["gpt-5.4-mini", 750_000_000, 75_000_000, null, 4_500_000_000],
    ["gpt-5.4-nano", 200_000_000, 20_000_000, null, 1_250_000_000],
    ["gpt-5.4-pro", 30_000_000_000, null, null, 180_000_000_000],
    ["gpt-5.5", 5_000_000_000, 500_000_000, null, 30_000_000_000],
    ["gpt-5.5-pro", 30_000_000_000, null, null, 180_000_000_000],
  ]);
  let config = context.config;
  let overlay = null;
  let modal = null;
  let nav = null;
  let content = null;
  let style = null;
  let activePanel = config.profile_visible ? "profile" : "general";
  let stopped = false;
  const mutationSequences = { pricing: 0, profile: 0, visibility: 0 };

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstElementChild) node.firstElementChild.remove();
    node.textContent = "";
  }

  function button(text, action, variant) {
    const node = make("button", "cltc-settings-button", text);
    node.type = "button";
    node.dataset.action = action;
    if (variant) node.dataset.variant = variant;
    return node;
  }

  function field(label, value, key, type = "text") {
    const wrap = make("label", "cltc-price-field");
    wrap.appendChild(make("span", "", label));
    const input = make("input", "cltc-price-input");
    input.type = type;
    input.value = value == null ? "" : String(value);
    input.dataset[key.kind] = key.name;
    wrap.appendChild(input);
    return wrap;
  }

  function section(title, description) {
    const root = make("section", "cltc-settings-section");
    const heading = make("div", "cltc-settings-section-heading");
    heading.append(make("h2", "", title), make("p", "", description));
    root.appendChild(heading);
    return root;
  }

  function statusNode(kind) {
    return overlay && overlay.querySelector(`[data-settings-status='${kind}']`);
  }

  function setStatus(kind, message, isError = false) {
    if (!overlay) return;
    let node = statusNode(kind);
    if (!node) {
      node = make("div", "cltc-settings-status");
      node.dataset.settingsStatus = kind;
      content.appendChild(node);
    }
    node.className = isError ? "cltc-settings-status cltc-settings-error" : "cltc-settings-status";
    node.textContent = String(message || "").slice(0, 180);
  }

  function clearError() {
    const node = overlay && overlay.querySelector(".cltc-settings-error");
    if (node) node.remove();
  }

  function validUpdated(result) {
    return Boolean(result && result.status === "ok" && result.response && result.response.type === "updated"
      && result.response.config && result.response.snapshot && Number.isSafeInteger(result.response.snapshot.revision));
  }

  function mutate(action, success) {
    const family = action.type === "save_profile" ? "profile"
      : action.type === "set_visibility" ? "visibility" : "pricing";
    const sequence = ++mutationSequences[family];
    const isCurrent = () => mutationSequences[family] === sequence;
    return context.emitAction(action).then((result) => {
      if (!isCurrent()) return result;
      if (!validUpdated(result)) throw new Error("native update rejected");
      config = context.config;
      clearError();
      if (success) success(result.response);
      return result;
    }).catch(() => {
      if (isCurrent()) setStatus("error", "保存失败，请重试。", true);
      return null;
    });
  }

  function toggleRow(title, description, name, checked) {
    const label = make("label", "cltc-toggle-field");
    const copy = make("span");
    copy.append(make("strong", "", title), make("small", "", description));
    const input = make("input");
    input.type = "checkbox";
    input.checked = checked === true;
    input.dataset.miscField = name;
    label.append(copy, input);
    return label;
  }

  function renderGeneral() {
    const root = section("数据与显示", "管理 HUD 显示、本地 helper 与 CC Switch 数据同步。");
    root.append(
      toggleRow("显示 HUB", "在输入框上方显示本轮、会话与今日统计。", "hubVisible", config.hub_visible),
      toggleRow("显示 Token 输出速率", "显示本轮实时与上一轮平均输出速率。", "outputRateVisible", config.output_rate_visible),
      toggleRow("启用本地 Profile 解锁", "关闭后停止资料伪装与 Profile 补丁；如界面未完全恢复，请重启 Codex。", "profileUnlockEnabled", config.profile_visible),
    );

    const helper = make("div", "cltc-settings-row");
    const helperCopy = make("div");
    const helperStatus = make("div", "cltc-sync-status", "Helper 可选：未连接时使用本地 Profile ledger；CC Switch 同步不可用。");
    helperStatus.dataset.field = "helper-status";
    helperStatus.dataset.helperUnavailable = "false";
    helperCopy.append(make("strong", "", "本地 helper"), helperStatus);
    const link = make("a", "cltc-link-button", "查看脚本");
    link.setAttribute("href", "https://github.com/Tianzora/codex-token-cost/blob/main/scripts/codex-local-usage-helper.cjs");
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer");
    helper.append(helperCopy, link);
    root.appendChild(helper);

    const sync = make("div", "cltc-settings-row");
    const syncCopy = make("div");
    syncCopy.append(make("strong", "", "CC Switch 数据"));
    const syncStatus = make("div", "cltc-sync-status", "按需同步本地历史统计。");
    syncStatus.dataset.settingsStatus = "sync";
    syncCopy.appendChild(syncStatus);
    sync.append(syncCopy, button("立即同步", "sync-cc-switch"));
    root.appendChild(sync);
    return root;
  }

  function renderProfile() {
    const root = section("个人资料", "这些资料只保存在本地，用于 Codex 个人资料与账号菜单。");
    const grid = make("div", "cltc-price-grid");
    const profile = config.profile;
    const email = field("邮箱", profile.email, { kind: "profileField", name: "email" }, "email");
    email.classList.add("cltc-price-field-full");
    email.appendChild(make("small", "cltc-profile-field-note", "官方新版本的账号菜单不再显示邮箱；这里修改的是本地伪装资料。"));
    const account = make("label", "cltc-price-field");
    account.dataset.profileLocked = "";
    account.title = "新版本不再允许全局伪装账号";
    account.appendChild(make("span", "", "账号类型"));
    const accountSelect = make("select", "cltc-profile-select");
    accountSelect.dataset.profileField = "accountStructure";
    accountSelect.disabled = true;
    accountSelect.setAttribute("aria-disabled", "true");
    for (const [value, label] of [["personal", "个人账户"], ["workspace", "工作区账户"]]) {
      const option = make("option", "", label);
      option.value = value;
      accountSelect.appendChild(option);
    }
    accountSelect.value = "personal";
    account.appendChild(accountSelect);
    const workspace = field("空间名称", profile.workspace_name, { kind: "profileField", name: "workspaceName" });
    workspace.dataset.profileLocked = "";
    workspace.title = "新版本不再允许全局伪装账号";
    const workspaceInput = workspace.querySelector("input");
    workspaceInput.setAttribute("placeholder", "Codex Workspace");
    workspaceInput.disabled = true;
    workspaceInput.setAttribute("aria-disabled", "true");
    const selectedPlan = PROFILE_PLAN_OPTIONS.find(([value, label]) => value === profile.plan_type || label === profile.plan_type || label === profile.plan_label);
    const planField = make("label", "cltc-price-field");
    planField.appendChild(make("span", "", "Plan 类型"));
    const planSelect = make("select", "cltc-profile-select");
    planSelect.dataset.profileField = "planType";
    for (const [value, label] of [...PROFILE_PLAN_OPTIONS, ["custom", "自定义"]]) {
      const option = make("option", "", label);
      option.value = value;
      planSelect.appendChild(option);
    }
    planSelect.value = selectedPlan ? selectedPlan[0] : "custom";
    planField.appendChild(planSelect);
    const custom = field("自定义", selectedPlan ? "" : profile.plan_label || profile.plan_type, { kind: "profileField", name: "planCustom" });
    custom.querySelector("input").setAttribute("placeholder", "Team Enterprise");
    grid.append(email, account, workspace, planField, custom);
    root.appendChild(grid);
    const actions = make("div", "cltc-price-actions");
    actions.appendChild(button("保存更改", "save-profile", "primary"));
    root.appendChild(actions);
    return root;
  }

  function nanosToDecimal(value) {
    if (!Number.isSafeInteger(value) || value < 0) return "";
    const text = String(value).padStart(10, "0");
    const whole = text.slice(0, -9) || "0";
    const fraction = text.slice(-9).replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole;
  }

  function boundedOverrideModels() {
    const names = [];
    const overrides = config.price_overrides || {};
    for (const name in overrides) {
      if (!Object.hasOwn(overrides, name)) continue;
      names.push(name);
      if (names.length >= 64) break;
    }
    return names;
  }

  function currentModel(overrideModels) {
    const model = context.snapshot && context.snapshot.model;
    if (typeof model === "string" && model) return model;
    return overrideModels[0] || "gpt-5.6-sol";
  }

  function defaultPrice(model) {
    const row = DEFAULT_MODEL_PRICES.find(([name]) => name === model);
    if (!row) return null;
    return {
      input_nanos_per_million: row[1], cached_input_nanos_per_million: row[2],
      cache_write_nanos_per_million: row[3], output_nanos_per_million: row[4],
    };
  }

  function priceFor(model) {
    return (config.price_overrides && Object.hasOwn(config.price_overrides, model))
      ? config.price_overrides[model] : defaultPrice(model);
  }

  function pricingModels(model, overrideModels = boundedOverrideModels()) {
    const seen = new Set();
    const required = [];
    for (const name of [model, ...DEFAULT_MODEL_PRICES.map(([defaultModel]) => defaultModel)]) {
      if (seen.has(name)) continue;
      seen.add(name);
      required.push(name);
    }
    const extras = overrideModels.filter((name) => !seen.has(name)).sort((left, right) => left.localeCompare(right));
    return required.concat(extras.slice(0, Math.max(0, 64 - required.length)));
  }

  function priceSource(model) {
    if (config.price_overrides && Object.hasOwn(config.price_overrides, model)) return "自定义";
    return defaultPrice(model) ? "默认" : "未定价";
  }

  function appendPriceRows(list, selectedModel, overrideModels) {
    for (const name of pricingModels(selectedModel, overrideModels)) {
      const resolvedPrice = priceFor(name);
      const item = resolvedPrice || {};
      const row = make("button", "cltc-price-row");
      row.type = "button";
      row.dataset.pricePick = name;
      row.dataset.active = String(name === selectedModel);
      for (const value of [
        resolvedPrice ? name : `${name} · 未定价`,
        nanosToDecimal(item.input_nanos_per_million) || "-",
        nanosToDecimal(item.cached_input_nanos_per_million) || "-",
        nanosToDecimal(item.cache_write_nanos_per_million) || "-",
        nanosToDecimal(item.output_nanos_per_million) || "-",
      ]) row.appendChild(make("span", "", value));
      list.appendChild(row);
    }
  }

  function refreshPricing(model, preserveFocused = true) {
    if (!overlay || activePanel !== "pricing") return;
    const price = priceFor(model) || {};
    modal.dataset.priceModel = model;
    const meta = overlay.querySelector(".cltc-price-meta");
    if (meta) meta.textContent = `${model} · ${priceSource(model)}`;
    const list = overlay.querySelector(".cltc-price-list");
    if (list) {
      clear(list);
      appendPriceRows(list, model);
    }
    const values = {
      model,
      input: nanosToDecimal(price.input_nanos_per_million),
      cachedInput: nanosToDecimal(price.cached_input_nanos_per_million),
      cacheWrite: nanosToDecimal(price.cache_write_nanos_per_million),
      output: nanosToDecimal(price.output_nanos_per_million),
    };
    for (const [name, value] of Object.entries(values)) {
      const input = priceField(name);
      if (input && (!preserveFocused || document.activeElement !== input) && input.value !== value) input.value = value;
    }
  }

  function renderPricing() {
    const root = section("模型价格", "按 USD / 1M tokens 设置输入、缓存与输出价格。");
    const overrideModels = boundedOverrideModels();
    const model = currentModel(overrideModels);
    modal.dataset.priceModel = model;
    const price = priceFor(model) || {};
    const meta = make("div", "cltc-price-meta", `${model} · ${priceSource(model)}`);
    root.appendChild(meta);
    const tableHead = make("div", "cltc-price-row cltc-price-table-head");
    tableHead.setAttribute("aria-hidden", "true");
    for (const label of ["模型", "输入", "读缓存", "写缓存", "输出"]) tableHead.appendChild(make("span", "", label));
    root.appendChild(tableHead);
    const list = make("div", "cltc-price-list");
    appendPriceRows(list, model, overrideModels);
    root.appendChild(list);
    const editor = make("div", "cltc-price-editor");
    const grid = make("div", "cltc-price-grid");
    const modelField = field("模型名", model, { kind: "priceField", name: "model" });
    modelField.classList.add("cltc-price-field-full");
    const numericField = (label, value, name) => {
      const wrap = field(label, value, { kind: "priceField", name }, "number");
      const input = wrap.querySelector("input");
      input.setAttribute("min", "0");
      input.setAttribute("step", "0.000001");
      return wrap;
    };
    grid.append(
      modelField,
      numericField("输入", nanosToDecimal(price.input_nanos_per_million), "input"),
      numericField("读缓存", nanosToDecimal(price.cached_input_nanos_per_million), "cachedInput"),
      numericField("写缓存", nanosToDecimal(price.cache_write_nanos_per_million), "cacheWrite"),
      numericField("输出", nanosToDecimal(price.output_nanos_per_million), "output"),
    );
    editor.appendChild(grid);
    const actions = make("div", "cltc-price-actions");
    actions.append(
      button("恢复默认", "reset-price"), button("新建", "new-price"),
      button("删除", "delete-price", "danger"), button("保存", "save-price", "primary"),
    );
    editor.appendChild(actions);
    root.appendChild(editor);
    return root;
  }

  function renderUsage() {
    const host = make("div", "cltc-analytics-host");
    host.dataset.analyticsHost = "true";
    host.appendChild(section("使用统计", "运行期统计将在首次显式打开后按需加载。"));
    return host;
  }

  function renderNavigation() {
    if (!nav) return;
    clear(nav);
    const panels = config.profile_visible
      ? [["profile", "个人资料"], ["general", "数据与显示"], ["usage", "使用统计"], ["pricing", "模型价格"]]
      : [["general", "数据与显示"], ["usage", "使用统计"], ["pricing", "模型价格"]];
    for (const [name, label] of panels) {
      const item = make("button", "", label);
      item.type = "button";
      item.dataset.settingsPanel = name;
      item.dataset.active = String(name === activePanel);
      nav.appendChild(item);
    }
  }

  function refreshVisibilityUi() {
    if (!config.profile_visible && activePanel === "profile") {
      renderPanel("general");
      renderNavigation();
      return;
    }
    renderNavigation();
  }

  function renderPanel(name) {
    if (!content || !["profile", "general", "usage", "pricing"].includes(name)) return;
    if (name === activePanel && content.firstElementChild) return;
    if (activePanel === "usage") context.closeAnalytics();
    activePanel = name;
    modal.dataset.settingsActive = name;
    for (const item of overlay.querySelectorAll("[data-settings-panel]")) {
      item.dataset.active = String(item.dataset.settingsPanel === name);
    }
    clear(content);
    const panel = name === "profile" ? renderProfile()
      : name === "general" ? renderGeneral()
        : name === "pricing" ? renderPricing() : renderUsage();
    content.appendChild(panel);
    if (name === "usage") {
      context.requestAnalytics(panel, () => {
        if (!stopped && activePanel === "usage" && panel.isConnected) {
          clear(panel);
          const fallback = section("使用统计", "统计模块加载失败，请重新打开后重试。");
          fallback.classList.add("cltc-settings-error");
          panel.appendChild(fallback);
        }
      });
    }
  }

  function priceField(name) {
    return overlay && overlay.querySelector(`[data-price-field='${name}']`);
  }

  function parseNanos(text, nullable) {
    if (text === "" && nullable) return null;
    if (!/^[0-9]+(?:\.[0-9]{1,9})?$/.test(text)) throw new Error("invalid decimal");
    const parts = text.split(".");
    const nanos = BigInt(parts[0]) * 1_000_000_000n + BigInt((parts[1] || "").padEnd(9, "0") || "0");
    if (nanos > MAX_SAFE_NANOS) throw new Error("decimal overflow");
    return Number(nanos);
  }

  function readModel() {
    const model = priceField("model").value;
    if (model.length === 0 || new TextEncoder().encode(model).length > 128) {
      throw new Error("invalid model");
    }
    return model;
  }

  function savePrice() {
    try {
      const model = readModel();
      const price = {
        input_nanos_per_million: parseNanos(priceField("input").value, false),
        cached_input_nanos_per_million: parseNanos(priceField("cachedInput").value, true),
        cache_write_nanos_per_million: parseNanos(priceField("cacheWrite").value, true),
        output_nanos_per_million: parseNanos(priceField("output").value, false),
      };
      mutate({ type: "save_price", model, price }, () => {
        refreshPricing(model);
        setStatus("saved", "已保存模型价格。");
      });
    } catch {
      setStatus("error", "请输入有效的模型名和价格。", true);
    }
  }

  function deleteOrResetPrice(type) {
    try {
      const model = readModel();
      mutate({ type, model }, () => {
        const snapshotModel = context.snapshot && context.snapshot.model;
        const nextModel = type === "delete_price" && !defaultPrice(model)
          ? (typeof snapshotModel === "string" && snapshotModel !== model ? snapshotModel : DEFAULT_MODEL_PRICES[0][0])
          : model;
        refreshPricing(nextModel, false);
        setStatus("saved", type === "delete_price" ? "已删除价格覆盖。" : "已恢复默认价格。");
      });
    } catch {
      setStatus("error", "请输入有效的模型名。", true);
    }
  }

  function saveVisibility() {
    const value = (name) => overlay.querySelector(`[data-misc-field='${name}']`).checked === true;
    mutate({
      type: "set_visibility",
      hub_visible: value("hubVisible"),
      output_rate_visible: value("outputRateVisible"),
      profile_visible: value("profileUnlockEnabled"),
    }, refreshVisibilityUi);
  }

  function saveProfile() {
    const email = overlay.querySelector("[data-profile-field='email']").value;
    const planType = overlay.querySelector("[data-profile-field='planType']").value;
    const planCustom = overlay.querySelector("[data-profile-field='planCustom']").value;
    const selected = PROFILE_PLAN_OPTIONS.find(([value]) => value === planType);
    const custom = planCustom;
    const normalizedPlan = selected || (planType === "custom" && custom ? [custom, custom] : null);
    const profile = {
      ...config.profile,
      email,
      plan_type: normalizedPlan ? normalizedPlan[0] : "",
      plan_label: normalizedPlan ? normalizedPlan[1] : "",
    };
    const planValid = normalizedPlan && new TextEncoder().encode(profile.plan_type).length <= 128
      && new TextEncoder().encode(profile.plan_label).length <= 128;
    const emailValid = new TextEncoder().encode(email).length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!planValid || !emailValid) {
      setStatus("error", "个人资料格式无效。", true);
      return;
    }
    mutate({ type: "save_profile", profile }, () => setStatus("saved", "个人资料已保存。"));
  }

  function syncCcSwitch() {
    context.emitAction({ type: "sync_cc_switch" }).then((result) => {
      const response = result && result.status === "ok" ? result.response : null;
      if (!response || response.type !== "synced") throw new Error("sync rejected");
      setStatus("sync", `已同步 ${response.imported_turns} 条。`);
    }).catch(() => setStatus("sync", "同步失败，请重试。", true));
  }

  function onClick(event) {
    const panel = event.target && event.target.closest && event.target.closest("[data-settings-panel]");
    if (panel) {
      renderPanel(panel.dataset.settingsPanel);
      return;
    }
    const priceModel = event.target && event.target.closest && event.target.closest("[data-price-pick]");
    if (priceModel) {
      const modelName = priceModel.dataset.pricePick;
      refreshPricing(modelName, false);
      return;
    }
    const action = event.target && event.target.closest && event.target.closest("[data-action]");
    if (action) {
      const type = action.dataset.action;
      if (type === "close-price") context.close();
      else if (type === "sync-cc-switch") syncCcSwitch();
      else if (type === "save-profile") saveProfile();
      else if (type === "save-price") savePrice();
      else if (type === "delete-price") deleteOrResetPrice("delete_price");
      else if (type === "reset-price") deleteOrResetPrice("reset_price");
      else if (type === "new-price") {
        for (const name of ["model", "input", "cachedInput", "cacheWrite", "output"]) priceField(name).value = "";
        priceField("model").focus();
      }
      return;
    }
    if (event.target === overlay) context.close();
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      context.close();
    }
  }

  function onChange(event) {
    if (event.target && event.target.closest && event.target.closest("[data-misc-field]")) saveVisibility();
  }
  function onInput() {}

  function mount() {
    if (stopped || overlay) return;
    style = make("style");
    style.id = STYLE_ID;
    style.textContent = `
      .cltc-settings-overlay {
        --cltc-text: var(--color-token-text-primary, light-dark(#111827, #f4f4f5));
        --cltc-muted: var(--color-token-text-tertiary, light-dark(#6b7280, #a1a1aa));
        --cltc-border: var(--color-token-border-light, light-dark(#d1d5db, #3f3f46));
        --cltc-border-subtle: var(--color-token-border-light, light-dark(#e5e7eb, #323238));
        --cltc-surface: var(--color-token-main-surface-primary, light-dark(#ffffff, #18181b));
        --cltc-surface-secondary: var(--color-token-main-surface-secondary, light-dark(#f3f4f6, #27272a));
        --cltc-popover: var(--color-token-dropdown-background, var(--color-token-main-surface-primary, light-dark(#ffffff, #18181b)));
        --cltc-input: var(--color-token-input-background, var(--color-token-main-surface-primary, light-dark(#ffffff, #18181b)));
        --cltc-hover: var(--color-token-list-hover-background, light-dark(rgba(0, 0, 0, .06), rgba(255, 255, 255, .08)));
        --cltc-shadow: light-dark(rgba(0, 0, 0, .18), rgba(0, 0, 0, .48));
        --cltc-primary: var(--color-token-text-primary, light-dark(#171717, #f4f4f5));
        --cltc-primary-text: var(--color-token-main-surface-primary, light-dark(#ffffff, #18181b));
        --cltc-danger: light-dark(#b42318, #f97066);
        position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
        padding: 48px 20px; background: transparent; color: var(--cltc-text); color-scheme: light dark; -webkit-app-region: no-drag;
        font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      html.electron-dark .cltc-settings-overlay {
        --cltc-text: #f4f4f5; --cltc-muted: #a1a1aa; --cltc-border: #3f3f46; --cltc-border-subtle: #323238;
        --cltc-surface: #18181b; --cltc-surface-secondary: #27272a; --cltc-popover: #18181b; --cltc-input: #18181b;
        --cltc-hover: rgba(255,255,255,.08); --cltc-shadow: rgba(0,0,0,.48); --cltc-primary: #f4f4f5;
        --cltc-primary-text: #18181b; --cltc-danger: #f97066; color-scheme: dark;
      }
      .cltc-settings-modal { position: relative; display: grid; grid-template-rows: auto minmax(0,1fr);
        width: min(920px, calc(100vw - 40px)); height: min(620px, calc(100vh - 96px)); max-height: calc(100vh - 96px);
        overflow: hidden; padding: 0; border: 1px solid var(--cltc-border); border-radius: 12px;
        background: var(--cltc-popover); box-shadow: 0 18px 55px var(--cltc-shadow); color: var(--cltc-text); }
      .cltc-price-head { display:flex; justify-content:space-between; align-items:center; min-height:54px; padding:10px 14px 10px 18px;
        border-bottom:1px solid var(--cltc-border-subtle); }
      .cltc-price-title { font-size:15px; font-weight:600; }
      .cltc-price-head button { width:30px; height:30px; border:0; border-radius:8px; background:transparent; color:var(--cltc-muted); cursor:pointer; font-size:20px; }
      .cltc-settings-shell { display:grid; grid-template-columns:176px minmax(0, 1fr); min-height:0; overflow:hidden; }
      .cltc-settings-sidebar { display:flex; flex-direction:column; min-width:0; padding:18px 10px; border-right:1px solid var(--cltc-border-subtle); background:color-mix(in srgb, var(--cltc-surface-secondary) 62%, var(--cltc-popover)); }
      .cltc-settings-nav { display:grid; gap:2px; }
      .cltc-settings-nav button { width:100%; min-height:34px; padding:7px 10px; border:0; border-radius:8px; background:transparent; color:var(--cltc-muted); cursor:pointer; font:inherit; text-align:left; }
      .cltc-settings-nav button:focus-visible, .cltc-settings-nav button[data-active='true'] { background:var(--cltc-hover); color:var(--cltc-text); outline:none; }
      .cltc-settings-nav button[data-active='true'] { font-weight:600; }
      .cltc-settings-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:auto; padding:12px 10px 0; color:var(--cltc-muted); font-size:11px; }
      .cltc-settings-version { opacity:.68; }
      .cltc-settings-content { min-width:0; overflow:auto; padding:26px 30px 30px; scrollbar-width:thin; scrollbar-color:color-mix(in srgb, var(--cltc-muted) 35%, transparent) transparent; }
      .cltc-settings-section { display:grid; gap:20px; }
      .cltc-settings-section-heading { display:grid; gap:4px; }
      .cltc-settings-section-heading h2 { margin:0; font-size:20px; font-weight:600; line-height:28px; }
      .cltc-settings-section-heading p { margin:0; color:var(--cltc-muted); font-size:13px; line-height:19px; }
      .cltc-settings-row, .cltc-toggle-field { display:grid; grid-template-columns:minmax(0, 1fr) auto; align-items:center; gap:18px; min-height:66px; padding:14px 0; border-top:1px solid var(--cltc-border-subtle); }
      .cltc-settings-row strong, .cltc-toggle-field strong { display:block; font-weight:500; }
      .cltc-toggle-field { color:var(--cltc-text); cursor:pointer; }
      .cltc-toggle-field small { display:block; margin-top:2px; color:var(--cltc-muted); font-size:12px; line-height:17px; }
      .cltc-toggle-field input { appearance:none; position:relative; width:34px; height:20px; margin:0; border:1px solid var(--cltc-border); border-radius:999px; background:var(--cltc-surface-secondary); cursor:pointer; }
      .cltc-toggle-field input::after { content:""; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:var(--cltc-surface); box-shadow:0 1px 3px rgba(0,0,0,.22); }
      .cltc-toggle-field input:checked { border-color:var(--cltc-text); background:var(--cltc-text); }
      .cltc-toggle-field input:checked::after { transform:translateX(14px); }
      .cltc-toggle-field input:focus-visible { outline:2px solid var(--cltc-muted); outline-offset:2px; }
      .cltc-sync-status { margin-top:3px; color:var(--cltc-muted); font-size:12px; line-height:17px; }
      .cltc-price-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px 12px; }
      .cltc-price-field { display:grid; gap:6px; } .cltc-price-field-full { grid-column:1/-1; }
      .cltc-price-field span { color:var(--cltc-muted); font-size:12px; }
      .cltc-price-input, .cltc-profile-select { box-sizing:border-box; min-width:0; width:100%; height:36px; padding:7px 10px; border:1px solid var(--cltc-border); border-radius:8px; background:var(--cltc-input); color:var(--cltc-text); font:inherit; outline:none; }
      .cltc-profile-select { cursor:pointer; }
      .cltc-price-input:disabled, .cltc-profile-select:disabled { cursor:not-allowed; opacity:.55; pointer-events:none; }
      .cltc-profile-field-note { margin-top:-2px; color:var(--cltc-muted); font-size:11px; line-height:16px; }
      .cltc-price-input:focus, .cltc-profile-select:focus { border-color:color-mix(in srgb, var(--cltc-text) 58%, var(--cltc-border)); box-shadow:0 0 0 2px color-mix(in srgb, var(--cltc-text) 10%, transparent); }
      .cltc-price-row { display:grid; grid-template-columns:minmax(120px, 1fr) repeat(4,minmax(44px, .45fr)); gap:6px; align-items:center; width:100%; min-height:34px; padding:7px 9px; border:0; border-bottom:1px solid var(--cltc-border-subtle); background:transparent; color:inherit; font:inherit; text-align:left; }
      .cltc-settings-overlay .cltc-price-row[data-active="true"] { background:var(--cltc-hover); font-weight:650; }
      .cltc-price-row span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .cltc-price-table-head { min-height:30px; padding-top:4px; padding-bottom:4px; color:var(--cltc-muted); font-size:11px; font-weight:500; }
      .cltc-settings-overlay .cltc-price-meta { margin-top:-12px; color:var(--cltc-muted); font-size:12px; }
      .cltc-settings-overlay .cltc-price-list { display:grid; max-height:210px; overflow:auto; border:1px solid var(--cltc-border-subtle); border-radius:8px; scrollbar-width:thin; scrollbar-color:color-mix(in srgb, var(--cltc-muted) 35%, transparent) transparent; }
      .cltc-price-editor { display:grid; gap:14px; padding-top:20px; border-top:1px solid var(--cltc-border-subtle); }
      .cltc-price-actions { display:flex; justify-content:flex-end; gap:8px; }
      .cltc-settings-button, .cltc-link-button { display:inline-flex; align-items:center; justify-content:center; min-height:32px; padding:6px 10px; border:1px solid var(--cltc-border); border-radius:8px; background:transparent; color:inherit; cursor:pointer; font:inherit; text-decoration:none; }
      .cltc-settings-button[data-variant='primary'] { border-color:var(--cltc-primary); background:var(--cltc-primary); color:var(--cltc-primary-text); }
      .cltc-settings-button[data-variant='danger'] { color:var(--cltc-danger); }
      .cltc-settings-status { min-height:20px; color:var(--cltc-muted); } .cltc-settings-error { color:var(--cltc-danger); }
      @media (max-width:680px) {
        .cltc-settings-overlay { align-items:stretch; padding:12px; }
        .cltc-settings-modal { width:100%; height:calc(100vh - 24px); max-height:none; }
        .cltc-settings-shell { grid-template-columns:minmax(0,1fr); grid-template-rows:auto minmax(0,1fr); }
        .cltc-settings-sidebar { display:block; padding:8px 10px; border-right:0; border-bottom:1px solid var(--cltc-border-subtle); overflow-x:auto; }
        .cltc-settings-footer { display:none; }
        .cltc-settings-nav { display:flex; min-width:max-content; }
        .cltc-settings-nav button { width:auto; white-space:nowrap; }
        .cltc-settings-content { padding:22px 18px 26px; }
        .cltc-price-grid { grid-template-columns:minmax(0,1fr); }
        .cltc-price-row { grid-template-columns:minmax(112px,1fr) repeat(4,minmax(42px,.45fr)); font-size:11px; }
      }
    `;
    document.head.appendChild(style);

    overlay = make("div", "cltc-settings-overlay");
    modal = make("div", "cltc-settings-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Codex Token Cost 设置");
    const head = make("div", "cltc-price-head");
    const close = button("×", "close-price");
    close.setAttribute("aria-label", "关闭");
    head.append(make("span", "cltc-price-title", "Codex Token Cost"), close);
    modal.appendChild(head);
    const shell = make("div", "cltc-settings-shell");
    const sidebar = make("aside", "cltc-settings-sidebar");
    nav = make("nav", "cltc-settings-nav");
    nav.setAttribute("aria-label", "设置分组");
    renderNavigation();
    const footer = make("div", "cltc-settings-footer");
    footer.append(make("span", "", "Tianzora"), make("span", "cltc-settings-version", "v1.0.0"));
    sidebar.append(nav, footer);
    content = make("div", "cltc-settings-content");
    content.setAttribute("role", "region");
    content.setAttribute("aria-live", "polite");
    shell.append(sidebar, content);
    modal.appendChild(shell);
    overlay.appendChild(modal);
    overlay.addEventListener("click", onClick);
    overlay.addEventListener("change", onChange);
    overlay.addEventListener("input", onInput);
    overlay.addEventListener("keydown", onKeydown);
    document.body.appendChild(overlay);
    renderPanel(activePanel);
    close.focus();
  }

  function unmount() {
    if (stopped) return;
    stopped = true;
    context.closeAnalytics();
    if (overlay) {
      overlay.removeEventListener("click", onClick);
      overlay.removeEventListener("change", onChange);
      overlay.removeEventListener("input", onInput);
      overlay.removeEventListener("keydown", onKeydown);
      overlay.remove();
    }
    if (style) style.remove();
    overlay = null;
    modal = null;
    content = null;
    nav = null;
    style = null;
    config = null;
  }

  return Object.freeze({ mount, unmount });
});
