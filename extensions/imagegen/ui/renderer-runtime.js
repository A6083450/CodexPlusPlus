  window.__codexPlusImageGenerationRuntime ||= { active: false, threads: new Map() };
  window.__codexPlusImageGenerationRuntime.stopping = false;

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
    const manager = collectCodexReactRuntimeCandidates().conversationManagers.find(m => m.requestClient?.hostId === "local");
    if (!manager || typeof manager.streamState?.stopFollowingConversationState !== "function") return Promise.resolve(false);
    // 内部保存不能触发原生 archive 通知的缓存驱逐，否则当前页面会跳到新会话。
    for (const candidate of collectCodexReactRuntimeCandidates().conversationManagers) {
      if (candidate.requestClient?.hostId !== "local") continue;
      const context = candidate.notificationContext;
      if (!context) return Promise.resolve(false);
      for (const name of ["handleThreadArchived", "handleThreadUnarchived"]) {
        const original = context[name];
        if (typeof original !== "function") return Promise.resolve(false);
        if (original.__codexPlusImagePersistenceGuard) continue;
        const guarded = function(threadId, ...args) {
          if (jobs.has(threadId)) return;
          return original.call(this, threadId, ...args);
        };
        guarded.__codexPlusImagePersistenceGuard = true;
        context[name] = guarded;
      }
    }
    const job = (async () => {
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
    const hadImageOverride = client.__codexPlusImageGenerationProxyThreads?.has(threadId)
      || String(runtime.threads.get(threadId)?.model || "").toLowerCase().startsWith("gpt-image-");
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
    const readyKey = `hosted-v3:${model}:${profile?.id || ""}:${JSON.stringify(codexPlusBackendSettings.imageGenerationProxy)}:${threadId}`;
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
    ready.add(readyKey);
    runtime.threads.set(threadId, { client, model });
    if (wantsProxy) proxyThreads.add(threadId);
    else proxyThreads.delete(threadId);
  }

  function patchCodexImageGenerationManager(manager) {
    if (manager.requestClient?.hostId !== "local") return;
    const settings = manager.settings;
    const id = typeof currentSessionRef === "function" && currentSessionRef()?.session_id;
    const conversation = id && manager.getConversation?.(id);
    if (conversation && codexImageGenerationRuntimeActive()) window.__codexPlusImageGenerationRuntime.threads.set(id, {
      client: manager.requestClient, model: conversation.latestModel,
    });
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

