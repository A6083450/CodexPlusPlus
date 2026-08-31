use anyhow::Context;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use toml_edit::{DocumentMut, Item};

pub const MANAGED_SERVICE_TIER_CATALOG: &str = "model-catalogs/codexplusplus-service-tiers.json";

const GPT56_METADATA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../assets/gpt56-model-metadata-compat.json"
));

pub fn sync_service_tier_catalog_in_home(home: &Path) -> anyhow::Result<bool> {
    let config_path = home.join("config.toml");
    let config_text = match std::fs::read_to_string(&config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", config_path.display()));
        }
    };
    let mut config = parse_config(&config_text)?;
    let existing_catalog = config
        .get("model_catalog_json")
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if existing_catalog.is_some_and(|path| !is_managed_catalog(path)) {
        return Ok(false);
    }

    let cache_path = home.join("models_cache.json");
    let cache_bytes = std::fs::read(&cache_path)
        .with_context(|| format!("failed to read {}", cache_path.display()))?;
    let mut cache: Value = serde_json::from_slice(&cache_bytes)
        .with_context(|| format!("{} is not valid JSON", cache_path.display()))?;
    let models = cache
        .get_mut("models")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            anyhow::anyhow!("{} does not contain a models array", cache_path.display())
        })?;
    let compatibility = compatibility_by_slug()?;

    let mut patched = false;
    for model in models.iter_mut() {
        let Some(slug) = model.get("slug").and_then(Value::as_str) else {
            continue;
        };
        let Some(metadata) = compatibility.get(slug) else {
            continue;
        };
        let Some(target) = model.as_object_mut() else {
            continue;
        };
        for key in ["additional_speed_tiers", "service_tiers"] {
            let Some(value) = metadata.get(key) else {
                continue;
            };
            if target.get(key) != Some(value) {
                target.insert(key.to_string(), value.clone());
                patched = true;
            }
        }
    }
    if !patched {
        return Ok(false);
    }

    let catalog_path = home.join(MANAGED_SERVICE_TIER_CATALOG);
    let mut catalog_bytes = serde_json::to_vec_pretty(&json!({ "models": models }))?;
    catalog_bytes.push(b'\n');
    let mut changed = write_if_changed(&catalog_path, &catalog_bytes)?;

    if existing_catalog.is_none() {
        config["model_catalog_json"] = toml_edit::value(MANAGED_SERVICE_TIER_CATALOG);
        let mut updated = config.to_string();
        if !updated.ends_with('\n') {
            updated.push('\n');
        }
        crate::settings::atomic_write(&config_path, updated.as_bytes())?;
        changed = true;
    }
    Ok(changed)
}

fn compatibility_by_slug() -> anyhow::Result<HashMap<String, Value>> {
    let catalog: Value = serde_json::from_str(GPT56_METADATA_JSON)?;
    let models = catalog
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("bundled GPT-5.6 metadata does not contain models"))?;
    Ok(models
        .iter()
        .filter_map(|model| {
            let slug = model.get("slug")?.as_str()?.to_string();
            Some((slug, model.clone()))
        })
        .collect())
}

fn is_managed_catalog(path: &str) -> bool {
    path.trim().replace('\\', "/").trim_start_matches("./") == MANAGED_SERVICE_TIER_CATALOG
}

fn parse_config(contents: &str) -> anyhow::Result<DocumentMut> {
    let contents = contents.trim_start_matches('\u{feff}');
    if contents.trim().is_empty() {
        Ok(DocumentMut::new())
    } else {
        contents
            .parse::<DocumentMut>()
            .map_err(|error| anyhow::anyhow!("config.toml TOML parse failed: {error}"))
    }
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> anyhow::Result<bool> {
    if std::fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(false);
    }
    crate::settings::atomic_write(path, bytes)?;
    Ok(true)
}
