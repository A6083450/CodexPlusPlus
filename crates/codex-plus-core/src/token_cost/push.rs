use std::sync::{
    RwLock,
    atomic::{AtomicU64, Ordering},
};

use tokio::sync::{broadcast, watch};

use super::{LazyAssetPush, SnapshotPush};

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
