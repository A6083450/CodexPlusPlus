(() => {
  if (typeof MutationObserver !== "function") return;
  const state = window.__codexPlusGeneratedImagesState || {
    requestKey: "",
    sessionId: "",
    images: [],
    pending: false,
    timer: 0,
  };
  window.__codexPlusGeneratedImagesState = state;
  clearTimeout(state.timer);
  state.pending = false;
  state.requestKey = "";
  document.querySelectorAll("dialog[data-codex-generated-image-preview]").forEach(dialog => {
    dialog.close?.();
    dialog.remove?.();
  });

  function responseTargets() {
    return Array.from(document.querySelectorAll("[data-response-annotation-target]"));
  }

  function findResponseTarget(messageId, responseIndex, targets) {
    if (messageId) {
      const exact = targets.find(
        (target) => target.getAttribute("data-response-annotation-target") === messageId,
      );
      return exact || null;
    }
    if (
      Number.isInteger(responseIndex)
      && responseIndex >= 0
      && responseIndex < targets.length
    ) {
      return targets[responseIndex];
    }
    return messageId ? null : targets.at(-1) || null;
  }

  async function openPreview(sourceImage) {
    const imageId = sourceImage.getAttribute("data-codex-generated-image-id");
    const matches = src => typeof src === "string" && imageId && src.includes(imageId);
    const button = Array.from(document.querySelectorAll('[data-testid="generated-image-preview"]')).find(candidate => {
      if (candidate.disabled || candidate.closest?.('[inert], [data-app-shell-active-page="false"]')) return false;
      if (Array.from(candidate.querySelectorAll("img")).some(image => matches(image.getAttribute("src")) || image.src === sourceImage.src)) return true;
      const key = Object.getOwnPropertyNames(candidate).find(name => name.startsWith("__reactFiber$"));
      let fiber = key && candidate[key];
      for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if ([props?.src, props?.image?.src, props?.image?.savedPath, props?.sourceImage?.src].some(matches)) return true;
      }
      return false;
    });
    if (button) { button.click(); return; }
    const trigger = sourceImage.parentElement;
    if (!trigger || trigger.disabled) return;
    trigger.querySelector("[data-codex-native-preview-status]")?.remove();
    const image = state.images.find(image => image.id === imageId);
    const session = window.__codexPlusCurrentSessionRef?.();
    trigger.disabled = true;
    try {
      if (!image || typeof window.__codexPlusOpenGeneratedImagePreview !== "function") throw new Error("图片预览组件未加载，请重新打开会话");
      await window.__codexPlusOpenGeneratedImagePreview(image, session);
    } catch (error) {
      const status = document.createElement("span");
      status.setAttribute("data-codex-plus-ext", "imagegen");
      status.setAttribute("data-codex-native-preview-status", "true");
      status.setAttribute("role", "status");
      status.textContent = String(error?.message || "原生图片预览打开失败，请重试");
      trigger.appendChild(status);
    } finally {
      trigger.disabled = false;
    }
  }

  function renderImages(images, targets) {
    const bindPreview = (trigger, image) => {
      trigger.removeEventListener?.("click", trigger.__codexPlusImagePreviewCapture, true);
      const handler = event => {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        openPreview(image);
      };
      trigger.addEventListener("click", handler, true);
      trigger.__codexPlusImagePreviewCapture = handler;
    };
    const ids = new Set(images.map((image) => image.id));
    document.querySelectorAll("[data-codex-generated-image-id]").forEach((element) => {
      if (!ids.has(element.getAttribute("data-codex-generated-image-id"))) element.parentElement?.remove();
    });
    images.forEach((image) => {
      if (!image?.id || !image?.base64_data) return;
      const existing = Array.from(document.querySelectorAll("[data-codex-generated-image-id]")).find(
        (element) => element.getAttribute("data-codex-generated-image-id") === image.id,
      );
      const nativeImage = Array.from(document.querySelectorAll("img:not([data-codex-generated-image-id])"))
        .find((element) => element.getAttribute("data-codex-generated-image-preview-content") !== "true"
          && (element.getAttribute("src")?.includes(image.id)
            || element.getAttribute("src") === `data:${image.media_type || "image/png"};base64,${image.base64_data}`));
      if (nativeImage?.complete && nativeImage.naturalWidth > 0) {
        existing?.parentElement?.remove();
        return;
      }
      if (nativeImage && !(state.nativeImageListeners ||= new WeakSet()).has(nativeImage)) {
        state.nativeImageListeners.add(nativeImage);
        nativeImage.addEventListener("load", scheduleRefresh, { once: true });
      }
      const target = findResponseTarget(
        image.assistant_message_id,
        image.assistant_response_index,
        targets,
      );
      if (!target) return;
      if (existing && existing.parentElement?.getAttribute("data-codex-generated-images") !== null) {
        existing.parentElement.remove();
      }
      const markdown = Array.from(target.children).find(
        (child) => child.getAttribute?.("data-selected-text-overlay-target") !== null,
      ) || target;
      let container = markdown.querySelector(":scope > [data-codex-generated-images]");
      if (!container) {
        container = document.createElement("div");
        container.setAttribute("data-codex-plus-ext", "imagegen");
        container.setAttribute("data-codex-generated-images", "true");
        container.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;max-width:100%;";
        markdown.appendChild(container);
      }
      if (existing && existing.parentElement?.getAttribute("data-codex-generated-image-preview-trigger") !== null) {
        // 流式结果先于正文到达时，预览必须跟随最终消息移动。
        if (existing.parentElement.parentElement !== container) container.appendChild(existing.parentElement);
        bindPreview(existing.parentElement, existing);
        return;
      }
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "cursor-zoom-in border-0 bg-transparent p-0 align-top inline-block max-w-full";
      trigger.setAttribute("data-codex-generated-image-preview-trigger", "true");
      trigger.setAttribute("aria-haspopup", "dialog");
      const element = document.createElement("img");
      element.setAttribute("data-codex-generated-image-id", image.id);
      const revisedPrompt = String(image.revised_prompt || "").trim();
      const hasStructuredPrompt = /(?:^|\s)(?:Use case|Asset type|Primary request):/i.test(revisedPrompt);
      element.alt = revisedPrompt && revisedPrompt.length <= 48 && !hasStructuredPrompt
        ? revisedPrompt
        : "生成的图片";
      if (revisedPrompt && revisedPrompt !== element.alt) {
        element.setAttribute("aria-description", revisedPrompt);
      }
      element.loading = "lazy";
      element.decoding = "async";
      element.className = "my-3 block h-auto rounded-md object-contain shadow-md border border-token-border max-h-[10rem] w-auto max-w-full";
      element.src = `data:${image.media_type || "image/png"};base64,${image.base64_data}`;
      trigger.setAttribute("aria-label", element.alt);
      bindPreview(trigger, element);
      trigger.appendChild(element);
      container.appendChild(trigger);
    });
  }

  async function refresh() {
    if (state.pending) return;
    const sessionRef = window.__codexPlusCurrentSessionRef?.();
    const sessionId = String(sessionRef?.session_id || "").trim();
    const targets = responseTargets();
    if (!sessionId || !targets.length || typeof window.__codexPlusPostJson !== "function") return;
    if (state.sessionId !== sessionId) {
      state.sessionId = sessionId;
      state.images = [];
      state.requestKey = "";
    } else if (Array.isArray(state.images) && state.images.length) {
      renderImages(state.images, targets);
    }
    const lastTarget = targets.at(-1)?.getAttribute("data-response-annotation-target") || "";
    const requestKey = `${sessionId}:${targets.length}:${lastTarget}`;
    if (state.requestKey === requestKey) return;
    state.requestKey = requestKey;
    state.pending = true;
    try {
      const result = await window.__codexPlusPostJson("/thread-generated-images", sessionRef);
      const currentSessionId = String(window.__codexPlusCurrentSessionRef?.()?.session_id || "").trim();
      if (currentSessionId !== sessionId) {
        state.requestKey = "";
        return;
      }
      if ((result?.status === "found" || result?.status === "empty") && Array.isArray(result.images)) {
        const returned = new Set(result.images.map(image => image.id));
        const nativeImages = Array.from(document.querySelectorAll("img:not([data-codex-generated-image-id])"));
        const pending = state.images.filter(image => !returned.has(image.id)
          && !nativeImages.some(element => element.getAttribute("data-codex-generated-image-preview-content") !== "true"
            && (element.getAttribute("src")?.includes(image.id)
            || element.getAttribute("src") === `data:${image.media_type || "image/png"};base64,${image.base64_data}`)
            && element.complete && element.naturalWidth > 0));
        state.images = [...result.images, ...pending];
        renderImages(state.images, responseTargets());
        const persistKey = `${sessionId}:${state.images.map(image => image.id).join(",")}`;
        if (state.images.length && state.persistKey !== persistKey
            && typeof window.__codexPlusPersistGeneratedImages === "function") {
          state.persistKey = persistKey;
          const persisted = await window.__codexPlusPersistGeneratedImages(sessionRef);
          if (persisted === true) {
            state.requestKey = "";
            state.timer = setTimeout(() => void refresh(), 150);
          } else if (persisted === "busy") {
            state.persistKey = "";
            state.requestKey = "";
            state.timer = setTimeout(() => void refresh(), 1500);
          }
        }

      } else if (result?.status === "failed") {
        state.requestKey = "";
      }
    } finally {
      state.pending = false;
    }
  }

  function scheduleRefresh() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => void refresh(), 150);
  }

  window.__codexPlusGeneratedImagesObserver?.disconnect();
  window.__codexPlusGeneratedImagesObserver = new MutationObserver(scheduleRefresh);
  window.__codexPlusGeneratedImagesObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
  scheduleRefresh();
})();
