use std::marker::PhantomData;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::ensure;
use futures_util::StreamExt;
use serde::de::{Error as _, IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, watch};

pub mod assets;
pub mod config;
pub mod input;
pub mod model;
pub mod pricing;
pub mod push;
pub mod state;

pub use config::{ProfileConfig, UiConfig, UiConfigStore};
pub use input::{ChatUsageTap, ResponsesUsageTap, validate_renderer_event};
pub use model::{
    AnalyticsDay, AnalyticsModel, AnalyticsRange, AnalyticsSnapshot, AnalyticsTotals, EventMeta,
    IngestOutcome, LazyAsset, LazyAssetPush, MAX_EMAIL_BYTES, MAX_ID_BYTES, MAX_MODEL_BYTES,
    MAX_PROFILE_AVATAR_BYTES, MAX_PROFILE_TEXT_BYTES, MAX_TOOL_NAME_BYTES, ModelPrice,
    SnapshotPush, TokenCostAction, TokenCostActionResponse, TokenCostBootstrap,
    TokenCostDiagnostics, TokenCostEvent, TokenCostSnapshot, TokenUsage, UsageSource,
};
pub use pricing::{default_model_price, fast_multiplier_millis, usage_cost_nanos};
pub use push::{SnapshotCoalescer, SnapshotOffer, TokenCostPushReceiver};
pub use state::{
    BoundedEventQueue, DEDUPE_FINGERPRINT_LIMIT, EVENT_QUEUE_CAPACITY, QueueAdmission,
    RECENT_TURN_LIMIT, RuntimeState,
};

use push::{ActiveInstance, PushMetrics};

const LAZY_PUSH_CAPACITY: usize = 8;
const MAX_INSTANCE_ID_BYTES: usize = 128;
const MAX_CC_SWITCH_BODY_BYTES: usize = 1024 * 1024;
const MAX_CC_SWITCH_TURNS: usize = RECENT_TURN_LIMIT;
const MAX_CC_SWITCH_OCCURRED_AT_MS: u64 = 253_402_300_799_999;
const CC_SWITCH_URL: &str = "http://127.0.0.1:17888/cc-switch/turns?refresh=1";

pub const MAX_SSE_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_RENDERER_EVENT_BYTES: usize = 4 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 8 * 1024;
pub const SNAPSHOT_MIN_INTERVAL: Duration = Duration::from_millis(500);

pub struct TokenCostService {
    inner: Mutex<ServiceInner>,
    #[allow(dead_code)]
    store: UiConfigStore,
    snapshot_tx: watch::Sender<Option<SnapshotPush>>,
    lazy_tx: broadcast::Sender<LazyAssetPush>,
    push_metrics: Arc<PushMetrics>,
    active_instance: Arc<ActiveInstance>,
    #[allow(dead_code)]
    cc_switch_in_flight: AtomicBool,
}

struct ServiceInner {
    state: RuntimeState,
    queue: BoundedEventQueue,
    config: UiConfig,
    events_ingested: u64,
    events_coalesced: u64,
    events_rejected: u64,
    snapshots_published: u64,
}

impl TokenCostService {
    pub fn with_store(store: UiConfigStore) -> Arc<Self> {
        let config = store.load();
        let (snapshot_tx, _) = watch::channel(None);
        let (lazy_tx, _) = broadcast::channel(LAZY_PUSH_CAPACITY);
        Arc::new(Self {
            inner: Mutex::new(ServiceInner {
                state: RuntimeState::new(),
                queue: BoundedEventQueue::new(EVENT_QUEUE_CAPACITY),
                config,
                events_ingested: 0,
                events_coalesced: 0,
                events_rejected: 0,
                snapshots_published: 0,
            }),
            store,
            snapshot_tx,
            lazy_tx,
            push_metrics: Arc::new(PushMetrics::default()),
            active_instance: Arc::new(ActiveInstance::default()),
            cc_switch_in_flight: AtomicBool::new(false),
        })
    }

