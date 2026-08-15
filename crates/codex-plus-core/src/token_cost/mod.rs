use std::sync::{Arc, Mutex, atomic::AtomicBool};

use anyhow::{bail, ensure};
use tokio::sync::{broadcast, watch};

pub mod config;
pub mod model;
pub mod pricing;
pub mod push;
pub mod state;

pub use config::{ProfileConfig, UiConfig, UiConfigStore};
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
        if !self.capture_enabled() {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            inner.events_rejected = inner.events_rejected.saturating_add(1);
            return IngestOutcome::Rejected {
                reason: "capture_disabled",
            };
        }

        let queued_copy = event.clone();
        let (outcome, push) = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            inner.events_ingested = inner.events_ingested.saturating_add(1);
            let mut before = inner.state.snapshot(&inner.config);
            before.revision = 0;

            let admission = inner.queue.push(event);
            match admission {
                QueueAdmission::Rejected => {
                    inner.events_rejected = inner.events_rejected.saturating_add(1);
                    return IngestOutcome::Rejected {
                        reason: "queue_capacity",
                    };
                }
                QueueAdmission::Coalesced => {
                    inner.events_coalesced = inner.events_coalesced.saturating_add(1);
                }
                QueueAdmission::RequiresDrain => {
                    if let Some(oldest) = inner.queue.pop_front() {
                        let config = inner.config.clone();
                        inner.state.apply(oldest, &config);
                    }
                    let replacement = inner.queue.push(queued_copy);
                    debug_assert_eq!(replacement, QueueAdmission::Enqueued);
                }
                QueueAdmission::Enqueued => {}
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
            } else if admission == QueueAdmission::Coalesced {
                IngestOutcome::Coalesced { revision }
            } else {
                IngestOutcome::NoChange { revision }
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
