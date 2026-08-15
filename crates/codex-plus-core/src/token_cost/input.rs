use anyhow::ensure;
use serde::de::value::MapAccessDeserializer;
use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::fmt;

use super::{
    EventMeta, MAX_ID_BYTES, MAX_MODEL_BYTES, MAX_RENDERER_EVENT_BYTES, MAX_SSE_FRAME_BYTES,
    MAX_TOOL_NAME_BYTES, TokenCostEvent, TokenUsage, UsageSource,
};

const MAX_ESCAPED_JSON_STRING_BYTES: usize = 1024 * 1024;
const MAX_NON_STREAM_JSON_DEPTH: usize = 64;

pub struct ResponsesUsageTap {
    state: UsageTapState,
}

pub struct ChatUsageTap {
    state: UsageTapState,
}

struct UsageTapState {
    request_id: u64,
    session_id: String,
    turn_id: String,
    correlation_id: String,
    model: String,
    fast: bool,
    announced_model: String,
    announced_fast: bool,
    sequence: u64,
    cumulative_output_bytes: u64,
    tail: Vec<u8>,
    separator: Vec<u8>,
    discarding_oversized_frame: bool,
    terminal_seen: bool,
}

#[derive(Clone, Copy)]
enum ProtocolKind {
    Responses,
    Chat,
}

#[derive(Debug)]
enum BoundedString<'a, const TRIM: bool> {
    Borrowed(&'a str),
    Owned(String),
    Ignored,
}

type BoundedModel<'a> = BoundedString<'a, true>;
type BoundedLiteral<'a> = BoundedString<'a, false>;

impl<const TRIM: bool> BoundedString<'_, TRIM> {
    fn as_str(&self) -> Option<&str> {
        match self {
            Self::Borrowed(value) => Some(value),
            Self::Owned(value) => Some(value),
            Self::Ignored => None,
        }
    }
}

struct BoundedStringVisitor<'a, const TRIM: bool>(std::marker::PhantomData<&'a str>);

impl<'de: 'a, 'a, const TRIM: bool> Visitor<'de> for BoundedStringVisitor<'a, TRIM> {
    type Value = BoundedString<'a, TRIM>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded identity string")
    }

    fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Self::Value, E> {
        let value = if TRIM { value.trim() } else { value };
        Ok(if !value.is_empty() && value.len() <= MAX_MODEL_BYTES {
            BoundedString::Borrowed(value)
        } else {
            BoundedString::Ignored
        })
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        let value = if TRIM { value.trim() } else { value };
        Ok(if !value.is_empty() && value.len() <= MAX_MODEL_BYTES {
            BoundedString::Owned(value.to_string())
        } else {
            BoundedString::Ignored
        })
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        let value = if TRIM { value.trim() } else { &value };
        if !value.is_empty() && value.len() <= MAX_MODEL_BYTES {
            Ok(BoundedString::Owned(value.to_string()))
        } else {
            Ok(BoundedString::Ignored)
        }
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(BoundedString::Ignored)
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(BoundedString::Ignored)
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(BoundedString::Ignored)
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(BoundedString::Ignored)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(BoundedString::Ignored)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(BoundedString::Ignored)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<IgnoredAny>()?.is_some() {}
        Ok(BoundedString::Ignored)
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(BoundedString::Ignored)
    }
}

impl<'de: 'a, 'a, const TRIM: bool> Deserialize<'de> for BoundedString<'a, TRIM> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(BoundedStringVisitor(std::marker::PhantomData))
    }
}

#[derive(Clone, Copy, Debug, Default)]
enum DirectNumber {
    #[default]
    Missing,
    Value(u64),
    Invalid,
}

impl DirectNumber {
    fn optional(self) -> Result<Option<u64>, ()> {
        match self {
            Self::Missing => Ok(None),
            Self::Value(value) => Ok(Some(value)),
            Self::Invalid => Err(()),
        }
    }
}

struct DirectNumberVisitor;

impl<'de> Visitor<'de> for DirectNumberVisitor {
    type Value = DirectNumber;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an unsigned integer")
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(DirectNumber::Value(value))
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(DirectNumber::Invalid)
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(DirectNumber::Invalid)
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(DirectNumber::Invalid)
    }

    fn visit_borrowed_str<E>(self, _value: &'de str) -> Result<Self::Value, E> {
        Ok(DirectNumber::Invalid)
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(DirectNumber::Invalid)
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
        Ok(DirectNumber::Invalid)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(DirectNumber::Invalid)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(DirectNumber::Invalid)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<IgnoredAny>()?.is_some() {}
        Ok(DirectNumber::Invalid)
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(DirectNumber::Invalid)
    }
}

impl<'de> Deserialize<'de> for DirectNumber {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(DirectNumberVisitor)
    }
}

#[derive(Debug, Default, Deserialize)]
struct DirectTokenDetails {
    #[serde(default)]
    cached_tokens: DirectNumber,
}

#[derive(Debug, Default)]
enum DirectDetailsField {
    #[default]
    Missing,
    Value(DirectTokenDetails),
    Invalid,
}

struct DirectDetailsVisitor;

impl<'de> Visitor<'de> for DirectDetailsVisitor {
    type Value = DirectDetailsField;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a direct token details object")
    }

    fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        DirectTokenDetails::deserialize(MapAccessDeserializer::new(map))
            .map(DirectDetailsField::Value)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<IgnoredAny>()?.is_some() {}
        Ok(DirectDetailsField::Invalid)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(DirectDetailsField::Invalid)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(DirectDetailsField::Invalid)
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(DirectDetailsField::Invalid)
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(DirectDetailsField::Invalid)
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(DirectDetailsField::Invalid)
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(DirectDetailsField::Invalid)
    }

    fn visit_borrowed_str<E>(self, _value: &'de str) -> Result<Self::Value, E> {
        Ok(DirectDetailsField::Invalid)
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(DirectDetailsField::Invalid)
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
        Ok(DirectDetailsField::Invalid)
    }
}

impl<'de> Deserialize<'de> for DirectDetailsField {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(DirectDetailsVisitor)
    }
}

#[derive(Debug, Default, Deserialize)]
struct DirectUsage {
    #[serde(default)]
    prompt_tokens: DirectNumber,
    #[serde(default)]
    input_tokens: DirectNumber,
    #[serde(default)]
    completion_tokens: DirectNumber,
    #[serde(default)]
    output_tokens: DirectNumber,
    #[serde(default)]
    total_tokens: DirectNumber,
    #[serde(default)]
    cache_read_input_tokens: DirectNumber,
    #[serde(default)]
    cache_creation_input_tokens: DirectNumber,
    #[serde(default)]
    cache_creation_5m_input_tokens: DirectNumber,
    #[serde(default)]
    cache_creation_1h_input_tokens: DirectNumber,
    #[serde(default)]
    prompt_tokens_details: DirectDetailsField,
    #[serde(default)]
    input_tokens_details: DirectDetailsField,
}

#[derive(Debug, Default)]
enum DirectUsageField {
    #[default]
    Missing,
    Value(DirectUsage),
    Invalid,
}

impl DirectUsageField {
    fn as_ref(&self) -> Option<&DirectUsage> {
        match self {
            Self::Value(usage) => Some(usage),
            Self::Missing | Self::Invalid => None,
        }
    }
}

struct DirectUsageVisitor;

impl<'de> Visitor<'de> for DirectUsageVisitor {
    type Value = DirectUsageField;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a direct usage object")
    }

    fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        DirectUsage::deserialize(MapAccessDeserializer::new(map)).map(DirectUsageField::Value)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<IgnoredAny>()?.is_some() {}
        Ok(DirectUsageField::Invalid)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(DirectUsageField::Invalid)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(DirectUsageField::Invalid)
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(DirectUsageField::Invalid)
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(DirectUsageField::Invalid)
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(DirectUsageField::Invalid)
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(DirectUsageField::Invalid)
    }

    fn visit_borrowed_str<E>(self, _value: &'de str) -> Result<Self::Value, E> {
        Ok(DirectUsageField::Invalid)
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(DirectUsageField::Invalid)
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
        Ok(DirectUsageField::Invalid)
    }
}