    pub fn in_memory() -> Arc<Self> {
        Self::with_store(UiConfigStore::in_memory())
    }

    pub fn ingest(&self, event: TokenCostEvent) -> IngestOutcome {
        self.ingest_batch(std::iter::once(event))
    }

    pub(crate) fn ingest_for_instance(
        &self,
        instance_id: &str,
        event: TokenCostEvent,
    ) -> IngestOutcome {
        self.ingest_batch_checked(Some(instance_id), std::iter::once(event))
    }

    pub(crate) fn ingest_batch<I>(&self, events: I) -> IngestOutcome
    where
        I: IntoIterator<Item = TokenCostEvent>,
    {
        self.ingest_batch_checked(None, events)
    }

    fn ingest_batch_checked<I>(
        &self,
        expected_instance_id: Option<&str>,
        events: I,
    ) -> IngestOutcome
    where
        I: IntoIterator<Item = TokenCostEvent>,
    {
        let events = events.into_iter();
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let active = expected_instance_id.map_or_else(
            || self.active_instance.is_active(),
            |instance_id| self.active_instance.matches(instance_id),
        );
        if !active {
            let rejected = events.count() as u64;
            inner.events_rejected = inner.events_rejected.saturating_add(rejected);
            return IngestOutcome::Rejected {
                reason: if expected_instance_id.is_some() {
                    "stale_instance"
                } else {
                    "capture_disabled"
                },
            };
        }

        let (outcome, push) = {
            let mut before = inner.state.snapshot(&inner.config);
            before.revision = 0;
            let mut admitted = false;
            let mut coalesced = false;
            let mut rejected = false;

            for event in events {
                inner.events_ingested = inner.events_ingested.saturating_add(1);
                let queued_copy = event.clone();
                match inner.queue.push(event) {
                    QueueAdmission::Rejected => {
                        inner.events_rejected = inner.events_rejected.saturating_add(1);
                        rejected = true;
                    }
                    QueueAdmission::Coalesced => {
                        inner.events_coalesced = inner.events_coalesced.saturating_add(1);
                        coalesced = true;
                    }
                    QueueAdmission::RequiresDrain => {
                        if let Some(oldest) = inner.queue.pop_front() {
                            let config = inner.config.clone();
                            inner.state.apply(oldest, &config);
                        }
                        let replacement = inner.queue.push(queued_copy);
                        debug_assert_eq!(replacement, QueueAdmission::Enqueued);
                        admitted = true;
                    }
                    QueueAdmission::Enqueued => admitted = true,
                }
            }

            while let Some(next) = inner.queue.pop_front() {
                let config = inner.config.clone();
                inner.state.apply(next, &config);
            }

            let mut after = inner.state.snapshot(&inner.config);
            after.revision = 0;
            let visible_changed = before != after;
            if visible_changed {
                inner.state.bump_revision();
            }
            let snapshot = inner.state.snapshot(&inner.config);
            let revision = snapshot.revision;
            let outcome = if visible_changed {
                IngestOutcome::Applied { revision }
            } else if coalesced {
                IngestOutcome::Coalesced { revision }
            } else if admitted || !rejected {
                IngestOutcome::NoChange { revision }
            } else {
                IngestOutcome::Rejected {
                    reason: "queue_capacity",
                }
            };
            let push = if visible_changed {
                self.active_instance.current().map(|instance_id| {
                    inner.snapshots_published = inner.snapshots_published.saturating_add(1);
                    SnapshotPush::Snapshot {
                        instance_id,
                        snapshot,
                    }
                })
            } else {
                None
            };
            (outcome, push)
        };

        if let Some(push) = push {
            self.snapshot_tx.send_replace(Some(push));
        }
        outcome
    }

