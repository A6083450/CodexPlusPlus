//! Computer Use 的应用级审批。
//!
//! Codex 的原生 CU server 在「首次接管某个 app」时会发 `elicitation/create`
//! （`Allow ChatGPT to use "Finder"?`），并**阻塞到有人答复为止**。答复有三档：
//! `accept` / `decline` / `cancel`。
//!
//! 这里提供两种策略（`BackendSettings::computer_use_approval`）：
//!
//! - `auto`：代理自己答 `accept`，只留痕。信任调用方的场景用这个。
//! - `claude`：把请求原样转给 MCP 客户端，由 Claude 侧弹卡。
//!
//! 记忆过的允许（`approvals.json`）在两种模式下都直接放行——用户已经表达过
//! 「这个 app 不必再问」。撤销即删除对应条目。
//!
//! 文件落在 state 目录下（`<state>/cu/approvals.json`），与 `elicitation.log` 同级。

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::Context;
use serde::{Deserialize, Serialize};

const APPROVALS_FILE: &str = "cu/approvals.json";
const AUDIT_FILE: &str = "cu/audit.jsonl";
const LAST_CLIENT_FILE: &str = "cu/last-client.json";
/// 管理器自检握手时用的客户端名，见 `computer_use::run_probe`。
pub const SELF_CHECK_CLIENT: &str = "codex-plus";

/// 记下最近一次连上来的 MCP 客户端，以及它**自己**有没有声明 elicitation。
///
/// `claude` 模式依赖客户端能弹审批卡；客户端不支持时代理会退回放行。
/// 这个降级必须让用户在页面上看得见，否则会误以为一直在手动审批。
pub fn record_client(client_info: Option<&serde_json::Value>, supports_elicitation: bool) {
    // 管理器自检也走这条入口（clientInfo.name = "codex-plus"），不能让它盖掉真实客户端。
    if client_info
        .and_then(|info| info.get("name"))
        .and_then(serde_json::Value::as_str)
        == Some(SELF_CHECK_CLIENT)
    {
        return;
    }
    let record = serde_json::json!({
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0),
        "name": client_info.and_then(|info| info.get("name")).cloned(),
        "version": client_info.and_then(|info| info.get("version")).cloned(),
        "elicitation": supports_elicitation,
    });
    let path = crate::paths::default_app_state_dir().join(LAST_CLIENT_FILE);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, format!("{record}\n"));
}

pub fn last_client() -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(crate::paths::default_app_state_dir().join(LAST_CLIENT_FILE))
        .ok()?;
    serde_json::from_str(&text).ok()
}

/// 审批策略。字符串形式与 `settings.json` 和前端下拉框一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalMode {
    /// 代理就地放行。
    Auto,
    /// 转给 MCP 客户端审批。
    Claude,
}

impl ApprovalMode {
    pub fn parse(value: &str) -> Self {
        match value {
            "claude" => Self::Claude,
            // 未知取值一律按默认处理：settings.json 里可能有旧版本或手写的值。
            _ => Self::Auto,
        }
    }

    /// 从设置文件现读。读失败按默认处理，不让审批链因为读配置挂掉。
    pub fn current() -> Self {
        let value = crate::settings::SettingsStore::default()
            .load()
            .map(|settings| settings.computer_use_approval)
            .unwrap_or_default();
        Self::parse(&value)
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Claude => "claude",
        }
    }
}

/// 记忆下来的决定。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppApproval {
    /// `allow` 或 `deny`。
    pub decision: String,
    /// `always`（跨会话）或 `session`（仅当次进程）。
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub decided_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalStore {
    #[serde(default = "default_version")]
    pub version: u32,
    /// bundle id -> 决定。没有 bundle id 的条目用显示名当键。
    #[serde(default)]
    pub apps: BTreeMap<String, AppApproval>,
}

fn default_version() -> u32 {
    1
}

fn path() -> PathBuf {
    crate::paths::default_app_state_dir().join(APPROVALS_FILE)
}

impl ApprovalStore {
    pub fn load() -> Self {
        let Ok(text) = std::fs::read_to_string(path()) else {
            return Self::default();
        };
        // 文件坏了就当空的：审批记录丢了只会多问一次，不会误放行。
        serde_json::from_str(&text).unwrap_or_default()
    }

    pub fn read_all() -> Vec<(String, AppApproval)> {
        Self::load().apps.into_iter().collect()
    }

    /// 记忆一个决定。`always` 才落盘，`session` 不写。
    pub fn remember(key: &str, approval: AppApproval) -> anyhow::Result<()> {
        if approval.mode != "always" {
            return Ok(());
        }
        let mut store = Self::load();
        store.version = 1;
        store.apps.insert(key.to_string(), approval);
        store.save()
    }

    pub fn forget(key: &str) -> anyhow::Result<bool> {
        let mut store = Self::load();
        if store.apps.remove(key).is_none() {
            return Ok(false);
        }
        store.save()?;
        Ok(true)
    }

