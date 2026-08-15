"use strict";

api.registerModule("analytics", (context) => {
  const STYLE_ID = "codex-live-token-cost-analytics-style";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const MAX_ANALYTICS_DAYS = 31;
  const MAX_ANALYTICS_MODELS = 20;
  const RANGE_TYPES = Object.freeze({ today: "today", "7d": "last_seven_days", "30d": "last_thirty_days" });
  let root = null;
  let resultRoot = null;
  let statusRoot = null;
  let style = null;
  let stopped = false;
  let querySequence = 0;
  let currentPreset = "today";
  let currentModel = null;
  let currentMetric = "tokens";
  let lastAnalytics = null;
  let modelsExpanded = false;
  let customDates = [];
  let calendarFailures = 0;
  let syncInFlight = false;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function makeSvg(tag, className, text) {
    const node = document.createElementNS(SVG_NS, tag);
    if (className) node.setAttribute("class", className);
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstElementChild) node.firstElementChild.remove();
    node.textContent = "";
  }

  function button(text, attribute, value) {
    const node = make("button", "cltc-analytics-control", text);
    node.type = "button";
    node.dataset[attribute] = value;
    return node;
  }

  function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function validTotals(value) {
    return Boolean(value && typeof value === "object" && [
      value.turns, value.steps, value.input, value.cached_input, value.cache_write, value.output,
      value.cost_nanos, value.llm_ms, value.tool_ms, value.first_token_total_ms,
      value.first_token_samples, value.generation_ms, value.generation_output_tokens,
    ].every(safeCount) && value.cached_input <= value.input);
  }

  function validDayString(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day >= 1 && day <= monthDays[month - 1];
  }

  function validDay(value) {
    return Boolean(value && validDayString(value.day) && validTotals(value.totals));
  }

  function validModel(value) {
    return Boolean(value && typeof value.model === "string" && value.model.length > 0
      && new TextEncoder().encode(value.model).length <= 128 && validTotals(value.totals));
  }

  function boundedAnalytics(value) {
    if (!value || typeof value !== "object" || !validDayString(value.from_day)
      || !validDayString(value.to_day) || value.from_day > value.to_day || !validTotals(value.totals)
      || !Array.isArray(value.days) || !Array.isArray(value.models)) return null;
    const days = value.days.slice(0, MAX_ANALYTICS_DAYS);
    const models = value.models.slice(0, MAX_ANALYTICS_MODELS);
    if (!days.every(validDay) || !models.every(validModel)) return null;
    return { from_day: value.from_day, to_day: value.to_day, totals: value.totals, days, models };
  }

  function formatCount(value) {
    if (value >= 1_000_000_000) return `${Math.round(value / 100_000_000) / 10}B`;
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
    if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
    return String(value);
  }

  function formatMoney(nanos) {
    return `$${(nanos / 1_000_000_000).toFixed(2)}`;
  }

  function setError(message) {
    if (!root || !statusRoot) return;
    clear(statusRoot);
    delete statusRoot.dataset.analyticsStatus;
    const error = make("div", "cltc-analytics-error", String(message || "操作失败，请重试。").slice(0, 180));
    statusRoot.appendChild(error);
  }

  function clearStatus() {
    if (!statusRoot) return;
    clear(statusRoot);
    delete statusRoot.dataset.analyticsStatus;
  }

  function metric(label, value) {
    const node = make("div", "cltc-analytics-metric");
    node.append(make("span", "", label), make("strong", "", value), make("small", "", "较上期新增"));
    return node;
  }

  function analyticsChart(days) {
    const chart = makeSvg("svg", "cltc-analytics-chart");
    chart.dataset.analyticsChart = "true";
    chart.setAttribute("viewBox", "0 0 640 190");
    chart.setAttribute("role", "graphics-document");
    chart.setAttribute("aria-label", currentMetric === "cost" ? "花费趋势" : "Token 趋势");
    const maximum = Math.max(1, ...days.map((day) => currentMetric === "cost"
      ? day.totals.cost_nanos : day.totals.input + day.totals.output));
    const slot = 640 / Math.max(1, days.length);
    const width = Math.max(3, Math.min(18, slot - 4));
    days.forEach((day, index) => {
      const value = currentMetric === "cost" ? day.totals.cost_nanos : day.totals.input + day.totals.output;
      const height = Math.max(value > 0 ? 2 : 0, Math.round((value / maximum) * 146));
      const group = makeSvg("g", "cltc-analytics-bar");
      const rect = makeSvg("rect");
      rect.dataset.chartIndex = String(index);
      rect.setAttribute("x", String(Math.round(index * slot + (slot - width) / 2)));
      rect.setAttribute("y", String(158 - height));
      rect.setAttribute("width", String(width));
      rect.setAttribute("height", String(height));
      rect.setAttribute("rx", "2");
      const label = makeSvg("text", "", day.day.slice(5));
      label.setAttribute("x", String(Math.round(index * slot + slot / 2)));
      label.setAttribute("y", "178");
      label.setAttribute("text-anchor", "middle");
      group.append(rect, label);
      chart.appendChild(group);
    });
    return chart;
  }

  function renderAnalytics(analytics) {
    if (!resultRoot || stopped) return;
    lastAnalytics = analytics;
    clear(resultRoot);
    resultRoot.dataset.toDay = analytics.to_day;
    customDates = [analytics.from_day, analytics.to_day];
    const totals = analytics.totals;
    const metrics = make("div", "cltc-analytics-metrics");
    metrics.append(
      metric("总 Token", formatCount(totals.input + totals.output)),
      metric("总花费", formatMoney(totals.cost_nanos)),
      metric("模型调用", formatCount(totals.turns)),
      metric("缓存命中率", totals.input ? `${Math.round((totals.cached_input * 100) / totals.input)}%` : "--"),
    );
    resultRoot.appendChild(metrics);

    if (totals.turns === 0 && analytics.days.length === 0 && analytics.models.length === 0) {
      resultRoot.appendChild(make("div", "cltc-analytics-empty", "当前范围暂无使用记录。"));
      return;
    }

    const trend = make("section", "cltc-analytics-section");
    const trendHead = make("div", "cltc-analytics-section-head");
    const trendCopy = make("div");
    trendCopy.append(make("h3", "", "趋势"), make("p", "", currentPreset === "today" ? "按小时" : "按日"));
    const legend = make("div", "cltc-segmented cltc-segmented-compact");
    legend.setAttribute("role", "group");
    legend.setAttribute("aria-label", "趋势指标");
    const tokenMetric = button("Token", "analyticsMetric", "tokens");
    const costMetric = button("花费", "analyticsMetric", "cost");
    tokenMetric.dataset.active = String(currentMetric === "tokens");
    costMetric.dataset.active = String(currentMetric === "cost");
    legend.append(tokenMetric, costMetric);
    trendHead.append(trendCopy, legend);
    trend.appendChild(trendHead);
    trend.appendChild(analyticsChart(analytics.days));
    resultRoot.appendChild(trend);

    const composition = make("section", "cltc-analytics-section");
    const compositionHead = make("div", "cltc-analytics-section-head");
    const compositionCopy = make("div");
    compositionCopy.append(make("h3", "", "Token 构成"), make("p", "", "输入构成互斥计算"));
    compositionHead.append(compositionCopy, make("strong", "", formatCount(totals.input + totals.output)));
    composition.appendChild(compositionHead);
    const compositionBar = make("div", "cltc-composition-bar");
    for (const item of [["neutral", Math.max(0, totals.input - totals.cached_input)], ["green", totals.output], ["blue", totals.cached_input], ["purple", totals.cache_write]]) {
      const part = make("span");
      part.dataset.tone = item[0];
      part.style.setProperty("flex-grow", String(item[1]));
      compositionBar.appendChild(part);
    }
    composition.appendChild(compositionBar);
    const compositionLegend = make("div", "cltc-composition-legend");
    for (const item of [["常规输入", Math.max(0, totals.input - totals.cached_input)], ["输出", totals.output], ["读缓存", totals.cached_input], ["写缓存", totals.cache_write]]) {
      const label = make("span");
      const swatch = make("i");
      swatch.dataset.tone = item[0] === "常规输入" ? "neutral" : item[0] === "输出" ? "green" : item[0] === "读缓存" ? "blue" : "purple";
      label.append(swatch, make("span", "", item[0]), make("strong", "", formatCount(item[1])));
      compositionLegend.appendChild(label);
    }
    composition.appendChild(compositionLegend);
    resultRoot.appendChild(composition);

    const models = make("section", "cltc-analytics-section");
    const modelHeadCopy = make("div", "cltc-analytics-section-head");
    const modelCopy = make("div");
    modelCopy.append(make("h3", "", "模型明细"), make("p", "", "点击模型可联动筛选整页"));
    modelHeadCopy.appendChild(modelCopy);
    models.appendChild(modelHeadCopy);
    const columns = make("div", "cltc-analytics-model-head");
    for (const label of ["模型", "Token", "模型调用", "花费", "占比"]) columns.appendChild(make("span", "", label));
    models.appendChild(columns);
    const modelList = make("div", "cltc-analytics-models");
    analytics.models.forEach((model, index) => {
      const row = make("button", "cltc-analytics-model-row");
      row.type = "button";
      row.dataset.analyticsModel = model.model;
      row.dataset.hidden = String(index >= 10 && !modelsExpanded);
      const tokens = model.totals.input + model.totals.output;
      const modelName = make("span", "", model.model);
      modelName.setAttribute("title", model.model);
      row.append(
        modelName,
        make("span", "", formatCount(tokens)),
        make("span", "", formatCount(model.totals.turns)),
        make("span", "", formatMoney(model.totals.cost_nanos)),
        make("span", "", totals.input + totals.output ? `${Math.round((tokens * 100) / (totals.input + totals.output))}%` : "0%"),
      );
      modelList.appendChild(row);
    });
    if (!analytics.models.length) modelList.appendChild(make("div", "cltc-analytics-empty", "当前范围内暂无真实模型调用。"));
    models.appendChild(modelList);
    if (analytics.models.length > 10) {
      const expand = button(modelsExpanded ? "收起" : `查看全部 ${analytics.models.length} 个模型`, "action", "toggle-analytics-models");
      expand.classList.add("cltc-analytics-expand");
      models.appendChild(expand);
    }
    resultRoot.appendChild(models);
  }

  function renderModelFilter() {
    const filter = root?.querySelector("[data-action='clear-analytics-model']");
    if (!filter) return;
    filter.hidden = !currentModel;
    filter.textContent = currentModel ? `${currentModel} ×` : "";
  }

  function rangeValue() {
    if (currentPreset !== "custom") return { type: RANGE_TYPES[currentPreset] };
    if (customDates.length !== 2) return null;
    return { type: "custom", from_day: customDates[0], to_day: customDates[1] };
  }

  function queryAnalytics() {
    const range = rangeValue();
    if (!range || stopped) return;
    const sequence = ++querySequence;
    clearStatus();
    const action = { type: "query_analytics", range };
    if (currentModel) action.model = currentModel;
    context.emitAction(action).then((result) => {
      if (stopped || sequence !== querySequence) return;
      const value = result?.status === "ok" && result.response?.type === "analytics"
        ? boundedAnalytics(result.response.analytics) : null;
      if (!value) throw new Error("analytics rejected");
      renderAnalytics(value);
    }).catch(() => {
      if (!stopped && sequence === querySequence) setError("统计加载失败，请重试。");
    });
  }

  function applyCustomRange(fromDay, toDay) {
    if (stopped || !validDayString(fromDay) || !validDayString(toDay) || fromDay > toDay) return;
    customDates = [fromDay, toDay];
    currentPreset = "custom";
    context.closeFlatpickr();
    const trigger = root?.querySelector("[data-action='open-analytics-calendar']");
    if (trigger) trigger.textContent = `${fromDay} – ${toDay}`;
    queryAnalytics();
  }

  function openCalendar() {
    if (calendarFailures >= 2) return;
    clearStatus();
    const target = root?.querySelector("[data-analytics-date-input]");
    if (!target) return;
    target.value = customDates.length === 2 ? `${customDates[0]} 至 ${customDates[1]}` : "";
    context.requestFlatpickr(target, applyCustomRange, () => {
      if (stopped) return;
      calendarFailures += 1;
      setError(calendarFailures >= 2 ? "日期组件加载失败。" : "日期组件加载失败，请重试。");
    });
  }

  function syncCcSwitch() {
    if (stopped || syncInFlight) return;
    syncInFlight = true;
    const syncButton = root?.querySelector("[data-action='sync-analytics-cc-switch']");
    if (syncButton) syncButton.disabled = true;
    const sequence = ++querySequence;
    clearStatus();
    context.emitAction({ type: "sync_cc_switch" }).then((result) => {
      if (stopped || sequence !== querySequence) return;
      const response = result?.status === "ok" && result.response?.type === "synced" ? result.response : null;
      const analytics = response ? boundedAnalytics(response.analytics) : null;
      if (!response || !safeCount(response.imported_turns) || !analytics) throw new Error("sync rejected");
      currentPreset = "custom";
      currentModel = null;
      customDates = [analytics.from_day, analytics.to_day];
      context.closeFlatpickr();
      for (const item of root.querySelectorAll("[data-analytics-preset]")) item.dataset.active = String(item.dataset.analyticsPreset === "custom");
      const trigger = root.querySelector("[data-action='open-analytics-calendar']");
      if (trigger) {
        trigger.hidden = false;
        trigger.textContent = `${analytics.from_day} – ${analytics.to_day}`;
      }
      renderModelFilter();
      statusRoot.textContent = "";
      statusRoot.dataset.analyticsStatus = "sync";
      statusRoot.textContent = `已同步 ${response.imported_turns} 条。`;
      renderAnalytics(analytics);
    }).catch(() => {
      if (!stopped && sequence === querySequence) setError("CC Switch 同步失败，请重试。");
    }).finally(() => {
      syncInFlight = false;
      if (!stopped && syncButton?.isConnected) syncButton.disabled = false;
    });
  }

  function selectPreset(name) {
    if (!["today", "7d", "30d", "custom"].includes(name)) return;
    currentPreset = name;
    for (const item of root.querySelectorAll("[data-analytics-preset]")) item.dataset.active = String(item.dataset.analyticsPreset === name);
    const custom = root.querySelector(".cltc-date-range-trigger");
    if (custom) custom.hidden = name !== "custom";
    if (name === "custom") return;
    context.closeFlatpickr();
    queryAnalytics();
  }

  function onClick(event) {
    const preset = event.target?.closest?.("[data-analytics-preset]");
    if (preset) {
      selectPreset(preset.dataset.analyticsPreset);
      return;
    }
    const model = event.target?.closest?.("[data-analytics-model]");
    if (model) {
      currentModel = model.dataset.analyticsModel;
      renderModelFilter();
      queryAnalytics();
      return;
    }
    const metric = event.target?.closest?.("[data-analytics-metric]");
    if (metric && ["tokens", "cost"].includes(metric.dataset.analyticsMetric) && metric.dataset.analyticsMetric !== currentMetric) {
      currentMetric = metric.dataset.analyticsMetric;
      if (lastAnalytics) renderAnalytics(lastAnalytics);
      return;
    }
    const action = event.target?.closest?.("[data-action]");
    if (action?.dataset.action === "open-analytics-calendar") openCalendar();
    else if (action?.dataset.action === "sync-analytics-cc-switch") syncCcSwitch();
    else if (action?.dataset.action === "clear-analytics-model" && currentModel) {
      currentModel = null;
      renderModelFilter();
      queryAnalytics();
    }
    else if (action?.dataset.action === "toggle-analytics-models") {
      modelsExpanded = !modelsExpanded;
      if (lastAnalytics) renderAnalytics(lastAnalytics);
    }
  }

  function mount() {
    const host = context.mountTarget;
    if (stopped || root || !host?.isConnected) return;
    clear(host);
    style = make("style");
    style.id = STYLE_ID;
    style.textContent = `
      .cltc-analytics{display:grid;gap:26px;color:var(--cltc-text)}
      .cltc-analytics-heading,.cltc-analytics-toolbar,.cltc-analytics-section-head{display:flex;align-items:center;justify-content:space-between;gap:14px}.cltc-analytics-heading{align-items:flex-start;gap:18px}.cltc-analytics-heading>div{min-width:0}
      .cltc-segmented{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:8px;background:var(--cltc-surface-secondary)}
      .cltc-analytics-control{min-height:30px;padding:5px 9px;border:0;border-radius:6px;background:transparent;color:var(--cltc-muted);cursor:pointer;font:inherit;text-align:left}.cltc-analytics-control[data-active='true']{background:var(--cltc-surface);color:var(--cltc-text);box-shadow:0 1px 2px color-mix(in srgb,var(--cltc-shadow) 34%,transparent);font-weight:600}
      .cltc-date-range-trigger{border:1px solid var(--cltc-border);color:var(--cltc-text)}.cltc-date-range-trigger[hidden],.cltc-analytics-filter[hidden]{display:none}.cltc-analytics-filter{flex:0 1 auto;max-width:230px;overflow:hidden;background:var(--cltc-surface-secondary);color:var(--cltc-text);text-overflow:ellipsis;white-space:nowrap}.cltc-analytics-date-input{position:fixed;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none}
      .cltc-analytics-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--cltc-border-subtle);border-bottom:1px solid var(--cltc-border-subtle)}
      .cltc-analytics-metric{display:grid;min-width:0;gap:4px;padding:16px 14px;border-right:1px solid var(--cltc-border-subtle)}.cltc-analytics-metric:first-child{padding-left:0}.cltc-analytics-metric:last-child{border-right:0}
      .cltc-analytics-metric>span,.cltc-analytics-metric small{overflow:hidden;color:var(--cltc-muted);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}.cltc-analytics-metric strong{overflow:hidden;font-size:18px;font-weight:600;line-height:24px;text-overflow:ellipsis;white-space:nowrap}
      .cltc-analytics-result{display:grid;gap:26px}.cltc-analytics-section{display:grid;gap:14px;padding-top:22px;border-top:1px solid var(--cltc-border-subtle)}
      .cltc-analytics-section-head h3{margin:0;font-size:14px;font-weight:600}.cltc-analytics-section-head p{margin:2px 0 0;color:var(--cltc-muted);font-size:11px}.cltc-segmented-compact .cltc-analytics-control{min-width:52px}
      .cltc-analytics-chart{display:block;width:100%;min-height:190px;overflow:visible}.cltc-analytics-chart rect[data-chart-index]{fill:color-mix(in srgb,var(--cltc-text) 78%,transparent)}.cltc-analytics-chart text{fill:var(--cltc-muted);font-size:9px}
      .cltc-composition-bar{display:flex;gap:2px;width:100%;height:10px;overflow:hidden;border-radius:5px;background:var(--cltc-surface-secondary)}.cltc-composition-bar span{min-width:0}.cltc-analytics [data-tone='neutral']{background:#8e8e93}.cltc-analytics [data-tone='green']{background:#10a37f}.cltc-analytics [data-tone='blue']{background:#3b82f6}.cltc-analytics [data-tone='purple']{background:#8b5cf6}
      .cltc-composition-legend{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 16px}.cltc-composition-legend>span{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:7px;min-width:0;color:var(--cltc-muted);font-size:11px}.cltc-composition-legend i{width:7px;height:7px;border-radius:2px}.cltc-composition-legend strong{color:var(--cltc-text);font-weight:500}
      .cltc-analytics-model-head,.cltc-analytics-model-row{display:grid;grid-template-columns:minmax(150px,1.45fr) repeat(4,minmax(72px,.7fr));gap:10px;align-items:center}.cltc-analytics-model-head{padding:0 9px;color:var(--cltc-muted);font-size:10px}.cltc-analytics-models{max-height:320px;overflow:auto;border-top:1px solid var(--cltc-border-subtle);border-bottom:1px solid var(--cltc-border-subtle)}
      .cltc-analytics-model-row{width:100%;min-height:38px;padding:7px 9px;border:0;border-bottom:1px solid var(--cltc-border-subtle);background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left}.cltc-analytics-model-row[data-hidden='true']{display:none}.cltc-analytics-model-row span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.cltc-analytics-expand{justify-self:start;padding-left:0;color:var(--cltc-text)}
      .cltc-analytics-sync{margin-top:0}.cltc-analytics-status{min-height:18px;color:var(--cltc-muted);font-size:12px}.cltc-analytics-error{color:var(--cltc-danger)}.cltc-analytics-empty{padding:24px 10px;color:var(--cltc-muted);font-size:12px;text-align:center}
      @media(max-width:680px){.cltc-analytics-toolbar,.cltc-analytics-section-head{align-items:flex-start;flex-direction:column}.cltc-analytics-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.cltc-analytics-model-head,.cltc-analytics-model-row{grid-template-columns:minmax(110px,1.2fr) repeat(4,minmax(54px,.7fr))}}
    `;
    document.head.appendChild(style);
    root = make("section", "cltc-settings-section cltc-analytics");
    const heading = make("div", "cltc-settings-section-heading cltc-analytics-heading");
    const headingCopy = make("div");
    headingCopy.append(make("h2", "", "使用统计"), make("p", "", "基于 HUD、Profile 与 CC Switch 相同的本地去重口径。"));
    const filter = button("", "action", "clear-analytics-model");
    filter.classList.add("cltc-analytics-filter");
    filter.hidden = true;
    heading.append(headingCopy, filter);
    root.appendChild(heading);
    const toolbar = make("div", "cltc-analytics-toolbar");
    const presets = make("div", "cltc-segmented");
    presets.setAttribute("role", "group");
    presets.setAttribute("aria-label", "统计时间范围");
    for (const item of [["today", "今日"], ["7d", "7 天"], ["30d", "30 天"], ["custom", "自定义"]]) {
      const control = button(item[1], "analyticsPreset", item[0]);
      control.dataset.active = String(item[0] === currentPreset);
      presets.appendChild(control);
    }
    const trigger = button("选择日期范围", "action", "open-analytics-calendar");
    trigger.classList.add("cltc-date-range-trigger");
    trigger.hidden = true;
    const date = make("input", "cltc-analytics-date-input");
    date.type = "text";
    date.dataset.analyticsDateInput = "true";
    date.setAttribute("tabindex", "-1");
    date.setAttribute("aria-hidden", "true");
    toolbar.append(presets, trigger, date);
    root.appendChild(toolbar);
    resultRoot = make("div", "cltc-analytics-result");
    resultRoot.dataset.analyticsResult = "true";
    root.appendChild(resultRoot);
    const syncRow = make("div", "cltc-settings-row cltc-analytics-sync");
    const syncCopy = make("div");
    syncCopy.appendChild(make("strong", "", "CC Switch 数据"));
    statusRoot = make("div", "cltc-analytics-status", "按需同步本地历史统计。");
    syncCopy.appendChild(statusRoot);
    const sync = button("立即同步", "action", "sync-analytics-cc-switch");
    syncRow.append(syncCopy, sync);
    root.appendChild(syncRow);
    root.addEventListener("click", onClick);
    host.appendChild(root);
    queryAnalytics();
  }

  function unmount() {
    if (stopped) return;
    stopped = true;
    syncInFlight = false;
    querySequence += 1;
    context.closeFlatpickr();
    root?.removeEventListener("click", onClick);
    root?.remove();
    style?.remove();
    root = null;
    resultRoot = null;
    statusRoot = null;
    style = null;
    customDates = [];
    lastAnalytics = null;
  }

  return Object.freeze({ mount, unmount });
});
