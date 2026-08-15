use std::sync::{Arc, Mutex, atomic::AtomicBool};

use anyhow::{bail, ensure};
use tokio::sync::{broadcast, watch};

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
pub use push::TokenCostPushReceiver;
pub use state::{
    BoundedEventQueue, DEDUPE_FINGERPRINT_LIMIT, EVENT_QUEUE_CAPACITY, QueueAdmission,
    RECENT_TURN_LIMIT, RuntimeState,
};

use push::{ActiveInstance, PushMetrics};

const LAZY_PUSH_CAPACITY: usize = 8;

pub const MAX_SSE_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_RENDERER_EVENT_BYTES: usize = 4 * 1024;

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

    pub(crate) fn ingest_batch<I>(&self, events: I) -> IngestOutcome
    where
        I: IntoIterator<Item = TokenCostEvent>,
    {
        let events = events.into_iter();
        if !self.capture_enabled() {
            let rejected = events.count() as u64;
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            inner.events_rejected = inner.events_rejected.saturating_add(rejected);
            return IngestOutcome::Rejected {
                reason: "capture_disabled",
            };
        }

        let (outcome, push) = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
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
        self.active_instance.replace(instance_id.to_string());
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
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
            TokenCostAction::DisposeInstance { instance_id } => {
                ensure!(
                    self.active_instance.clear_if(&instance_id),
                    "stale token cost instance"
                );
                self.snapshot_tx.send_replace(None);
                Ok(TokenCostActionResponse::Disposed)
            }
            TokenCostAction::QueryDiagnostics { instance_id } => {
                ensure!(
                    self.active_instance.matches(&instance_id),
                    "stale token cost instance"
                );
                let inner = self
                    .inner
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                Ok(TokenCostActionResponse::Diagnostics {
                    diagnostics: self.diagnostics_locked(&inner),
                })
            }
            action => {
                ensure!(
                    self.active_instance.matches(action.instance_id()),
                    "stale token cost instance"
                );
                bail!("token cost action is not implemented in the runtime core")
            }
        }
    }

    pub fn request_lazy_asset(&self, instance_id: &str, asset: LazyAsset) -> anyhow::Result<()> {
        validate_instance_id(instance_id)?;
        ensure!(
            self.active_instance.matches(instance_id),
            "stale token cost instance"
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

fn validate_instance_id(instance_id: &str) -> anyhow::Result<()> {
    ensure!(!instance_id.is_empty(), "instance_id must not be empty");
    ensure!(
        instance_id.len() <= MAX_ID_BYTES,
        "instance_id exceeds {MAX_ID_BYTES} bytes"
    );
    Ok(())
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
}