impl<'de> Deserialize<'de> for DirectUsageField {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(DirectUsageVisitor)
    }
}

#[derive(Debug, Deserialize)]
struct NonStreamEnvelope<'a> {
    #[serde(borrow, default)]
    object: Option<BoundedLiteral<'a>>,
    #[serde(borrow, default)]
    status: Option<BoundedLiteral<'a>>,
    #[serde(borrow, default)]
    model: Option<BoundedModel<'a>>,
    #[serde(borrow, default)]
    service_tier: Option<BoundedLiteral<'a>>,
    #[serde(default)]
    usage: DirectUsageField,
}

impl ResponsesUsageTap {
    pub fn from_request(request_id: u64, body: &[u8], now_ms: u64) -> (Self, Vec<TokenCostEvent>) {
        let (state, events) = UsageTapState::from_request(request_id, body, now_ms);
        (Self { state }, events)
    }

    pub fn push_bytes(&mut self, bytes: &[u8], now_ms: u64) -> Vec<TokenCostEvent> {
        self.state
            .push_bytes(ProtocolKind::Responses, bytes, now_ms)
    }

    pub fn finish(&mut self, now_ms: u64) -> Vec<TokenCostEvent> {
        self.state.finish(ProtocolKind::Responses, now_ms)
    }
}

impl ChatUsageTap {
    pub fn from_request(request_id: u64, body: &[u8], now_ms: u64) -> (Self, Vec<TokenCostEvent>) {
        let (state, events) = UsageTapState::from_request(request_id, body, now_ms);
        (Self { state }, events)
    }

    pub fn push_bytes(&mut self, bytes: &[u8], now_ms: u64) -> Vec<TokenCostEvent> {
        self.state.push_bytes(ProtocolKind::Chat, bytes, now_ms)
    }

    pub fn finish(&mut self, now_ms: u64) -> Vec<TokenCostEvent> {
        self.state.finish(ProtocolKind::Chat, now_ms)
    }
}

impl UsageTapState {
    fn from_request(request_id: u64, body: &[u8], now_ms: u64) -> (Self, Vec<TokenCostEvent>) {
        let value = serde_json::from_slice::<Value>(body).ok();
        let object = value.as_ref().and_then(Value::as_object);
        let connection_id = format!("proxy-{request_id}");
        let correlation_id = object
            .and_then(|object| bounded_object_string(object, "correlation_id", MAX_ID_BYTES))
            .or_else(|| {
                object.and_then(|object| {
                    bounded_object_string(object, "prompt_cache_key", MAX_ID_BYTES)
                })
            })
            .or_else(|| {
                object
                    .and_then(|object| bounded_object_string(object, "conversation", MAX_ID_BYTES))
            })
            .unwrap_or_else(|| connection_id.clone());
        let metadata = object
            .and_then(|object| object.get("metadata"))
            .and_then(Value::as_object);
        let session_id = metadata
            .and_then(|metadata| bounded_object_string(metadata, "thread_id", MAX_ID_BYTES))
            .unwrap_or_else(|| correlation_id.clone());
        let turn_id = metadata
            .and_then(|metadata| bounded_object_string(metadata, "turn_id", MAX_ID_BYTES))
            .unwrap_or_else(|| correlation_id.clone());
        let model = object
            .and_then(|object| bounded_object_string(object, "model", MAX_MODEL_BYTES))
            .unwrap_or_default();
        let fast = object
            .and_then(|object| object.get("service_tier"))
            .and_then(Value::as_str)
            == Some("priority");
        let mut state = Self {
            request_id,
            session_id,
            turn_id,
            correlation_id,
            model,
            fast,
            announced_model: String::new(),
            announced_fast: false,
            sequence: 0,
            cumulative_output_bytes: 0,
            tail: Vec::new(),
            separator: Vec::with_capacity(4),
            discarding_oversized_frame: false,
            terminal_seen: false,
        };
        let mut events = Vec::new();
        state.emit_turn_started_if_changed(now_ms, &mut events);
        (state, events)
    }

    fn push_bytes(&mut self, kind: ProtocolKind, bytes: &[u8], now_ms: u64) -> Vec<TokenCostEvent> {
        if self.terminal_seen {
            return Vec::new();
        }
        if self.tail.is_empty()
            && self.separator.is_empty()
            && !self.discarding_oversized_frame
            && bytes
                .iter()
                .find(|byte| !byte.is_ascii_whitespace())
                .is_some_and(|byte| *byte == b'{')
            && let Ok(envelope) = parse_non_stream_envelope(bytes)
        {
            let mut events = Vec::new();
            self.process_non_stream_envelope(kind, &envelope, now_ms, &mut events);
            return events;
        }
        let mut events = Vec::new();
        for &byte in bytes {
            if self.terminal_seen {
                break;
            }
            self.push_byte(kind, byte, now_ms, &mut events);
        }
        events
    }

    fn push_byte(
        &mut self,
        kind: ProtocolKind,
        byte: u8,
        now_ms: u64,
        events: &mut Vec<TokenCostEvent>,
    ) {
        if matches!(byte, b'\r' | b'\n') {
            self.separator.push(byte);
            loop {
                if self.separator == b"\n\n" || self.separator == b"\r\n\r\n" {
                    self.separator.clear();
                    self.complete_frame(kind, now_ms, events);
                    return;
                }
                if b"\n\n".starts_with(&self.separator) || b"\r\n\r\n".starts_with(&self.separator)
                {
                    return;
                }
                let first = self.separator.remove(0);
                self.append_frame_byte(first);
            }
        }

        let separator = std::mem::take(&mut self.separator);
        for separator_byte in separator {
            self.append_frame_byte(separator_byte);
        }
        self.append_frame_byte(byte);
    }

    fn append_frame_byte(&mut self, byte: u8) {
        if self.discarding_oversized_frame {
            return;
        }
        if self.tail.len() == MAX_SSE_FRAME_BYTES {
            self.tail.clear();
            self.discarding_oversized_frame = true;
            return;
        }
        self.tail.push(byte);
    }

    fn complete_frame(
        &mut self,
        kind: ProtocolKind,
        now_ms: u64,
        events: &mut Vec<TokenCostEvent>,
    ) {
        if self.discarding_oversized_frame {
            self.discarding_oversized_frame = false;
            self.tail.clear();
            return;
        }
        let frame = std::mem::take(&mut self.tail);
        self.process_sse_frame(kind, &frame, now_ms, events);
    }

    fn process_sse_frame(
        &mut self,
        kind: ProtocolKind,
        frame: &[u8],
        now_ms: u64,
        events: &mut Vec<TokenCostEvent>,
    ) -> bool {
        let mut saw_data = false;
        for line in frame.split(|byte| *byte == b'\n') {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            let Some(data) = line.strip_prefix(b"data:") else {
                continue;
            };
            saw_data = true;
            let data = data.strip_prefix(b" ").unwrap_or(data);
            if data == b"[DONE]" {
                self.emit_completed(None, now_ms, events);
                break;
            }
            let Ok(value) = serde_json::from_slice::<Value>(data) else {
                continue;
            };
            match kind {
                ProtocolKind::Responses => self.process_responses_value(&value, now_ms, events),
                ProtocolKind::Chat => self.process_chat_value(&value, now_ms, events),
            }
            if self.terminal_seen {
                break;
            }
        }
        saw_data
    }

