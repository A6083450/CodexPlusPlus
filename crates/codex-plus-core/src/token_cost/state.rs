use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use super::{
    AnalyticsTotals, EventMeta, TokenCostEvent, TokenCostSnapshot, TokenUsage, UiConfig,
    UsageSource, default_model_price, fast_multiplier_millis, usage_cost_nanos,
};

pub const EVENT_QUEUE_CAPACITY: usize = 256;
pub const RECENT_TURN_LIMIT: usize = 256;
pub const DEDUPE_FINGERPRINT_LIMIT: usize = 512;

const DAY_ROLLUP_LIMIT: usize = 31;
const MODEL_ROLLUP_LIMIT: usize = 20;
const MILLIS_PER_DAY: u64 = 86_400_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QueueAdmission {
    Enqueued,
    Coalesced,
    Rejected,
    RequiresDrain,
}

pub struct BoundedEventQueue {
    capacity: usize,
    events: VecDeque<TokenCostEvent>,
    high_water: usize,
}

impl BoundedEventQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            events: VecDeque::with_capacity(capacity.max(1)),
            high_water: 0,
        }
    }

    pub fn push(&mut self, event: TokenCostEvent) -> QueueAdmission {
        if self.coalesce(&event) {
            return QueueAdmission::Coalesced;
        }
        if self.events.len() < self.capacity {
            self.events.push_back(event);
            self.high_water = self.high_water.max(self.events.len());
            return QueueAdmission::Enqueued;
        }

        let Some(coalescible) = self.events.iter().position(is_coalescible) else {
            return if is_critical(&event) {
                QueueAdmission::RequiresDrain
            } else {
                QueueAdmission::Rejected
            };
        };
        if is_critical(&event) || is_coalescible(&event) {
            self.events.remove(coalescible);
            self.events.push_back(event);
            QueueAdmission::Enqueued
        } else {
            QueueAdmission::Rejected
        }
    }

    pub fn pop_front(&mut self) -> Option<TokenCostEvent> {
        self.events.pop_front()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn high_water(&self) -> usize {
        self.high_water
    }

    fn coalesce(&mut self, incoming: &TokenCostEvent) -> bool {
        match incoming {
            TokenCostEvent::OutputDelta {
                meta,
                estimated_output_tokens,
            } => {
                for queued in &mut self.events {
                    let TokenCostEvent::OutputDelta {
                        meta: queued_meta,
                        estimated_output_tokens: queued_tokens,
                    } = queued
                    else {
                        continue;
                    };
                    if same_turn(queued_meta, meta) {
                        if *estimated_output_tokens > *queued_tokens {
                            *queued_meta = meta.clone();
                            *queued_tokens = *estimated_output_tokens;
                        }
                        return true;
                    }
                }
                false
            }
            TokenCostEvent::Usage {
                meta,
                usage,
                exact: false,
            } => {
                for queued in &mut self.events {
                    let TokenCostEvent::Usage {
                        meta: queued_meta,
                        usage: queued_usage,
                        exact: false,
                    } = queued
                    else {
                        continue;
                    };
                    if same_turn(queued_meta, meta)
                        && queued_meta.correlation_id == meta.correlation_id
                    {
                        let merged = TokenUsage {
                            input: queued_usage.input.max(usage.input),
                            cached_input: queued_usage.cached_input.max(usage.cached_input),
                            cache_write: queued_usage.cache_write.max(usage.cache_write),
                            output: queued_usage.output.max(usage.output),
                        };
                        if merged != *queued_usage {
                            *queued_meta = meta.clone();
                            *queued_usage = merged;
                        }
                        return true;
                    }
                }
                false
            }
            _ => false,
        }
    }
}

fn same_turn(left: &EventMeta, right: &EventMeta) -> bool {
    left.session_id == right.session_id && left.turn_id == right.turn_id
}

fn is_coalescible(event: &TokenCostEvent) -> bool {
    matches!(
        event,
        TokenCostEvent::OutputDelta { .. } | TokenCostEvent::Usage { exact: false, .. }
    )
}