    pub fn bootstrap(&self, instance_id: &str) -> anyhow::Result<TokenCostBootstrap> {
        validate_instance_id(instance_id)?;
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        self.active_instance.replace(instance_id.to_string());
        Ok(TokenCostBootstrap {
            instance_id: instance_id.to_string(),
            config: inner.config.clone(),
            snapshot: inner.state.snapshot(&inner.config),
        })
    }

    pub async fn apply_action(
        &self,
        action: TokenCostAction,
    ) -> anyhow::Result<TokenCostActionResponse> {
        validate_instance_id(action.instance_id())?;
        match action {
            TokenCostAction::SetVisibility {
                instance_id,
                hub_visible,
                output_rate_visible,
                profile_visible,
            } => self.update_config(&instance_id, |config| {
                config.hub_visible = hub_visible;
                config.output_rate_visible = output_rate_visible;
                config.profile_visible = profile_visible;
                Ok(())
            }),
            TokenCostAction::SavePrice {
                instance_id,
                model,
                price,
            } => self.update_config(&instance_id, |config| {
                validate_model(&model)?;
                config.price_overrides.insert(model, price);
                Ok(())
            }),
            TokenCostAction::DeletePrice { instance_id, model }
            | TokenCostAction::ResetPrice { instance_id, model } => {
                self.update_config(&instance_id, |config| {
                    validate_model(&model)?;
                    config.price_overrides.remove(&model);
                    Ok(())
                })
            }
            TokenCostAction::SaveProfile {
                instance_id,
                profile,
            } => self.update_config(&instance_id, |config| {
                config.profile = profile;
                Ok(())
            }),
            TokenCostAction::QueryAnalytics {
                instance_id,
                range,
                model,
            } => {
                ensure!(
                    self.active_instance.matches(&instance_id),
                    "stale_instance: token cost instance is not active"
                );
                if let Some(model) = model.as_deref() {
                    validate_model(model)?;
                }
                let inner = self
                    .inner
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                ensure!(
                    self.active_instance.matches(&instance_id),
                    "stale_instance: token cost instance is not active"
                );
                Ok(TokenCostActionResponse::Analytics {
                    analytics: analytics_snapshot(&inner, range, model.as_deref())?,
                })
            }
            TokenCostAction::SyncCcSwitch { instance_id } => {
                self.sync_cc_switch(&instance_id).await
            }
            TokenCostAction::DisposeInstance { instance_id } => {
                {
                    let _inner = self
                        .inner
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    ensure!(
                        self.active_instance.clear_if(&instance_id),
                        "stale_instance: token cost instance is not active"
                    );
                    self.snapshot_tx.send_replace(None);
                }
                Ok(TokenCostActionResponse::Disposed)
            }
            TokenCostAction::QueryDiagnostics { instance_id } => {
                ensure!(
                    self.active_instance.matches(&instance_id),
                    "stale_instance: token cost instance is not active"
                );
                let inner = self
                    .inner
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                ensure!(
                    self.active_instance.matches(&instance_id),
                    "stale_instance: token cost instance is not active"
                );
                Ok(TokenCostActionResponse::Diagnostics {
                    diagnostics: self.diagnostics_locked(&inner),
                })
            }
        }
    }

    pub fn request_lazy_asset(&self, instance_id: &str, asset: LazyAsset) -> anyhow::Result<()> {
        validate_instance_id(instance_id)?;
        ensure!(
            self.active_instance.matches(instance_id),
            "stale_instance: token cost instance is not active"
        );
        self.lazy_tx
            .send(LazyAssetPush {
                instance_id: instance_id.to_string(),
                asset,
            })
            .map(|_| ())
            .map_err(|_| anyhow::anyhow!("token cost push receiver is not active"))
    }

    pub fn subscribe(&self) -> TokenCostPushReceiver {
        TokenCostPushReceiver {
            snapshots: self.snapshot_tx.subscribe(),
            lazy: self.lazy_tx.subscribe(),
            metrics: Arc::clone(&self.push_metrics),
            active_instance: Arc::clone(&self.active_instance),
        }
    }

