use serde::{Deserialize, Serialize};

use super::config::{ProfileConfig, UiConfig};

pub const MAX_ID_BYTES: usize = 160;
pub const MAX_MODEL_BYTES: usize = 128;
pub const MAX_TOOL_NAME_BYTES: usize = 128;
pub const MAX_EMAIL_BYTES: usize = 320;
pub const MAX_PROFILE_TEXT_BYTES: usize = 128;
pub const MAX_PROFILE_AVATAR_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    ProtocolProxy,
    Renderer,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventMeta {
    pub source: UsageSource,
    pub session_id: String,
    pub turn_id: String,
    pub event_id: String,
    pub correlation_id: String,
    pub occurred_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenUsage {
    pub input: u64,
    pub cached_input: u64,
    pub cache_write: u64,
    pub output: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TokenCostEvent {
    TurnStarted {
        meta: EventMeta,
        model: String,
        fast: bool,
    },
    OutputDelta {
        meta: EventMeta,
        estimated_output_tokens: u64,
    },
    ToolStarted {
        meta: EventMeta,
        call_id: String,
        name: String,
    },
    ToolCompleted {
        meta: EventMeta,
        call_id: String,
    },
    Usage {
        meta: EventMeta,
        usage: TokenUsage,
        exact: bool,
    },
    TurnCompleted {
        meta: EventMeta,
        usage: Option<TokenUsage>,
    },
    TurnFailed {
        meta: EventMeta,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelPrice {
    pub input_nanos_per_million: u64,
    pub cached_input_nanos_per_million: Option<u64>,
    pub cache_write_nanos_per_million: Option<u64>,
    pub output_nanos_per_million: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TokenCostAction {
    SetVisibility {
        instance_id: String,
        hub_visible: bool,
        output_rate_visible: bool,
        profile_visible: bool,
    },
    SavePrice {
        instance_id: String,
        model: String,
        price: ModelPrice,
    },
    DeletePrice {
        instance_id: String,
        model: String,
    },
    ResetPrice {
        instance_id: String,
        model: String,
    },
    SaveProfile {
        instance_id: String,
        profile: ProfileConfig,
    },
    QueryAnalytics {
        instance_id: String,
        range: AnalyticsRange,
        model: Option<String>,
    },
    SyncCcSwitch {
        instance_id: String,
    },
    QueryDiagnostics {
        instance_id: String,
    },
    DisposeInstance {
        instance_id: String,
    },
}

impl TokenCostAction {
    pub(crate) fn instance_id(&self) -> &str {
        match self {
            Self::SetVisibility { instance_id, .. }
            | Self::SavePrice { instance_id, .. }
            | Self::DeletePrice { instance_id, .. }
            | Self::ResetPrice { instance_id, .. }
            | Self::SaveProfile { instance_id, .. }
            | Self::QueryAnalytics { instance_id, .. }
            | Self::SyncCcSwitch { instance_id }
            | Self::QueryDiagnostics { instance_id }
            | Self::DisposeInstance { instance_id } => instance_id,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AnalyticsRange {
    Today,
    LastSevenDays,
    LastThirtyDays,
    Custom { from_day: String, to_day: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LazyAsset {
    Settings,
    Analytics,
    Profile,
    Flatpickr,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TokenCostActionResponse {
    Updated {
        config: UiConfig,
        snapshot: TokenCostSnapshot,
    },
    Analytics {
        analytics: AnalyticsSnapshot,
    },
    Synced {
        imported_turns: u32,
        analytics: AnalyticsSnapshot,
    },
    Diagnostics {
        diagnostics: TokenCostDiagnostics,
    },
    Disposed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsSnapshot {
    pub from_day: String,
    pub to_day: String,
    pub totals: AnalyticsTotals,
    pub days: Vec<AnalyticsDay>,
    pub models: Vec<AnalyticsModel>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsTotals {
    pub turns: u32,
    pub steps: u32,
    pub input: u64,
    pub cached_input: u64,
    pub cache_write: u64,
    pub output: u64,
    pub cost_nanos: u64,
    pub llm_ms: u64,
    pub tool_ms: u64,
    pub first_token_total_ms: u64,
    pub first_token_samples: u32,
    pub generation_ms: u64,
    pub generation_output_tokens: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsDay {
    pub day: String,
    pub totals: AnalyticsTotals,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsModel {
    pub model: String,
    pub totals: AnalyticsTotals,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct TokenCostDiagnostics {
    pub events_ingested: u64,
    pub events_coalesced: u64,
    pub events_rejected: u64,
    pub queue_depth: u64,
    pub queue_high_water: u64,
    pub recent_turns: u64,
    pub dedupe_fingerprints: u64,
    pub snapshots_published: u64,
    pub snapshots_sent: u64,
    pub lazy_commands_sent: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SnapshotPush {
    Snapshot {
        instance_id: String,
        snapshot: TokenCostSnapshot,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LazyAssetPush {
    pub instance_id: String,
    pub asset: LazyAsset,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TokenCostBootstrap {
    pub instance_id: String,
    pub config: UiConfig,
    pub snapshot: TokenCostSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TokenCostSnapshot {
    pub revision: u64,
    pub running: bool,
    pub model: String,
    pub fast: bool,
    pub turns: u32,
    pub steps: u32,
    pub llm_ms: u64,
    pub tool_ms: u64,
    pub first_token_average_ms: Option<u64>,
    pub output_rate_milli_tokens_per_second: u64,
    pub input: u64,
    pub cached_input: u64,
    pub output: u64,
    pub cost_nanos: u64,
    pub hub_visible: bool,
    pub output_rate_visible: bool,
    pub profile_visible: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IngestOutcome {
    Applied { revision: u64 },
    NoChange { revision: u64 },
    Coalesced { revision: u64 },
    Rejected { reason: &'static str },
}
