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
      const model = conversation?.latestModel;
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
    if (!threadId || !model?.toLowerCase().startsWith("gpt-image-")) return;
    await loadBackendSettingsState();
    if (!codexImageGenerationDisabled()) return;
    const ready = client.__codexPlusImageGenerationReady ||= new Set();
    if (ready.has(threadId)) return;
    // 已加载会话会忽略 resume 的 config；首次发送前必须真正卸载再恢复。
    const { thread } = await client.sendRequest("thread/read", { threadId, includeTurns: false });
    if (!thread.path) return; // 新会话尚未创建 rollout，由已安装的 start 拦截负责。
    await window.__codexPlusImagePersistenceJobs.get(threadId);
    const restored = await window.__codexPlusPersistGeneratedImages({ session_id: threadId }, true);
    if (restored !== true) throw new Error("生图会话配置未恢复，请稍后重试");
    ready.add(threadId);
  }

  function patchCodexImageGenerationManager(manager) {
    if (manager.requestClient?.hostId !== "local") return;
    const settings = manager.settings;
    if (typeof settings?.readDefaultFeatureOverrides !== "function"
        || settings.__codexPlusImageGenerationDefaults) return;
    const original = settings.readDefaultFeatureOverrides.bind(settings);
    settings.readDefaultFeatureOverrides = (...args) => {
      const defaults = original(...args);
      // 默认值及下方请求拦截同时生效，覆盖原生界面的显式实验开关。
      return codexImageGenerationDisabled()
        ? { ...defaults, image_generation: false } : defaults;
    };
    settings.__codexPlusImageGenerationDefaults = true;
  }

  function codexImageGenerationDisabled() {
    const profile = codexRemoteSessionActiveProfile();
    const directImages = profile?.imageGenerationProxy === false && profile.protocol === "responses"
      && (profile.relayMode !== "official" || profile.officialMixApiKey)
      && `${profile.model || ""}\n${profile.modelList || ""}`.split("\n")
        .some((model) => model.trim().toLowerCase().startsWith("gpt-image-"));
    return directImages || codexPlusBackendSettings.nativeImageGenerationEnabled === false;
  }

  function applyCodexImageGenerationRequestOverride(method, params) {
    if (!["thread/start", "thread/resume", "thread/fork"].includes(method)
        || !codexImageGenerationDisabled()) return params;
    const config = { ...params?.config, "features.image_generation": false };
    if (config.features && typeof config.features === "object" && !Array.isArray(config.features)) {
      config.features = { ...config.features, image_generation: false };
    }
    return { ...params, config };
  }