    pub fn capture_enabled(&self) -> bool {
        self.active_instance.is_active()
    }

    pub(crate) fn matches_instance(&self, instance_id: &str) -> bool {
        self.active_instance.matches(instance_id)
    }

    fn update_config<F>(
        &self,
        instance_id: &str,
        update: F,
    ) -> anyhow::Result<TokenCostActionResponse>
    where
        F: FnOnce(&mut UiConfig) -> anyhow::Result<()>,
    {
        ensure!(
            self.active_instance.matches(instance_id),
            "stale_instance: token cost instance is not active"
        );
        let response = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            ensure!(
                self.active_instance.matches(instance_id),
                "stale_instance: token cost instance is not active"
            );
            let mut config = inner.config.clone();
            update(&mut config)?;
            config.validate()?;
            let changed = config != inner.config;
            if changed {
                self.store.save(&config)?;
                inner.config = config;
                inner.state.bump_revision();
            }
            let snapshot = inner.state.snapshot(&inner.config);
            let push = changed.then(|| {
                inner.snapshots_published = inner.snapshots_published.saturating_add(1);
                SnapshotPush::Snapshot {
                    instance_id: instance_id.to_string(),
                    snapshot: snapshot.clone(),
                }
            });
            let response = TokenCostActionResponse::Updated {
                config: inner.config.clone(),
                snapshot,
            };
            if let Some(push) = push {
                self.snapshot_tx.send_replace(Some(push));
            }
            response
        };
        Ok(response)
    }

    async fn sync_cc_switch(&self, instance_id: &str) -> anyhow::Result<TokenCostActionResponse> {
        ensure!(
            self.active_instance.matches(instance_id),
            "stale_instance: token cost instance is not active"
        );
        ensure!(
            self.cc_switch_in_flight
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok(),
            "sync_in_progress: CC Switch sync is already running"
        );
        let _guard = AtomicFlagGuard {
            flag: &self.cc_switch_in_flight,
        };

        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(500))
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| anyhow::anyhow!("cc_switch: client construction failed"))?;
        let response = client
            .get(CC_SWITCH_URL)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("cc_switch: request failed"))?;
        ensure!(
            response.status().is_success(),
            "cc_switch: HTTP request failed"
        );
        ensure!(
            response
                .content_length()
                .is_none_or(|length| length <= MAX_CC_SWITCH_BODY_BYTES as u64),
            "cc_switch: response body exceeds byte limit"
        );
        let mut body = Vec::with_capacity(
            response
                .content_length()
                .unwrap_or_default()
                .min(MAX_CC_SWITCH_BODY_BYTES as u64) as usize,
        );
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| anyhow::anyhow!("cc_switch: response read failed"))?;
            ensure!(
                body.len().saturating_add(chunk.len()) <= MAX_CC_SWITCH_BODY_BYTES,
                "cc_switch: response body exceeds byte limit"
            );
            body.extend_from_slice(&chunk);
        }
        let payload = serde_json::from_slice::<CcSwitchPayload<'_>>(&body)
            .map_err(|_| anyhow::anyhow!("cc_switch: response schema is invalid"))?;
        validate_cc_switch_payload(&payload)?;
        ensure!(
            self.active_instance.matches(instance_id),
            "stale_instance: token cost instance is not active"
        );

        let response = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            ensure!(
                self.active_instance.matches(instance_id),
                "stale_instance: token cost instance is not active"
            );
            let config = inner.config.clone();
            let mut before = inner.state.snapshot(&inner.config);
            before.revision = 0;
            let mut imported_turns = 0_u32;
            let mut min_epoch_day = current_epoch_day();
            let mut max_epoch_day = min_epoch_day;
            for turn in &payload.turns {
                let epoch_day = (turn.occurred_at_ms / 86_400_000) as i64;
                min_epoch_day = min_epoch_day.min(epoch_day);
                max_epoch_day = max_epoch_day.max(epoch_day);
                let turn_id = turn.turn_id.to_string();
                let identity = cc_switch_identity(turn.turn_id);
                let correlation_id = format!("cc-c-{identity}");
                inner.state.apply(
                    TokenCostEvent::TurnStarted {
                        meta: cc_switch_meta(
                            &turn_id,
                            format!("cc-s-{identity}"),
                            &correlation_id,
                            turn.occurred_at_ms.saturating_sub(2),
                        ),
                        model: turn.model.to_string(),
                        fast: false,
                    },
                    &config,
                );
                inner.state.apply(
                    TokenCostEvent::Usage {
                        meta: cc_switch_meta(
                            &turn_id,
                            format!("cc-u-{identity}"),
                            &correlation_id,
                            turn.occurred_at_ms.saturating_sub(1),
                        ),
                        usage: turn.usage,
                        exact: true,
                    },
                    &config,
                );
                if inner.state.apply(
                    TokenCostEvent::TurnCompleted {
                        meta: cc_switch_meta(
                            &turn_id,
                            format!("cc-f-{identity}"),
                            &correlation_id,
                            turn.occurred_at_ms,
                        ),
                        usage: None,
                    },
                    &config,
                ) {
                    imported_turns = imported_turns
                        .checked_add(1)
                        .ok_or_else(|| anyhow::anyhow!("cc_switch: turn count overflow"))?;
                }
            }
            let mut after = inner.state.snapshot(&inner.config);
            after.revision = 0;
            let changed = before != after;
            if changed {
                inner.state.bump_revision();
            }
            let snapshot = inner.state.snapshot(&inner.config);
            let analytics = inner.state.analytics_snapshot(
                &inner.config,
                format_day(min_epoch_day),
                format_day(max_epoch_day),
                min_epoch_day,
                max_epoch_day,
                None,
                current_time_ms(),
            );
            let push = changed.then(|| {
                inner.snapshots_published = inner.snapshots_published.saturating_add(1);
                SnapshotPush::Snapshot {
                    instance_id: instance_id.to_string(),
                    snapshot,
                }
            });
            let response = TokenCostActionResponse::Synced {
                imported_turns,
                analytics,
            };
            if let Some(push) = push {
                self.snapshot_tx.send_replace(Some(push));
            }
            response
        };
        Ok(response)
    }

    fn diagnostics_locked(&self, inner: &ServiceInner) -> TokenCostDiagnostics {
        TokenCostDiagnostics {
            events_ingested: inner.events_ingested,
            events_coalesced: inner.events_coalesced,
            events_rejected: inner.events_rejected,
            queue_depth: inner.queue.len() as u64,
            queue_high_water: inner.queue.high_water() as u64,
            recent_turns: inner.state.recent_turn_count() as u64,
            dedupe_fingerprints: inner.state.dedupe_fingerprint_count() as u64,
            snapshots_published: inner.snapshots_published,
            snapshots_sent: self.push_metrics.snapshots_sent(),
            lazy_commands_sent: self.push_metrics.lazy_commands_sent(),
        }
    }
}