    fn process_responses_value(
        &mut self,
        value: &Value,
        now_ms: u64,
        events: &mut Vec<TokenCostEvent>,
    ) {
        match value.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta" | "response.reasoning_summary_text.delta") => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    self.emit_delta(delta, now_ms, events);
                }
            }
            Some("response.completed") => {
                let response = value.get("response").and_then(Value::as_object);
                if let Some(response) = response {
                    self.update_model_and_tier(response, now_ms, events);
                }
                let usage = response
                    .and_then(|response| response.get("usage"))
                    .and_then(parse_responses_usage);
                self.emit_completed(usage, now_ms, events);
            }
            _ => {}
        }
    }

    fn process_chat_value(&mut self, value: &Value, now_ms: u64, events: &mut Vec<TokenCostEvent>) {
        if let Some(object) = value.as_object() {
            self.update_model_and_tier(object, now_ms, events);
        }
        if let Some(choices) = value.get("choices").and_then(Value::as_array) {
            for choice in choices {
                let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
                    continue;
                };
                if let Some(content) = delta.get("content").and_then(Value::as_str) {
                    self.emit_delta(content, now_ms, events);
                }
                if let Some(reasoning) = delta
                    .get("reasoning_content")
                    .and_then(Value::as_str)
                    .or_else(|| delta.get("reasoning").and_then(Value::as_str))
                {
                    self.emit_delta(reasoning, now_ms, events);
                }
            }
        }
        if let Some(usage) = value.get("usage").and_then(parse_chat_usage) {
            self.emit_completed(Some(usage), now_ms, events);
        }
    }

    fn finish(&mut self, kind: ProtocolKind, now_ms: u64) -> Vec<TokenCostEvent> {
        if self.terminal_seen {
            return Vec::new();
        }
        let separator = std::mem::take(&mut self.separator);
        for byte in separator {
            self.append_frame_byte(byte);
        }
        let mut events = Vec::new();
        if !self.discarding_oversized_frame && !self.tail.is_empty() {
            let tail = std::mem::take(&mut self.tail);
            let saw_data = self.process_sse_frame(kind, &tail, now_ms, &mut events);
            if !saw_data && !self.terminal_seen {
                self.process_non_stream(kind, &tail, now_ms, &mut events);
            }
        }
        self.tail.clear();
        self.separator.clear();
        self.discarding_oversized_frame = false;
        if !self.terminal_seen {
            self.emit_failed(now_ms, &mut events);
        }
        events
    }

    fn process_non_stream(
        &mut self,
        kind: ProtocolKind,
        body: &[u8],
        now_ms: u64,
        events: &mut Vec<TokenCostEvent>,
    ) {
        let Ok(envelope) = parse_non_stream_envelope(body) else {
            return;
        };
        self.process_non_stream_envelope(kind, &envelope, now_ms, events);
    }

    fn process_non_stream_envelope(
        &mut self,
        kind: ProtocolKind,
        envelope: &NonStreamEnvelope<'_>,
        now_ms: u64,
        events: &mut Vec<TokenCostEvent>,
    ) {
        match kind {
            ProtocolKind::Responses => {
                let is_response = envelope.object.as_ref().and_then(BoundedLiteral::as_str)
                    == Some("response")
                    || envelope.status.as_ref().and_then(BoundedLiteral::as_str)
                        == Some("completed");
                if is_response {
                    self.update_non_stream_identity(envelope, now_ms, events);
                    self.emit_completed(
                        envelope.usage.as_ref().and_then(normalize_responses_usage),
                        now_ms,
                        events,
                    );
                }
            }
            ProtocolKind::Chat => {
                let has_chat_discriminator = envelope
                    .object
                    .as_ref()
                    .and_then(BoundedLiteral::as_str)
                    .is_some_and(|object| object.starts_with("chat.completion"));
                let usage = envelope.usage.as_ref().and_then(normalize_chat_usage);
                if has_chat_discriminator || usage.is_some() {
                    self.update_non_stream_identity(envelope, now_ms, events);
                    self.emit_completed(usage, now_ms, events);
                }
            }
        }
    }

    fn update_non_stream_identity(
        &mut self,
        envelope: &NonStreamEnvelope<'_>,
        now_ms: u64,
        events: &mut Vec<TokenCostEvent>,
    ) {
        if let Some(model) = envelope.model.as_ref().and_then(BoundedModel::as_str) {
            self.model.clear();
            self.model.push_str(model);
        }
        if let Some(service_tier) = envelope
            .service_tier
            .as_ref()
            .and_then(BoundedLiteral::as_str)
        {
            self.fast = service_tier == "priority";
        }
        self.emit_turn_started_if_changed(now_ms, events);
    }

    fn update_model_and_tier(
        &mut self,
        object: &serde_json::Map<String, Value>,
        now_ms: u64,
        events: &mut Vec<TokenCostEvent>,
    ) {
        if let Some(model) = bounded_object_string(object, "model", MAX_MODEL_BYTES) {
            self.model = model;
        }
        if let Some(service_tier) = object.get("service_tier").and_then(Value::as_str) {
            self.fast = service_tier == "priority";
        }
        self.emit_turn_started_if_changed(now_ms, events);
    }

    fn emit_turn_started_if_changed(&mut self, now_ms: u64, events: &mut Vec<TokenCostEvent>) {
        if self.terminal_seen
            || self.model.is_empty()
            || (self.announced_model == self.model && self.announced_fast == self.fast)
        {
            return;
        }
        self.announced_model.clone_from(&self.model);
        self.announced_fast = self.fast;
        let meta = self.next_meta(now_ms);
        events.push(TokenCostEvent::TurnStarted {
            meta,
            model: self.model.clone(),
            fast: self.fast,
        });
    }

    fn emit_delta(&mut self, delta: &str, now_ms: u64, events: &mut Vec<TokenCostEvent>) {
        if delta.is_empty() || self.terminal_seen {
            return;
        }
        self.cumulative_output_bytes = self
            .cumulative_output_bytes
            .saturating_add(delta.len() as u64);
        let estimated_output_tokens = (self.cumulative_output_bytes / 4)
            .saturating_add(u64::from(self.cumulative_output_bytes % 4 != 0))
            .max(1);
        let meta = self.next_meta(now_ms);
        events.push(TokenCostEvent::OutputDelta {
            meta,
            estimated_output_tokens,
        });
    }

    fn emit_completed(
        &mut self,
        usage: Option<TokenUsage>,
        now_ms: u64,
        events: &mut Vec<TokenCostEvent>,
    ) {
        if self.terminal_seen {
            return;
        }
        if let Some(usage) = usage {
            let meta = self.next_meta(now_ms);
            events.push(TokenCostEvent::Usage {
                meta,
                usage,
                exact: true,
            });
        }
        let meta = self.next_meta(now_ms);
        events.push(TokenCostEvent::TurnCompleted { meta, usage: None });
        self.mark_terminal();
    }

    fn emit_failed(&mut self, now_ms: u64, events: &mut Vec<TokenCostEvent>) {
        if self.terminal_seen {
            return;
        }
        let meta = self.next_meta(now_ms);
        events.push(TokenCostEvent::TurnFailed { meta });
        self.mark_terminal();
    }

    fn mark_terminal(&mut self) {
        self.terminal_seen = true;
        self.tail.clear();
        self.separator.clear();
        self.discarding_oversized_frame = false;
    }

    fn next_meta(&mut self, occurred_at_ms: u64) -> EventMeta {
        let event_id = format!("proxy-{}-{}", self.request_id, self.sequence);
        self.sequence = self.sequence.saturating_add(1);
        EventMeta {
            source: UsageSource::ProtocolProxy,
            session_id: self.session_id.clone(),
            turn_id: self.turn_id.clone(),
            event_id,
            correlation_id: self.correlation_id.clone(),
            occurred_at_ms,
        }
    }
}

fn bounded_object_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Option<String> {
    let value = object.get(key)?.as_str()?.trim();
    (!value.is_empty() && value.len() <= max_bytes).then(|| value.to_string())
}

