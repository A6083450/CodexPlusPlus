use anyhow::Context;
use serde_json::{Map, Value};
use std::path::Path;
use toml_edit::{DocumentMut, Item};

pub const MANAGED_SERVICE_TIER_CATALOG: &str = "model-catalogs/codexplusplus-service-tiers.json";

pub fn sync_native_model_cache_in_home(
    home: &Path,
    requested_model: Option<&str>,
) -> anyhow::Result<Value> {
    sync_service_tier_catalog_in_home(home)?;
    let config =
        parse_config(&std::fs::read_to_string(home.join("config.toml")).unwrap_or_default())?;
    if uses_external_catalog(&config) {
        return Ok(serde_json::json!({ "status": "unavailable" }));
    }
    let model_name = requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .or_else(|| config.get("model").and_then(Item::as_str))
        .unwrap_or_default();
    let path = home.join("models_cache.json");
    if !path.exists() {
        return Ok(serde_json::json!({ "status": "unavailable" }));
    }
    let cache: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let model = cache["models"]
        .as_array()
        .and_then(|models| models.iter().find(|model| model["slug"] == model_name));
    let window = model.and_then(|model| {
        let window = model["context_window"].as_u64()?;
        let percent = model["effective_context_window_percent"].as_u64()?;
        if window == 0 || !(1..=100).contains(&percent) {
            return None;
        }
        window.checked_mul(percent).map(|value| value / 100)
    });
    Ok(match window {
        Some(window) => serde_json::json!({
            "status": "ok", "model": model_name, "contextWindow": window
        }),
        None => serde_json::json!({ "status": "unavailable" }),
    })
}

pub fn sync_service_tier_catalog_in_home(home: &Path) -> anyhow::Result<bool> {
    let config_path = home.join("config.toml");
    let config_text = match std::fs::read_to_string(&config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let mut config = parse_config(&config_text)?;
    let uses_managed_catalog = config
        .get("model_catalog_json")
        .and_then(Item::as_str)
        .is_some_and(is_managed_catalog);
    let replaces_invalid_gpt6_reasoning = config.get("model").and_then(Item::as_str)
        == Some("gpt-6-astra")
        && config.get("model_reasoning_effort").and_then(Item::as_str) == Some("none");
    let mut changed = patch_native_model_cache(home, &config)?;

    if uses_managed_catalog {
        config.remove("model_catalog_json");
    }
    if replaces_invalid_gpt6_reasoning {
        config["model_reasoning_effort"] = toml_edit::value("medium");
    }
    if uses_managed_catalog || replaces_invalid_gpt6_reasoning {
        let mut updated = config.to_string();
        if !updated.ends_with('\n') {
            updated.push('\n');
        }
        crate::settings::atomic_write(&config_path, updated.as_bytes())?;
        changed = true;
    }
    Ok(changed)
}

fn patch_native_model_cache(home: &Path, config: &DocumentMut) -> anyhow::Result<bool> {
    if uses_external_catalog(config) {
        return Ok(false);
    }
    let cache_path = home.join("models_cache.json");
    let cache_bytes = match std::fs::read(&cache_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let mut cache: Value = serde_json::from_slice(&cache_bytes)
        .with_context(|| format!("{} is not valid JSON", cache_path.display()))?;
    let Some(models) = cache.get_mut("models").and_then(Value::as_array_mut) else {
        return Ok(false);
    };
    let context = context_metadata_from_config(config);
    let gpt6 = gpt6_compat_metadata();
    let mut changed = false;
    for model in models.iter_mut().filter_map(Value::as_object_mut) {
        let mut metadata = context.clone();
        if model.get("slug").and_then(Value::as_str) == Some("gpt-6-astra") {
            for (key, value) in &gpt6 {
                let value = if key == "supported_reasoning_levels" {
                    merge_gpt6_reasoning_levels(model.get(key), value)
                } else {
                    value.clone()
                };
                metadata.entry(key.clone()).or_insert(value);
            }
        }
        for (key, value) in metadata {
            if model.get(&key) != Some(&value) {
                model.insert(key, value);
                changed = true;
            }
        }
    }
    if !changed {
        return Ok(false);
    }
    let mut updated = serde_json::to_vec_pretty(&cache)?;
    updated.push(b'\n');
    crate::settings::atomic_write(&cache_path, &updated)?;
    Ok(true)
}

fn merge_gpt6_reasoning_levels(native: Option<&Value>, fallback: &Value) -> Value {
    let mut levels = fallback.as_array().cloned().unwrap_or_default();
    for level in native.and_then(Value::as_array).into_iter().flatten() {
        let Some(effort) = level
            .get("effort")
            .and_then(Value::as_str)
            .filter(|effort| !effort.trim().is_empty() && *effort != "none")
        else {
            continue;
        };
        if let Some(existing) = levels.iter_mut().find(|entry| entry["effort"] == effort) {
            *existing = level.clone();
        } else {
            levels.push(level.clone());
        }
    }
    Value::Array(levels)
}

fn context_metadata_from_config(config: &DocumentMut) -> Map<String, Value> {
    let mut metadata = Map::new();
    if let Some(window) = positive_config_integer(config, "model_context_window") {
        metadata.insert("context_window".into(), window.into());
        metadata.insert("max_context_window".into(), window.into());
        metadata.insert("effective_context_window_percent".into(), 100.into());
    }
    if let Some(limit) = positive_config_integer(config, "model_auto_compact_token_limit") {
        metadata.insert("auto_compact_token_limit".into(), limit.into());
    }
    metadata
}

fn gpt6_compat_metadata() -> Map<String, Value> {
    let metadata = crate::model_suffix::runtime_model_metadata_entry("gpt-6-astra")
        .expect("bundled GPT-6 metadata");
    [
        "default_reasoning_level",
        "supported_reasoning_levels",
        "additional_speed_tiers",
        "service_tiers",
        "input_modalities",
        "supports_image_detail_original",
        "context_window",
        "max_context_window",
        "effective_context_window_percent",
        "auto_compact_token_limit",
    ]
    .into_iter()
    .map(|key| (key.into(), metadata[key].clone()))
    .collect()
}

fn uses_external_catalog(config: &DocumentMut) -> bool {
    config
        .get("model_catalog_json")
        .and_then(Item::as_str)
        .is_some_and(|path| !path.trim().is_empty() && !is_managed_catalog(path))
}

fn positive_config_integer(config: &DocumentMut, key: &str) -> Option<u64> {
    config
        .get(key)
        .and_then(Item::as_integer)
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| *value > 0)
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