struct AtomicFlagGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for AtomicFlagGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

#[derive(Deserialize)]
struct CcSwitchPayload<'a> {
    ok: bool,
    #[serde(borrow, deserialize_with = "deserialize_cc_switch_turns")]
    turns: Vec<CcSwitchTurn<'a>>,
}

#[derive(Deserialize)]
struct CcSwitchTurn<'a> {
    #[serde(borrow)]
    turn_id: &'a str,
    #[serde(borrow)]
    model: &'a str,
    occurred_at_ms: u64,
    usage: TokenUsage,
}

fn deserialize_cc_switch_turns<'de, D>(deserializer: D) -> Result<Vec<CcSwitchTurn<'de>>, D::Error>
where
    D: Deserializer<'de>,
{
    struct BoundedTurnsVisitor<'de>(PhantomData<&'de ()>);

    impl<'de> Visitor<'de> for BoundedTurnsVisitor<'de> {
        type Value = Vec<CcSwitchTurn<'de>>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(formatter, "at most {MAX_CC_SWITCH_TURNS} CC Switch turns")
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut turns = Vec::with_capacity(
                sequence
                    .size_hint()
                    .unwrap_or_default()
                    .min(MAX_CC_SWITCH_TURNS),
            );
            while turns.len() < MAX_CC_SWITCH_TURNS {
                let Some(turn) = sequence.next_element()? else {
                    return Ok(turns);
                };
                turns.push(turn);
            }
            if sequence.next_element::<IgnoredAny>()?.is_some() {
                return Err(A::Error::custom("CC Switch turn count exceeds limit"));
            }
            Ok(turns)
        }
    }

    deserializer.deserialize_seq(BoundedTurnsVisitor(PhantomData))
}

