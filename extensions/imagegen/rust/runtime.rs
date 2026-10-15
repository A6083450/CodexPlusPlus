pub async fn restore_native_image_generation(websocket_url: &str) -> anyhow::Result<serde_json::Value> {
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        crate::bridge::evaluate_script_with_await_promise(
            websocket_url,
            "(async () => await window.__codexPlusRestoreNativeImageGeneration?.() || {restored: 0, pending: 0})()",
            true,
        ),
    ).await.map_err(|_| anyhow::anyhow!("恢复原生生图会话超时"))??;
    Ok(response["result"]["result"]["value"].clone())
}
