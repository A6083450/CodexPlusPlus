use serde::{Deserialize, Serialize};

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
