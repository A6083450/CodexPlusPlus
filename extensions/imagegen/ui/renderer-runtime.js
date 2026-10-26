  window.__codexPlusImageGenerationRuntime ||= { active: false, threads: new Map() };
  window.__codexPlusImageGenerationRuntime.stopping = false;
  installCodexNativeImageIngress();

  function codexImageGenerationRuntimeActive() {
    const runtime = window.__codexPlusImageGenerationRuntime;
    return runtime?.active === true && !runtime.stopping;
  }

  function setCodexImageGenerationRuntimeActive(active) {
    const runtime = window.__codexPlusImageGenerationRuntime ||= { active: false, threads: new Map() };
    if (active && (runtime.stopping || runtime.restoring)) return;
    runtime.active = active;
  }

  function recordCodexImageGenerationThread(client, state, params) {
    if (client.hostId !== "local" || !codexImageGenerationRuntimeActive() || !state.threadId
        || params?.config?.["features.image_generation"] !== false) return;
    const model = state.model || codexServiceTierCurrentModelName();
    if (String(model).toLowerCase().startsWith("gpt-image-")) {
      (client.__codexPlusImageGenerationProxyThreads ||= new Set()).add(state.threadId);
      const proxy = codexPlusBackendSettings.imageGenerationProxy;
      if (state.requestMethod === "thread/start" && proxy && params.modelProvider === proxy.provider
          && params.config.model_providers?.[proxy.provider]?.base_url === proxy.baseUrl) {
        // 新会话也立即有 rollout；成功 start 已应用代理，无需首条消息前再恢复。
        (client.__codexPlusImageGenerationReady ||= new Set()).add(codexImageGenerationReadyKey(state.threadId, model));
      }
    }
    window.__codexPlusImageGenerationRuntime.threads.set(state.threadId, {
      client, model,
    });
  }

  window.__codexPlusRestoreNativeImageGeneration = (stopping = true) => {
    const runtime = window.__codexPlusImageGenerationRuntime;
    runtime.active = false;
    runtime.stopping ||= stopping;
    if (runtime.restoring) return runtime.restoring;
    runtime.restoring = (async () => {
      let restored = 0;
      for (const [id, entry] of [...runtime.threads]) {
        await window.__codexPlusImagePersistenceJobs?.get(id);
        const result = await window.__codexPlusPersistGeneratedImages({ session_id: id, model: entry.model }, true);
        if (result !== true) continue;
        runtime.threads.delete(id);
        entry.client.__codexPlusImageGenerationProxyThreads?.delete(id);
        entry.client.__codexPlusImageGenerationReady?.clear();
        restored++;
      }
      return { restored, pending: runtime.threads.size };
    })().finally(() => { runtime.restoring = null; });
    return runtime.restoring;
  };

  window.__codexPlusImagePersistenceJobs = window.__codexPlusImagePersistenceJobs || new Map();
  window.__codexPlusPersistGeneratedImages = (session, refreshOnly = false) => {
    const id = session?.session_id;
    const jobs = window.__codexPlusImagePersistenceJobs;
    if (!id) return Promise.resolve(false);
    if (jobs.has(id)) return jobs.get(id);
    const candidates = collectCodexReactRuntimeCandidates();
    const manager = candidates.conversationManagers.find(m => m.requestClient?.hostId === "local"
      && typeof m.streamState?.stopFollowingConversationState === "function");
    if (!manager && !refreshOnly) return Promise.resolve(false);
    const job = (async () => {
      if (!manager) {
        const module = await loadOptionalCodexAppModule("app-initial-");
        const getter = Object.values(module || {}).find(value => typeof value === "function"
          && value.toString().includes("AppServerManager RPC is unavailable for hostId:")
          && /\.forHost\(/.test(value.toString()));
        if (!getter || !candidates.appScope) return false;
        const rpc = getter(candidates.appScope, "local");
        if (await rpc.getHostId() !== "local") return false;
        const { thread } = await rpc.sendRequest("thread/read", { threadId: id, includeTurns: false });
        if (!["idle", "notLoaded"].includes(thread.status?.type)) return "busy";
        const conversation = await rpc.getConversation(id);
        if (!conversation) return false;
        // 图片编辑器等页面只暴露 RPC；原生卸载接口会保留会话设置并清理流归属。
        await rpc.unsubscribeInactiveConversation(id);
        if ((await rpc.getConversation(id))?.resumeState !== "needs_resume") return false;
        const resumed = await rpc.resumeConversation({ conversationId: id,
          workspaceRoots: [conversation.cwd || thread.cwd], model: session.model || conversation.latestModel,
          reasoningEffort: conversation.latestReasoningEffort ?? null });
        if (resumed?.status !== "ready") return false;
        const restored = await rpc.sendRequest("thread/read", { threadId: id, includeTurns: false });
        return restored.thread.status?.type !== "notLoaded";
      }
      // 内部保存不能触发原生 archive 通知的缓存驱逐，否则当前页面会跳到新会话。
      for (const candidate of candidates.conversationManagers) {
        if (candidate.requestClient?.hostId !== "local") continue;
        const context = candidate.notificationContext;
        if (!context) return false;
        for (const name of ["handleThreadArchived", "handleThreadUnarchived"]) {
          const original = context[name];
          if (typeof original !== "function") return false;
          if (original.__codexPlusImagePersistenceGuard) continue;
          const guarded = function(threadId, ...args) {
            if (jobs.has(threadId)) return;
            return original.call(this, threadId, ...args);
          };
          guarded.__codexPlusImagePersistenceGuard = true;
          context[name] = guarded;
        }
      }
      const client = manager.requestClient;
      const { thread } = await client.sendRequest("thread/read", { threadId: id, includeTurns: false });
      if (!["idle", "notLoaded"].includes(thread.status?.type)) return "busy";
      const conversation = manager.getConversation(id);
      const cwd = manager.getConversationCwd(id) || thread.cwd;
      const model = (refreshOnly && session.model) || conversation?.latestModel;
      let archived = false;
      try {
        // Archive closes the native writer before changing existing references; no events are appended.
        await client.sendRequest("thread/archive", { threadId: id });
        archived = true;
        const result = refreshOnly ? 1 : await postJson("/thread-generated-images/persist", session);
        if (typeof result !== "number") throw new Error(result?.message || "图片持久化失败");
        return result > 0;
      } finally {
        if (archived) {
          await client.sendRequest("thread/unarchive", { threadId: id });
          // 仅改变 resumeState 不够：原生只要还持有 stream role 就会直接返回 ready。
          manager.streamState.stopFollowingConversationState(id);
          manager.updateConversationState(id, state => { state.resumeState = "needs_resume"; });
          const resumed = await manager.resumeConversation({ conversationId: id, workspaceRoots: [cwd], model, reasoningEffort: conversation?.latestReasoningEffort ?? null });
          if (resumed?.status !== "ready") throw new Error("图片已保存，请重新打开会话");
          const restored = await client.sendRequest("thread/read", { threadId: id, includeTurns: true });
          if (restored.thread.status?.type === "notLoaded") throw new Error("原生会话未恢复，保留图片预览");
          const texts = new Map((restored.thread.turns || []).flatMap(turn => turn.items || [])
            .filter(item => item.type === "agentMessage" && item.text?.includes("/generated_images/"))
            .map(item => [item.id, item.text]));
          // 同步已缓存的尾部消息；分页合并可能保留同 ID 的旧文字。
          manager.updateConversationState(id, state => {
            const turns = [...(state.turns || []), ...Object.values(state.turnHistory?.history?.entitiesByKey || {})];
            for (const turn of turns) for (const item of turn.items || []) {
              if (item.type === "agentMessage" && texts.has(item.id)) item.text = texts.get(item.id);
            }
          });
        }
      }
    })().catch(error => {
      sendCodexPlusDiagnostic("generated_image_persistence_failed", { message: String(error?.message || error) });
      return false;
    }).finally(() => jobs.delete(id));
    jobs.set(id, job);
    return job;
  };

  async function prepareCodexImageGenerationTurn(client, method, params) {
    if (method !== "turn/start" || client.hostId !== "local") return;
    const threadId = params?.threadId;
    const model = String(params?.collaborationMode?.settings?.model || params?.model
      || client.__codexPlusThreadModels?.get(threadId) || codexServiceTierCurrentModelName());
    if (!threadId) return;
    const runtime = window.__codexPlusImageGenerationRuntime;
    if (!runtime) return;
    const imageModel = model.toLowerCase().startsWith("gpt-image-");
    const previousClient = runtime.threads.get(threadId)?.client;
    // 旧注入的模型名可能来自界面；只有请求实际应用过代理才需要恢复。
    const hadImageOverride = client.__codexPlusImageGenerationProxyThreads?.has(threadId)
      || previousClient?.__codexPlusImageGenerationProxyThreads?.has(threadId);
    // 普通文字发送不依赖生图恢复；真正用过生图覆盖的会话仍必须先恢复。
    if (!imageModel && !hadImageOverride) return;
    if (codexImageGenerationRuntimeActive()) {
      const status = await postJson("/backend/status", {}).catch(() => null);
      if (status?.status !== "ok") setCodexImageGenerationRuntimeActive(false);
    }
    if (!codexImageGenerationRuntimeActive()) {
      await runtime.restoring;
      if (runtime.threads.has(threadId) || client.__codexPlusImageGenerationProxyThreads?.has(threadId)) {
        await window.__codexPlusImagePersistenceJobs?.get(threadId);
        const restored = await window.__codexPlusPersistGeneratedImages({ session_id: threadId, model }, true);
        if (restored !== true) throw new Error("原生生图配置尚未恢复，请等待当前会话空闲后重试");
        runtime.threads.delete(threadId);
        previousClient?.__codexPlusImageGenerationProxyThreads?.delete(threadId);
        client.__codexPlusImageGenerationProxyThreads?.delete(threadId);
        client.__codexPlusImageGenerationReady?.clear();
      }
      return;
    }
    const proxyThreads = client.__codexPlusImageGenerationProxyThreads ||= new Set();
    if (hadImageOverride) proxyThreads.add(threadId);
    await loadBackendSettingsState();
    const profile = codexRemoteSessionActiveProfile();
    const proxied = codexPlusBackendSettings.imageGenerationProxy
      || (profile?.imageGenerationProxy !== false && profile?.protocol === "responses"
        && (profile.relayMode !== "official" || profile.officialMixApiKey));
    const wantsProxy = imageModel && Boolean(proxied);
    if (!wantsProxy && !proxyThreads.has(threadId) && !codexImageGenerationDisabled()) return;
    const ready = client.__codexPlusImageGenerationReady ||= new Set();
    const readyKey = codexImageGenerationReadyKey(threadId, model);
    if (ready.has(readyKey) && wantsProxy === proxyThreads.has(threadId)) return;
    // 已加载会话会忽略 resume 的 config；首次发送前必须真正卸载再恢复。
    const { thread } = await client.sendRequest("thread/read", { threadId, includeTurns: false });
    if (!thread.path) {
      if (wantsProxy) proxyThreads.add(threadId);
      runtime.threads.set(threadId, { client, model });
      return; // 新会话尚未创建 rollout，由已安装的 start 拦截负责。
    }
    await window.__codexPlusImagePersistenceJobs.get(threadId);
    const restored = await window.__codexPlusPersistGeneratedImages({ session_id: threadId, model }, true);
    if (restored !== true) throw new Error("生图会话配置未恢复，请稍后重试");
    previousClient?.__codexPlusImageGenerationProxyThreads?.delete(threadId);
    ready.add(readyKey);
    runtime.threads.set(threadId, { client, model });
    if (wantsProxy) proxyThreads.add(threadId);
    else proxyThreads.delete(threadId);
  }

  function codexImageGenerationReadyKey(threadId, model) {
    return `hosted-v3:${model}:${codexRemoteSessionActiveProfile()?.id || ""}:${JSON.stringify(codexPlusBackendSettings.imageGenerationProxy)}:${threadId}`;
  }

  function patchCodexImageGenerationManager(manager) {
    if (manager.requestClient?.hostId !== "local") return;
    patchCodexNativeImagePreview(manager);
    const settings = manager.settings;
    if (typeof settings?.readDefaultFeatureOverrides !== "function"
        || settings.__codexPlusImageGenerationDefaults === "lifecycle-v1") return;
    const legacy = settings.__codexPlusImageGenerationDefaults === true;
    const original = settings.__codexPlusImageGenerationOriginalDefaults
      || (legacy && typeof Object.getPrototypeOf(settings)?.readDefaultFeatureOverrides === "function"
        ? Object.getPrototypeOf(settings).readDefaultFeatureOverrides.bind(settings)
        : settings.readDefaultFeatureOverrides.bind(settings));
    settings.__codexPlusImageGenerationOriginalDefaults = original;
    settings.readDefaultFeatureOverrides = (...args) => {
      const defaults = original(...args);
      // 默认值及下方请求拦截同时生效，覆盖原生界面的显式实验开关。
      if (codexImageGenerationDisabled()) return { ...defaults, image_generation: false };
      return legacy && typeof codexPlusBackendSettings.nativeImageGenerationEnabled === "boolean"
        ? { ...defaults, image_generation: codexPlusBackendSettings.nativeImageGenerationEnabled } : defaults;
    };
    settings.__codexPlusImageGenerationDefaults = "lifecycle-v1";
  }

  function codexNativeImagePreviewItems(items, descending = false) {
    let changed = false;
    const next = (items || []).flatMap(item => {
      if (item?.type !== "agentMessage" || !codexNativeImageMessageId(item.id)) return [item];
      const paths = String(item.text || "").split("\n\n").map(line =>
        /^!\[已生成图像\]\(<((?:\/|[A-Za-z]:[\\/])[^<>\r\n]*[\\/]generated_images[\\/]response-assets[\\/][A-Za-z0-9_-]+\.(?:png|jpg|webp))>\)$/.exec(line)?.[1]);
      if (paths.some(path => !path || path.split(/[\\/]/).includes(".."))) return [item];
      changed = true;
      const generated = paths.flatMap((path, index) => {
        const id = index === 0 ? item.id : `${item.id}_${index}`;
        // 分页恢复可能保留派生图片，同时把首项恢复成磁盘中的 Markdown 消息。
        if (index > 0 && items.some(existing => existing?.type === "imageGeneration"
            && existing.id === id && existing.savedPath === path)) return [];
        return { type: "imageGeneration", id, status: "completed",
          result: path, savedPath: path, src: path, revisedPrompt: null, inputImages: [] };
      });
      return descending ? generated.reverse() : generated;
    });
    return changed ? next : null;
  }

  function codexNativeImageMessageId(id) {
    return /^msg_cpp_images_(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(id || "");
  }

  function patchCodexNativeImageResult(method, client, result, params = {}) {
    if (client.hostId !== "local" || !codexImageGenerationRuntimeActive() || !result) return;
    const patchTurn = turn => {
      const items = codexNativeImagePreviewItems(turn?.items);
      if (items) turn.items = items;
    };
    if (["thread/start", "thread/resume", "thread/read", "thread/fork", "thread/rollback"].includes(method)) {
      result.thread?.turns?.forEach(patchTurn);
    } else if (method === "thread/turns/list") result.data?.forEach(patchTurn);
    else if (["thread/items/list", "thread/items/read"].includes(method)) {
      const descending = method === "thread/items/list" && (params.sortDirection || params.params?.sortDirection) === "desc";
      if (Array.isArray(result.data) && result.data.every(entry => entry?.item)) {
        const entries = new Map(result.data.map(entry => [entry.item.id, entry]));
        const items = codexNativeImagePreviewItems(result.data.map(entry => entry.item), descending);
        if (items) result.data = items.map(item => ({
          ...(entries.get(item.id) || entries.get(item.id.replace(/_\d+$/, ""))), item,
        }));
      } else {
        const items = codexNativeImagePreviewItems(result.data, descending);
        if (items) result.data = items;
      }
    }
  }

  function installCodexNativeImageIngress() {
    if (typeof window.addEventListener !== "function") return;
    if (window.__codexPlusNativeImageMessageHandler) window.removeEventListener("message", window.__codexPlusNativeImageMessageHandler, true);
    const pending = window.__codexPlusImageGenerationRuntime.nativeImageIds ||= new Set();
    const handler = event => {
      const data = event.data;
      if (data?.type !== "mcp-notification" || data.hostId !== "local") return;
      const origin = String(event.origin || "");
      if (!(event.source == null && !origin)
          && (event.source !== window || (origin && origin !== "null" && origin !== window.location.origin))) return;
      const params = data.params;
      const itemId = params?.item?.id || params?.itemId;
      if (!codexImageGenerationRuntimeActive() && !pending.has(itemId)) return;
      if (data.method === "item/agentMessage/delta" && codexNativeImageMessageId(itemId)) {
        event.stopImmediatePropagation();
      } else if (data.method === "item/started" && params?.item?.type === "agentMessage" && codexNativeImageMessageId(itemId)) {
        pending.add(itemId);
        if (pending.size > 128) pending.delete(pending.values().next().value);
        params.item = { type: "imageGeneration", id: itemId, status: "in_progress", result: "", revisedPrompt: null, inputImages: [] };
      } else if (data.method === "item/completed") {
        pending.delete(itemId);
        const items = codexNativeImagePreviewItems([params?.item]);
        if (!items) return;
        params.item = items[0];
        // 多图分别进入原生项目表，不能把第二张塞到文字或自制弹窗中。
        if (items.length > 1) queueMicrotask(() => {
          for (const item of items.slice(1)) for (const method of ["item/started", "item/completed"]) {
            const nativeItem = method === "item/started" ? { ...item, status: "in_progress", result: "", savedPath: null } : item;
            const nativeParams = { ...params, item: nativeItem };
            if (method === "item/started") {
              nativeParams.startedAtMs = params.completedAtMs ?? Date.now();
              delete nativeParams.completedAtMs;
            }
            window.dispatchEvent(new MessageEvent("message", { data: { ...data, method, params: nativeParams } }));
          }
        });
      } else if (data.method === "turn/completed") {
        for (const item of params?.turn?.items || []) pending.delete(item.id);
        const items = codexNativeImagePreviewItems(params?.turn?.items);
        if (items) params.turn.items = items;
      }
    };
    window.__codexPlusNativeImageMessageHandler = handler;
    window.addEventListener("message", handler, true);
  }

  function patchCodexNativeImagePreview(manager) {
    if (typeof manager.addAnyConversationCallback !== "function") return;
    if (manager.__codexPlusNativeImagePreviewPatch !== codexAppServerModelRequestPatchVersion) {
      manager.__codexPlusNativeImagePreviewObserver?.();
      const turns = state => [...(state?.turns || []), ...Object.values(state?.turnHistory?.history?.entitiesByKey || {})];
      const refresh = value => {
        const id = typeof value === "string" ? value : currentSessionRef()?.session_id;
        if (!codexImageGenerationRuntimeActive() || typeof id !== "string") return;
        if (!turns(manager.getConversation(id)).some(turn => turn.status === "completed" && codexNativeImagePreviewItems(turn.items))) return;
        // 仅投影已完成轮次，保留流式消息目标及磁盘历史，由原生图库处理预览和编辑。
        manager.updateConversationState(id, state => {
          for (const turn of turns(state)) {
            const items = turn.status === "completed" && codexNativeImagePreviewItems(turn.items);
            if (items) turn.items = items;
          }
        }, false);
      };
      manager.__codexPlusNativeImagePreviewObserver = manager.addAnyConversationCallback(refresh);
      manager.__codexPlusNativeImagePreviewRefresh = refresh;
      manager.__codexPlusNativeImagePreviewPatch = codexAppServerModelRequestPatchVersion;
    }
    const id = typeof currentSessionRef === "function" && currentSessionRef()?.session_id;
    if (id) manager.__codexPlusNativeImagePreviewRefresh(id);
  }

  function codexImageGenerationDisabled() {
    if (!codexImageGenerationRuntimeActive()) return false;
    const profile = codexRemoteSessionActiveProfile();
    return Boolean(codexPlusBackendSettings.imageGenerationProxy || (profile?.imageGenerationProxy !== false && profile?.protocol === "responses"
      && (profile.relayMode !== "official" || profile.officialMixApiKey)
    ));
  }

  function applyCodexImageGenerationRequestOverride(method, params) {
    if (!codexImageGenerationRuntimeActive() || !["thread/start", "thread/resume", "thread/fork"].includes(method)) return params;
    const model = String(params?.collaborationMode?.settings?.model || params?.model || codexServiceTierCurrentModelName());
    const proxy = model.toLowerCase().startsWith("gpt-image-") && codexPlusBackendSettings.imageGenerationProxy;
    if (!proxy && !codexImageGenerationDisabled()) return params;
    const config = { ...params?.config, "features.image_generation": false };
    if (proxy) {
      // app-server 的点分键不解析 TOML 引号，嵌套对象才能保留供应商名称原文。
      config.model_providers = { ...config.model_providers, [proxy.provider]: {
        ...config.model_providers?.[proxy.provider],
        base_url: proxy.baseUrl, supports_websockets: false,
      } };
    }
    if (config.features && typeof config.features === "object" && !Array.isArray(config.features)) {
      config.features = { ...config.features, image_generation: false };
    }
    return { ...params, ...(proxy ? { modelProvider: proxy.provider } : {}), config };
  }

