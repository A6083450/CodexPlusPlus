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

  function responseTargets() {
    return Array.from(document.querySelectorAll("[data-response-annotation-target]"));
  }

  function findResponseTarget(messageId, responseIndex, targets) {
    if (messageId) {
      const exact = targets.find(
        (target) => target.getAttribute("data-response-annotation-target") === messageId,
      );
      if (exact) return exact;
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

  function openPreview(sourceImage) {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("data-codex-generated-image-preview", "true");
    dialog.setAttribute("aria-label", "图片预览");
    dialog.className = "codex-dialog left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none fixed pointer-events-none inset-0 !left-0 !top-0 max-w-none !translate-x-0 !translate-y-0 overflow-visible rounded-none bg-transparent p-0 shadow-none ring-0 backdrop-blur-none fixed h-[100dvh] w-screen";
    dialog.style.cssText = "height:calc(100dvh);width:calc(100vw);pointer-events:auto;";
    const backdropStyle = document.createElement("style");
    backdropStyle.textContent = "dialog[data-codex-generated-image-preview]::backdrop{background:rgba(0,0,0,.9)}";
    const viewer = document.createElement("div");
    viewer.className = "pointer-events-auto flex flex-col items-center justify-center relative size-full pb-8 pt-12 px-4 sm:px-8";

    const topControls = document.createElement("div");
    topControls.className = "absolute top-3 right-3 z-10 flex items-center gap-2";
    const topControlClass = "no-drag pointer-events-auto flex cursor-interaction items-center justify-center rounded-full bg-token-editor-background/95 text-token-foreground shadow-md ring-1 ring-black/5 backdrop-blur-sm transition-transform hover:bg-token-menu-background hover:ring-token-focus-border focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 h-10 min-w-10 px-3";
    const download = document.createElement("a");
    download.className = topControlClass;
    download.setAttribute("href", sourceImage.src);
    download.setAttribute("download", sourceImage.alt);
    download.setAttribute("aria-label", "下载图片");
    download.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs"><path d="M2.66831 12.6664V12.5004C2.66831 12.1331 2.96607 11.8353 3.33334 11.8353C3.70061 11.8353 3.99838 12.1331 3.99838 12.5004V12.6664C3.99838 13.3773 3.99929 13.8708 4.03061 14.2543C4.0613 14.6299 4.11812 14.8414 4.19858 14.9994L4.26889 15.1263C4.4452 15.4138 4.69823 15.6482 5.00034 15.8021L5.13022 15.8578C5.27399 15.9092 5.4635 15.9471 5.74545 15.9701C6.12897 16.0014 6.62231 16.0013 7.33334 16.0013H12.6664C13.3772 16.0013 13.8708 16.0014 14.2542 15.9701C14.6296 15.9394 14.8414 15.8825 14.9994 15.8021L15.1263 15.7308C15.4137 15.5545 15.6482 15.3014 15.8021 14.9994L15.8578 14.8695C15.9092 14.7258 15.947 14.5361 15.9701 14.2543C16.0014 13.8708 16.0013 13.3772 16.0013 12.6664V12.5004C16.0013 12.1332 16.2992 11.8355 16.6664 11.8353C17.0336 11.8353 17.3314 12.1331 17.3314 12.5004V12.6664C17.3314 13.3554 17.332 13.9125 17.2953 14.3627C17.2625 14.7636 17.1975 15.1248 17.0531 15.4613L16.9867 15.6039C16.7212 16.1248 16.3173 16.5606 15.8216 16.8646L15.6039 16.9867C15.2271 17.1787 14.8206 17.2579 14.3626 17.2953C13.9124 17.3321 13.3554 17.3314 12.6664 17.3314H7.33334C6.64425 17.3314 6.0873 17.3321 5.63706 17.2953C5.23651 17.2626 4.87562 17.1982 4.5394 17.0541L4.39682 16.9867C3.8757 16.7212 3.4392 16.3175 3.1351 15.8217L3.01303 15.6039C2.82106 15.2271 2.74186 14.8207 2.70444 14.3627C2.66767 13.9125 2.66831 13.3554 2.66831 12.6664ZM9.3353 3.33337C9.3353 2.9661 9.63307 2.66833 10.0003 2.66833C10.3675 2.66851 10.6654 2.96621 10.6654 3.33337V10.8939L12.8626 8.69666L12.9671 8.61169C13.2253 8.44097 13.5767 8.4693 13.804 8.69666C14.0634 8.95633 14.0635 9.37748 13.804 9.63708L10.4701 12.9701C10.3454 13.0947 10.1766 13.1653 10.0003 13.1654C9.82397 13.1654 9.65434 13.0948 9.52963 12.9701L6.19663 9.63708L6.11166 9.53259C5.9411 9.27445 5.96934 8.92394 6.19663 8.69666C6.42392 8.46937 6.77442 8.44113 7.03256 8.61169L7.13705 8.69666L9.3353 10.8949V3.33337Z" fill="currentColor"></path></svg>';
    const close = document.createElement("button");
    close.type = "button";
    close.className = topControlClass;
    close.setAttribute("aria-label", "关闭图片预览");
    close.innerHTML = '<svg width="21" height="21" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm"><path d="M14.6549 5.57307C14.9283 5.2997 15.3718 5.2997 15.6451 5.57307C15.9185 5.84643 15.9185 6.28993 15.6451 6.5633L11.3903 10.8182L15.6451 15.0731L15.735 15.1834C15.9141 15.4551 15.8842 15.8242 15.6451 16.0633C15.4061 16.3024 15.0369 16.3322 14.7653 16.1531L14.6549 16.0633L10.4 11.8084L6.14515 16.0633C5.87178 16.3367 5.42828 16.3367 5.15492 16.0633C4.88155 15.7899 4.88155 15.3464 5.15492 15.0731L9.4098 10.8182L5.15492 6.5633L5.06507 6.45295C4.88597 6.18128 4.91584 5.81214 5.15492 5.57307C5.39399 5.33399 5.76313 5.30413 6.0348 5.48322L6.14515 5.57307L10.4 9.82795L14.6549 5.57307Z" fill="currentColor"></path></svg>';
    close.addEventListener("click", () => dialog.close());
    topControls.appendChild(download);
    topControls.appendChild(close);
    viewer.appendChild(topControls);

    const viewport = document.createElement("div");
    viewport.setAttribute("data-codex-generated-image-preview-viewport", "true");
    viewport.className = "flex min-h-0 w-full flex-1 touch-none items-start justify-start overflow-auto";
    const previewImage = document.createElement("img");
    previewImage.alt = sourceImage.alt;
    previewImage.src = sourceImage.src;
    previewImage.className = "m-auto rounded-lg object-contain block max-w-none";
    viewport.appendChild(previewImage);
    viewer.appendChild(viewport);

    const bottomControls = document.createElement("div");
    bottomControls.className = "z-10 mt-5 flex max-w-[min(48rem,calc(100vw-2rem))] flex-col items-center gap-3 text-token-foreground";
    const title = document.createElement("div");
    title.setAttribute("data-codex-generated-image-preview-title", "true");
    title.className = "max-w-full rounded-2xl bg-token-editor-background/95 px-4 py-2 text-center text-sm shadow-md ring-1 ring-black/5 backdrop-blur-sm";
    title.textContent = sourceImage.alt;
    const zoomControls = document.createElement("div");
    zoomControls.className = "flex items-center gap-1 rounded-full bg-token-editor-background/95 p-1 shadow-md ring-1 ring-black/5 backdrop-blur-sm";
    const zoomControlClass = "no-drag flex size-9 cursor-interaction items-center justify-center rounded-full bg-token-foreground/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border disabled:cursor-not-allowed disabled:opacity-50";
    const zoomOut = document.createElement("button");
    zoomOut.type = "button";
    zoomOut.className = zoomControlClass;
    zoomOut.setAttribute("aria-label", "缩小图片");
    zoomOut.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs"><path d="M3.5 10.0002C3.5 9.63297 3.79777 9.33521 4.16504 9.33521H15.835C16.2022 9.33521 16.5 9.63297 16.5 10.0002C16.5 10.3675 16.2022 10.6652 15.835 10.6652H4.16504C3.79777 10.6652 3.5 10.3675 3.5 10.0002Z" fill="currentColor"></path></svg>';
    const zoomValue = document.createElement("div");
    zoomValue.className = "no-drag flex min-w-16 items-center justify-center px-2 text-center text-sm tabular-nums";
    const zoomLevel = document.createElement("span");
    zoomLevel.setAttribute("data-codex-generated-image-zoom-level", "true");
    zoomValue.appendChild(zoomLevel);
    const zoomIn = document.createElement("button");
    zoomIn.type = "button";
    zoomIn.className = zoomControlClass;
    zoomIn.setAttribute("aria-label", "放大图片");
    zoomIn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs"><path d="M9.33496 16.5V10.665H3.5C3.13273 10.665 2.83496 10.3673 2.83496 10C2.83496 9.63273 3.13273 9.33496 3.5 9.33496H9.33496V3.5C9.33496 3.13273 9.63273 2.83496 10 2.83496C10.3673 2.83496 10.665 3.13273 10.665 3.5V9.33496H16.5L16.6338 9.34863C16.9369 9.41057 17.165 9.67857 17.165 10C17.165 10.3214 16.9369 10.5894 16.6338 10.6514L16.5 10.665H10.665V16.5C10.665 16.8673 10.3673 17.165 10 17.165C9.63273 17.165 9.33496 16.8673 9.33496 16.5Z" fill="currentColor"></path></svg>';
    zoomControls.appendChild(zoomOut);
    zoomControls.appendChild(zoomValue);
    zoomControls.appendChild(zoomIn);
    bottomControls.appendChild(title);
    bottomControls.appendChild(zoomControls);
    viewer.appendChild(bottomControls);
    dialog.appendChild(viewer);
    dialog.appendChild(backdropStyle);

    const naturalWidth = Math.max(1, sourceImage.naturalWidth || 1);
    const naturalHeight = Math.max(1, sourceImage.naturalHeight || 1);
    const fitScale = Math.min(
      1,
      Math.max(1, window.innerWidth - 64) / naturalWidth,
      Math.max(1, window.innerHeight - 190) / naturalHeight,
    );
    const zoomLevels = [0.25, 0.5, 0.75, fitScale, 1, 1.25, 1.5, 2]
      .sort((left, right) => left - right)
      .filter((scale, index, levels) => index === 0 || Math.abs(scale - levels[index - 1]) > 0.001);
    let zoomIndex = zoomLevels.findIndex((scale) => Math.abs(scale - fitScale) < 0.001);
    function renderZoom() {
      const scale = zoomLevels[zoomIndex];
      previewImage.style.width = `${naturalWidth * scale}px`;
      previewImage.style.height = `${naturalHeight * scale}px`;
      zoomLevel.textContent = `${Math.round(scale * 100)}%`;
      zoomOut.disabled = zoomIndex === 0;
      zoomIn.disabled = zoomIndex === zoomLevels.length - 1;
    }
    zoomOut.addEventListener("click", () => {
      if (zoomIndex === 0) return;
      zoomIndex -= 1;
      renderZoom();
    });
    zoomIn.addEventListener("click", () => {
      if (zoomIndex === zoomLevels.length - 1) return;
      zoomIndex += 1;
      renderZoom();
    });
    renderZoom();

    dialog.addEventListener("close", () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  function renderImages(images, targets) {
    images.forEach((image) => {
      if (!image?.id || !image?.base64_data) return;
      const existing = Array.from(document.querySelectorAll("[data-codex-generated-image-id]")).find(
        (element) => element.getAttribute("data-codex-generated-image-id") === image.id,
      );
      if (existing && existing.parentElement?.getAttribute("data-codex-generated-image-preview-trigger") !== null) {
        return;
      }
      if (existing && existing.parentElement?.getAttribute("data-codex-generated-images") !== null) {
        existing.parentElement.remove();
      }
      const target = findResponseTarget(
        image.assistant_message_id,
        image.assistant_response_index,
        targets,
      );
      if (!target) return;
      const markdown = Array.from(target.children).find(
        (child) => child.getAttribute?.("data-selected-text-overlay-target") !== null,
      ) || target;
      let container = markdown.querySelector(":scope > [data-codex-generated-images]");
      if (!container) {
        container = document.createElement("div");
        container.setAttribute("data-codex-generated-images", "true");
        container.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;max-width:100%;";
        markdown.appendChild(container);
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
      trigger.addEventListener("click", () => openPreview(element));
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
      if (result?.status === "found" && Array.isArray(result.images)) {
        state.images = result.images;
        renderImages(state.images, responseTargets());
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
