//! Computer Use 接入命令。
//!
//! 只暴露给管理器前端；不注册到用户脚本路由，也不经过 HTTP 层。
//! 具体行为都在 `codex_plus_core::computer_use` 里，这里只做参数解析与提示文案。

use serde_json::{Value, json};

use crate::commands::{CommandResult, failed, ok};

async fn run_blocking<T, F>(run: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|error| format!("任务执行失败：{error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn computer_use_status() -> CommandResult<Value> {
    match run_blocking(codex_plus_core::computer_use::status).await {
        Ok(report) => {
            let message = if report.runtime_found {
                "已找到 Codex 运行时。"
            } else {
                "未找到 ChatGPT.app，Computer Use 暂时不可接入。"
            };
            ok(message, serde_json::to_value(report).unwrap_or_else(|_| json!({})))
        }
        Err(error) => failed(&error, json!({})),
    }
}

#[tauri::command]
pub async fn computer_use_install(target: String) -> CommandResult<Value> {
    let parsed = match codex_plus_core::computer_use::Target::parse(&target) {
        Ok(target) => target,
        Err(error) => return failed(&error.to_string(), json!({})),
    };
    match run_blocking(move || codex_plus_core::computer_use::install(parsed)).await {
        Ok(receipt) => {
            // 只有 Claude Code 有 hooks。装完 MCP 顺手挂上回合结束钩子，
            // 否则浏览器标签不会在回合结束时清理（见 claude_hooks 模块注释）。
            let hooks = if parsed == codex_plus_core::computer_use::Target::ClaudeCode {
                codex_plus_core::claude_hooks::install().ok()
            } else {
                None
            };
            let message = if receipt.changed {
                "已接入；重启对应客户端后生效。"
            } else {
                "已是接入状态，无需改动。"
            };
            // 前端的 `CuMutation` 直接读 payload 顶层的 `changed` / `backupPath`，
            // 所以钩子信息是追加字段，不能把 receipt 再包一层。
            let mut payload = serde_json::to_value(receipt).unwrap_or_else(|_| json!({}));
            if let Some(object) = payload.as_object_mut() {
                object.insert("hooks".into(), json!(hooks));
            }
            ok(message, payload)
        }
        Err(error) => failed(&error, json!({})),
    }
}

#[tauri::command]
pub async fn computer_use_uninstall(target: String) -> CommandResult<Value> {
    let parsed = match codex_plus_core::computer_use::Target::parse(&target) {
        Ok(target) => target,
        Err(error) => return failed(&error.to_string(), json!({})),
    };
    match run_blocking(move || codex_plus_core::computer_use::uninstall(parsed)).await {
        Ok(receipt) => {
            // 撤掉接入时同步摘掉回合结束钩子，别在用户不用的客户端里留一条空命令。
            let hooks = if parsed == codex_plus_core::computer_use::Target::ClaudeCode {
                codex_plus_core::claude_hooks::uninstall().ok()
            } else {
                None
            };
            let message = if receipt.changed {
                "已移除接入；原配置已备份。"
            } else {
                "本来就没有接入，未改动配置。"
            };
            let mut payload = serde_json::to_value(receipt).unwrap_or_else(|_| json!({}));
            if let Some(object) = payload.as_object_mut() {
                object.insert("hooks".into(), json!(hooks));
            }
            ok(message, payload)
        }
        Err(error) => failed(&error, json!({})),
    }
}

#[tauri::command]
pub async fn computer_use_check() -> CommandResult<Value> {
    match run_blocking(|| Ok(codex_plus_core::computer_use::check())).await {
        Ok(report) => {
            let message = if report.ok {
                format!(
                    "自检通过：识别到 {} 个应用，用时 {} ms。",
                    report.app_count.unwrap_or(0),
                    report.duration_ms
                )
            } else {
                report
                    .failure_detail
                    .clone()
                    .unwrap_or_else(|| "自检失败。".to_string())
            };
            ok(
                &message,
                serde_json::to_value(report).unwrap_or_else(|_| json!({})),
            )
        }
        Err(error) => failed(&error, json!({})),
    }
}

/// 打开 ChatGPT.app。运行时缺失时给用户一个明确的下一步动作。
#[tauri::command]
pub async fn computer_use_open_app() -> CommandResult<Value> {
    let result = run_blocking(|| -> anyhow::Result<String> {
        let runtime = codex_plus_core::computer_use::locate_runtime()?
            .ok_or_else(|| anyhow::anyhow!("未找到 ChatGPT.app"))?;
        Ok(runtime.app_path)
    })
    .await;
    match result {
        Ok(app_path) => {
            let status = std::process::Command::new("open")
                .arg(&app_path)
                .status();
            match status {
                Ok(status) if status.success() => ok(
                    "已打开 ChatGPT；请确认 Computer Use 的辅助功能与屏幕录制权限已授予。",
                    json!({ "appPath": app_path }),
                ),
                Ok(status) => failed(
                    &format!("打开 ChatGPT 失败（退出码 {:?}）", status.code()),
                    json!({ "appPath": app_path }),
                ),
                Err(error) => failed(&format!("打开 ChatGPT 失败：{error}"), json!({})),
            }
        }
        Err(error) => failed(&error, json!({})),
    }
}

// ---------------------------------------------------------------------------
// 审批
// ---------------------------------------------------------------------------

/// 当前审批策略与已记忆的应用。
///
/// `auto` = 全部放行（只留痕）；`claude` = 交给 MCP 客户端审批。
#[tauri::command]
pub async fn computer_use_approval_get() -> CommandResult<Value> {
    let mode = codex_plus_core::computer_use_approval::ApprovalMode::current();
    ok(
        "已读取审批策略。",
        json!({
            "mode": mode.id(),
            "approvals": codex_plus_core::computer_use_approval::ApprovalStore::read_all(),
            "lastClient": codex_plus_core::computer_use_approval::last_client(),
            // 浏览器标签的清理靠 Claude Code 的 Stop 钩子；装上没有要在页面上说清楚。
            "turnHooks": {
                "installed": codex_plus_core::claude_hooks::is_installed(),
                "events": codex_plus_core::claude_hooks::installed_events(),
                "settings": codex_plus_core::claude_hooks::claude_settings_path().display().to_string(),
            },
        }),
    )
}

/// 切换审批策略。写进 `settings.json` 的 `computerUseApproval`。
///
/// 只改这一个键：设置里还有几十个互不相关的字段，整份回写会把并发改动冲掉。
#[tauri::command]
pub async fn computer_use_approval_set(mode: String) -> CommandResult<Value> {
    if !matches!(mode.as_str(), "auto" | "claude") {
        return failed("审批策略只能是 auto 或 claude", json!({}));
    }
    match run_blocking(move || -> anyhow::Result<()> {
        let store = codex_plus_core::settings::SettingsStore::default();
        let mut settings = store.load()?;
        settings.computer_use_approval = mode;
        store.save(&settings)?;
        Ok(())
    })
    .await
    {
        Ok(()) => ok("审批策略已保存；对下一个 Claude 会话生效。", json!({})),
        Err(error) => failed(&error, json!({})),
    }
}

/// 撤销某个应用的审批记忆。
#[tauri::command]
pub async fn computer_use_approval_forget(app: String) -> CommandResult<Value> {
    match run_blocking(move || codex_plus_core::computer_use_approval::ApprovalStore::forget(&app))
        .await
    {
        Ok(true) => ok("已撤销该应用的审批记忆。", json!({})),
        Ok(false) => ok("没有找到该应用的审批记录。", json!({})),
        Err(error) => failed(&error, json!({})),
    }
}

/// 清空全部审批记忆。
#[tauri::command]
pub async fn computer_use_approval_clear() -> CommandResult<Value> {
    match run_blocking(codex_plus_core::computer_use_approval::ApprovalStore::clear).await {
        Ok(()) => ok("已清空全部审批记忆。", json!({})),
        Err(error) => failed(&error, json!({})),
    }
}