fn validate_cc_switch_payload(payload: &CcSwitchPayload<'_>) -> anyhow::Result<()> {
    ensure!(payload.ok, "cc_switch: helper reported failure");
    let mut aggregate = TokenUsage::default();
    for turn in &payload.turns {
        ensure!(
            !turn.turn_id.is_empty() && turn.turn_id.len() <= MAX_ID_BYTES,
            "cc_switch: turn_id is invalid"
        );
        validate_model(turn.model).map_err(|_| anyhow::anyhow!("cc_switch: model is invalid"))?;
        ensure!(
            (1..=MAX_CC_SWITCH_OCCURRED_AT_MS).contains(&turn.occurred_at_ms),
            "cc_switch: occurred_at_ms is invalid"
        );
        ensure!(
            turn.usage.cached_input <= turn.usage.input,
            "cc_switch: cached input exceeds input"
        );
        aggregate.input = aggregate
            .input
            .checked_add(turn.usage.input)
            .ok_or_else(|| anyhow::anyhow!("cc_switch: input overflow"))?;
        aggregate.cached_input = aggregate
            .cached_input
            .checked_add(turn.usage.cached_input)
            .ok_or_else(|| anyhow::anyhow!("cc_switch: cached input overflow"))?;
        aggregate.cache_write = aggregate
            .cache_write
            .checked_add(turn.usage.cache_write)
            .ok_or_else(|| anyhow::anyhow!("cc_switch: cache write overflow"))?;
        aggregate.output = aggregate
            .output
            .checked_add(turn.usage.output)
            .ok_or_else(|| anyhow::anyhow!("cc_switch: output overflow"))?;
    }
    Ok(())
}

fn cc_switch_meta(
    turn_id: &str,
    event_id: String,
    correlation_id: &str,
    occurred_at_ms: u64,
) -> EventMeta {
    EventMeta {
        source: UsageSource::ProtocolProxy,
        session_id: "cc-switch".to_string(),
        turn_id: turn_id.to_string(),
        event_id,
        correlation_id: correlation_id.to_string(),
        occurred_at_ms,
    }
}

fn cc_switch_identity(turn_id: &str) -> String {
    format!("{:x}", Sha256::digest(turn_id.as_bytes()))
}

pub(crate) fn validate_instance_id(instance_id: &str) -> anyhow::Result<()> {
    ensure!(
        !instance_id.is_empty(),
        "invalid_instance: instance_id must not be empty"
    );
    ensure!(
        instance_id.len() <= MAX_INSTANCE_ID_BYTES,
        "invalid_instance: instance_id exceeds {MAX_INSTANCE_ID_BYTES} bytes"
    );
    Ok(())
}

fn validate_model(model: &str) -> anyhow::Result<()> {
    ensure!(!model.is_empty(), "model must not be empty");
    ensure!(
        model.len() <= MAX_MODEL_BYTES,
        "model exceeds {MAX_MODEL_BYTES} bytes"
    );
    Ok(())
}