fn parse_non_stream_envelope(body: &[u8]) -> Result<NonStreamEnvelope<'_>, ()> {
    preflight_non_stream_json(body)?;
    serde_json::from_slice(body).map_err(|_| ())
}

// serde_json fills scratch buffers for escaped strings and ignored nested values before visitors run.
fn preflight_non_stream_json(body: &[u8]) -> Result<(), ()> {
    let mut closers = [0_u8; MAX_NON_STREAM_JSON_DEPTH];
    let mut depth = 0_usize;
    let mut in_string = false;
    let mut escape_next = false;
    let mut string_has_escape = false;
    let mut string_bytes = 0_usize;

    for &byte in body {
        if in_string {
            if escape_next {
                escape_next = false;
                string_bytes += 1;
            } else {
                match byte {
                    b'\\' => {
                        escape_next = true;
                        string_has_escape = true;
                        string_bytes += 1;
                    }
                    b'"' => {
                        in_string = false;
                        continue;
                    }
                    0..=0x1f => return Err(()),
                    _ => string_bytes += 1,
                }
            }
            if string_has_escape && string_bytes > MAX_ESCAPED_JSON_STRING_BYTES {
                return Err(());
            }
            continue;
        }

        match byte {
            b'"' => {
                in_string = true;
                escape_next = false;
                string_has_escape = false;
                string_bytes = 0;
            }
            b'{' | b'[' => {
                if depth == MAX_NON_STREAM_JSON_DEPTH {
                    return Err(());
                }
                closers[depth] = if byte == b'{' { b'}' } else { b']' };
                depth += 1;
            }
            b'}' | b']' => {
                if depth == 0 || closers[depth - 1] != byte {
                    return Err(());
                }
                depth -= 1;
            }
            _ => {}
        }
    }

    if in_string || depth != 0 {
        return Err(());
    }
    Ok(())
}

fn normalize_responses_usage(usage: &DirectUsage) -> Option<TokenUsage> {
    let direct_input = usage.input_tokens.optional().ok()??;
    let output = usage.output_tokens.optional().ok()??;
    let total = usage.total_tokens.optional().ok()?;
    let (cached_input, has_separate_cache_read) = direct_cached_input(usage).ok()?;
    let cache_write = direct_cache_write(usage).ok()?;
    let input = normalize_responses_input(
        direct_input,
        cached_input,
        cache_write,
        output,
        total,
        has_separate_cache_read,
    )?;
    (cached_input <= input).then_some(TokenUsage {
        input,
        cached_input,
        cache_write,
        output,
    })
}

fn normalize_chat_usage(usage: &DirectUsage) -> Option<TokenUsage> {
    let prompt_tokens = usage.prompt_tokens.optional().ok()?;
    let input_tokens = usage.input_tokens.optional().ok()?;
    let completion_tokens = usage.completion_tokens.optional().ok()?;
    let output_tokens = usage.output_tokens.optional().ok()?;
    let output = completion_tokens.or(output_tokens)?;
    let (cached_input, _) = direct_cached_input(usage).ok()?;
    let input = if let Some(input_tokens) = input_tokens {
        input_tokens.checked_add(cached_input)?
    } else {
        prompt_tokens?
    };
    let cache_write = direct_cache_write(usage).ok()?;
    (cached_input <= input).then_some(TokenUsage {
        input,
        cached_input,
        cache_write,
        output,
    })
}

fn direct_cached_input(usage: &DirectUsage) -> Result<(u64, bool), ()> {
    let cache_read = usage.cache_read_input_tokens.optional()?;
    let prompt_cached = direct_details_cached(&usage.prompt_tokens_details)?;
    let input_cached = direct_details_cached(&usage.input_tokens_details)?;
    Ok((
        cache_read.or(prompt_cached).or(input_cached).unwrap_or(0),
        cache_read.is_some(),
    ))
}

fn direct_details_cached(details: &DirectDetailsField) -> Result<Option<u64>, ()> {
    match details {
        DirectDetailsField::Missing => Ok(None),
        DirectDetailsField::Value(details) => details.cached_tokens.optional(),
        DirectDetailsField::Invalid => Err(()),
    }
}

fn direct_cache_write(usage: &DirectUsage) -> Result<u64, ()> {
    let cache_creation = usage.cache_creation_input_tokens.optional()?;
    let cache_creation_5m = usage
        .cache_creation_5m_input_tokens
        .optional()?
        .unwrap_or(0);
    let cache_creation_1h = usage
        .cache_creation_1h_input_tokens
        .optional()?
        .unwrap_or(0);
    match cache_creation {
        Some(value) if value > 0 => Ok(value),
        _ => cache_creation_5m.checked_add(cache_creation_1h).ok_or(()),
    }
}

fn parse_responses_usage(value: &Value) -> Option<TokenUsage> {
    let object = value.as_object()?;
    let direct_input = direct_u64(object, "input_tokens").ok()??;
    let output = direct_u64(object, "output_tokens").ok()??;
    let total = direct_u64(object, "total_tokens").ok()?;
    let (cached_input, has_separate_cache_read) = parse_cached_input(object).ok()?;
    let cache_write = parse_cache_write(object).ok()?;
    let input = normalize_responses_input(
        direct_input,
        cached_input,
        cache_write,
        output,
        total,
        has_separate_cache_read,
    )?;
    (cached_input <= input).then_some(TokenUsage {
        input,
        cached_input,
        cache_write,
        output,
    })
}

fn normalize_responses_input(
    direct_input: u64,
    cached_input: u64,
    cache_write: u64,
    output: u64,
    total: Option<u64>,
    has_separate_cache_read: bool,
) -> Option<u64> {
    if has_separate_cache_read {
        let input_with_cache = direct_input.checked_add(cached_input)?;
        let Some(total) = total else {
            return Some(input_with_cache);
        };
        let converted_total = input_with_cache
            .checked_add(cache_write)?
            .checked_add(output)?;
        return (converted_total == total).then_some(input_with_cache);
    }
    let Some(total) = total else {
        return Some(direct_input);
    };
    if direct_input.checked_add(output)? == total {
        return Some(direct_input);
    }
    let input_with_cache = direct_input.checked_add(cached_input)?;
    let converted_total = input_with_cache
        .checked_add(cache_write)?
        .checked_add(output)?;
    (converted_total == total).then_some(input_with_cache)
}

fn parse_chat_usage(value: &Value) -> Option<TokenUsage> {
    let object = value.as_object()?;
    let prompt_tokens = direct_u64(object, "prompt_tokens").ok()?;
    let input_tokens = direct_u64(object, "input_tokens").ok()?;
    let completion_tokens = direct_u64(object, "completion_tokens").ok()?;
    let output_tokens = direct_u64(object, "output_tokens").ok()?;
    let output = completion_tokens.or(output_tokens)?;
    let (cached_input, _) = parse_cached_input(object).ok()?;
    let input = if let Some(input_tokens) = input_tokens {
        input_tokens.checked_add(cached_input)?
    } else {
        prompt_tokens?
    };
    let cache_write = parse_cache_write(object).ok()?;
    (cached_input <= input).then_some(TokenUsage {
        input,
        cached_input,
        cache_write,
        output,
    })
}

fn parse_cached_input(object: &serde_json::Map<String, Value>) -> Result<(u64, bool), ()> {
    let cache_read = direct_u64(object, "cache_read_input_tokens")?;
    let prompt_cached = direct_nested_u64(object, "prompt_tokens_details", "cached_tokens")?;
    let input_cached = direct_nested_u64(object, "input_tokens_details", "cached_tokens")?;
    Ok((
        cache_read.or(prompt_cached).or(input_cached).unwrap_or(0),
        cache_read.is_some(),
    ))
}

