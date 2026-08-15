use std::sync::{
    RwLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Instant;

use tokio::sync::{broadcast, watch};

use super::{LazyAssetPush, SNAPSHOT_MIN_INTERVAL, SnapshotPush};

#[derive(Debug)]
pub struct SnapshotCoalescer {
    last_sent_at: Option<Instant>,
    pending: Option<SnapshotPush>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum SnapshotOffer {
    SendNow(SnapshotPush),
    ArmAt(Instant),
    ReplacedPending,
}

impl Default for SnapshotCoalescer {
    fn default() -> Self {
        Self {
            last_sent_at: None,
            pending: None,
        }
    }
}

impl SnapshotCoalescer {
    pub fn offer(&mut self, now: Instant, push: SnapshotPush) -> SnapshotOffer {
        let deadline = self
            .last_sent_at
            .and_then(|last_sent_at| last_sent_at.checked_add(SNAPSHOT_MIN_INTERVAL));
        if deadline.is_none_or(|deadline| now >= deadline) {
            self.pending = None;
            self.last_sent_at = Some(now);
            return SnapshotOffer::SendNow(push);
        }

        let replaced = self.pending.replace(push).is_some();
        if replaced {
            SnapshotOffer::ReplacedPending
        } else {
            SnapshotOffer::ArmAt(deadline.expect("a gated snapshot must have a deadline"))
        }
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.pending.as_ref()?;
        self.last_sent_at
            .and_then(|last_sent_at| last_sent_at.checked_add(SNAPSHOT_MIN_INTERVAL))
    }

    pub fn take_due(&mut self, now: Instant) -> Option<SnapshotPush> {
        if self.deadline().is_none_or(|deadline| now < deadline) {
            return None;
        }
        let push = self.pending.take()?;
        self.last_sent_at = Some(now);
        Some(push)
    }

    pub fn clear(&mut self) {
        self.pending = None;
    }
}

#[allow(dead_code)]
pub struct TokenCostPushReceiver {
    pub(crate) snapshots: watch::Receiver<Option<SnapshotPush>>,
    pub(crate) lazy: broadcast::Receiver<LazyAssetPush>,
    pub(crate) metrics: std::sync::Arc<PushMetrics>,
    pub(crate) active_instance: std::sync::Arc<ActiveInstance>,
}

#[derive(Default)]
pub(crate) struct PushMetrics {
    snapshots_sent: AtomicU64,
    lazy_commands_sent: AtomicU64,
}

impl PushMetrics {
    pub(crate) fn snapshots_sent(&self) -> u64 {
        self.snapshots_sent.load(Ordering::Relaxed)
    }

    pub(crate) fn lazy_commands_sent(&self) -> u64 {
        self.lazy_commands_sent.load(Ordering::Relaxed)
    }

    pub(crate) fn increment_snapshots_sent(&self) {
        self.snapshots_sent.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn increment_lazy_commands_sent(&self) {
        self.lazy_commands_sent.fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub(crate) struct ActiveInstance {
    current: RwLock<Option<String>>,
}

impl ActiveInstance {
    pub(crate) fn replace(&self, instance_id: String) {
        *self
            .current
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(instance_id);
    }

    pub(crate) fn clear_if(&self, instance_id: &str) -> bool {
        let mut current = self
            .current
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        if current.as_deref() != Some(instance_id) {
            return false;
        }
        *current = None;
        true
    }

    pub(crate) fn matches(&self, instance_id: &str) -> bool {
        self.current
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_deref()
            == Some(instance_id)
    }

    pub(crate) fn is_active(&self) -> bool {
        self.current
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .is_some()
    }

    pub(crate) fn current(&self) -> Option<String> {
        self.current
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }
}
