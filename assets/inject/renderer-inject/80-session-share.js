  function normalizeWorkspacePath(path) {
    const normalized = String(path || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized || String(path || "").trim();
  }

  function sameWorkspacePath(left, right) {
    const leftPath = normalizeWorkspacePath(left);
    const rightPath = normalizeWorkspacePath(right);
    return !!leftPath && !!rightPath && leftPath === rightPath;
  }

  function displayProjectName(path) {
    const trimmed = String(path || "").replace(/\/+$/, "");
    return trimmed.split(/[\\/]+/).filter(Boolean).pop() || trimmed || "未命名项目";
  }

  function normalizeProjectLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function projectsSection() {
    return document.querySelector('[data-app-action-sidebar-section-heading="Projects"]');
  }

  function chatsSection() {
    return document.querySelector('[data-app-action-sidebar-section-heading="Chats"]');
  }

  function projectRowListItem(projectRow) {
    return projectRow.closest?.('[role="listitem"][aria-label]') || projectRow.closest?.('[role="listitem"]') || projectRow;
  }

  function nativeProjectTargets() {
    const section = projectsSection();
    const seen = new Set();
    const targets = [];
    Array.from(document.querySelectorAll('[data-app-action-sidebar-project-row]')).forEach((row) => {
      if (section && !section.contains(row)) return;
      const path = row.getAttribute("data-app-action-sidebar-project-id") || "";
      const normalizedPath = normalizeWorkspacePath(path);
      if (!normalizedPath || seen.has(normalizedPath)) return;
      const label = row.getAttribute("data-app-action-sidebar-project-label") || row.getAttribute("aria-label") || displayProjectName(path);
      seen.add(normalizedPath);
      targets.push({ kind: "project", label: String(label || displayProjectName(path)), description: path, path, normalizedPath, row, listItem: projectRowListItem(row) });
    });
    return targets;
  }

  function serializableProjectTarget(target) {
    return { kind: target.kind, label: target.label, description: target.description, path: target.path, normalizedPath: target.normalizedPath || normalizeWorkspacePath(target.path) };
  }

  function projectMoveTargets() {
    return [
      { kind: "projectless", label: "普通对话", description: "不属于任何项目", path: "", normalizedPath: "" },
      ...nativeProjectTargets().map(serializableProjectTarget),
    ];
  }

  function readLegacyProjectMoveProjection() {
    try {
      const parsed = JSON.parse(localStorage.getItem(legacyProjectMoveOverridesKey) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const now = Date.now();
      const next = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value !== "object" || !value.targetCwd) continue;
        const sessionId = projectMoveSessionKey(value.sessionId || key);
        if (!sessionId) continue;
        next[sessionId] = {
          sessionId,
          targetKind: "project",
          targetCwd: String(value.targetCwd),
          targetLabel: String(value.targetLabel || displayProjectName(value.targetCwd)),
          title: String(value.title || ""),
          sortMs: sortMsForSession(sessionId, value.sortMs || value.updatedAtMs || value.updated_at_ms),
          sortMsTrusted: false,
          at: typeof value.at === "number" ? value.at : now,
        };
      }
      return next;
    } catch {
      return {};
    }
  }

  function readProjectMoveProjection() {
    try {
      const parsed = JSON.parse(localStorage.getItem(projectMoveProjectionKey) || "{}");
      const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      const merged = { ...readLegacyProjectMoveProjection(), ...raw };
      const now = Date.now();
      const projection = {};
      for (const [key, value] of Object.entries(merged)) {
        if (!value || typeof value !== "object") continue;
        const sessionId = projectMoveSessionKey(value.sessionId || key);
        if (!sessionId) continue;
        if (typeof value.at === "number" && now - value.at > projectMoveProjectionTtlMs) continue;
        const targetKind = value.targetKind === "projectless" ? "projectless" : "project";
        const targetCwd = String(value.targetCwd || value.path || "");
        if (targetKind === "project" && !targetCwd) continue;
        projection[sessionId] = {
          sessionId,
          targetKind,
          targetCwd,
          targetLabel: String(value.targetLabel || value.label || (targetKind === "projectless" ? "普通对话" : displayProjectName(targetCwd))),
          title: String(value.title || ""),
          sortMs: sortMsForSession(sessionId, value.sortMs || value.updatedAtMs || value.updated_at_ms),
          sortMsTrusted: value.sortMsTrusted === true,
          at: typeof value.at === "number" ? value.at : now,
        };
      }
      return projection;
    } catch {
      return readLegacyProjectMoveProjection();
    }
  }

  function writeProjectMoveProjection(projection) {
    try {
      localStorage.setItem(projectMoveProjectionKey, JSON.stringify(projection || {}));
      localStorage.removeItem(legacyProjectMoveOverridesKey);
    } catch (error) {
      window.__codexProjectMoveProjectionFailures = window.__codexProjectMoveProjectionFailures || [];
      window.__codexProjectMoveProjectionFailures.push(String(error?.stack || error));
    }
  }

  function saveProjectMoveProjection(ref, target, sortMs) {
    const id = projectMoveSessionKey(ref.session_id);
    if (!id || !target) return;
    const projection = readProjectMoveProjection();
    projection[id] = {
      sessionId: id,
      targetKind: target.kind === "projectless" ? "projectless" : "project",
      targetCwd: target.path || "",
      targetLabel: target.label || (target.kind === "projectless" ? "普通对话" : displayProjectName(target.path)),
      title: ref.title || "",
      sortMs: sortMsForSession(ref.session_id, sortMs || target.sortMs),
      sortMsTrusted: target.sortMsTrusted === true,
      at: Date.now(),
    };
    writeProjectMoveProjection(projection);
  }

  function clearProjectMoveProjection(ref) {
    const projection = readProjectMoveProjection();
    const keys = threadIdVariants(ref.session_id).map(projectMoveSessionKey).filter(Boolean);
    let changed = false;
    keys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(projection, key)) {
        delete projection[key];
        changed = true;
      }
    });
    if (changed) writeProjectMoveProjection(projection);
  }

  function projectionForSessionId(sessionId, projection = readProjectMoveProjection()) {
    const key = projectMoveSessionKey(sessionId);
    return key ? projection[key] || null : null;
  }

  function projectRowFromListItem(projectItem) {
    if (!projectItem) return null;
    if (projectItem.matches?.("[data-app-action-sidebar-project-row]")) return projectItem;
    return projectItem.querySelector?.("[data-app-action-sidebar-project-row]") || null;
  }

  function targetPath(target) {
    return target?.path || target?.targetCwd || "";
  }

  function targetLabel(target) {
    return target?.label || target?.targetLabel || displayProjectName(targetPath(target));
  }

  function projectItemMatchesTarget(projectItem, target) {
    const projectRow = projectRowFromListItem(projectItem);
    const projectPath = projectRow?.getAttribute?.("data-app-action-sidebar-project-id") || "";
    if (projectPath && sameWorkspacePath(projectPath, targetPath(target))) return true;
    const actual = normalizeProjectLabel(projectRow?.getAttribute?.("data-app-action-sidebar-project-label") || projectItem?.getAttribute?.("aria-label"));
    const labels = uniqueValues([targetLabel(target), displayProjectName(targetPath(target))]).map(normalizeProjectLabel).filter(Boolean);
    return !!actual && labels.includes(actual);
  }

  function findProjectListItem(target) {
    const nativeTarget = nativeProjectTargets().find((project) => sameWorkspacePath(project.path, targetPath(target)));
    if (nativeTarget?.listItem) return nativeTarget.listItem;
    const section = projectsSection();
    if (!section) return null;
    return Array.from(section.querySelectorAll('[role="listitem"][aria-label]')).find((item) => projectItemMatchesTarget(item, target)) || null;
  }

  function closestProjectListItem(row) {
    const item = row.closest?.('[role="listitem"][aria-label]');
    return item?.closest?.('[data-app-action-sidebar-section-heading="Projects"]') ? item : null;
  }

  function rowIsInChats(row) {
    return !!row.closest?.('[data-app-action-sidebar-section-heading="Chats"]');
  }

  function chatsThreadList() {
    return chatsSection()?.querySelector?.('[role="list"][aria-label="对话"], [role="list"]') || null;
  }

  function rowIsUnderTargetProject(row, target) {
    const item = closestProjectListItem(row);
    return !!item && projectItemMatchesTarget(item, target);
  }

  function rowIsUnderTarget(row, target) {
    return target?.targetKind === "projectless" || target?.kind === "projectless" ? rowIsInChats(row) : rowIsUnderTargetProject(row, target);
  }

  function rowListItem(row) {
    return row.closest?.('[role="listitem"]') || row;
  }

  function rowContentRoot(row) {
    return Array.from(row?.children || []).find((child) => String(child.className || "").includes("h-full w-full items-center")) || null;
  }

  function normalizedText(node) {
    return String(node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function classNameText(node) {
    return String(node?.className || "");
  }

  function isRelativeTimeText(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return /^(刚刚|just now|\d+\s*(秒|秒钟|分|分钟|小时|天|日|周|星期|个月|月|年|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months|y|yr|yrs|year|years))$/i.test(value);
  }

  function nodeIsThreadTitle(row, node) {
    return Array.from(row?.querySelectorAll?.('[data-thread-title], .truncate.select-none, .truncate.text-base') || [])
      .some((titleNode) => titleNode === node || titleNode.contains(node));
  }

  function closestTimeWrapper(row, node) {
    const root = rowContentRoot(row) || row;
    let current = node?.parentElement || null;
    while (current && current !== root && current !== row) {
      const className = classNameText(current);
      if (current.dataset?.codexProjectMoveTimeWrapper === "true" || (className.includes("ml-[3px]") && className.includes("min-w-[26px]"))) return current;
      current = current.parentElement;
    }
    return null;
  }

  function nodeInsideStatusIcon(row, node) {
    const stop = closestTimeWrapper(row, node) || rowContentRoot(row) || row;
    let current = node || null;
    while (current && current !== stop && current !== row) {
      const className = classNameText(current);
      if (className.includes("animate-spin")) return true;
      if (className.includes("size-5") && className.includes("shrink-0")) return true;
      if (className.includes("contain-paint") && className.includes("contain-layout")) return true;
      current = current.parentElement;
    }
    return false;
  }

  function cleanupManagedStatusIconTimeNodes(row) {
    Array.from(row?.querySelectorAll?.('[data-codex-project-move-time="true"]') || []).forEach((node) => {
      if (!nodeInsideStatusIcon(row, node)) return;
      const text = normalizedText(node);
      delete node.dataset.codexProjectMoveTime;
      delete node.dataset.codexProjectMoveTimeMs;
      if (node.children.length === 0 && isRelativeTimeText(text)) node.textContent = "";
    });
  }

  function nodeLooksLikeTimeLabel(row, node) {
    if (nodeInsideStatusIcon(row, node)) return false;
    if (node?.dataset?.codexProjectMoveTime === "true") return true;
    if (node.children.length > 0) return false;
    const text = normalizedText(node);
    const className = classNameText(node);
    if ((className.includes("tabular-nums") || className.includes("text-token-description-foreground")) && text.length <= 24) return true;
    if (!isRelativeTimeText(text)) return false;
    const rowRect = row?.getBoundingClientRect?.();
    const nodeRect = node?.getBoundingClientRect?.();
    if (!rowRect || !nodeRect || rowRect.width <= 0 || nodeRect.width <= 0) return false;
    return nodeRect.left >= rowRect.left + rowRect.width * 0.45 || nodeRect.right >= rowRect.right - 96;
  }

  function rowTimeLabelCandidates(row) {
    cleanupManagedStatusIconTimeNodes(row);
    const root = rowContentRoot(row) || row;
    const raw = Array.from(root?.querySelectorAll?.("div, span, time, small") || []).filter((node) => {
      if (nodeIsThreadTitle(row, node)) return false;
      return nodeLooksLikeTimeLabel(row, node);
    });
    return raw.filter((node) => !raw.some((other) => other !== node && node.contains(other)));
  }

  function rowTimeLabelNode(row) {
    const candidates = rowTimeLabelCandidates(row);
    return candidates.find((node) => node.dataset?.codexProjectMoveTime !== "true" && !node.closest?.('[data-codex-project-move-time-wrapper="true"]')) || candidates[0] || null;
  }

  function removeTimeLabelNode(row, node) {
    if (!node || !row?.contains?.(node)) return;
    const wrapper = node.closest?.('[data-codex-project-move-time-wrapper="true"]') || closestTimeWrapper(row, node);
    if (wrapper && wrapper !== row && row.contains(wrapper)) {
      wrapper.remove();
      return;
    }
    node.remove();
  }

  function cleanupRowTimeLabels(row, keepNode) {
    if (!keepNode) return;
    rowTimeLabelCandidates(row).forEach((node) => {
      if (node === keepNode) return;
      if (node.dataset?.codexProjectMoveTime === "true" || node.closest?.('[data-codex-project-move-time-wrapper="true"]')) removeTimeLabelNode(row, node);
    });
  }

  function ensureRowTimeLabelNode(row) {
    const existing = rowTimeLabelNode(row);
    if (existing) {
      cleanupRowTimeLabels(row, existing);
      return existing;
    }
    const root = rowContentRoot(row);
    if (!root) return null;
    const wrapper = document.createElement("div");
    wrapper.className = "ml-[3px] flex items-center justify-end gap-1 min-w-[26px]";
    wrapper.dataset.codexProjectMoveTimeWrapper = "true";
    const inner = document.createElement("div");
    const label = document.createElement("div");
    label.className = "text-token-description-foreground text-sm leading-4 empty:hidden tabular-nums overflow-visible truncate text-right group-focus-within:opacity-0 group-hover:opacity-0";
    label.dataset.codexProjectMoveTime = "true";
    inner.appendChild(label);
    wrapper.appendChild(inner);
    root.appendChild(wrapper);
    return label;
  }

  function updateRowTimeLabel(row, sortMs) {
    const label = ensureRowTimeLabelNode(row);
    if (!label) return;
    const timestamp = numericTimestamp(sortMs);
    const text = relativeTimeLabel(timestamp);
    label.dataset.codexProjectMoveTime = "true";
    label.dataset.codexProjectMoveTimeMs = String(timestamp || 0);
    if (text && label.textContent !== text) label.textContent = text;
    cleanupRowTimeLabels(row, label);
  }

  function rowProjectionKind(row) {
    return row?.dataset?.codexProjectMoveTargetKind || rowListItem(row)?.dataset?.codexProjectMoveTargetKind || "";
  }

  function rowSortMs(row, ref = sessionRefFromRow(row), target = null) {
    return sortMsForSession(ref.session_id, target?.sortMs || row?.dataset?.codexProjectMoveSortMs || rowListItem(row)?.dataset?.codexProjectMoveSortMs);
  }

  function threadRowFromListItem(item) {
    if (!item) return null;
    if (item.matches?.("[data-app-action-sidebar-thread-id]")) return item;
    return item.querySelector?.("[data-app-action-sidebar-thread-id]") || null;
  }

  function rowPinned(row) {
    return row?.getAttribute?.("data-app-action-sidebar-thread-pinned") === "true" || rowListItem(row)?.getAttribute?.("data-app-action-sidebar-thread-pinned") === "true";
  }

  function insertRowItemByTime(list, item, row, target) {
    const ref = sessionRefFromRow(row);
    const sortMs = rowSortMs(row, ref, target);
    item.dataset.codexProjectMoveSortMs = String(sortMs || 0);
    row.dataset.codexProjectMoveSortMs = String(sortMs || 0);
    if (target?.sortMsTrusted) updateRowTimeLabel(row, sortMs);
    const pinned = rowPinned(row);
    const sessionKey = projectMoveSessionKey(ref.session_id);
    const existingItems = Array.from(list.children).filter((child) => child !== item);
    let firstNonThreadItem = null;
    for (const child of existingItems) {
      const childRow = threadRowFromListItem(child);
      if (!childRow) {
        firstNonThreadItem = firstNonThreadItem || child;
        continue;
      }
      const childPinned = rowPinned(childRow);
      if (childPinned && !pinned) continue;
      if (!childPinned && pinned) {
        list.insertBefore(item, child);
        return;
      }
      const childRef = sessionRefFromRow(childRow);
      const childSortMs = rowSortMs(childRow, childRef);
      const childKey = projectMoveSessionKey(childRef.session_id);
      if (sortMs > childSortMs || (sortMs === childSortMs && sessionKey > childKey)) {
        list.insertBefore(item, child);
        return;
      }
    }
    if (firstNonThreadItem) {
      list.insertBefore(item, firstNonThreadItem);
      return;
    }
    list.appendChild(item);
  }

  function projectMoveInjectedList(projectItem) {
    let list = projectItem.querySelector('[data-codex-project-move-injected-list="true"]');
    if (!list) {
      const body = Array.from(projectItem.children).find((child) => child.classList?.contains("overflow-hidden")) || projectItem;
      list = document.createElement("div");
      list.setAttribute("role", "list");
      list.setAttribute("data-codex-project-move-injected-list", "true");
      list.className = "flex flex-col";
      body.appendChild(list);
    }
    return list;
  }

  function projectThreadList(projectItem, target) {
    const targetCwd = targetPath(target);
    const projectLists = Array.from(projectItem.querySelectorAll("[data-app-action-sidebar-project-list-id]"));
    return projectLists.find((list) => sameWorkspacePath(list.getAttribute("data-app-action-sidebar-project-list-id"), targetCwd))
      || projectLists[0]
      || projectMoveInjectedList(projectItem);
  }

  function projectEmptyStateNodes(projectItem) {
    const emptyLabels = new Set(["暂无对话", "No conversations"]);
    return Array.from(projectItem.querySelectorAll("div, span")).filter((node) => {
      if (node.classList?.contains("overflow-hidden")) return false;
      if (node.closest('[data-app-action-sidebar-thread-id], [data-codex-project-move-injected-list="true"]')) return false;
      return emptyLabels.has(normalizeProjectLabel(node.textContent));
    });
  }

  function setProjectEmptyStateHidden(projectItem, hidden) {
    projectEmptyStateNodes(projectItem).forEach((node) => {
      if (hidden) {
        node.dataset.codexProjectMoveEmptyHidden = "true";
        node.classList.add("codex-project-move-hidden");
      } else if (node.dataset.codexProjectMoveEmptyHidden === "true") {
        delete node.dataset.codexProjectMoveEmptyHidden;
        node.classList.remove("codex-project-move-hidden");
      }
    });
  }

  function updateProjectMoveEmptyStates() {
    document.querySelectorAll('[data-codex-project-move-injected-list="true"]').forEach((list) => {
      const projectItem = list.closest('[role="listitem"][aria-label]');
      const hasRows = Array.from(list.children).some((child) => child.querySelector?.("[data-app-action-sidebar-thread-id]") || child.matches?.("[data-app-action-sidebar-thread-id]"));
      if (!hasRows) list.remove();
      if (projectItem) setProjectEmptyStateHidden(projectItem, hasRows);
    });
    document.querySelectorAll('[data-codex-project-move-empty-hidden="true"]').forEach((node) => {
      const projectItem = node.closest('[role="listitem"][aria-label]');
      const list = projectItem?.querySelector?.('[data-codex-project-move-injected-list="true"]');
      if (!list || list.children.length === 0) {
        delete node.dataset.codexProjectMoveEmptyHidden;
        node.classList.remove("codex-project-move-hidden");
      }
    });
  }

  function moveRowToProjectList(row, target) {
    const projectItem = findProjectListItem(target);
    if (!projectItem) return false;
    const list = projectThreadList(projectItem, target);
    const item = rowListItem(row);
    if (!list) return false;
    insertRowItemByTime(list, item, row, target);
    cachedSessionRowsAt = 0;
    item.dataset.codexProjectMoveTargetKind = "project";
    item.dataset.codexProjectMoveTargetCwd = targetPath(target);
    row.dataset.codexProjectMoveTargetKind = "project";
    row.dataset.codexProjectMoveTargetCwd = targetPath(target);
    setProjectEmptyStateHidden(projectItem, true);
    return true;
  }

  function moveRowToChats(row, target = null) {
    const list = chatsThreadList();
    if (!list) return false;
    const item = rowListItem(row);
    insertRowItemByTime(list, item, row, target);
    cachedSessionRowsAt = 0;
    item.dataset.codexProjectMoveTargetKind = "projectless";
    row.dataset.codexProjectMoveTargetKind = "projectless";
    delete item.dataset.codexProjectMoveTargetCwd;
    delete row.dataset.codexProjectMoveTargetCwd;
    updateProjectMoveEmptyStates();
    return true;
  }

  function applyProjectMoveProjection() {
    if (!codexPlusSettings().projectMove) return;
    const projection = readProjectMoveProjection();
    const targetRowsById = new Map();
    const settledRefs = [];
    const now = Date.now();
    const rows = sessionRows(true);
    rows.forEach((row) => {
      const ref = sessionRefFromRow(row);
      const target = projectionForSessionId(ref.session_id, projection);
      if (target && rowIsUnderTarget(row, target)) {
        const rowId = projectMoveSessionKey(ref.session_id);
        const hadProjectionKind = !!rowProjectionKind(row);
        const existingRow = targetRowsById.get(rowId);
        if (existingRow && existingRow !== row) {
          const existingIsProjection = !!rowProjectionKind(existingRow);
          const currentIsProjection = !!rowProjectionKind(row);
          const rowToRemove = existingIsProjection && !currentIsProjection ? existingRow : row;
          rowListItem(rowToRemove).remove();
          if (rowToRemove === existingRow) targetRowsById.set(rowId, row);
          if (rowToRemove === row) return;
        } else {
          targetRowsById.set(rowId, row);
        }
        if (!hadProjectionKind && typeof target.at === "number" && now - target.at > projectMoveProjectionSettleMs) settledRefs.push(ref);
        const moved = target.targetKind === "projectless" ? moveRowToChats(row, target) : moveRowToProjectList(row, target);
        if (moved) targetRowsById.set(rowId, row);
        const projectItem = closestProjectListItem(row);
        if (projectItem) setProjectEmptyStateHidden(projectItem, true);
      }
    });
    rows.forEach((row) => {
      const ref = sessionRefFromRow(row);
      const rowId = projectMoveSessionKey(ref.session_id);
      const target = projectionForSessionId(ref.session_id, projection);
      if (!target) {
        const item = rowListItem(row);
        delete row.dataset.codexProjectMoveTargetKind;
        delete row.dataset.codexProjectMoveTargetCwd;
        delete item.dataset.codexProjectMoveTargetKind;
        delete item.dataset.codexProjectMoveTargetCwd;
        return;
      }
      if (rowIsUnderTarget(row, target)) return;
      if (targetRowsById.has(rowId)) {
        rowListItem(row).remove();
        return;
      }
      const moved = target.targetKind === "projectless" ? moveRowToChats(row, target) : moveRowToProjectList(row, target);
      if (moved) targetRowsById.set(rowId, row);
    });
    settledRefs.forEach(clearProjectMoveProjection);
    updateProjectMoveEmptyStates();
  }

  function scheduleProjectMoveProjection() {
    if (!codexPlusSettings().projectMove || window.__codexProjectMoveProjectionTimer) return;
    window.__codexProjectMoveProjectionTimer = setTimeout(() => {
      if (window.__codexProjectMoveRuntimeId !== codexProjectMoveRuntimeId) return;
      window.__codexProjectMoveProjectionTimer = null;
      applyProjectMoveProjection();
    }, 80);
  }

  async function refreshRecentConversationsForHost() {
    try {
      const signals = await loadOptionalCodexAppModule("app-server-manager-signals-");
      const sendRequest = Object.values(signals || {}).find((candidate) => {
        if (typeof candidate !== "function") return false;
        try {
          const source = Function.prototype.toString.call(candidate).replace(/\s+/g, "");
          return /^function[$\w]+\(e,t\)\{return[$\w]+\.sendRequest\(e,t\)\}$/.test(source);
        } catch {
          return false;
        }
      });
      if (typeof sendRequest !== "function") return false;
      await sendRequest("refresh-recent-conversations-for-host", { hostId: "local", sortKey: "updated_at" });
      return true;
    } catch (error) {
      window.__codexRecentConversationRefreshFailures = window.__codexRecentConversationRefreshFailures || [];
      window.__codexRecentConversationRefreshFailures.push(String(error?.stack || error));
      return false;
    }
  }

  function refreshAfterProjectMove() {
    const refreshVisibleSidebar = () => {
      applyProjectMoveProjection();
      scheduleChatsSortCorrection(0);
    };
    refreshVisibleSidebar();
    refreshRecentConversationsForHost().finally(() => {
      projectMoveRefreshDelaysMs.forEach((delay) => setTimeout(refreshVisibleSidebar, delay));
    });
  }

  function visibleChatsRows() {
    const list = chatsThreadList();
    if (!list) return [];
    return Array.from(list.children).map(threadRowFromListItem).filter(Boolean).filter((row) => rowIsInChats(row));
  }

  function chatsSortNeedsCorrection(rows) {
    let previousPinned = true;
    let previousSortMs = Infinity;
    let previousKey = "\uffff";
    for (const row of rows) {
      const pinned = rowPinned(row);
      const ref = sessionRefFromRow(row);
      const sortMs = rowSortMs(row, ref);
      const key = projectMoveSessionKey(ref.session_id);
      if (previousPinned && !pinned) {
        previousPinned = false;
        previousSortMs = sortMs;
        previousKey = key;
        continue;
      }
      if (!previousPinned && pinned) return true;
      if (sortMs > previousSortMs || (sortMs === previousSortMs && key > previousKey)) return true;
      previousSortMs = sortMs;
      previousKey = key;
    }
    return false;
  }

  function reorderChatsRows(rows) {
    const list = chatsThreadList();
    if (!list || rows.length < 2) return;
    const rowItems = new Set(rows.map(rowListItem));
    const firstNonThreadItem = Array.from(list.children).find((child) => !rowItems.has(child) && !threadRowFromListItem(child));
    const orderedRows = [...rows].sort((left, right) => {
      const leftPinned = rowPinned(left);
      const rightPinned = rowPinned(right);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      const leftRef = sessionRefFromRow(left);
      const rightRef = sessionRefFromRow(right);
      const leftSortMs = rowSortMs(left, leftRef);
      const rightSortMs = rowSortMs(right, rightRef);
      if (leftSortMs !== rightSortMs) return rightSortMs - leftSortMs;
      return projectMoveSessionKey(rightRef.session_id).localeCompare(projectMoveSessionKey(leftRef.session_id));
    });
    orderedRows.forEach((row) => list.insertBefore(rowListItem(row), firstNonThreadItem || null));
    cachedSessionRowsAt = 0;
  }

  async function applyChatsSortCorrection() {
    if (!codexPlusSettings().projectMove || chatsSortInFlight) return;
    const rows = visibleChatsRows();
    if (rows.length < 2) return;
    const refs = rows.map(sessionRefFromRow).filter((ref) => ref.session_id);
    const signature = refs.map((ref) => projectMoveSessionKey(ref.session_id)).join("|");
    const allRowsHaveSortMs = rows.every((row) => numericTimestamp(row.dataset.codexProjectMoveSortMs || rowListItem(row).dataset.codexProjectMoveSortMs));
    const shouldRefreshSortKeys = signature !== chatsSortSignature || !allRowsHaveSortMs || Date.now() - chatsSortLastFetchAt > chatsSortDbRefreshIntervalMs;
    if (!shouldRefreshSortKeys && !chatsSortNeedsCorrection(rows)) return;
    chatsSortInFlight = true;
    try {
      if (shouldRefreshSortKeys) {
        const result = await postJson("/thread-sort-keys", { sessions: refs }).catch(() => ({ status: "failed", sort_keys: [] }));
        chatsSortLastFetchAt = Date.now();
        const byId = new Map();
        if (result?.status === "ok" && Array.isArray(result?.sort_keys)) {
          result.sort_keys.forEach((item) => {
            const key = projectMoveSessionKey(String(item?.session_id || ""));
            if (key) byId.set(key, item);
          });
        }
        rows.forEach((row) => {
          const ref = sessionRefFromRow(row);
          const payload = byId.get(projectMoveSessionKey(ref.session_id));
          const trustedSortMs = timestampMsFromPayload(payload);
          const sortMs = trustedSortMs || sortMsForSession(ref.session_id, row.dataset.codexProjectMoveSortMs || rowListItem(row).dataset.codexProjectMoveSortMs);
          row.dataset.codexProjectMoveSortMs = String(sortMs || 0);
          rowListItem(row).dataset.codexProjectMoveSortMs = String(sortMs || 0);
          if (trustedSortMs) updateRowTimeLabel(row, trustedSortMs);
        });
      }
      if (chatsSortNeedsCorrection(rows)) reorderChatsRows(rows);
      chatsSortSignature = visibleChatsRows().map((row) => projectMoveSessionKey(sessionRefFromRow(row).session_id)).join("|");
    } finally {
      chatsSortInFlight = false;
    }
  }

  function scheduleChatsSortCorrection(delay = chatsSortRefreshIntervalMs) {
    if (!codexPlusSettings().projectMove || window.__codexProjectMoveChatsSortTimer) return;
    window.__codexProjectMoveChatsSortTimer = setTimeout(() => {
      if (window.__codexProjectMoveRuntimeId !== codexProjectMoveRuntimeId) return;
      window.__codexProjectMoveChatsSortTimer = null;
      applyChatsSortCorrection().catch((error) => {
        window.__codexProjectMoveSortFailures = window.__codexProjectMoveSortFailures || [];
        window.__codexProjectMoveSortFailures.push(String(error?.stack || error));
      }).finally(() => {
        if (codexPlusSettings().projectMove) scheduleChatsSortCorrection();
      });
    }, delay);
  }

  async function setProjectlessThreadIds(ref, mode) {
    const variants = threadIdVariants(ref.session_id);
    if (variants.length === 0) throw new Error("未找到会话 ID");
    const existingIds = await getCodexGlobalState("projectless-thread-ids").catch(() => []);
    const ids = Array.isArray(existingIds) ? existingIds : [];
    const variantSet = new Set(variants);
    const nextIds = mode === "add" ? uniqueValues([...ids, ...variants]) : ids.filter((id) => !variantSet.has(id));
    if (nextIds.length !== ids.length || nextIds.some((id, index) => id !== ids[index])) await setCodexGlobalState("projectless-thread-ids", nextIds);
  }

  async function clearThreadWorkspaceHints(ref) {
    const variants = threadIdVariants(ref.session_id);
    if (variants.length === 0) return;
    const hints = objectGlobalState(await getCodexGlobalState("thread-workspace-root-hints").catch(() => ({})));
    const hintKeys = variants.filter((id) => Object.prototype.hasOwnProperty.call(hints, id));
    if (hintKeys.length > 0) {
      hintKeys.forEach((id) => delete hints[id]);
      await setCodexGlobalState("thread-workspace-root-hints", hints);
    }
  }

  async function clearThreadWritableRoots(ref) {
    const variants = threadIdVariants(ref.session_id);
    if (variants.length === 0) return;
    const roots = objectGlobalState(await getCodexGlobalState("thread-writable-roots").catch(() => ({})));
    const rootKeys = variants.filter((id) => Object.prototype.hasOwnProperty.call(roots, id));
    if (rootKeys.length > 0) {
      rootKeys.forEach((id) => delete roots[id]);
      await setCodexGlobalState("thread-writable-roots", roots);
    }
  }

  async function clearThreadProjectlessOutputDirectories(ref) {
    const variants = threadIdVariants(ref.session_id);
    if (variants.length === 0) return;
    const dirs = objectGlobalState(await getCodexGlobalState("thread-projectless-output-directories").catch(() => ({})));
    const dirKeys = variants.filter((id) => Object.prototype.hasOwnProperty.call(dirs, id));
    if (dirKeys.length > 0) {
      dirKeys.forEach((id) => delete dirs[id]);
      await setCodexGlobalState("thread-projectless-output-directories", dirs);
    }
  }

  async function moveSessionToProjectless(ref) {
    if (!ref.session_id) throw new Error("未找到会话 ID");
    await setProjectlessThreadIds(ref, "add");
    await clearThreadWorkspaceHints(ref);
    await clearThreadWritableRoots(ref);
    await clearThreadProjectlessOutputDirectories(ref);
    const sortKey = await postJson("/thread-sort-key", ref).catch(() => ({}));
    return { status: "moved", session_id: ref.session_id, updated_at: sortKey?.updated_at, updated_at_ms: sortKey?.updated_at_ms, created_at_ms: sortKey?.created_at_ms };
  }

  function isNativeProjectTarget(target) {
    return target?.kind === "project" && nativeProjectTargets().some((project) => sameWorkspacePath(project.path, target.path));
  }

  async function moveSessionToProject(ref, target) {
    if (!ref.session_id) throw new Error("未找到会话 ID");
    if (!target?.path) throw new Error("目标项目路径为空");
    if (!isNativeProjectTarget(target)) throw new Error("目标项目不在 Codex 项目列表中");
    const result = await postJson("/move-thread-workspace", { ...ref, target_cwd: target.path });
    if (result.status !== "moved") throw new Error(result.message || "移动项目失败");
    await setProjectlessThreadIds(ref, "remove");
    await clearThreadWorkspaceHints(ref);
    return result;
  }
  /**
   * 同一时间最多显示几条 toast。
   *
   * 原来是「新 toast 顶掉旧 toast」的单例语义。拓展也能弹 toast 之后，单例会让
   * 第三方提示把「删除成功（可撤销）」这类关键反馈挤掉，所以改成有界队列：超出
   * 上限时挤掉最旧的一条，而不是最关键的当前一条。
   */
  const codexPlusToastLimit = 3;
  const codexPlusToastLifetimeMs = 10000;
  const codexPlusToastGapPx = 48;

  /**
   * 按当前 DOM 顺序重排所有提示的纵向位置。
   *
   * 必须在每次「新增」和「移除」之后都调用：位置只在插入那一刻算的话，一旦有
   * 人被挤掉或超时消失，剩下几条会停在自己的旧层号上，出现空档和重叠。
   */
  function layoutCodexPlusToasts() {
    document.querySelectorAll(".codex-delete-toast").forEach((node, index) => {
      node.style.bottom = `${18 + index * codexPlusToastGapPx}px`;
    });
  }

  /** 移除一条提示并立刻重排剩下的。 */
  function dismissCodexPlusToast(toast) {
    toast.remove();
    layoutCodexPlusToasts();
  }

  /**
   * 显示一条提示。
   *
   * `options.type` 取 info / success / warn / error，对应 styles 里的四条配色；
   * 不传则保持原先的默认外观。`options.undoToken` 会追加「撤销」按钮——这是
   * 内部删除流程用的，拓展一般用不到。
   */
  function showToast(message, options = {}) {
    // 兼容旧调用点：老签名是 showToast(message, undoToken)。第二个参数传字符串
    // 时按 undoToken 处理，传对象时按新签名处理。
    const settings = typeof options === "string" ? { undoToken: options } : (options || {});
    const undoToken = settings.undoToken;
    const type = typeof settings.type === "string" ? settings.type : "";
    const live = document.querySelectorAll(".codex-delete-toast");
    // 队列满时挤掉最旧的（DOM 顺序即插入顺序）。用 dismiss 而不是裸 remove，
    // 它会顺带重排剩下几条的位置。
    if (live.length >= codexPlusToastLimit) {
      for (let index = 0; index <= live.length - codexPlusToastLimit; index += 1) {
        dismissCodexPlusToast(live[index]);
      }
    }
    const toast = document.createElement("div");
    toast.className = "codex-delete-toast";
    if (type) toast.dataset.toastType = type;
    toast.textContent = message;
    if (undoToken) {
      const undo = document.createElement("button");
      undo.textContent = "撤销";
      undo.addEventListener("click", async () => {
        const result = await postJson("/undo", { undo_token: undoToken });
        toast.textContent = result.message || "撤销完成";
        if (result.status === "undone") {
          const refreshed = await refreshRecentConversationsForHost();
          if (!refreshed) window.location.reload();
        }
        setTimeout(() => dismissCodexPlusToast(toast), 5000);
      });
      toast.appendChild(undo);
    }
    document.body.appendChild(toast);
    // append 之后统一重排：此时这条才进入 DOM，索引才是它真实的层号。
    layoutCodexPlusToasts();
    setTimeout(() => dismissCodexPlusToast(toast), codexPlusToastLifetimeMs);
    return () => dismissCodexPlusToast(toast);
  }

  function shareBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function shareTextFromElement(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll?.("button, textarea, input, select, [contenteditable='true'], .codex-delete-toast, .codex-plus-modal-overlay, .codex-plus-page-overlay, .codex-session-share-button").forEach((node) => node.remove());
    return String(clone.innerText || clone.textContent || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function sessionShareMarkdown() {
    const ref = currentSessionRef();
    if (!ref.session_id) return { ref, markdown: "" };
    const root = conversationRoot();
    if (!root) return { ref, markdown: "" };
    const authored = Array.from(root.querySelectorAll("[data-message-author-role]"));
    const knownTurns = Array.from(root.querySelectorAll([
      '[data-testid="conversation-turn"]',
      '[data-testid*="message"]',
      '[data-message-content]',
      'main .prose',
      '[class*="message-bubble"]',
      '[class*="MessageBubble"]',
      '[class*="user-message"]',
      '[class*="UserMessage"]',
    ].join(",")));
    const turns = authored.length ? authored : knownTurns;
    const seen = new Set();
    const messages = turns.map((node) => {
      if (!(node instanceof HTMLElement) || seen.has(node)) return "";
      if (node.parentElement?.closest?.('[data-message-author-role], [data-testid="conversation-turn"]')) return "";
      seen.add(node);
      const text = shareTextFromElement(node);
      if (!text) return "";
      const role = String(node.getAttribute("data-message-author-role") || "").toLowerCase();
      const label = role === "user" ? "用户" : role === "assistant" ? "助手" : "消息";
      return { role: role === "user" || role === "assistant" ? role : "message", label, text };
    }).filter(Boolean);
    const title = String(ref.title || document.querySelector(selectors.threadTitle)?.textContent || "未命名会话").replace(/\s+/g, " ").trim();
    let content = messages.map((message) => `### ${message.label}\n\n${message.text}`).join("\n\n");
    if (!content) {
      const fallback = root.cloneNode(true);
      fallback.querySelectorAll?.([
        ".composer-footer", ".composer-surface-chrome", "form", "header", "nav", "aside",
        "button", "textarea", "input", "select", "[contenteditable='true']",
        ".codex-delete-toast", ".codex-plus-modal-overlay", ".codex-plus-page-overlay",
        ".codex-session-share-button",
      ].join(",")).forEach((node) => node.remove());
      content = String(fallback.innerText || fallback.textContent || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (content) messages.push({ role: "message", label: "会话", text: content });
    }
    const markdown = `# ${title || "未命名会话"}\n\n- 会话 ID：\`${ref.session_id}\`\n\n${content}`.slice(0, codexPlusShareMaxCharacters);
    return {
      ref,
      markdown: content ? markdown : "",
      session: content ? {
        version: 1,
        kind: "codex-session",
        session_id: ref.session_id,
        title: title || "未命名会话",
        messages: messages.map(({ role, text }) => ({ role, text })),
      } : null,
    };
  }

  async function encryptSessionShare(value) {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
    const exportedKey = await crypto.subtle.exportKey("raw", key);
    return {
      key: shareBase64Url(new Uint8Array(exportedKey)),
      encrypted: {
        v: 1,
        iv: shareBase64Url(iv),
        ciphertext: shareBase64Url(new Uint8Array(ciphertext)),
      },
    };
  }

  async function createSessionShare() {
    const { ref, markdown, session } = sessionShareMarkdown();
    if (!ref.session_id) {
      showToast("当前页面还没有可分享的会话", null);
      return;
    }
    if (!markdown || !session) {
      showToast("当前会话还没有可分享的消息", null);
      return;
    }
    const shareWindow = window.open("about:blank", "_blank");
    const button = document.querySelector(`.${sessionShareButtonClass}`);
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "正在创建…";
    }
    try {
      let shareDocument = session;
      const nativeSession = await postJson("/session/export", {
        session_id: ref.session_id,
        title: session.title,
      });
      if (nativeSession?.status !== "ok" || nativeSession.kind !== "codex-rollout" || typeof nativeSession.content !== "string") {
        throw new Error(nativeSession?.message || "无法读取完整 Codex 会话文件");
      }
      shareDocument = { ...nativeSession, title: session.title };
      const encrypted = await encryptSessionShare(JSON.stringify(shareDocument));
      const payload = { ttl: 604800, encrypted: encrypted.encrypted };
      let result;
      let baseUrl = codexPlusShareBaseUrl;
      try {
        result = await postJson("/share/create", payload);
        if (result?.id) {
          baseUrl = codexPlusShareBaseUrl;
        } else if (result?.status !== "failed") {
          throw new Error(result?.message || "创建分享失败");
        }
      } catch (_) {
        result = null;
      }
      if (!result?.id) {
        let response;
        try {
          response = await fetch(`${baseUrl}/api/shares`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        } catch (_) {
          baseUrl = codexPlusShareFallbackBaseUrl;
          response = await fetch(`${baseUrl}/api/shares`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        }
        result = await response.json().catch(() => ({}));
        if (!response.ok || !result.id) throw new Error(result.error || `创建分享失败（HTTP ${response.status}）`);
      }
      const shareUrl = `${baseUrl}/?s=${encodeURIComponent(result.id)}#k=${encrypted.key}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch (_) {
        const input = document.createElement("input");
        input.value = shareUrl;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      showToast("会话分享链接已复制", null);
      if (shareWindow && !shareWindow.closed) shareWindow.location.href = shareUrl;
    } catch (error) {
      if (shareWindow && !shareWindow.closed) shareWindow.close();
      showToast(error?.message || "创建分享失败，请稍后重试", null);
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = "分享会话";
      }
    }
  }

  function removeSessionShareButtons() {
    document.querySelectorAll(`.${sessionShareButtonClass}`).forEach((button) => button.remove());
  }

  function sessionImportMarkdown(session) {
    const title = String(session?.title || "未命名会话").trim() || "未命名会话";
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const body = messages.map((message) => {
      const role = message?.role === "user" ? "用户" : message?.role === "assistant" ? "助手" : "消息";
      const text = String(message?.text || "").trim();
      return text ? `### ${role}\n\n${text}` : "";
    }).filter(Boolean).join("\n\n");
    return `# ${title}\n\n${body}`.trim();
  }

  function importSharedSessionIntoNewChat(session) {
    if (session?.kind === "codex-rollout" && typeof session.content === "string") {
      void postJson("/session/import", session).then((result) => {
        if (result?.status !== "ok") {
          showToast(result?.message || "原生会话导入失败", null);
          return;
        }
        void refreshRecentConversationsForHost();
        showToast("已导入完整 Codex 会话", null);
      }).catch((error) => showToast(error?.message || "原生会话导入失败", null));
      return;
    }
    const markdown = sessionImportMarkdown(session);
    if (!markdown) {
      showToast("分享内容为空，无法导入", null);
      return;
    }
    const newChat = Array.from(document.querySelectorAll("button")).find((button) => {
      if (!visibleElement(button) || isExtensionUiNode(button)) return false;
      const text = String(button.textContent || "").replace(/\s+/g, " ").trim();
      const label = button.getAttribute("aria-label") || "";
      return /^(新对话|New chat)$/i.test(text) || /^(新对话|New chat)$/i.test(label);
    });
    if (newChat instanceof HTMLElement) newChat.click();
    const deadline = Date.now() + 5000;
    const fill = () => {
      const editor = Array.from(document.querySelectorAll("textarea, [contenteditable='true']"))
        .filter((node) => visibleElement(node))
        .at(-1);
      if (!(editor instanceof HTMLElement)) {
        if (Date.now() < deadline) window.setTimeout(fill, 100);
        else showToast("无法找到 Codex 输入框，请手动打开新对话后重试", null);
        return;
      }
      editor.focus();
      if (editor instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(editor, markdown);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        document.execCommand("insertText", false, markdown);
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: markdown }));
      }
      showToast("已导入完整会话内容，请发送以继续", null);
    };
    window.setTimeout(fill, newChat ? 350 : 0);
  }

  function installSessionShareImportListener() {
    window.removeEventListener("message", window.__codexSessionShareImportHandler);
    window.__codexSessionShareImportHandler = (event) => {
      if (!/^(https:\/\/share\.codexpp\.cc|https:\/\/codexpp-share\.pages\.dev)$/.test(event.origin || "") || event.data?.type !== "codexpp-import-session") return;
      const session = event.data?.session;
      if (!session || !["codex-session", "codex-rollout"].includes(session.kind)) return;
      if (session.kind === "codex-session" && !Array.isArray(session.messages)) return;
      if (session.kind === "codex-rollout" && typeof session.content !== "string") return;
      importSharedSessionIntoNewChat(session);
    };
    window.addEventListener("message", window.__codexSessionShareImportHandler);
  }

  function visibleElement(node) {
    if (!(node instanceof Element)) return false;
    const rect = node.getBoundingClientRect?.();
    return !!rect && rect.width > 0 && rect.height > 0;
  }

  function normalizedElementText(node) {
    return (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function confirmDelete(title, hostId = "local") {
    document.querySelectorAll(".codex-delete-confirm-overlay").forEach((node) => node.remove());
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "codex-delete-confirm-overlay";
      overlay.innerHTML = `
        <div class="codex-delete-confirm-content" role="dialog" aria-modal="true" aria-label="删除会话">
          <div class="codex-delete-confirm-title">删除会话</div>
          <div class="codex-delete-confirm-message">删除“${escapeHtml(title)}”？${hostId !== "local" ? "这将永久删除远端任务及其子任务，无法撤销。" : ""}</div>
          <div class="codex-delete-confirm-actions">
            <button type="button" data-codex-delete-cancel="true">取消</button>
            <button type="button" data-codex-delete-confirm="true">删除</button>
          </div>
        </div>
      `;
      const finish = (value, event) => {
        event?.preventDefault();
        event?.stopPropagation();
        event?.target?.blur?.();
        overlay.remove();
        resolve(value);
      };
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest("[data-codex-delete-cancel]")) {
          finish(false, event);
          return;
        }
        if (event.target.closest("[data-codex-delete-confirm]")) {
          finish(true, event);
        }
      }, true);
      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") finish(false, event);
      }, true);
      document.body.appendChild(overlay);
      overlay.querySelector("[data-codex-delete-cancel]")?.focus();
    });
  }

  function rowHref(row) {
    return row.getAttribute("href") || row.querySelector("a")?.getAttribute("href") || "";
  }

  function isCurrentSessionRow(row, ref) {
    if (row.getAttribute("aria-current") === "page" || row.getAttribute("aria-current") === "true") return true;
    const href = rowHref(row);
    if (href) {
      try {
        const url = new URL(href, window.location.href);
        if (url.href === window.location.href || url.pathname === window.location.pathname) return true;
      } catch {
        if (window.location.href.includes(href)) return true;
      }
    }
    return !!ref.session_id && window.location.href.includes(ref.session_id);
  }

  function releaseDeleteFocus(row, button) {
    button.blur();
    if (row.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  function removeDeletedRow(row, button, ref) {
    releaseDeleteFocus(row, button);
    const shouldReload = isCurrentSessionRow(row, ref);
    row.remove();
    if (shouldReload) {
      setTimeout(() => window.location.reload(), 10000);
    }
  }

  function updateDeleteButtonOffsets() {
    sessionRows().forEach((row) => {
      const hasArchiveConfirm = Array.from(row.querySelectorAll("button")).some((button) => {
        const rect = button.getBoundingClientRect();
        const label = button.getAttribute("aria-label") || "";
        const text = (button.textContent || "").trim();
        if (button.classList.contains(buttonClass) || button.classList.contains(exportButtonClass) || label === "归档对话" || label === "置顶对话") return false;
        return text === "确认" || (text.length > 0 && rect.width > 0 && rect.width <= 36 && rect.x > row.getBoundingClientRect().right - 50);
      });
      row.classList.toggle("codex-archive-confirm-visible", hasArchiveConfirm);
    });
  }

  function openDeleteConfirmForRow(row, button, ref, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    releaseDeleteFocus(row, button);
    if (!ref.host_id) {
      showToast("无法确定会话主机归属，请使用 Codex 原生会话管理", null);
      return;
    }
    confirmDelete(ref.title, ref.host_id).then(async (confirmed) => {
      if (!confirmed) return;
      releaseDeleteFocus(row, button);
      const result = await postJson("/delete", ref);
      if (result.status === "server_deleted" || result.status === "local_deleted") {
        // 远端由原生同主机 thread/deleted 通知更新，不能移除可能已重用的本地 DOM。
        if (ref.host_id === "local") {
          removeDeletedRow(row, button, ref);
          if (!await refreshRecentConversationsForHost()) window.location.reload();
        }
        showToast(result.message || "删除成功", result.undo_token);
      } else {
        showToast(result.message || "删除失败", null);
      }
    });
  }

  async function exportMarkdown(ref) {
    const result = await postJson("/export-markdown", ref);
    if (result.status === "exported" && result.filename && typeof result.markdown === "string") {
      const saveResult = await saveMarkdown(result.filename, result.markdown);
      if (saveResult?.status === "cancelled") {
        showToast(saveResult.message || "导出已取消", null);
      } else {
        showToast(result.message || "导出成功", null);
      }
      return;
    }
    showToast(result.message || "导出失败", null);
  }

  function sortStateFromMoveResult(result, ref, row) {
    const trustedSortMs = timestampMsFromPayload(result);
    return { sortMs: trustedSortMs || rowSortMs(row, ref), sortMsTrusted: !!trustedSortMs };
  }

  function finishProjectMove(row, button, ref, target, message) {
    releaseDeleteFocus(row, button);
    button.disabled = false;
    button.textContent = "移动";
    saveProjectMoveProjection(ref, target, target.sortMs || rowSortMs(row, ref, target));
    if (target.kind === "projectless") moveRowToChats(row, target);
    refreshAfterProjectMove();
    showToast(message, null);
  }

  async function applyProjectMove(row, button, ref, target) {
    button.disabled = true;
    button.textContent = "移动中";
    try {
      if (target.kind === "projectless") {
        const result = await moveSessionToProjectless(ref);
        finishProjectMove(row, button, ref, { ...target, ...sortStateFromMoveResult(result, ref, row) }, `已移动到普通对话：“${ref.title || ref.session_id}”`);
      } else {
        const result = await moveSessionToProject(ref, target);
        finishProjectMove(row, button, ref, { ...target, ...sortStateFromMoveResult(result, ref, row) }, `已移动到“${target.label}”：“${ref.title || ref.session_id}”`);
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = "移动";
      showToast(`移动失败：${error?.message || error}`, null);
    }
  }

  async function openProjectMoveMenuForRow(row, button, ref, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    releaseDeleteFocus(row, button);
    document.querySelectorAll(`.${projectMoveOverlayClass}`).forEach((node) => node.remove());
    const overlay = document.createElement("div");
    overlay.className = projectMoveOverlayClass;
    overlay.innerHTML = `
      <div class="codex-project-move-panel" role="dialog" aria-modal="true" aria-label="移动对话">
        <div class="codex-project-move-header">
          <div class="codex-project-move-title">移动“${escapeHtml(ref.title || ref.session_id)}”</div>
        </div>
        <div class="codex-project-move-list"><div class="codex-project-move-empty">加载项目中...</div></div>
      </div>
    `;
    const panel = overlay.querySelector(".codex-project-move-panel");
    const rect = button.getBoundingClientRect();
    const panelWidth = Math.min(360, Math.max(240, window.innerWidth - 32));
    panel.style.left = `${Math.max(16, Math.min(window.innerWidth - panelWidth - 16, rect.right - panelWidth))}px`;
    panel.style.top = `${Math.max(16, Math.min(window.innerHeight - 120, rect.bottom + 6))}px`;
    const close = () => overlay.remove();
    overlay.addEventListener("click", (clickEvent) => {
      if (clickEvent.target === overlay) close();
    }, true);
    overlay.addEventListener("keydown", (keyEvent) => {
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        close();
      }
    }, true);
    document.body.appendChild(overlay);
    try {
      const targets = projectMoveTargets();
      const list = overlay.querySelector(".codex-project-move-list");
      if (!list) return;
      list.innerHTML = "";
      if (targets.length === 0) {
        list.innerHTML = `<div class="codex-project-move-empty">没有可用目标</div>`;
        return;
      }
      for (const target of targets) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "codex-project-move-item";
        item.innerHTML = `
          <div class="codex-project-move-item-title">${escapeHtml(target.label)}</div>
          <div class="codex-project-move-item-path">${escapeHtml(target.description)}</div>
        `;
        item.addEventListener("click", async (selectEvent) => {
          selectEvent.preventDefault();
          selectEvent.stopPropagation();
          close();
          await applyProjectMove(row, button, ref, target);
        }, true);
        list.appendChild(item);
      }
      list.querySelector("button")?.focus();
    } catch (error) {
      close();
      showToast(`加载项目失败：${error?.message || error}`, null);
    }
  }
  function installDeleteButtonEventDelegation() {
    document.removeEventListener("click", window.__codexSessionDeleteDocumentDeleteHandler, true);
    const handler = (event) => {
      const button = event.target?.closest?.(`.${buttonClass}`);
      const row = button?.closest?.("[data-app-action-sidebar-thread-id]");
      if (!button || !row) return;
      const ref = sessionRefFromRow(row);
      if (!ref.session_id) {
        const placeholderId = row.getAttribute("data-app-action-sidebar-thread-id");
        if (isClientNewThreadId(placeholderId)) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          showToast("会话仍在同步，请稍后重试", null);
        }
        return;
      }
      openDeleteConfirmForRow(row, button, ref, event);
    };
    window.__codexSessionDeleteDocumentDeleteHandler = handler;
    document.addEventListener("click", handler, true);
  }

  function actionGroupFromRow(row) {
    return row.querySelector(`.${actionGroupClass}`);
  }

  function nativeActionButtonsFromRow(row) {
    return [...row.querySelectorAll('button,[role="button"],a')]
      .filter((node) => !node.closest(`.${actionGroupClass}`))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width < 12 || rect.height < 12) return false;
        const label = [
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
          node.dataset?.state,
          node.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (/(pin|archive|置顶|归档)/i.test(label)) return true;
        const rowRect = row.getBoundingClientRect();
        return rect.left > rowRect.left + rowRect.width * 0.68;
      });
  }

  function syncActionGroupLayout(row, group) {
    if (!row || !group) return;
    if (group.dataset.codexActionLayoutStable === "true") return;
    const rowRect = row.getBoundingClientRect();
    const nativeButtons = nativeActionButtonsFromRow(row);
    const leftmostNative = nativeButtons
      .map((button) => button.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => a.left - b.left)[0];
    const gap = 8;
    const fallbackRight = 28;
    const right = leftmostNative
      ? Math.max(fallbackRight, Math.round(rowRect.right - leftmostNative.left + gap))
      : fallbackRight;
    const groupWidth = Math.ceil(group.getBoundingClientRect().width || 96);
    const titleNode = row.querySelector(selectors.threadTitle);
    const titleRect = titleNode?.getBoundingClientRect();
    const titleLeft = titleRect?.left || rowRect.left + 40;
    let effectiveRight = right;
    group.style.setProperty("--codex-session-actions-right", `${effectiveRight}px`);
    if (leftmostNative) {
      const nativeStyle = getComputedStyle(nativeButtons.find((button) => button.getBoundingClientRect().left === leftmostNative.left) || nativeButtons[0]);
      group.style.setProperty("--codex-session-action-color", nativeStyle.color);
      group.style.setProperty("--codex-session-action-hover-color", nativeStyle.color);
      group.style.setProperty("--codex-session-action-hover-background", nativeStyle.backgroundColor);
      const groupRight = group.getBoundingClientRect().right;
      const targetRight = leftmostNative.left - 2;
      if (Number.isFinite(groupRight) && Number.isFinite(targetRight)) {
        const renderScale = row.offsetWidth > 0 ? rowRect.width / row.offsetWidth : 1;
        effectiveRight = Math.max(0, right + (groupRight - targetRight) / Math.max(0.1, renderScale));
        group.style.setProperty("--codex-session-actions-right", `${effectiveRight}px`);
      }
    }
    const renderScale = row.offsetWidth > 0 ? rowRect.width / row.offsetWidth : 1;
    const finalGroupLeft = group.getBoundingClientRect().left;
    const titleMaxWidth = Math.max(24, (finalGroupLeft - titleLeft - 8) / Math.max(0.1, renderScale));
    row.style.setProperty("--codex-session-title-mask", `${effectiveRight + groupWidth + 12}px`);
    row.style.setProperty("--codex-session-title-max-width", `${titleMaxWidth}px`);
    group.dataset.codexActionLayoutStable = "true";
  }