    pub fn clear() -> anyhow::Result<()> {
        let mut store = Self::load();
        store.apps.clear();
        store.save()
    }

    fn save(&self) -> anyhow::Result<()> {
        let path = path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("无法创建目录 {}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(self)?;
        // 先写临时文件再改名：审批文件被写坏会导致用户被反复追问。
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, format!("{text}\n"))
            .with_context(|| format!("无法写入 {}", temp.display()))?;
        std::fs::rename(&temp, &path).with_context(|| format!("无法替换 {}", path.display()))?;
        Ok(())
    }
}

/// 一次审批的结局，用于留痕。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// 记忆命中，直接放行。
    Remembered,
    /// `auto` 模式就地放行。
    AutoAccepted,
    /// 客户端批准。
    ClientAccepted,
    /// 客户端拒绝。
    ClientDeclined,
    /// 客户端取消或超时。
    ClientCanceled,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Remembered => "remembered",
            Self::AutoAccepted => "auto-accepted",
            Self::ClientAccepted => "client-accepted",
            Self::ClientDeclined => "client-declined",
            Self::ClientCanceled => "client-canceled",
        }
    }

    pub fn accepted(self) -> bool {
        matches!(
            self,
            Self::Remembered | Self::AutoAccepted | Self::ClientAccepted
        )
    }
}

/// 从 elicitation 参数里认出「针对哪个 app」。
///
/// 原生发的是 `Allow ChatGPT to use "Finder"?`，`_meta` 里没有 bundle id；
/// 更完整的一版（code-mode 路径）带 `tool_params.app`。两条都认。
pub fn subject_of(params: &serde_json::Value) -> (String, String) {
    let meta = params.get("_meta");
    let bundle = meta
        .and_then(|meta| meta.get("tool_params"))
        .and_then(|params| params.get("app"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let display = meta
        .and_then(|meta| meta.get("tool_params_display"))
        .and_then(serde_json::Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("value"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .or_else(|| quoted_name(params.get("message").and_then(serde_json::Value::as_str)))
        .unwrap_or_default();
    let key = if bundle.is_empty() {
        display.clone()
    } else {
        bundle.to_string()
    };
    (key, display)
}

/// 从 `Allow ChatGPT to use "Finder"?` 里取出 `Finder`。
fn quoted_name(message: Option<&str>) -> Option<String> {
    let message = message?;
    let start = message.find('"')?;
    let rest = &message[start + 1..];
    let end = rest.find('"')?;
    let name = rest[..end].trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// 追加一条审计记录。只记 app 与结果，不记输入内容。
pub fn audit(params: &serde_json::Value, mode: ApprovalMode, outcome: Outcome) {
    let (key, display) = subject_of(params);
    let record = serde_json::json!({
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0),
        "app": key,
        "displayName": display,
        "mode": mode.id(),
        "outcome": outcome.as_str(),
    });
    let path = crate::paths::default_app_state_dir().join(AUDIT_FILE);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write as _;
        let _ = writeln!(file, "{record}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_app_name_from_native_message() {
        let params = serde_json::json!({ "message": "Allow ChatGPT to use \"Finder\"?" });
        let (key, display) = subject_of(&params);
        assert_eq!(key, "Finder");
        assert_eq!(display, "Finder");
    }

    #[test]
    fn prefers_bundle_id_when_meta_carries_it() {
        let params = serde_json::json!({
            "message": "Allow Computer Use to use \"Finder\"?",
            "_meta": {
                "tool_params": { "app": "com.apple.finder" },
                "tool_params_display": [{ "name": "app", "value": "Finder" }]
            }
        });
        let (key, display) = subject_of(&params);
        assert_eq!(key, "com.apple.finder");
        assert_eq!(display, "Finder");
    }

    #[test]
    fn missing_message_yields_empty_subject() {
        let params = serde_json::json!({});
        assert_eq!(subject_of(&params).0, "");
    }

    #[test]
    fn approval_mode_parses_known_values_and_defaults_otherwise() {
        assert_eq!(ApprovalMode::parse("auto"), ApprovalMode::Auto);
        assert_eq!(ApprovalMode::parse("claude"), ApprovalMode::Claude);
        // 手写或旧版本的值不能让审批链挂掉。
        assert_eq!(ApprovalMode::parse(""), ApprovalMode::Auto);
        assert_eq!(ApprovalMode::parse("whatever"), ApprovalMode::Auto);
    }

    #[test]
    fn outcome_acceptance_matches_semantics() {
        assert!(Outcome::Remembered.accepted());
        assert!(Outcome::AutoAccepted.accepted());
        assert!(Outcome::ClientAccepted.accepted());
        assert!(!Outcome::ClientDeclined.accepted());
        assert!(!Outcome::ClientCanceled.accepted());
    }
}