fn parse_cache_write(object: &serde_json::Map<String, Value>) -> Result<u64, ()> {
    let cache_creation = direct_u64(object, "cache_creation_input_tokens")?;
    let cache_creation_5m = direct_u64(object, "cache_creation_5m_input_tokens")?.unwrap_or(0);
    let cache_creation_1h = direct_u64(object, "cache_creation_1h_input_tokens")?.unwrap_or(0);
    match cache_creation {
        Some(value) if value > 0 => Ok(value),
        _ => cache_creation_5m.checked_add(cache_creation_1h).ok_or(()),
    }
}

fn direct_u64(object: &serde_json::Map<String, Value>, key: &str) -> Result<Option<u64>, ()> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or(()),
    }
}

fn direct_nested_u64(
    object: &serde_json::Map<String, Value>,
    parent: &str,
    key: &str,
) -> Result<Option<u64>, ()> {
    let Some(parent) = object.get(parent) else {
        return Ok(None);
    };
    let parent = parent.as_object().ok_or(())?;
    direct_u64(parent, key)
}

pub fn validate_renderer_event(event: TokenCostEvent) -> anyhow::Result<TokenCostEvent> {
    ensure!(
        serde_json::to_vec(&event)?.len() <= MAX_RENDERER_EVENT_BYTES,
        "renderer event exceeds byte limit"
    );
    let meta = event_meta(&event);
    ensure!(
        meta.source == UsageSource::Renderer,
        "renderer source required"
    );
    validate_required_id(&meta.session_id)?;
    validate_required_id(&meta.turn_id)?;
    validate_required_id(&meta.event_id)?;
    validate_required_id(&meta.correlation_id)?;

    match &event {
        TokenCostEvent::TurnStarted { model, .. } => {
            ensure!(model.len() <= MAX_MODEL_BYTES, "model exceeds byte limit");
        }
        TokenCostEvent::OutputDelta {
            estimated_output_tokens,
            ..
        } => ensure!(
            *estimated_output_tokens > 0,
            "output estimate must be positive"
        ),
        TokenCostEvent::ToolStarted { call_id, name, .. } => {
            validate_required_id(call_id)?;
            ensure!(
                name.len() <= MAX_TOOL_NAME_BYTES,
                "tool name exceeds byte limit"
            );
        }
        TokenCostEvent::ToolCompleted { call_id, .. } => validate_required_id(call_id)?,
        TokenCostEvent::Usage { usage, .. } => validate_usage(*usage)?,
        TokenCostEvent::TurnCompleted {
            usage: Some(usage), ..
        } => validate_usage(*usage)?,
        TokenCostEvent::TurnCompleted { usage: None, .. } | TokenCostEvent::TurnFailed { .. } => {}
    }
    Ok(event)
}

fn event_meta(event: &TokenCostEvent) -> &EventMeta {
    match event {
        TokenCostEvent::TurnStarted { meta, .. }
        | TokenCostEvent::OutputDelta { meta, .. }
        | TokenCostEvent::ToolStarted { meta, .. }
        | TokenCostEvent::ToolCompleted { meta, .. }
        | TokenCostEvent::Usage { meta, .. }
        | TokenCostEvent::TurnCompleted { meta, .. }
        | TokenCostEvent::TurnFailed { meta } => meta,
    }
}

fn validate_required_id(value: &str) -> anyhow::Result<()> {
    ensure!(!value.is_empty(), "required id is empty");
    ensure!(value.len() <= MAX_ID_BYTES, "id exceeds byte limit");
    Ok(())
}

