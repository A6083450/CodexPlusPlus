use anyhow::ensure;
use serde_json::Value;

use super::{
    EventMeta, MAX_ID_BYTES, MAX_MODEL_BYTES, MAX_RENDERER_EVENT_BYTES, MAX_SSE_FRAME_BYTES,
    MAX_TOOL_NAME_BYTES, TokenCostEvent, TokenUsage, UsageSource,
};

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
            && let Ok(value) = serde_json::from_slice::<Value>(bytes)
        {
            let mut events = Vec::new();
            self.process_non_stream_value(kind, &value, now_ms, &mut events);
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
        let Ok(value) = serde_json::from_slice::<Value>(body) else {
            return;
        };
        self.process_non_stream_value(kind, &value, now_ms, events);
    }

    fn process_non_stream_value(
        &mut self,
        kind: ProtocolKind,
        value: &Value,
        now_ms: u64,
        events: &mut Vec<TokenCostEvent>,
    ) {
        let Some(object) = value.as_object() else {
            return;
        };
        match kind {
            ProtocolKind::Responses => {
                let is_response = object.get("object").and_then(Value::as_str) == Some("response")
                    || object.get("status").and_then(Value::as_str) == Some("completed");
                if is_response {
                    self.update_model_and_tier(object, now_ms, events);
                    self.emit_completed(
                        object.get("usage").and_then(parse_responses_usage),
                        now_ms,
                        events,
                    );
                }
            }
            ProtocolKind::Chat => {
                let has_chat_discriminator = object
                    .get("object")
                    .and_then(Value::as_str)
                    .is_some_and(|object| object.starts_with("chat.completion"));
                let usage = object.get("usage").and_then(parse_chat_usage);
                if has_chat_discriminator || usage.is_some() {
                    self.update_model_and_tier(object, now_ms, events);
                    self.emit_completed(usage, now_ms, events);
                }
            }
        }
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

fn parse_responses_usage(value: &Value) -> Option<TokenUsage> {
    let object = value.as_object()?;
    let direct_input = direct_u64(object, "input_tokens").ok()??;
    let output = direct_u64(object, "output_tokens").ok()??;
    let (cached_input, has_separate_cache_read) = parse_cached_input(object).ok()?;
    let input = if has_separate_cache_read {
        direct_input.checked_add(cached_input)?
    } else {
        direct_input
    };
    let cache_write = parse_cache_write(object).ok()?;
    (cached_input <= input).then_some(TokenUsage {
        input,
        cached_input,
        cache_write,
        output,
    })
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
            b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":3,\"cache_read_input_tokens\":2,\"cache_creation_5m_input_tokens\":4,\"cache_creation_1h_input_tokens\":6}}}\n\n",
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
