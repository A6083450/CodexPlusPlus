// ==UserScript==
// @name         Codex简体中文汉化
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Codex客户端全界面简体汉化补丁
// @author       BigPizzaV3
// @match        app://openai-codex/*
// @grant        none
// ==/UserScript==
(function () {
  const observerKey = "__codexZhCnTranslateObserver";
  const previousObserver = window[observerKey];
  if (previousObserver && typeof previousObserver.disconnect === "function") {
    previousObserver.disconnect();
  }

  const translations = new Map([
    ["Settings", "设置"],
    ["New chat", "新建对话"],
    ["Delete", "删除"],
    ["Export", "导出"],
    ["Save", "保存"],
    ["Cancel", "取消"],
    ["Model", "模型"],
    ["API Key", "密钥"],
    ["Add", "添加"],
    ["Remove", "移除"],
  ]);
  const reasoningEffortOrder = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const reasoningEffortLabels = {
    low: "轻度(low)",
    medium: "中(medium)",
    high: "高(high)",
    xhigh: "极高(xhigh)",
    max: "最高(max)",
    ultra: "极高(ultra)",
  };
  const reasoningTitleTexts = new Set(["推理强度", "Reasoning effort", "Reasoning Effort"]);
  const reasoningEffortAliases = new Map([
    ["轻度", "low"],
    ["轻度(low)", "low"],
    ["low", "low"],
    ["中", "medium"],
    ["中(medium)", "medium"],
    ["medium", "medium"],
    ["高", "high"],
    ["高(high)", "high"],
    ["high", "high"],
    ["极高(xhigh)", "xhigh"],
    ["xhigh", "xhigh"],
    ["extra high", "xhigh"],
    ["最高", "max"],
    ["最高(max)", "max"],
    ["max", "max"],
    ["maximum", "max"],
    ["极高(ultra)", "ultra"],
    ["ultra", "ultra"],
  ]);
  const ignoredParentSelector = "script, style, textarea, code, pre, [contenteditable='true']";

  function trimmedText(node) {
    return String(node?.nodeValue || "").trim();
  }

  function textNodesIn(root) {
    if (!root) return [];
    if (root.nodeType === Node.TEXT_NODE) return [root];
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  function replaceTrimmedText(node, translated) {
    const value = node?.nodeValue || "";
    const source = value.trim();
    if (!source || source === translated) return;
    const start = value.indexOf(source);
    node.nodeValue = value.slice(0, start) + translated + value.slice(start + source.length);
  }

  function reasoningEffortFromText(value) {
    const source = String(value || "").trim().toLowerCase();
    if (!source) return "";
    const alias = reasoningEffortAliases.get(source);
    if (alias) return alias;
    for (const effort of reasoningEffortOrder) {
      if (new RegExp(`(^|[^a-z])${effort}([^a-z]|$)`).test(source)) return effort;
    }
    return "";
  }

  function reasoningEffortFromElement(element) {
    if (!element || typeof element.getAttribute !== "function") return "";
    for (const name of ["data-selected-reasoning-effort", "data-codex-reasoning-effort", "data-value", "value", "aria-label"]) {
      const effort = reasoningEffortFromText(element.getAttribute(name));
      if (effort) return effort;
    }
    return "";
  }

  function reasoningLabelNode(element) {
    return textNodesIn(element).find((node) => {
      const source = trimmedText(node);
      return source === "极高" || !!reasoningEffortFromText(source);
    }) || null;
  }

  function hasReasoningTitle(element) {
    return textNodesIn(element).some((node) => reasoningTitleTexts.has(trimmedText(node)));
  }

  function reasoningOptionItems(menu) {
    if (!menu || !hasReasoningTitle(menu)) return [];
    const options = Array.from(menu.querySelectorAll('[role="menuitem"]'))
      .map((item) => ({ item, labelNode: reasoningLabelNode(item) }))
      .filter((entry) => !!entry.labelNode);
    return options.length === reasoningEffortOrder.length ? options : [];
  }

  function reasoningOptionChecked(item) {
    return item?.getAttribute?.("aria-checked") === "true"
      || item?.getAttribute?.("data-state") === "checked"
      || !!item?.querySelector?.('[aria-checked="true"], [data-state="checked"]');
  }

  function reasoningSummaryNode(row) {
    return textNodesIn(row).find((node) => {
      const source = trimmedText(node);
      return !reasoningTitleTexts.has(source)
        && (source === "极高" || !!reasoningEffortFromText(source));
    }) || null;
  }

  function syncReasoningEffortSummary(effort) {
    const rows = new Set([
      ...document.querySelectorAll('[role="menuitem"]'),
      ...document.querySelectorAll('[data-selected-reasoning-effort]'),
    ]);
    for (const row of rows) {
      const selectedEffort = reasoningEffortFromText(row.getAttribute?.("data-selected-reasoning-effort"));
      if (!selectedEffort && !hasReasoningTitle(row)) continue;
      const resolved = selectedEffort || effort || reasoningEffortFromElement(row);
      const summary = reasoningSummaryNode(row);
      if (!resolved || !summary) continue;
      row.setAttribute("data-codex-reasoning-effort", resolved);
      replaceTrimmedText(summary, reasoningEffortLabels[resolved]);
    }
  }

  function syncReasoningEffortLabels() {
    let selectedEffort = "";
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const options = reasoningOptionItems(menu);
      if (!options.length) continue;
      options.forEach(({ item, labelNode }, index) => {
        const effort = reasoningEffortFromElement(item)
          || reasoningEffortFromText(trimmedText(labelNode))
          || reasoningEffortOrder[index];
        item.setAttribute("data-codex-reasoning-effort", effort);
        replaceTrimmedText(labelNode, reasoningEffortLabels[effort]);
        if (reasoningOptionChecked(item)) selectedEffort = effort;
      });
    }
    syncReasoningEffortSummary(selectedEffort);
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const parent = node.parentElement;
    if (parent && typeof parent.matches === "function" && parent.matches(ignoredParentSelector)) return;

    const value = node.nodeValue || "";
    const source = value.trim();
    const translated = translations.get(source);
    if (!translated) return;

    const start = value.indexOf(source);
    node.nodeValue = value.slice(0, start) + translated + value.slice(start + source.length);
  }

  function translateSubtree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root);
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      translateTextNode(node);
    }
  }

  function install() {
    const root = document.body || document.documentElement;
    if (!root || typeof MutationObserver !== "function") return;

    translateSubtree(root);
    syncReasoningEffortLabels();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          translateTextNode(mutation.target);
        }
        for (const node of mutation.addedNodes || []) {
          translateSubtree(node);
        }
      }
      syncReasoningEffortLabels();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-checked", "data-state", "data-value", "data-selected-reasoning-effort", "aria-label"],
    });
    window[observerKey] = observer;
  }

  if (!document.body && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