fn is_critical(event: &TokenCostEvent) -> bool {
    matches!(
        event,
        TokenCostEvent::TurnStarted { .. }
            | TokenCostEvent::ToolStarted { .. }
            | TokenCostEvent::ToolCompleted { .. }
            | TokenCostEvent::Usage { exact: true, .. }
            | TokenCostEvent::TurnCompleted { .. }
            | TokenCostEvent::TurnFailed { .. }
    )
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct TurnKey {
    session_id: String,
    turn_id: String,
}

impl TurnKey {
    fn from_meta(meta: &EventMeta) -> Self {
        Self {
            session_id: meta.session_id.clone(),
            turn_id: meta.turn_id.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum DedupeKey {
    Event(u8, String),
    Final(String, u64, u64, u64, u64),
}

#[derive(Default)]
struct DedupeWindow {
    order: VecDeque<DedupeKey>,
    keys: HashSet<DedupeKey>,
}

impl DedupeWindow {
    fn observe(&mut self, event: &TokenCostEvent) -> DedupeStatus {
        let meta = event_meta(event);
        let event_key = DedupeKey::Event(source_rank(meta.source), meta.event_id.clone());
        if self.keys.contains(&event_key) {
            return DedupeStatus::Duplicate;
        }
        self.insert(event_key);

        let Some((correlation_id, usage)) = final_usage(event) else {
            return DedupeStatus::New;
        };
        let final_key = DedupeKey::Final(
            correlation_id.to_string(),
            usage.input,
            usage.cached_input,
            usage.cache_write,
            usage.output,
        );
        if self.keys.contains(&final_key) {
            DedupeStatus::EquivalentFinal
        } else {
            self.insert(final_key);
            DedupeStatus::New
        }
    }

    fn insert(&mut self, key: DedupeKey) {
        if self.keys.insert(key.clone()) {
            self.order.push_back(key);
        }
        while self.order.len() > DEDUPE_FINGERPRINT_LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.keys.remove(&oldest);
            }
        }
    }
}

enum DedupeStatus {
    New,
    EquivalentFinal,
    Duplicate,
}

fn final_usage(event: &TokenCostEvent) -> Option<(&str, TokenUsage)> {
    match event {
        TokenCostEvent::Usage {
            meta,
            usage,
            exact: true,
        }
        | TokenCostEvent::TurnCompleted {
            meta,
            usage: Some(usage),
        } => Some((&meta.correlation_id, *usage)),
        _ => None,
    }
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

fn source_rank(source: UsageSource) -> u8 {
    match source {
        UsageSource::Renderer => 1,
        UsageSource::ProtocolProxy => 2,
    }
}

#[derive(Clone)]
struct UsageRecord {
    usage: TokenUsage,
    rank: u8,
}

#[derive(Clone)]
struct TurnState {
    model: String,
    fast: bool,
    started_at_ms: u64,
    last_seen_at_ms: u64,
    steps: u32,
    step_correlations: HashSet<String>,
    current_step_started_at_ms: u64,
    current_step_has_output: bool,
    pending_step_started_at_ms: Option<u64>,
    first_token_total_ms: u64,
    first_token_samples: u32,
    open_tools: HashMap<String, u64>,
    tool_union_started_at_ms: Option<u64>,
    tool_ms: u64,
    usage_by_correlation: HashMap<String, UsageRecord>,
    usage_order: VecDeque<String>,
    folded_usage: TokenUsage,
    estimated_output_tokens: u64,
    last_output_at_ms: Option<u64>,
    generation_ms: u64,
    generation_pause_ms: u64,
    generation_pause_started_at_ms: Option<u64>,
}

impl TurnState {
    fn new(meta: &EventMeta, model: String, fast: bool) -> Self {
        let mut step_correlations = HashSet::new();
        if !meta.correlation_id.is_empty() {
            step_correlations.insert(meta.correlation_id.clone());
        }
        Self {
            model,
            fast,
            started_at_ms: meta.occurred_at_ms,
            last_seen_at_ms: meta.occurred_at_ms,
            steps: 1,
            step_correlations,
            current_step_started_at_ms: meta.occurred_at_ms,
            current_step_has_output: false,
            pending_step_started_at_ms: None,
            first_token_total_ms: 0,
            first_token_samples: 0,
            open_tools: HashMap::new(),
            tool_union_started_at_ms: None,
            tool_ms: 0,
            usage_by_correlation: HashMap::new(),
            usage_order: VecDeque::new(),
            folded_usage: TokenUsage::default(),
            estimated_output_tokens: 0,
            last_output_at_ms: None,
            generation_ms: 0,
            generation_pause_ms: 0,
            generation_pause_started_at_ms: None,
        }
    }

    fn observe_output(&mut self, meta: &EventMeta, estimated_output_tokens: u64) -> bool {
        if self.pending_step_started_at_ms.is_none()
            && self.current_step_has_output
            && estimated_output_tokens <= self.estimated_output_tokens
        {
            self.remember_correlation(&meta.correlation_id);
            return false;
        }
        let mut changed = false;
        if let Some(step_started_at_ms) = self.pending_step_started_at_ms.take() {
            self.steps = self.steps.saturating_add(1);
            self.current_step_started_at_ms = step_started_at_ms;
            self.current_step_has_output = false;
            changed = true;
        }
        self.remember_correlation(&meta.correlation_id);
        if !self.current_step_has_output {
            self.first_token_total_ms = self.first_token_total_ms.saturating_add(
                meta.occurred_at_ms
                    .saturating_sub(self.current_step_started_at_ms),
            );
            self.first_token_samples = self.first_token_samples.saturating_add(1);
            self.current_step_has_output = true;
            changed = true;
        }

        if let Some(last_output_at_ms) = self.last_output_at_ms {
            let active_pause = self
                .generation_pause_started_at_ms
                .map(|started| meta.occurred_at_ms.saturating_sub(started))
                .unwrap_or(0);
            let elapsed = meta.occurred_at_ms.saturating_sub(last_output_at_ms);
            self.generation_ms = self.generation_ms.saturating_add(
                elapsed.saturating_sub(self.generation_pause_ms.saturating_add(active_pause)),
            );
        }
        self.generation_pause_ms = 0;
        self.generation_pause_started_at_ms =
            (!self.open_tools.is_empty()).then_some(meta.occurred_at_ms);
        self.last_output_at_ms = Some(
            self.last_output_at_ms
                .map_or(meta.occurred_at_ms, |last| last.max(meta.occurred_at_ms)),
        );
        if estimated_output_tokens > self.estimated_output_tokens {
            self.estimated_output_tokens = estimated_output_tokens;
            changed = true;
        }
        self.last_seen_at_ms = self.last_seen_at_ms.max(meta.occurred_at_ms);
        changed
    }

    fn start_tool(&mut self, meta: &EventMeta, call_id: String) -> bool {
        if self.open_tools.contains_key(&call_id)
            || self.open_tools.len() >= DEDUPE_FINGERPRINT_LIMIT
        {
            return false;
        }
        if self.open_tools.is_empty() {
            self.tool_union_started_at_ms = Some(meta.occurred_at_ms);
            if self.last_output_at_ms.is_some() {
                self.generation_pause_started_at_ms = Some(meta.occurred_at_ms);
            }
        }
        self.pending_step_started_at_ms = None;
        self.open_tools.insert(call_id, meta.occurred_at_ms);
        self.last_seen_at_ms = self.last_seen_at_ms.max(meta.occurred_at_ms);
        true
    }

    fn complete_tool(&mut self, meta: &EventMeta, call_id: &str) -> bool {
        if self.open_tools.remove(call_id).is_none() {
            return false;
        }
        if self.open_tools.is_empty() {
            if let Some(started) = self.tool_union_started_at_ms.take() {
                self.tool_ms = self
                    .tool_ms
                    .saturating_add(meta.occurred_at_ms.saturating_sub(started));
            }
            if let Some(started) = self.generation_pause_started_at_ms.take() {
                self.generation_pause_ms = self
                    .generation_pause_ms
                    .saturating_add(meta.occurred_at_ms.saturating_sub(started));
            }
            self.pending_step_started_at_ms = Some(meta.occurred_at_ms);
        }
        self.last_seen_at_ms = self.last_seen_at_ms.max(meta.occurred_at_ms);
        true
    }

    fn apply_usage(&mut self, meta: &EventMeta, usage: TokenUsage, exact: bool) -> bool {
        let rank = if exact { source_rank(meta.source) } else { 0 };
        let correlation_id = meta.correlation_id.clone();
        let mut changed = false;
        if !self.step_correlations.contains(&correlation_id) {
            self.steps = self.steps.saturating_add(1);
            self.current_step_started_at_ms = meta.occurred_at_ms;
            self.current_step_has_output = false;
            self.pending_step_started_at_ms = None;
            self.remember_correlation(&correlation_id);
            changed = true;
        }

        if let Some(existing) = self.usage_by_correlation.get_mut(&correlation_id) {
            if rank < existing.rank || (rank == existing.rank && usage == existing.usage) {
                return changed;
            }
            if rank == 0 && existing.rank == 0 {
                let merged = TokenUsage {
                    input: existing.usage.input.max(usage.input),
                    cached_input: existing.usage.cached_input.max(usage.cached_input),
                    cache_write: existing.usage.cache_write.max(usage.cache_write),
                    output: existing.usage.output.max(usage.output),
                };
                if merged == existing.usage {
                    return changed;
                }
                existing.usage = merged;
                changed = true;
            } else if rank > existing.rank && usage == existing.usage {
                existing.rank = rank;
                return changed;
            } else {
                existing.usage = usage;
                existing.rank = rank;
                changed = true;
            }
        } else {
            if self.usage_by_correlation.len() >= DEDUPE_FINGERPRINT_LIMIT {
                if let Some(oldest) = self.usage_order.pop_front()
                    && let Some(record) = self.usage_by_correlation.remove(&oldest)
                {
                    add_usage(&mut self.folded_usage, record.usage);
                }
            }
            self.usage_order.push_back(correlation_id.clone());
            self.usage_by_correlation
                .insert(correlation_id, UsageRecord { usage, rank });
            changed = true;
        }
        self.last_seen_at_ms = self.last_seen_at_ms.max(meta.occurred_at_ms);
        changed
    }

    fn finish(&mut self, occurred_at_ms: u64) {
        if let Some(started) = self.tool_union_started_at_ms.take() {
            self.tool_ms = self
                .tool_ms
                .saturating_add(occurred_at_ms.saturating_sub(started));
        }
        if let Some(started) = self.generation_pause_started_at_ms.take() {
            self.generation_pause_ms = self
                .generation_pause_ms
                .saturating_add(occurred_at_ms.saturating_sub(started));
        }
        self.open_tools.clear();
        self.pending_step_started_at_ms = None;
        self.last_seen_at_ms = self.last_seen_at_ms.max(occurred_at_ms);
    }

    fn totals(&self, occurred_at_ms: u64, config: &UiConfig) -> AnalyticsTotals {
        let usage = self.effective_usage();
        let wall_ms = occurred_at_ms.saturating_sub(self.started_at_ms);
        let active_tool_ms = self
            .tool_union_started_at_ms
            .map(|started| occurred_at_ms.saturating_sub(started))
            .unwrap_or(0);
        let tool_ms = self.tool_ms.saturating_add(active_tool_ms).min(wall_ms);
        let price = config
            .price_overrides
            .get(&self.model)
            .copied()
            .or_else(|| default_model_price(&self.model));
        let cost_nanos = price
            .map(|price| {
                usage_cost_nanos(
                    usage,
                    price,
                    if self.fast {
                        fast_multiplier_millis(&self.model)
                    } else {
                        1_000
                    },
                )
            })
            .unwrap_or(0);
        AnalyticsTotals {
            turns: 1,
            steps: self.steps,
            input: usage.input,
            cached_input: usage.cached_input,
            cache_write: usage.cache_write,
            output: usage.output,
            cost_nanos,
            llm_ms: wall_ms.saturating_sub(tool_ms),
            tool_ms,
            first_token_total_ms: self.first_token_total_ms,
            first_token_samples: self.first_token_samples,
            generation_ms: self.generation_ms,
            generation_output_tokens: usage.output,
        }
    }

    fn effective_usage(&self) -> TokenUsage {
        let mut usage = self.folded_usage;
        if self.usage_by_correlation.is_empty() && usage == TokenUsage::default() {
            usage.output = self.estimated_output_tokens;
            return usage;
        }
        for record in self.usage_by_correlation.values() {
            add_usage(&mut usage, record.usage);
        }
        usage
    }

    fn remember_correlation(&mut self, correlation_id: &str) {
        if !correlation_id.is_empty() && self.step_correlations.len() < DEDUPE_FINGERPRINT_LIMIT {
            self.step_correlations.insert(correlation_id.to_string());
        }
    }
}

struct CompletedTurn {
    key: TurnKey,
    turn: TurnState,
    completed_at_ms: u64,
    totals: AnalyticsTotals,
}

pub struct RuntimeState {
    active_turns: HashMap<TurnKey, TurnState>,
    recent_turns: VecDeque<CompletedTurn>,
    retired_turns: VecDeque<TurnKey>,
    retired_turn_keys: HashSet<TurnKey>,
    dedupe_by_session: HashMap<String, DedupeWindow>,
    totals: AnalyticsTotals,
    day_rollups: BTreeMap<u64, AnalyticsTotals>,
    model_rollups: BTreeMap<String, AnalyticsTotals>,
    display_model: String,
    display_fast: bool,
    revision: u64,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeState {
    pub fn new() -> Self {
        Self {
            active_turns: HashMap::new(),
            recent_turns: VecDeque::with_capacity(RECENT_TURN_LIMIT),
            retired_turns: VecDeque::with_capacity(DEDUPE_FINGERPRINT_LIMIT),
            retired_turn_keys: HashSet::with_capacity(DEDUPE_FINGERPRINT_LIMIT),
            dedupe_by_session: HashMap::new(),
            totals: AnalyticsTotals::default(),
            day_rollups: BTreeMap::new(),
            model_rollups: BTreeMap::new(),
            display_model: String::new(),
            display_fast: false,
            revision: 0,
        }
    }

    pub fn apply(&mut self, event: TokenCostEvent, config: &UiConfig) -> bool {
        let session_id = event_meta(&event).session_id.clone();
        let changed = self.apply_event(event, config);
        if !self
            .active_turns
            .keys()
            .any(|key| key.session_id == session_id)
        {
            self.dedupe_by_session.remove(&session_id);
        }
        changed
    }

    fn apply_event(&mut self, event: TokenCostEvent, config: &UiConfig) -> bool {
        let meta = event_meta(&event).clone();
        let key = TurnKey::from_meta(&meta);
        if self.retired_turn_keys.contains(&key) {
            return false;
        }
        let dedupe = self
            .dedupe_by_session
            .entry(meta.session_id.clone())
            .or_default()
            .observe(&event);
        if matches!(dedupe, DedupeStatus::Duplicate) {
            return false;
        }

        match event {
            TokenCostEvent::TurnStarted { model, fast, .. } => {
                if self.recent_turn(&key).is_some() {
                    return false;
                }
                self.display_model = model.clone();
                self.display_fast = fast;
                if let Some(turn) = self.active_turns.get_mut(&key) {
                    let changed = turn.model != model || turn.fast != fast;
                    turn.model = model;
                    turn.fast = fast;
                    changed
                } else {
                    self.active_turns
                        .insert(key, TurnState::new(&meta, model, fast));
                    true
                }
            }
            TokenCostEvent::OutputDelta {
                estimated_output_tokens,
                ..
            } => {
                if self.recent_turn(&key).is_some() {
                    return false;
                }
                let turn = self.ensure_turn(&key, &meta);
                turn.observe_output(&meta, estimated_output_tokens)
            }
            TokenCostEvent::ToolStarted { call_id, .. } => {
                if self.recent_turn(&key).is_some() {
                    return false;
                }
                self.ensure_turn(&key, &meta).start_tool(&meta, call_id)
            }
            TokenCostEvent::ToolCompleted { call_id, .. } => {
                if self.recent_turn(&key).is_some() {
                    return false;
                }
                self.active_turns
                    .get_mut(&key)
                    .is_some_and(|turn| turn.complete_tool(&meta, &call_id))
            }
            TokenCostEvent::Usage { usage, exact, .. } => {
                if let Some(turn) = self.active_turns.get_mut(&key) {
                    turn.apply_usage(&meta, usage, exact)
                } else if self.recent_turn(&key).is_some() {
                    self.apply_late_usage(&key, &meta, usage, exact, config)
                } else {
                    self.ensure_turn(&key, &meta)
                        .apply_usage(&meta, usage, exact);
                    true
                }
            }
            TokenCostEvent::TurnCompleted { usage, .. } => {
                if self.recent_turn(&key).is_some() {
                    return usage.is_some_and(|usage| {
                        self.apply_late_usage(&key, &meta, usage, true, config)
                    });
                }
                let turn = self.ensure_turn(&key, &meta);
                if let Some(usage) = usage {
                    turn.apply_usage(&meta, usage, true);
                }
                self.complete_turn(&key, meta.occurred_at_ms, config)
            }
            TokenCostEvent::TurnFailed { .. } => {
                if self.recent_turn(&key).is_some() {
                    return false;
                }
                self.ensure_turn(&key, &meta);
                self.complete_turn(&key, meta.occurred_at_ms, config)
            }
        }
    }

    pub fn snapshot(&self, config: &UiConfig) -> TokenCostSnapshot {
        let mut totals = self.totals.clone();
        for turn in self.active_turns.values() {
            add_totals(&mut totals, &turn.totals(turn.last_seen_at_ms, config));
        }
        let first_token_average_ms = (totals.first_token_samples > 0)
            .then(|| totals.first_token_total_ms / u64::from(totals.first_token_samples));
        let output_rate_milli_tokens_per_second = if totals.generation_ms == 0 {
            0
        } else {
            ((u128::from(totals.generation_output_tokens) * 1_000_000)
                / u128::from(totals.generation_ms))
            .min(u128::from(u64::MAX)) as u64
        };
        TokenCostSnapshot {
            revision: self.revision,
            running: !self.active_turns.is_empty(),
            model: self.display_model.clone(),
            fast: self.display_fast,
            turns: totals.turns,
            steps: totals.steps,
            llm_ms: totals.llm_ms,
            tool_ms: totals.tool_ms,
            first_token_average_ms,
            output_rate_milli_tokens_per_second,
            input: totals.input,
            cached_input: totals.cached_input,
            output: totals.output,
            cost_nanos: totals.cost_nanos,
            hub_visible: config.hub_visible,
            output_rate_visible: config.output_rate_visible,
            profile_visible: config.profile_visible,
        }
    }

    pub(crate) fn bump_revision(&mut self) -> u64 {
        self.revision = self.revision.saturating_add(1);
        self.revision
    }

    pub(crate) fn recent_turn_count(&self) -> usize {
        self.recent_turns.len()
    }

    #[cfg(test)]
    pub(crate) fn retired_turn_count(&self) -> usize {
        self.retired_turns.len()
    }

    pub(crate) fn dedupe_fingerprint_count(&self) -> usize {
        self.dedupe_by_session
            .values()
            .map(|window| window.order.len())
            .sum()
    }

    fn ensure_turn(&mut self, key: &TurnKey, meta: &EventMeta) -> &mut TurnState {
        self.active_turns
            .entry(key.clone())
            .or_insert_with(|| TurnState::new(meta, self.display_model.clone(), self.display_fast))
    }

    fn recent_turn(&self, key: &TurnKey) -> Option<&CompletedTurn> {
        self.recent_turns.iter().rev().find(|turn| &turn.key == key)
    }

    fn complete_turn(&mut self, key: &TurnKey, occurred_at_ms: u64, config: &UiConfig) -> bool {
        let Some(mut turn) = self.active_turns.remove(key) else {
            return false;
        };
        turn.finish(occurred_at_ms);
        self.display_model = turn.model.clone();
        self.display_fast = turn.fast;
        let totals = turn.totals(occurred_at_ms, config);
        add_totals(&mut self.totals, &totals);
        self.add_rollups(&turn.model, occurred_at_ms, &totals);
        self.recent_turns.push_back(CompletedTurn {
            key: key.clone(),
            turn,
            completed_at_ms: occurred_at_ms,
            totals,
        });
        if self.recent_turns.len() > RECENT_TURN_LIMIT
            && let Some(evicted) = self.recent_turns.pop_front()
        {
            self.remember_retired(evicted.key);
        }
        true
    }

    fn remember_retired(&mut self, key: TurnKey) {
        if self.retired_turn_keys.insert(key.clone()) {
            self.retired_turns.push_back(key);
        }
        while self.retired_turns.len() > DEDUPE_FINGERPRINT_LIMIT {
            if let Some(oldest) = self.retired_turns.pop_front() {
                self.retired_turn_keys.remove(&oldest);
            }
        }
    }

    fn apply_late_usage(
        &mut self,
        key: &TurnKey,
        meta: &EventMeta,
        usage: TokenUsage,
        exact: bool,
        config: &UiConfig,
    ) -> bool {
        let Some(index) = self.recent_turns.iter().position(|turn| &turn.key == key) else {
            return false;
        };
        let completed = &mut self.recent_turns[index];
        let old_totals = completed.totals.clone();
        if !completed.turn.apply_usage(meta, usage, exact) {
            return false;
        }
        let model = completed.turn.model.clone();
        let completed_at_ms = completed.completed_at_ms;
        let new_totals = completed.turn.totals(completed_at_ms, config);
        completed.totals = new_totals.clone();
        replace_totals(&mut self.totals, &old_totals, &new_totals);
        self.replace_rollups(&model, completed_at_ms, &old_totals, &new_totals);
        true
    }

    fn add_rollups(&mut self, model: &str, occurred_at_ms: u64, totals: &AnalyticsTotals) {
        let day = occurred_at_ms / MILLIS_PER_DAY;
        add_totals(self.day_rollups.entry(day).or_default(), totals);
        while self.day_rollups.len() > DAY_ROLLUP_LIMIT {
            let Some(oldest) = self.day_rollups.keys().next().copied() else {
                break;
            };
            self.day_rollups.remove(&oldest);
        }

        if self.model_rollups.contains_key(model) || self.model_rollups.len() < MODEL_ROLLUP_LIMIT {
            add_totals(
                self.model_rollups.entry(model.to_string()).or_default(),
                totals,
            );
        }
    }

    fn replace_rollups(
        &mut self,
        model: &str,
        occurred_at_ms: u64,
        old: &AnalyticsTotals,
        new: &AnalyticsTotals,
    ) {
        if let Some(day) = self.day_rollups.get_mut(&(occurred_at_ms / MILLIS_PER_DAY)) {
            replace_totals(day, old, new);
        }
        if let Some(model_totals) = self.model_rollups.get_mut(model) {
            replace_totals(model_totals, old, new);
        }
    }
}

fn add_usage(target: &mut TokenUsage, value: TokenUsage) {
    target.input = target.input.saturating_add(value.input);
    target.cached_input = target.cached_input.saturating_add(value.cached_input);
    target.cache_write = target.cache_write.saturating_add(value.cache_write);
    target.output = target.output.saturating_add(value.output);
}

fn add_totals(target: &mut AnalyticsTotals, value: &AnalyticsTotals) {
    target.turns = target.turns.saturating_add(value.turns);
    target.steps = target.steps.saturating_add(value.steps);
    target.input = target.input.saturating_add(value.input);
    target.cached_input = target.cached_input.saturating_add(value.cached_input);
    target.cache_write = target.cache_write.saturating_add(value.cache_write);
    target.output = target.output.saturating_add(value.output);
    target.cost_nanos = target.cost_nanos.saturating_add(value.cost_nanos);
    target.llm_ms = target.llm_ms.saturating_add(value.llm_ms);
    target.tool_ms = target.tool_ms.saturating_add(value.tool_ms);
    target.first_token_total_ms = target
        .first_token_total_ms
        .saturating_add(value.first_token_total_ms);
    target.first_token_samples = target
        .first_token_samples
        .saturating_add(value.first_token_samples);
    target.generation_ms = target.generation_ms.saturating_add(value.generation_ms);
    target.generation_output_tokens = target
        .generation_output_tokens
        .saturating_add(value.generation_output_tokens);
}

fn replace_totals(target: &mut AnalyticsTotals, old: &AnalyticsTotals, new: &AnalyticsTotals) {
    target.turns = target
        .turns
        .saturating_sub(old.turns)
        .saturating_add(new.turns);
    target.steps = target
        .steps
        .saturating_sub(old.steps)
        .saturating_add(new.steps);
    target.input = target
        .input
        .saturating_sub(old.input)
        .saturating_add(new.input);
    target.cached_input = target
        .cached_input
        .saturating_sub(old.cached_input)
        .saturating_add(new.cached_input);
    target.cache_write = target
        .cache_write
        .saturating_sub(old.cache_write)
        .saturating_add(new.cache_write);
    target.output = target
        .output
        .saturating_sub(old.output)
        .saturating_add(new.output);
    target.cost_nanos = target
        .cost_nanos
        .saturating_sub(old.cost_nanos)
        .saturating_add(new.cost_nanos);
    target.llm_ms = target
        .llm_ms
        .saturating_sub(old.llm_ms)
        .saturating_add(new.llm_ms);
    target.tool_ms = target
        .tool_ms
        .saturating_sub(old.tool_ms)
        .saturating_add(new.tool_ms);
    target.first_token_total_ms = target
        .first_token_total_ms
        .saturating_sub(old.first_token_total_ms)
        .saturating_add(new.first_token_total_ms);
    target.first_token_samples = target
        .first_token_samples
        .saturating_sub(old.first_token_samples)
        .saturating_add(new.first_token_samples);
    target.generation_ms = target
        .generation_ms
        .saturating_sub(old.generation_ms)
        .saturating_add(new.generation_ms);
    target.generation_output_tokens = target
        .generation_output_tokens
        .saturating_sub(old.generation_output_tokens)
        .saturating_add(new.generation_output_tokens);
}
