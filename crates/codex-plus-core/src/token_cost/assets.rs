use anyhow::{bail, ensure};

use super::{LazyAsset, LazyAssetPush, MAX_SNAPSHOT_BYTES, SnapshotPush};

const SETTINGS_SOURCE: &str = include_str!("../../../../assets/live_token_cost/settings.js");
const ANALYTICS_SOURCE: &str = include_str!("../../../../assets/live_token_cost/analytics.js");
const PROFILE_SOURCE: &str = include_str!("../../../../assets/live_token_cost/profile.js");
const FLATPICKR_SOURCE: &str = include_str!("../../../../assets/live_token_cost/flatpickr.js");
const FLATPICKR_CSS: &str = include_str!("../../../../assets/live_token_cost/flatpickr.css");

pub fn snapshot_expression(push: &SnapshotPush) -> anyhow::Result<String> {
    let payload = serde_json::to_string(push)?;
    let expression = format!("window.__codexLiveTokenCostV1?.acceptNativePush({payload})");
    ensure!(
        expression.len() <= MAX_SNAPSHOT_BYTES,
        "snapshot expression exceeds {MAX_SNAPSHOT_BYTES} bytes"
    );
    Ok(expression)
}

pub fn lazy_asset_expression(push: &LazyAssetPush) -> anyhow::Result<String> {
    let instance_id = serde_json::to_string(&push.instance_id)?;
    let source = lazy_asset_source(push.asset);
    let css = serde_json::to_string(match push.asset {
        LazyAsset::Flatpickr => FLATPICKR_CSS,
        _ => "",
    })?;
    Ok(format!(
        "(()=>{{const api=window.__codexLiveTokenCostV1;if(!api || api.instanceId !== {instance_id})return;const css={css};(()=>{{\n{source}\n}})();}})()"
    ))
}

pub(crate) fn lazy_lag_expression(push: &LazyAssetPush) -> anyhow::Result<String> {
    let instance_id = serde_json::to_string(&push.instance_id)?;
    let asset = serde_json::to_string(lazy_asset_name(push.asset))?;
    Ok(format!(
        "(()=>{{const api=window.__codexLiveTokenCostV1;if(!api || api.instanceId !== {instance_id})return;api.acceptLazyError?.({{asset:{asset},category:\"lagged\",message:\"lazy module request was superseded\"}});}})()"
    ))
}

pub fn lazy_asset_source(asset: LazyAsset) -> &'static str {
    match asset {
        LazyAsset::Settings => SETTINGS_SOURCE,
        LazyAsset::Analytics => ANALYTICS_SOURCE,
        LazyAsset::Profile => PROFILE_SOURCE,
        LazyAsset::Flatpickr => FLATPICKR_SOURCE,
    }
}

fn lazy_asset_name(asset: LazyAsset) -> &'static str {
    match asset {
        LazyAsset::Settings => "settings",
        LazyAsset::Analytics => "analytics",
        LazyAsset::Profile => "profile",
        LazyAsset::Flatpickr => "flatpickr",
    }
}

pub(crate) fn validate_lazy_expression(expression: &str) -> anyhow::Result<()> {
    if expression.len() > 512 * 1024 {
        bail!("lazy expression exceeds the static asset limit");
    }
    Ok(())
}
