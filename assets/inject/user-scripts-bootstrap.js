(() => {
  if (window.top !== window || window.self !== window || !window.electronBridge || !/^app:\/\/\-\//i.test(window.location.href)) return;
  if (window.__codexPlusUserScriptsBootstrap) return;
  window.__codexPlusUserScriptsBootstrap = true;
  let loading = false;
  let retryAfterFailure = false;
  const load = async () => {
    // 新文档中的 DOM 与 Bridge 可能先后就绪，两者齐备才发起加载。
    if (loading || document.readyState === "loading" || typeof window.__codexSessionDeleteBridge !== "function") return;
    loading = true;
    retryAfterFailure = false;
    try {
      // 每次页面加载都读取当前文件与开关，不保留启动时的旧脚本副本。
      const result = await window.__codexSessionDeleteBridge("/user-scripts/load", {});
      if (result?.status === "failed") throw new Error(result.message || "用户脚本加载失败");
      window.removeEventListener("codex-plus-bridge-ready", onBridgeReady);
      window.dispatchEvent(new Event("codex-plus-user-scripts-loaded"));
    } catch (error) {
      // 保留就绪监听；桥接重连后可以重试，不把一次启动失败锁死。
      loading = false;
      console.warn("[Codex++] user scripts:", error);
      if (retryAfterFailure) void load();
    }
  };
  // 重连通知可能先于旧请求的 catch，记下重试，但成功时不重复加载。
  const onBridgeReady = () => {
    if (loading) retryAfterFailure = true;
    else void load();
  };
  window.addEventListener("codex-plus-bridge-ready", onBridgeReady);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load, { once: true });
  else load();
})();
