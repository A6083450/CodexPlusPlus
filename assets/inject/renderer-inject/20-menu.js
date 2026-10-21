  function renderCodexPlusMenu() {
    const settings = codexPlusSettings();
    document.querySelectorAll(".codex-plus-toggle[data-codex-plus-setting]").forEach((button) => {
      const key = button.getAttribute("data-codex-plus-setting");
      const waitsForBackend = codexPlusBackendMappedSettings.has(key) && !codexPlusBackendSettingsLoaded;
      button.dataset.enabled = String(!!settings[key]);
      button.setAttribute("aria-checked", button.dataset.enabled);
      button.dataset.pending = String(waitsForBackend);
      button.disabled = waitsForBackend || button.dataset.relayUnneeded === "true";
    });
    refreshConversationViewControls();
    document.querySelectorAll("[data-codex-plus-typing-effect]").forEach((select) => {
      select.value = ["rainbow", "fireworks", "stars"].includes(settings.typingEffect) ? settings.typingEffect : "off";
      select.disabled = !codexPlusBackendSettingsLoaded || codexPlusBackendSettings.enhancementsEnabled === false;
      if (typeof syncCodexPlusTypingEffectDropdown === "function") syncCodexPlusTypingEffectDropdown(select);
    });
  }

  let codexPlusBackendSettings = { providerSyncEnabled: false, enhancementsEnabled: true, codexAppVersion: "" };
  let codexPlusBackendSettingsSeq = 0;
  const codexPluginLegacyEntryUnlockBeforeVersion = "26.601.2237";
  const codexPluginBridgeRequestUnlockFromVersion = "26.616.0";
  const codexPluginBroadCatalogKindsFromVersion = "26.803.0";

  function parseCodexVersionParts(version) {
    const raw = String(version || "").trim();
    if (!raw) return null;
    const match = raw.match(/\d+(?:\.\d+)*/);
    if (!match) return null;
    const parts = match[0].split(".").map((part) => Number(part));
    if (!parts.length || parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
    return parts;
  }

  function compareCodexVersions(left, right) {
    const leftParts = parseCodexVersionParts(left);
    const rightParts = parseCodexVersionParts(right);
    if (!leftParts || !rightParts) return null;
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const leftPart = leftParts[index] || 0;
      const rightPart = rightParts[index] || 0;
      if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
    }
    return 0;
  }

  function codexPluginUnlockStrategy() {
    const version = String(codexPlusBackendSettings.codexAppVersion || "").trim();
    const comparison = compareCodexVersions(version, codexPluginLegacyEntryUnlockBeforeVersion);
    if (comparison == null) return "unknown";
    return comparison < 0 ? "legacy" : "modern";
  }

  function logCodexPluginUnlockStrategy(strategy) {
    const codexAppVersion = String(codexPlusBackendSettings.codexAppVersion || "").trim();
    const signature = `${strategy}:${codexAppVersion || "unknown"}`;
    if (window.__codexPluginUnlockStrategyLogged === signature) return;
    window.__codexPluginUnlockStrategyLogged = signature;
    sendCodexPlusDiagnostic("plugin_unlock_strategy_selected", {
      strategy,
      codexAppVersion,
      cutoff: codexPluginLegacyEntryUnlockBeforeVersion,
    });
  }

  function codexPluginMarketplaceRequestPatchStrategy() {
    const pluginStrategy = codexPluginUnlockStrategy();
    if (pluginStrategy === "legacy") return "none";
    const version = String(codexPlusBackendSettings.codexAppVersion || "").trim();
    const comparison = compareCodexVersions(version, codexPluginBridgeRequestUnlockFromVersion);
    if (comparison == null) return "unknown";
    return comparison >= 0 ? "bridge" : "client";
  }

  function codexPluginUsesBroadCatalogKinds() {
    const version = String(codexPlusBackendSettings.codexAppVersion || "").trim();
    const comparison = compareCodexVersions(version, codexPluginBroadCatalogKindsFromVersion);
    return comparison != null && comparison >= 0;
  }

  let codexPlusBackendSettingsLoaded = false;
  const codexServiceTierModulePromises = new Map();
  // namePart -> { at, attempts, error }，见 loadCodexAppModule 里的说明。
  // 挂在 window 上跨重注入保留：否则每次重注入都会清空失败记录，重新全量 fetch asset
  // （issue #2330 / #2169：桥接看门狗重注入后 asset rescan 被重新跑满）。
  const codexAppModuleFailures = window.__codexPlusAppModuleFailures || (window.__codexPlusAppModuleFailures = new Map());
  // namePart -> { at, url }：codexAppAssetUrlFromScriptText 的查找结果，未命中也缓存，
  // 同样跨重注入保留（有调用方会绕过 asset loader 直接调它）。
  const codexAppAssetUrlLookups = window.__codexPlusAssetUrlLookups || (window.__codexPlusAssetUrlLookups = new Map());
  const codexAppModuleRetryCooldownMs = 30000;
  const codexAppModuleMaxAttempts = 8;
  const codexServiceTierSupportedFastModels = new Set(["gpt-5.4", "gpt-5.5"]);
  // 这里只放确认支持 priority service tier 的官方模型——这个集合同时用于生成
  // 「Fast 仅支持 …」的提示文案，塞进没验证过的模型等于对用户做出错误承诺。
  // 第三方模型（deepseek 等）走下面 codexServiceTierFastSupportedForModel 里的
  // 模型元数据判定：上游自己声明了 priority 才认。
  ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"].forEach((model) => codexServiceTierSupportedFastModels.add(model));

  function uniqueCodexAppAssetUrls(urls) {
    return Array.from(new Set((urls || []).filter((url) => typeof url === "string" && url.includes("/assets/") && url.split("?")[0].endsWith(".js"))));
  }

  function codexAppAssetCandidateUrls() {
    return uniqueCodexAppAssetUrls([
      // Fast 的 import map 让实际加载记录指向 Blob；定位原生类仍需要原资产 URL。
      window.__codexPlusNativeFastCompiled === "v1" ? window.__codexPlusNativeFastModuleDiagnostics?.url : null,
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ]);
  }

  function codexAppAssetUrl(namePart) {
    if (!namePart) return "";
    return codexAppAssetCandidateUrls().find((url) => url.includes(namePart)) || "";
  }

  function codexServiceTierDispatcherAssetUrls() {
    return codexAppAssetCandidateUrls();
  }

  async function codexAppAssetUrlFromScriptText(namePart) {
    if (!namePart) return "";
    // 有调用方会绕过 asset loader 直接调这里，
    // 没有缓存时每次注入都要把全部 app asset fetch 一遍（issue #2330）。
    // 未命中同样缓存：冷却期内不重复扫描。
    const cached = codexAppAssetUrlLookups.get(namePart);
    if (cached && (cached.url || Date.now() - cached.at < codexAppModuleRetryCooldownMs)) {
      return cached.url;
    }
    const url = await scanCodexAppAssetUrlFromScriptText(namePart);
    codexAppAssetUrlLookups.set(namePart, { at: Date.now(), url });
    return url;
  }

  async function scanCodexAppAssetUrlFromScriptText(namePart) {
    const scripts = codexAppAssetCandidateUrls();
    const escaped = String(namePart).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`["'](\\./(?:assets/)?${escaped}[^"']+\\.js)["']`),
      new RegExp(`["'](\\.?/assets/${escaped}[^"']+\\.js)["']`),
      new RegExp(`["']([^"']*/assets/${escaped}[^"']+\\.js)["']`),
    ];
    for (const src of scripts) {
      try {
        const text = await fetch(src).then((response) => response.ok ? response.text() : "");
        if (!text) continue;
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (!match) continue;
          return new URL(match[1], src).href;
        }
      } catch {
      }
    }
    return "";
  }

  // issue #1960：失败必须被记住。之前失败只是把 promise 从 map 里删掉，
  // 于是任何调用方下一次重试都会重新走 codexAppAssetUrlFromScriptText()，
  // 把全部 app asset（实测 121 个）重新 fetch 一遍再跑三条正则。
  // 这个 loader 有四个调用方，其中 installCodexServiceTierDispatcherPatch()
  // 挂在 scanLightweight() 里、每轮 scan 都试三个前缀，Codex 侧改名后就成了永不停止的重扫：
  // 实测空闲时 301 次请求/秒，主线程 TaskOtherDuration 占满一半 CPU，JS 堆每秒涨约 1MB，
  // Sentry 又给每个请求记一条 breadcrumb 并回同步一次 scope，把量再翻一倍推给 browser 进程。
  // 记住失败 + 冷却重试，让下游即便还在轮询也只会周期性地试一次。
  // 「这个 asset 找不到」是可预期的、会随 Codex 版本变化的情形，
  // 不是异常。用结构化标记而不是靠 message 字符串比对来区分：字符串比对让
  // loadOptionalCodexAppModule 的「可选」语义只对精确复刻了那段 message 的调用方生效，
  // 任何一个自己抛错或包了一层的调用方都会漏判，把可选依赖的缺失当成硬失败中断整条流程
  // （issue #1316 的「未找到 Codex App asset: vscode-api-」就是这么冒到用户面前的）。
  function codexAppAssetMissingError(namePart) {
    const error = new Error(`未找到 Codex App asset: ${namePart}`);
    error.code = "CODEX_PLUS_ASSET_MISSING";
    error.assetNamePart = namePart;
    return error;
  }

  function isCodexAppAssetMissingError(error) {
    return !!error && (error.code === "CODEX_PLUS_ASSET_MISSING" || error.name === "CodexPlusAssetMissingError");
  }

  async function loadCodexAppModule(namePart) {
    if (!codexServiceTierModulePromises.has(namePart)) {
      const failure = codexAppModuleFailures.get(namePart);
      if (failure
          && (failure.attempts >= codexAppModuleMaxAttempts
            || Date.now() - failure.at < codexAppModuleRetryCooldownMs)) {
        throw failure.error;
      }
      const promise = Promise.resolve().then(async () => {
        const url = codexAppAssetUrl(namePart) || await codexAppAssetUrlFromScriptText(namePart);
        if (!url) throw codexAppAssetMissingError(namePart);
        return await import(url);
      }).then((module) => {
        // Codex 更新后 asset 可能又出现，成功时把失败记录清掉，冷却计数重新开始。
        codexAppModuleFailures.delete(namePart);
        return module;
      }).catch((error) => {
        codexServiceTierModulePromises.delete(namePart);
        codexAppModuleFailures.set(namePart, {
          at: Date.now(),
          attempts: (codexAppModuleFailures.get(namePart)?.attempts || 0) + 1,
          error,
        });
        throw error;
      });
      codexServiceTierModulePromises.set(namePart, promise);
    }
    return await codexServiceTierModulePromises.get(namePart);
  }

  async function loadOptionalCodexAppModule(namePart) {
    try {
      return await loadCodexAppModule(namePart);
    } catch (error) {
      // 结构化标记优先；保留字符串兜底以便老缓存里的 Error 也能被认出来。
      if (isCodexAppAssetMissingError(error)) return null;
      if (String(error?.message || error).includes(`未找到 Codex App asset: ${namePart}`)) return null;
      throw error;
    }
  }

  function appServerFallbackAssetUrls() {
    const urls = codexAppAssetCandidateUrls();
    const preferred = urls.filter((url) => {
      const name = (url.split("/").pop() || "").toLowerCase();
      return /use-host-config|app-server-manager-signals|signals|server-manager/.test(name);
    });
    // 只读服务模块，导入 app-main/app-initial 会抢跑原生启动与模型查询初始化。
    preferred.sort((left, right) => {
      const score = (url) => {
        const name = (url.split("/").pop() || "").toLowerCase();
        if (name.includes("use-host-config")) return 0;
        if (name.includes("app-server-manager-signals")) return 1;
        return 5;
      };
      return score(left) - score(right) || right.length - left.length;
    });
    return preferred.slice(0, 16);
  }

  function collectAppServerRequestCandidatesFromModule(module) {
    const candidates = [];
    const seen = new Set();
    const push = (value) => {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      candidates.push(value);
    };
    for (const { value } of Object.values(Object.getOwnPropertyDescriptors(module || {}))) {
      push(value);
      if (!value || typeof value !== "object") continue;
      try {
        // 任意 get()/getter 可能创建原生查询；仅 Map 查找和已存储的字段可安全探测。
        if (value instanceof Map) {
          push(Map.prototype.get.call(value, undefined));
          push(Map.prototype.get.call(value, "local"));
        }
        for (const { value: nested } of Object.values(Object.getOwnPropertyDescriptors(value)).slice(0, 100)) push(nested);
      } catch {}
    }
    return candidates;
  }

  async function loadAppServerRequestModules() {
    const modules = [];
    const sources = [];
    const seenModules = new Set();
    const seenUrls = new Set();
    const pushModule = (module, source) => {
      if (!module || typeof module !== "object" || seenModules.has(module)) return;
      seenModules.add(module);
      modules.push(module);
      sources.push(source);
    };
    for (const assetPrefix of ["use-host-config-", "app-server-manager-signals-"]) {
      try {
        const module = await loadOptionalCodexAppModule(assetPrefix);
        if (module) pushModule(module, assetPrefix);
      } catch {
      }
    }
    for (const url of appServerFallbackAssetUrls()) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      try {
        pushModule(await import(url), url);
      } catch {
      }
    }
    return { modules, sources };
  }

  function codexReactFiberRoots() {
    const roots = [];
    const nodes = [
      document.getElementById("root"),
      document.querySelector("button, [role='button']"),
      document.body,
      document.documentElement,
    ].filter(Boolean);
    for (const node of nodes) {
      for (const key of Object.getOwnPropertyNames(node)) {
        if (!key.startsWith("__reactFiber$") && !key.startsWith("__reactContainer$")) continue;
        let fiber = node[key];
        while (fiber?.return) fiber = fiber.return;
        if (fiber && !roots.includes(fiber)) roots.push(fiber);
      }
    }
    return roots;
  }

  function collectCodexReactRuntimeCandidates(rootFibers = codexReactFiberRoots()) {
    const queryClients = [];
    const requestClients = [];
    const conversationManagers = [];
    const seenFibers = new Set();
    const pushQueryClient = (value) => {
      if (!value || typeof value.setQueriesData !== "function" || queryClients.includes(value)) return;
      queryClients.push(value);
    };
    const pushRequestClient = (value) => {
      if (!value
          || typeof value.sendRequest !== "function"
          || typeof value.hostId !== "string"
          || !(value.requestPromises instanceof Map)
          || typeof value.onResult !== "function"
          || typeof value.onError !== "function"
          || requestClients.includes(value)) return;
      requestClients.push(value);
    };
    const inspect = (value) => {
      if (!value || typeof value !== "object") return;
      pushQueryClient(value);
      pushQueryClient(value.queryClient);
      pushRequestClient(value);
      pushRequestClient(value.requestClient);
      if (value.requestClient && typeof value.getConversation === "function"
          && typeof value.updateConversationState === "function"
          && !conversationManagers.includes(value)) conversationManagers.push(value);
    };
    const inspectMemo = (value, depth = 0) => {
      inspect(value);
      if (!Array.isArray(value) || depth >= 2) return;
      value.slice(0, 40).forEach((item) => inspectMemo(item, depth + 1));
    };
    const queue = Array.isArray(rootFibers) ? [...rootFibers] : [];
    while (queue.length && seenFibers.size < 5000) {
      const fiber = queue.shift();
      if (!fiber || seenFibers.has(fiber)) continue;
      seenFibers.add(fiber);
      inspect(fiber.memoizedProps);
      inspect(fiber.pendingProps);
      let hook = fiber.memoizedState;
      for (let index = 0; hook && typeof hook === "object" && index < 40; index += 1) {
        inspectMemo(hook.memoizedState);
        hook = hook.next;
      }
      inspectMemo(fiber.updateQueue?.memoCache?.data);
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return { queryClients, requestClients, conversationManagers, fiberCount: seenFibers.size };
  }

  async function loadAppServerRequestCandidates() {
    const runtime = collectCodexReactRuntimeCandidates();
    if (runtime.requestClients.length) {
      return {
        modules: [],
        candidates: runtime.requestClients,
        sources: ["react-runtime"],
        discovery: "react-runtime",
      };
    }
    const { modules, sources } = await loadAppServerRequestModules();
    const candidates = [];
    const seen = new Set();
    for (const module of modules) {
      for (const candidate of collectAppServerRequestCandidatesFromModule(module)) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
    const usedFallback = sources.some((source) => !source.endsWith("-"));
    return { modules, candidates, sources, discovery: usedFallback ? "fallback" : "named-assets" };
  }

  function codexSettingStorageFromModule(module, assetPrefix = "") {
    const values = module && typeof module === "object" ? Object.values(module) : [];
    const functionSource = (candidate) => {
      if (typeof candidate !== "function") return "";
      try {
        return String(candidate);
      } catch (_) {
        return "";
      }
    };
    const getSettingByCapability = () => values.find((candidate) => {
      const source = functionSource(candidate);
      return source.includes("get-setting") && source.includes("params") && source.includes("key");
    });
    const setSettingByCapability = () => values.find((candidate) => {
      const source = functionSource(candidate);
      return source.includes("set-setting") && source.includes("params") && source.includes("key");
    });
    let getSetting = null;
    let setSetting = null;
    if (assetPrefix.startsWith("setting-storage-")) {
      getSetting = typeof module?.n === "function" ? module.n : getSettingByCapability();
      setSetting = typeof module?.s === "function" ? module.s : setSettingByCapability();
    } else if (assetPrefix.startsWith("app-initial-")) {
      getSetting = typeof module?.jut === "function" ? module.jut : getSettingByCapability();
      setSetting = typeof module?.Put === "function" ? module.Put : setSettingByCapability();
    } else {
      getSetting = getSettingByCapability();
      setSetting = setSettingByCapability();
    }
    return typeof getSetting === "function" && typeof setSetting === "function"
      ? { n: getSetting, s: setSetting, assetPrefix }
      : null;
  }

  async function codexSettingStorageModule() {
    const errors = [];
    for (const assetPrefix of ["setting-storage-", "app-initial-"]) {
      try {
        const module = await loadCodexAppModule(assetPrefix);
        const settingStorage = codexSettingStorageFromModule(module, assetPrefix);
        if (settingStorage) return settingStorage;
        errors.push(`${assetPrefix}: setting exports unavailable`);
      } catch (error) {
        errors.push(`${assetPrefix}: ${error?.message || String(error)}`);
      }
    }
    throw new Error(`Codex setting-storage 接口不可用 (${errors.join("; ")})`);
  }

  function normalizeCodexServiceTierModelName(model) {
    return String(model || "").trim().toLowerCase();
  }

  function codexServiceTierModelFromValue(value, visited = new WeakSet(), depth = 0) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object" || visited.has(value) || depth > 3) return "";
    visited.add(value);
    for (const key of ["model", "modelId", "model_id", "selectedModel", "selected_model", "defaultModel", "default_model"]) {
      const model = codexServiceTierModelFromValue(value[key], visited, depth + 1);
      if (model) return model;
    }
    for (const key of ["params", "request", "payload", "body", "config", "options"]) {
      const model = codexServiceTierModelFromValue(value[key], visited, depth + 1);
      if (model) return model;
    }
    return "";
  }

  function codexServiceTierCurrentModelName() {
    return codexServiceTierModelFromValue(codexModelCatalog.model) || codexServiceTierModelFromValue(codexModelCatalog.default_model);
  }

  // threadId -> 模型名。挂在 window 上跨重注入保留（重注入不该丢掉已知的线程模型）。
  // 只在请求路径观测到模型时写入，用于让界面判定跟上线程当前模型（issue #1463）。
  const codexServiceTierThreadModels = window.__codexPlusServiceTierThreadModels
    || (window.__codexPlusServiceTierThreadModels = new Map());

  // 线程中途换模型后，全局 catalog 的 model 字段往往还没更新，直接拿它判 Fast 可用性
  // 会落后一拍。因此界面优先读「当前线程最近一次实际请求用的模型」，读不到才回落全局。
  function codexServiceTierUiModelName(threadId = "") {
    const key = typeof validThreadScrollSessionKey === "function"
      ? validThreadScrollSessionKey(threadId)
      : String(threadId || "");
    if (key) {
      const cached = codexServiceTierThreadModels.get(key);
      if (cached) return cached;
    }
    return codexServiceTierCurrentModelName();
  }

  function codexServiceTierRememberThreadModel(threadId, modelName) {
    const key = typeof validThreadScrollSessionKey === "function"
      ? validThreadScrollSessionKey(threadId)
      : String(threadId || "");
    const model = codexServiceTierModelFromValue(modelName);
    if (!key || !model) return;
    codexServiceTierThreadModels.set(key, model);
    // 简易上界，避免长会话里 Map 无限增长；Map 的插入序即写入序，删最旧的即可。
    while (codexServiceTierThreadModels.size > 64) {
      const oldest = codexServiceTierThreadModels.keys().next().value;
      if (oldest === undefined) break;
      codexServiceTierThreadModels.delete(oldest);
    }
  }

  function codexServiceTierModelForRequest(params, modelHint = "") {
    return codexServiceTierModelFromValue(params) || codexServiceTierModelFromValue(modelHint) || codexServiceTierCurrentModelName();
  }

  function codexServiceTierFastSupportedForModel(modelName) {
    const normalized = normalizeCodexServiceTierModelName(modelName);
    if (!normalized) return false;
    // 不按名字猜：模型叫 deepseek 不代表它的中转站支持 priority tier。
    // 只认上游模型元数据里明确声明的 priority。
    try {
      const metadata = typeof codexPlusModelMetadata === "function" ? codexPlusModelMetadata(modelName) : null;
      if (typeof metadata?.prioritySupportOverride === "boolean") return metadata.prioritySupportOverride;
      const tierIs = (tier, expected) => String(typeof tier === "string" ? tier : tier?.id || "").trim().toLowerCase() === expected;
      if (Array.isArray(metadata?.serviceTiers) && metadata.serviceTiers.some((tier) => tierIs(tier, "priority"))) return true;
      if (Array.isArray(metadata?.additionalSpeedTiers) && metadata.additionalSpeedTiers.some((tier) => tierIs(tier, "fast"))) return true;
    } catch {}
    // 未声明仍沿用已验证的内置模型；第三方模型不能因名字含 fast 就自动放行。
    return codexServiceTierSupportedFastModels.has(normalized);
  }

  // UI 侧「Fast 是否可用」的唯一判据。这里必须复用 codexServiceTierFastSupportedForModel，
  // 不能再自己对照 codexServiceTierSupportedFastModels：那套只认内置名单，中转场景下
  // 模型名带前缀（或仅靠上游元数据声明 priority）时，界面会判「不支持/未读取」，而真正
  // 发请求的路径却按同一模型放了 service_tier=priority——两条判据不一致就会自相矛盾
  // （issue #772）。
  //
  // 默认模型名优先取最近一次在线程里观测到的模型（见 codexServiceTierRememberThreadModel），
  // 只有完全没观测过时才回落到全局 catalog——否则线程中途换模型后 UI 会落后一拍
  // （issue #1463）。
  function codexServiceTierFastAvailability(modelName = codexServiceTierUiModelName()) {
    const normalizedModel = normalizeCodexServiceTierModelName(modelName);
    return {
      modelName: modelName || "",
      supported: !!normalizedModel && codexServiceTierFastSupportedForModel(modelName),
    };
  }