fn validate_usage(usage: TokenUsage) -> anyhow::Result<()> {
    ensure!(
        usage.cached_input <= usage.input,
        "cached input exceeds input"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token_cost::{MAX_SSE_FRAME_BYTES, TokenCostEvent, TokenCostService};

    #[test]
    fn processed_delta_text_is_not_retained_in_tap_state() {
        let secret = "delta-text-that-must-not-be-retained";
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, started) = ResponsesUsageTap::from_request(1, request, 10);
        assert!(matches!(
            started.as_slice(),
            [TokenCostEvent::TurnStarted { .. }]
        ));
        let frame = format!(
            "data: {{\"type\":\"response.output_text.delta\",\"delta\":{}}}\n\n",
            serde_json::to_string(secret).unwrap()
        );

        let events = tap.push_bytes(frame.as_bytes(), 11);

        assert!(matches!(
            events.as_slice(),
            [TokenCostEvent::OutputDelta { .. }]
        ));
        assert_eq!(tap.state.cumulative_output_bytes, secret.len() as u64);
        assert!(tap.state.tail.is_empty());
        assert!(
            !tap.state
                .tail
                .windows(secret.len())
                .any(|window| window == secret.as_bytes())
        );
    }

    #[test]
    fn frame_tail_is_bounded_before_append_and_recovers_after_oversize_frame() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, started) = ResponsesUsageTap::from_request(2, request, 10);
        assert!(matches!(
            started.as_slice(),
            [TokenCostEvent::TurnStarted { .. }]
        ));
        let prefix = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"";
        let suffix = b"\"}";
        let exact_padding = MAX_SSE_FRAME_BYTES - prefix.len() - suffix.len();
        let mut exact = Vec::with_capacity(MAX_SSE_FRAME_BYTES + 2);
        exact.extend_from_slice(prefix);
        exact.extend(std::iter::repeat_n(b'x', exact_padding));
        exact.extend_from_slice(suffix);
        assert_eq!(exact.len(), MAX_SSE_FRAME_BYTES);
        exact.extend_from_slice(b"\n\n");

        assert!(matches!(
            tap.push_bytes(&exact, 11).as_slice(),
            [TokenCostEvent::OutputDelta { .. }]
        ));
        assert!(tap.state.tail.is_empty());

        let mut over = Vec::with_capacity(MAX_SSE_FRAME_BYTES + 1);
        over.extend_from_slice(prefix);
        over.extend(std::iter::repeat_n(b'y', exact_padding + 1));
        over.extend_from_slice(suffix);
        assert_eq!(over.len(), MAX_SSE_FRAME_BYTES + 1);
        assert!(tap.push_bytes(&over, 12).is_empty());
        assert!(tap.state.tail.len() <= MAX_SSE_FRAME_BYTES);

        let valid = b"\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n";
        let events = tap.push_bytes(valid, 13);
        assert!(matches!(
            events.as_slice(),
            [TokenCostEvent::OutputDelta { .. }]
        ));
        assert!(tap.state.tail.is_empty());
    }

    #[test]
    fn exact_usage_and_terminal_batch_do_not_double_add_state() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, mut events) = ResponsesUsageTap::from_request(3, request, 10);
        assert!(matches!(
            events.as_slice(),
            [TokenCostEvent::TurnStarted { .. }]
        ));
        events.extend(tap.push_bytes(
            b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"input_tokens_details\":{\"cached_tokens\":2},\"output_tokens\":5}}}\n\n",
            20,
        ));

        let service = TokenCostService::in_memory();
        service.bootstrap("page-1").unwrap();
        service.ingest_batch(events);
        let snapshot = service.bootstrap("page-1").unwrap().snapshot;

        assert_eq!(snapshot.turns, 1);
        assert_eq!(snapshot.input, 10);
        assert_eq!(snapshot.cached_input, 2);
        assert_eq!(snapshot.output, 5);
    }

    #[test]
    fn chat_stream_waits_through_null_and_invalid_usage_for_later_exact_usage() {
        let request = br#"{"model":"gpt-5.4"}"#;
        let (mut tap, mut events) = ChatUsageTap::from_request(5, request, 10);

        let null_usage = tap.push_bytes(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}],\"usage\":null}\n\n",
            20,
        );
        assert!(matches!(
            null_usage.as_slice(),
            [TokenCostEvent::OutputDelta { .. }]
        ));
        events.extend(null_usage);

        let invalid_usage = tap.push_bytes(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"bc\"}}],\"usage\":{}}\n\n",
            30,
        );
        assert!(matches!(
            invalid_usage.as_slice(),
            [TokenCostEvent::OutputDelta { .. }]
        ));
        events.extend(invalid_usage);

        let exact_usage = tap.push_bytes(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"d\"}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3}}\n\n",
            40,
        );
        assert!(matches!(
            exact_usage.as_slice(),
            [
                TokenCostEvent::OutputDelta { .. },
                TokenCostEvent::Usage { exact: true, .. },
                TokenCostEvent::TurnCompleted { usage: None, .. }
            ]
        ));
        events.extend(exact_usage);

        let service = TokenCostService::in_memory();
        service.bootstrap("page-1").unwrap();
        service.ingest_batch(events);
        let snapshot = service.bootstrap("page-1").unwrap().snapshot;

        assert_eq!(snapshot.turns, 1);
        assert_eq!(snapshot.input, 10);
        assert_eq!(snapshot.output, 3);
        assert_eq!(snapshot.cost_nanos, 70_000);
    }

    #[test]
    fn chat_non_stream_requires_a_valid_discriminator_or_usage_to_complete() {
        let request = br#"{"model":"gpt-5.4"}"#;
        let (mut tap, _) = ChatUsageTap::from_request(6, request, 10);

        assert!(tap.push_bytes(br#"{"usage":null}"#, 20).is_empty());
        assert!(matches!(
            tap.finish(30).as_slice(),
            [TokenCostEvent::TurnFailed { .. }]
        ));

        let (mut empty_usage, _) = ChatUsageTap::from_request(7, request, 10);
        assert!(empty_usage.push_bytes(br#"{"usage":{}}"#, 20).is_empty());
        assert!(matches!(
            empty_usage.finish(30).as_slice(),
            [TokenCostEvent::TurnFailed { .. }]
        ));
    }

    #[test]
    fn chat_first_response_identity_is_announced_once_before_usage() {
        let (mut tap, mut events) = ChatUsageTap::from_request(8, b"{}", 10);
        assert!(events.is_empty());

        let first = tap.push_bytes(
            b"data: {\"model\":\"gpt-5.6-sol\",\"service_tier\":\"priority\",\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n",
            20,
        );
        assert!(matches!(
            first.as_slice(),
            [
                TokenCostEvent::TurnStarted {
                    model,
                    fast: true,
                    ..
                },
                TokenCostEvent::OutputDelta { .. }
            ] if model == "gpt-5.6-sol"
        ));
        events.extend(first);

        let same_identity = tap.push_bytes(
            b"data: {\"model\":\"gpt-5.6-sol\",\"service_tier\":\"priority\",\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n",
            30,
        );
        assert!(matches!(
            same_identity.as_slice(),
            [TokenCostEvent::OutputDelta { .. }]
        ));
        events.extend(same_identity);

        let terminal = tap.push_bytes(
            b"data: {\"model\":\"gpt-5.6-sol\",\"service_tier\":\"priority\",\"choices\":[],\"usage\":{\"prompt_tokens\":1000000,\"completion_tokens\":1000000}}\n\n",
            40,
        );
        assert!(matches!(
            terminal.as_slice(),
            [
                TokenCostEvent::Usage { exact: true, .. },
                TokenCostEvent::TurnCompleted { usage: None, .. }
            ]
        ));
        events.extend(terminal);

        let service = TokenCostService::in_memory();
        service.bootstrap("page-1").unwrap();
        service.ingest_batch(events);
        let snapshot = service.bootstrap("page-1").unwrap().snapshot;
        assert_eq!(snapshot.model, "gpt-5.6-sol");
        assert!(snapshot.fast);
        assert_eq!(snapshot.turns, 1);
        assert_eq!(snapshot.cost_nanos, 70_000_000_000);
    }

    #[test]
    fn responses_model_change_is_announced_before_terminal_usage() {
        let request = br#"{"model":"gpt-5.4"}"#;
        let (mut tap, mut events) = ResponsesUsageTap::from_request(9, request, 10);
        let terminal = tap.push_bytes(
            b"data: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-5.6-sol\",\"usage\":{\"input_tokens\":1000000,\"output_tokens\":1000000}}}\n\n",
            20,
        );
        assert!(matches!(
            terminal.as_slice(),
            [
                TokenCostEvent::TurnStarted {
                    model,
                    fast: false,
                    ..
                },
                TokenCostEvent::Usage { exact: true, .. },
                TokenCostEvent::TurnCompleted { usage: None, .. }
            ] if model == "gpt-5.6-sol"
        ));
        events.extend(terminal);

        let service = TokenCostService::in_memory();
        service.bootstrap("page-1").unwrap();
        service.ingest_batch(events);
        let snapshot = service.bootstrap("page-1").unwrap().snapshot;
        assert_eq!(snapshot.model, "gpt-5.6-sol");
        assert!(!snapshot.fast);
        assert_eq!(snapshot.turns, 1);
        assert_eq!(snapshot.cost_nanos, 35_000_000_000);
    }

    #[test]
    fn responses_tier_change_is_announced_before_terminal_usage() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, mut events) = ResponsesUsageTap::from_request(10, request, 10);
        let terminal = tap.push_bytes(
            b"data: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-5.6-sol\",\"service_tier\":\"priority\",\"usage\":{\"input_tokens\":1000000,\"output_tokens\":1000000}}}\n\n",
            20,
        );
        assert!(matches!(
            terminal.as_slice(),
            [
                TokenCostEvent::TurnStarted {
                    model,
                    fast: true,
                    ..
                },
                TokenCostEvent::Usage { exact: true, .. },
                TokenCostEvent::TurnCompleted { usage: None, .. }
            ] if model == "gpt-5.6-sol"
        ));
        events.extend(terminal);

        let service = TokenCostService::in_memory();
        service.bootstrap("page-1").unwrap();
        service.ingest_batch(events);
        let snapshot = service.bootstrap("page-1").unwrap().snapshot;
        assert_eq!(snapshot.model, "gpt-5.6-sol");
        assert!(snapshot.fast);
        assert_eq!(snapshot.turns, 1);
        assert_eq!(snapshot.cost_nanos, 70_000_000_000);
    }

    #[test]
    fn complete_non_stream_body_is_processed_without_retention() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, _) = ResponsesUsageTap::from_request(11, request, 10);
        let body = br#"{"object":"response","status":"completed","usage":{"input_tokens":7,"output_tokens":3}}"#;

        let events = tap.push_bytes(body, 20);

        assert!(matches!(
            events.as_slice(),
            [
                TokenCostEvent::Usage {
                    usage: TokenUsage {
                        input: 7,
                        output: 3,
                        ..
                    },
                    exact: true,
                    ..
                },
                TokenCostEvent::TurnCompleted { usage: None, .. }
            ]
        ));
        assert!(tap.state.tail.is_empty());
        assert!(tap.state.separator.is_empty());
        assert!(tap.finish(30).is_empty());
    }

    #[test]
    fn responses_non_stream_body_over_sse_limit_still_extracts_exact_usage() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, _) = ResponsesUsageTap::from_request(12, request, 10);
        let padding = "x".repeat(MAX_SSE_FRAME_BYTES);
        let body = format!(
            "{{\"object\":\"response\",\"status\":\"completed\",\"output\":\"{padding}\",\"usage\":{{\"input_tokens\":9,\"output_tokens\":4}}}}"
        );
        assert!(body.len() > MAX_SSE_FRAME_BYTES);

        let events = tap.push_bytes(body.as_bytes(), 20);

        assert!(matches!(
            events.as_slice(),
            [
                TokenCostEvent::Usage {
                    usage: TokenUsage {
                        input: 9,
                        output: 4,
                        ..
                    },
                    exact: true,
                    ..
                },
                TokenCostEvent::TurnCompleted { usage: None, .. }
            ]
        ));
        assert!(tap.state.tail.is_empty());
        assert!(!tap.state.discarding_oversized_frame);
        assert!(tap.finish(30).is_empty());
    }

    #[test]
    fn narrow_non_stream_parser_borrows_identity_and_skips_large_unknown_body() {
        let padding = "x".repeat(MAX_SSE_FRAME_BYTES * 32);
        let body = format!(
            "  {{\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.6-sol\",\"service_tier\":\"priority\",\"output\":\"{padding}\",\"usage\":{{\"input_tokens\":9,\"output_tokens\":4}}}}  "
        );

        let envelope = parse_non_stream_envelope(body.as_bytes()).unwrap();

        assert!(matches!(
            envelope.model,
            Some(BoundedModel::Borrowed("gpt-5.6-sol"))
        ));
        assert!(matches!(
            envelope
                .service_tier
                .as_ref()
                .and_then(BoundedLiteral::as_str),
            Some("priority")
        ));
        assert_eq!(
            envelope.usage.as_ref().and_then(normalize_responses_usage),
            Some(TokenUsage {
                input: 9,
                cached_input: 0,
                cache_write: 0,
                output: 4,
            })
        );
    }

    #[test]
    fn non_stream_preflight_accepts_bounded_escaped_strings() {
        let body = br#"{"object":"respon\u0073e","model":"gpt-5.6-\u0073ol","service_tier":"prior\u0069ty","usage":{"input_tokens":9,"output_tokens":4}}"#;
        let envelope = parse_non_stream_envelope(body).unwrap();

        assert_eq!(
            envelope.object.as_ref().and_then(BoundedLiteral::as_str),
            Some("response")
        );
        assert_eq!(
            envelope.model.as_ref().and_then(BoundedModel::as_str),
            Some("gpt-5.6-sol")
        );
        assert_eq!(
            envelope
                .service_tier
                .as_ref()
                .and_then(BoundedLiteral::as_str),
            Some("priority")
        );
    }

    #[test]
    fn non_stream_preflight_rejects_escaped_known_fields_over_one_mibibyte() {
        let escaped = format!("\\u0061{}", "a".repeat(1_048_571));
        assert_eq!(escaped.len(), 1_048_577);
        let bodies = [
            format!(
                "{{\"object\":\"{escaped}\",\"usage\":{{\"input_tokens\":1,\"output_tokens\":1}}}}"
            ),
            format!(
                "{{\"object\":\"response\",\"model\":\"{escaped}\",\"usage\":{{\"input_tokens\":1,\"output_tokens\":1}}}}"
            ),
            format!(
                "{{\"object\":\"response\",\"usage\":{{\"input_tokens\":\"{escaped}\",\"output_tokens\":1}}}}"
            ),
        ];

        for (index, body) in bodies.iter().enumerate() {
            assert!(parse_non_stream_envelope(body.as_bytes()).is_err());
            let (mut tap, _) = ResponsesUsageTap::from_request(
                30 + u64::try_from(index).unwrap(),
                br#"{"model":"gpt-5.6-sol"}"#,
                10,
            );
            assert!(tap.push_bytes(body.as_bytes(), 20).is_empty());
            assert!(tap.state.tail.len() <= MAX_SSE_FRAME_BYTES);
            assert!(tap.state.discarding_oversized_frame);
            assert!(matches!(
                tap.finish(30).as_slice(),
                [TokenCostEvent::TurnFailed { .. }]
            ));
        }
    }

    #[test]
    fn non_stream_preflight_allows_depth_64_and_rejects_depth_65() {
        fn nested_body(array_depth: usize) -> Vec<u8> {
            let mut body = b"{\"object\":\"response\",\"unknown\":".to_vec();
            body.extend(std::iter::repeat_n(b'[', array_depth));
            body.push(b'0');
            body.extend(std::iter::repeat_n(b']', array_depth));
            body.extend_from_slice(b",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}");
            body
        }

        assert!(parse_non_stream_envelope(&nested_body(63)).is_ok());
        assert!(parse_non_stream_envelope(&nested_body(64)).is_err());
        assert!(parse_non_stream_envelope(br#"{"object":"response"]"#).is_err());
    }

    #[test]
    fn incomplete_large_object_uses_only_bounded_fallback_state() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, _) = ResponsesUsageTap::from_request(17, request, 10);
        let mut body = b"{\"object\":\"response\",\"output\":\"".to_vec();
        body.extend(std::iter::repeat_n(b'x', MAX_SSE_FRAME_BYTES * 2));

        assert!(tap.push_bytes(&body, 20).is_empty());
        assert!(tap.state.tail.len() <= MAX_SSE_FRAME_BYTES);
        assert!(tap.state.discarding_oversized_frame);
        assert!(matches!(
            tap.finish(30).as_slice(),
            [TokenCostEvent::TurnFailed { .. }]
        ));
    }

    #[test]
    fn invalid_usage_skips_large_body_without_terminalizing_malformed_json() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, _) = ResponsesUsageTap::from_request(18, request, 10);
        let padding = "x".repeat(MAX_SSE_FRAME_BYTES * 2);
        let body = format!(
            "{{\"object\":\"response\",\"output\":\"{padding}\",\"usage\":{{\"input_tokens\":\"bad\",\"output_tokens\":4}}}}"
        );

        assert!(matches!(
            tap.push_bytes(body.as_bytes(), 20).as_slice(),
            [TokenCostEvent::TurnCompleted { usage: None, .. }]
        ));
        assert!(tap.state.tail.is_empty());
        assert!(tap.state.separator.is_empty());

        let (mut malformed_tap, _) = ResponsesUsageTap::from_request(19, request, 10);
        assert!(
            malformed_tap
                .push_bytes(br#"{"object":"response",}"#, 20)
                .is_empty()
        );
        assert!(matches!(
            malformed_tap.finish(30).as_slice(),
            [TokenCostEvent::TurnFailed { .. }]
        ));
    }

    #[test]
    fn non_stream_discriminator_and_tier_matching_stays_exact() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, _) = ResponsesUsageTap::from_request(20, request, 10);
        assert!(
            tap.push_bytes(
                br#"{"object":" response ","service_tier":" priority ","usage":null}"#,
                20,
            )
            .is_empty()
        );

        let events = tap.push_bytes(
            br#"{"object":"response","service_tier":" priority ","usage":{"input_tokens":1,"output_tokens":1}}"#,
            30,
        );
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, TokenCostEvent::TurnStarted { fast: true, .. }))
        );
    }

    #[test]
    fn non_stream_model_trims_before_applying_exact_byte_limit() {
        let cases = [
            (
                format!(
                    "{{\"object\":\"response\",\"model\":\" {} \",\"usage\":{{\"input_tokens\":1,\"output_tokens\":1}}}}",
                    "m".repeat(128)
                ),
                "m".repeat(128),
            ),
            (
                format!(
                    "{{\"object\":\"response\",\"model\":\" \\u0061{} \",\"usage\":{{\"input_tokens\":1,\"output_tokens\":1}}}}",
                    "m".repeat(127)
                ),
                format!("a{}", "m".repeat(127)),
            ),
        ];

        for (index, (body, expected_model)) in cases.iter().enumerate() {
            let (mut tap, _) =
                ResponsesUsageTap::from_request(50 + u64::try_from(index).unwrap(), b"{}", 10);
            let events = tap.push_bytes(body.as_bytes(), 20);
            assert!(matches!(
                events.first(),
                Some(TokenCostEvent::TurnStarted { model, .. }) if model == expected_model
            ));
        }

        let over_limit = format!(
            "{{\"object\":\"response\",\"model\":\" {} \",\"usage\":{{\"input_tokens\":1,\"output_tokens\":1}}}}",
            "m".repeat(129)
        );
        let (mut tap, _) = ResponsesUsageTap::from_request(52, b"{}", 10);
        assert!(
            !tap.push_bytes(over_limit.as_bytes(), 20)
                .iter()
                .any(|event| matches!(event, TokenCostEvent::TurnStarted { .. }))
        );
    }

    #[test]
    fn chat_direct_cache_fields_normalize_exact_usage_and_cost() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, mut events) = ChatUsageTap::from_request(13, request, 10);
        let terminal = tap.push_bytes(
            b"data: {\"usage\":{\"input_tokens\":10,\"output_tokens\":3,\"cache_read_input_tokens\":2,\"cache_creation_5m_input_tokens\":4,\"cache_creation_1h_input_tokens\":6}}\n\n",
            20,
        );
        assert!(matches!(
            terminal.as_slice(),
            [
                TokenCostEvent::Usage {
                    usage: TokenUsage {
                        input: 12,
                        cached_input: 2,
                        cache_write: 10,
                        output: 3
                    },
                    exact: true,
                    ..
                },
                TokenCostEvent::TurnCompleted { usage: None, .. }
            ]
        ));
        events.extend(terminal);

        let service = TokenCostService::in_memory();
        service.bootstrap("page-1").unwrap();
        service.ingest_batch(events);
        let snapshot = service.bootstrap("page-1").unwrap().snapshot;
        assert_eq!(snapshot.turns, 1);
        assert_eq!(snapshot.input, 12);
        assert_eq!(snapshot.cached_input, 2);
        assert_eq!(snapshot.output, 3);
        assert_eq!(snapshot.cost_nanos, 203_500);
    }

    #[test]
    fn responses_converter_cache_fields_normalize_exact_usage_and_cost() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, mut events) = ResponsesUsageTap::from_request(14, request, 10);
        let terminal = tap.push_bytes(
            b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":3,\"total_tokens\":25,\"cache_read_input_tokens\":2,\"cache_creation_5m_input_tokens\":4,\"cache_creation_1h_input_tokens\":6}}}\n\n",
            20,
        );
        assert!(matches!(
            terminal.as_slice(),
            [
                TokenCostEvent::Usage {
                    usage: TokenUsage {
                        input: 12,
                        cached_input: 2,
                        cache_write: 10,
                        output: 3
                    },
                    exact: true,
                    ..
                },
                TokenCostEvent::TurnCompleted { usage: None, .. }
            ]
        ));
        events.extend(terminal);

        let service = TokenCostService::in_memory();
        service.bootstrap("page-1").unwrap();
        service.ingest_batch(events);
        let snapshot = service.bootstrap("page-1").unwrap().snapshot;
        assert_eq!(snapshot.turns, 1);
        assert_eq!(snapshot.input, 12);
        assert_eq!(snapshot.cached_input, 2);
        assert_eq!(snapshot.output, 3);
        assert_eq!(snapshot.cost_nanos, 203_500);
    }

    #[test]
    fn responses_direct_cache_total_mismatch_is_rejected_in_sse() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, _) = ResponsesUsageTap::from_request(40, request, 10);

        let terminal = tap.push_bytes(
            b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":3,\"total_tokens\":24,\"cache_read_input_tokens\":2,\"cache_creation_5m_input_tokens\":4,\"cache_creation_1h_input_tokens\":6}}}\n\n",
            20,
        );

        assert!(matches!(
            terminal.as_slice(),
            [TokenCostEvent::TurnCompleted { usage: None, .. }]
        ));
    }

    #[test]
    fn responses_direct_cache_total_overflow_is_rejected_in_non_stream_body() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, _) = ResponsesUsageTap::from_request(41, request, 10);
        let body = format!(
            "{{\"object\":\"response\",\"usage\":{{\"input_tokens\":{},\"output_tokens\":1,\"total_tokens\":0,\"cache_read_input_tokens\":1,\"cache_creation_input_tokens\":1}}}}",
            u64::MAX - 2
        );

        let terminal = tap.push_bytes(body.as_bytes(), 20);

        assert!(matches!(
            terminal.as_slice(),
            [TokenCostEvent::TurnCompleted { usage: None, .. }]
        ));
    }

    #[test]
    fn chat_usage_addition_overflow_is_rejected_without_terminating() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, _) = ChatUsageTap::from_request(15, request, 10);

        assert!(
            tap.push_bytes(
                format!(
                    "data: {{\"usage\":{{\"input_tokens\":{},\"output_tokens\":1,\"cache_read_input_tokens\":1}}}}\n\n",
                    u64::MAX
                )
                .as_bytes(),
                20,
            )
            .is_empty()
        );
        assert!(
            tap.push_bytes(
                format!(
                    "data: {{\"usage\":{{\"input_tokens\":1,\"output_tokens\":1,\"cache_creation_5m_input_tokens\":{},\"cache_creation_1h_input_tokens\":1}}}}\n\n",
                    u64::MAX
                )
                .as_bytes(),
                30,
            )
            .is_empty()
        );

        let terminal = tap.push_bytes(
            b"data: {\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\n",
            40,
        );
        assert!(matches!(
            terminal.as_slice(),
            [
                TokenCostEvent::Usage {
                    usage: TokenUsage {
                        input: 2,
                        output: 1,
                        ..
                    },
                    exact: true,
                    ..
                },
                TokenCostEvent::TurnCompleted { usage: None, .. }
            ]
        ));
    }

    #[test]
    fn responses_usage_addition_overflow_drops_exact_usage() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, _) = ResponsesUsageTap::from_request(16, request, 10);
        let terminal = tap.push_bytes(
            format!(
                "data: {{\"type\":\"response.completed\",\"response\":{{\"usage\":{{\"input_tokens\":{},\"output_tokens\":1,\"cache_read_input_tokens\":1}}}}}}\n\n",
                u64::MAX
            )
            .as_bytes(),
            20,
        );

        assert!(matches!(
            terminal.as_slice(),
            [TokenCostEvent::TurnCompleted { usage: None, .. }]
        ));
    }

    #[test]
    fn responses_total_consistency_rejects_checked_add_overflow() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut native_total, _) = ResponsesUsageTap::from_request(18, request, 10);
        let native_overflow = native_total.push_bytes(
            format!(
                "data: {{\"type\":\"response.completed\",\"response\":{{\"usage\":{{\"input_tokens\":{},\"output_tokens\":1,\"total_tokens\":0}}}}}}\n\n",
                u64::MAX
            )
            .as_bytes(),
            20,
        );
        assert!(matches!(
            native_overflow.as_slice(),
            [TokenCostEvent::TurnCompleted { usage: None, .. }]
        ));

        let (mut converted_total, _) = ResponsesUsageTap::from_request(19, request, 10);
        let converted_overflow = converted_total.push_bytes(
            format!(
                "data: {{\"type\":\"response.completed\",\"response\":{{\"usage\":{{\"input_tokens\":{},\"output_tokens\":0,\"total_tokens\":0,\"input_tokens_details\":{{\"cached_tokens\":1}},\"cache_creation_input_tokens\":1}}}}}}\n\n",
                u64::MAX - 1
            )
            .as_bytes(),
            20,
        );
        assert!(matches!(
            converted_overflow.as_slice(),
            [TokenCostEvent::TurnCompleted { usage: None, .. }]
        ));
    }

    #[test]
    fn cumulative_estimate_uses_overflow_safe_ceiling_division() {
        let request = br#"{"model":"gpt-5.6-sol"}"#;
        let (mut tap, _) = ResponsesUsageTap::from_request(4, request, 10);
        tap.state.cumulative_output_bytes = u64::MAX - 3;

        let events = tap.push_bytes(
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"abc\"}\n\n",
            20,
        );

        assert!(matches!(
            events.as_slice(),
            [TokenCostEvent::OutputDelta {
                estimated_output_tokens,
                ..
            }] if *estimated_output_tokens == u64::MAX / 4 + 1
        ));
    }
}