fn analytics_snapshot(
    inner: &ServiceInner,
    range: AnalyticsRange,
    model_filter: Option<&str>,
) -> anyhow::Result<AnalyticsSnapshot> {
    let today = current_epoch_day();
    let (from_day_number, to_day_number) = match range {
        AnalyticsRange::Today => (today, today),
        AnalyticsRange::LastSevenDays => (today.saturating_sub(6), today),
        AnalyticsRange::LastThirtyDays => (today.saturating_sub(29), today),
        AnalyticsRange::Custom { from_day, to_day } => {
            let from = parse_day(&from_day)?;
            let to = parse_day(&to_day)?;
            ensure!(from <= to, "analytics range is reversed");
            ensure!(to - from < 31, "analytics range exceeds 31 days");
            (from, to)
        }
    };
    let from_day = format_day(from_day_number);
    let to_day = format_day(to_day_number);
    Ok(inner.state.analytics_snapshot(
        &inner.config,
        from_day,
        to_day,
        from_day_number,
        to_day_number,
        model_filter,
        current_time_ms(),
    ))
}

fn current_epoch_day() -> i64 {
    current_time_ms().min(i64::MAX as u64) as i64 / 86_400_000
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn parse_day(day: &str) -> anyhow::Result<i64> {
    ensure!(day.len() == 10, "analytics day must use YYYY-MM-DD");
    let bytes = day.as_bytes();
    ensure!(
        bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit()),
        "analytics day must use YYYY-MM-DD"
    );
    let year = day[0..4].parse::<i32>()?;
    let month = day[5..7].parse::<u32>()?;
    let day_of_month = day[8..10].parse::<u32>()?;
    ensure!((1..=12).contains(&month), "analytics month is invalid");
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        28 + u32::from(leap),
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    ensure!(
        (1..=month_days[month as usize - 1]).contains(&day_of_month),
        "analytics day is invalid"
    );
    Ok(days_from_civil(year, month, day_of_month))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let adjusted_year = i64::from(year) - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn format_day(days: i64) -> String {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(turn_id: String, event_id: String, occurred_at_ms: u64) -> EventMeta {
        EventMeta {
            source: UsageSource::Renderer,
            session_id: "batch-session".to_string(),
            turn_id,
            event_id,
            correlation_id: "batch-correlation".to_string(),
            occurred_at_ms,
        }
    }

    #[test]
    fn synchronous_batches_exercise_real_service_queue_pressure() {
        let deltas = TokenCostService::in_memory();
        deltas.bootstrap("page-1").unwrap();
        let outcome =
            deltas.ingest_batch((0..10_000_u64).map(|index| TokenCostEvent::OutputDelta {
                meta: meta("delta-turn".to_string(), format!("delta-{index}"), index),
                estimated_output_tokens: index,
            }));
        assert_eq!(outcome, IngestOutcome::Applied { revision: 1 });
        let inner = deltas
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let diagnostics = deltas.diagnostics_locked(&inner);
        assert_eq!(diagnostics.events_ingested, 10_000);
        assert_eq!(diagnostics.events_coalesced, 9_999);
        assert_eq!(diagnostics.events_rejected, 0);
        assert_eq!(diagnostics.queue_depth, 0);
        assert_eq!(diagnostics.queue_high_water, 1);
        assert_eq!(diagnostics.snapshots_published, 1);
        assert_eq!(inner.state.snapshot(&inner.config).output, 9_999);
        drop(inner);

        let critical = TokenCostService::in_memory();
        critical.bootstrap("page-1").unwrap();
        let outcome = critical.ingest_batch((0..=EVENT_QUEUE_CAPACITY).map(|index| {
            TokenCostEvent::TurnStarted {
                meta: meta(
                    format!("critical-turn-{index}"),
                    format!("critical-start-{index}"),
                    index as u64,
                ),
                model: "gpt-5.6-sol".to_string(),
                fast: false,
            }
        }));
        assert_eq!(outcome, IngestOutcome::Applied { revision: 1 });
        let inner = critical
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let diagnostics = critical.diagnostics_locked(&inner);
        assert_eq!(diagnostics.events_ingested, 257);
        assert_eq!(diagnostics.events_coalesced, 0);
        assert_eq!(diagnostics.events_rejected, 0);
        assert_eq!(diagnostics.queue_depth, 0);
        assert_eq!(diagnostics.queue_high_water, EVENT_QUEUE_CAPACITY as u64);
        assert_eq!(diagnostics.snapshots_published, 1);
        assert_eq!(inner.state.snapshot(&inner.config).turns, 257);
    }

    #[test]
    fn synchronous_batch_applies_every_distinct_ordinary_event_at_capacity() {
        let service = TokenCostService::in_memory();
        service.bootstrap("page-1").unwrap();

        let outcome = service.ingest_batch((0..=EVENT_QUEUE_CAPACITY).map(|index| {
            TokenCostEvent::OutputDelta {
                meta: meta(
                    format!("ordinary-turn-{index}"),
                    format!("ordinary-delta-{index}"),
                    index as u64,
                ),
                estimated_output_tokens: 1,
            }
        }));

        assert_eq!(outcome, IngestOutcome::Applied { revision: 1 });
        let inner = service
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let diagnostics = service.diagnostics_locked(&inner);
        let snapshot = inner.state.snapshot(&inner.config);
        assert_eq!(snapshot.turns, 257);
        assert_eq!(snapshot.output, 257);
        assert_eq!(diagnostics.events_ingested, 257);
        assert_eq!(diagnostics.events_rejected, 0);
        assert_eq!(diagnostics.events_coalesced, 0);
        assert_eq!(diagnostics.queue_high_water, EVENT_QUEUE_CAPACITY as u64);
        assert_eq!(snapshot.revision, 1);
        assert_eq!(diagnostics.snapshots_published, 1);
    }

    #[test]
    fn retired_turn_support_window_stays_hard_bounded() {
        let service = TokenCostService::in_memory();
        service.bootstrap("page-1").unwrap();
        for index in 0..(RECENT_TURN_LIMIT + DEDUPE_FINGERPRINT_LIMIT + 1) {
            let turn_id = format!("retired-turn-{index}");
            service.ingest(TokenCostEvent::TurnStarted {
                meta: meta(turn_id.clone(), format!("start-{index}"), index as u64 * 2),
                model: "gpt-5.6-sol".to_string(),
                fast: false,
            });
            service.ingest(TokenCostEvent::TurnCompleted {
                meta: meta(turn_id, format!("complete-{index}"), index as u64 * 2 + 1),
                usage: None,
            });
        }

        let inner = service
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        assert_eq!(inner.state.recent_turn_count(), RECENT_TURN_LIMIT);
        assert_eq!(inner.state.retired_turn_count(), DEDUPE_FINGERPRINT_LIMIT);
    }

    #[tokio::test]
    async fn matching_dispose_clears_a_precreated_snapshot_subscription() {
        let service = TokenCostService::in_memory();
        let pushes = service.subscribe();
        service.bootstrap("page-1").unwrap();
        service.ingest(TokenCostEvent::TurnStarted {
            meta: meta("turn-1".to_string(), "start-1".to_string(), 1),
            model: "gpt-5.6-sol".to_string(),
            fast: false,
        });
        assert!(pushes.snapshots.borrow().is_some());

        let response = service
            .apply_action(TokenCostAction::DisposeInstance {
                instance_id: "page-1".to_string(),
            })
            .await
            .unwrap();

        assert_eq!(response, TokenCostActionResponse::Disposed);
        assert!(pushes.snapshots.borrow().is_none());
        assert!(!service.capture_enabled());
    }
}
