use anyhow::Context;
use serde_json::{Map, Value};
use std::path::Path;
use toml_edit::{DocumentMut, Item};

pub const MANAGED_SERVICE_TIER_CATALOG: &str = "model-catalogs/codexplusplus-service-tiers.json";
const CC_SWITCH_NATIVE_CATALOG: &str = "model-catalogs/cc-switch-native.json";

pub fn sync_cc_switch_catalog(
    home: &Path,
    settings: &crate::settings::BackendSettings,
    db_path: &Path,
) -> anyhow::Result<bool> {
    if settings.relay_profiles_enabled || !settings.enhancements_enabled || !db_path.exists() {
        return Ok(false);
    }
    let config_path = home.join("config.toml");
    let original = std::fs::read_to_string(&config_path)?;
    let mut config = parse_config(&original)?;
    let pointer = config.get("model_catalog_json").and_then(Item::as_str).unwrap_or_default();
    let path = home.join(pointer);
    if !pointer.is_empty() && path != home.join("cc-switch-model-catalog.json")
        && path != home.join(CC_SWITCH_NATIVE_CATALOG)
        && !(path.parent() == Some(home.join("model-catalogs").as_path())
            && path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("relay-")))
    {
        return Ok(false);
    }
    let source_path = home.join("cc-switch-model-catalog.json");
    if !source_path.exists() { return Ok(false); }
    let db = rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let saved = db.query_row(
        "SELECT settings_config FROM providers WHERE app_type='codex' AND is_current=1",
        [], |row| row.get::<_, String>(0),
    );
    let saved = match saved {
        Ok(saved) => serde_json::from_str::<Value>(&saved)?,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let saved_config = parse_config(saved["config"].as_str().unwrap_or_default())?;
    let provider = config.get("model_provider").and_then(Item::as_str).unwrap_or_default();
    if provider.is_empty() || saved_config.get("model_provider").and_then(Item::as_str) != Some(provider) {
        return Ok(false);
    }
    let base_url = |document: &DocumentMut| document.get("model_providers")
        .and_then(|providers| providers.get(provider)).and_then(|entry| entry.get("base_url"))
        .and_then(Item::as_str).unwrap_or_default().trim_end_matches('/').to_string();
    if base_url(&config).is_empty() || base_url(&config) != base_url(&saved_config) { return Ok(false); }
    let Some(entries) = saved["modelCatalog"]["models"].as_array().filter(|entries| !entries.is_empty()) else {
        return Ok(false);
    };
    let source: Value = serde_json::from_slice(&std::fs::read(source_path)?)?;
    let templates = source["models"].as_array().context("CC Switch catalog has no models")?;
    let global_window = positive_config_integer(&saved_config, "model_context_window");
    let global_compact = positive_config_integer(&saved_config, "model_auto_compact_token_limit");
    let mut models = Vec::new();
    for entry in entries {
        let slug = entry["model"].as_str().context("CC Switch model has no id")?;
        let mut model = templates.iter().find(|model| model["slug"] == slug)
            .context("CC Switch generated catalog is missing a saved model")?.clone();
        if let Some(window) = entry["contextWindow"].as_u64().filter(|value| *value > 0 && *value <= i64::MAX as u64).or(global_window) {
            model["context_window"] = window.into();
            model["max_context_window"] = window.into();
            model["effective_context_window_percent"] = model["effective_context_window_percent"]
                .as_u64().filter(|percent| (1..=100).contains(percent)).unwrap_or(95).into();
            let compact = global_window.zip(global_compact)
                .filter(|(total, limit)| limit <= total)
                .and_then(|(total, limit)| window.checked_mul(limit).map(|value| value / total))
                .unwrap_or(window / 100 * 95 + window % 100 * 95 / 100);
            model["auto_compact_token_limit"] = compact.into();
        }
        if settings.codex_app_native_fast_unlock && matches!(slug,
            "gpt-5.6-luna" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna" | "gpt-6.1-sol")
        {
            let mut tiers = model["service_tiers"].as_array().cloned().unwrap_or_default();
            if !tiers.iter().any(|tier| tier["id"] == "priority") {
                tiers.push(serde_json::json!({"id":"priority","name":"Fast","description":"Priority processing, increased usage"}));
            }
            model["service_tiers"] = tiers.into();
            let mut speeds = model["additional_speed_tiers"].as_array().cloned().unwrap_or_default();
            if !speeds.iter().any(|speed| speed == "fast") { speeds.push("fast".into()); }
            model["additional_speed_tiers"] = speeds.into();
        }
        models.push(model);
    }
    let target = home.join(CC_SWITCH_NATIVE_CATALOG);
    let projected = serde_json::to_vec_pretty(&serde_json::json!({"models":models}))?;
    let mut changed = std::fs::read(&target).ok().as_deref() != Some(projected.as_slice());
    if changed {
        std::fs::create_dir_all(target.parent().unwrap())?;
        crate::settings::atomic_write(&target, &projected)?;
    }
    config["model_catalog_json"] = toml_edit::value(target.to_string_lossy().as_ref());
    config.remove("model_context_window");
    config.remove("model_auto_compact_token_limit");
    let updated = config.to_string();
    if updated != original {
        crate::settings::atomic_write(&config_path, updated.as_bytes())?;
        changed = true;
    }
    Ok(changed)
}

pub fn sync_native_model_cache_in_home(
    home: &Path,
    requested_model: Option<&str>,
) -> anyhow::Result<Value> {
    sync_service_tier_catalog_in_home(home)?;
    let config =
        parse_config(&std::fs::read_to_string(home.join("config.toml")).unwrap_or_default())?;
    let projection = config.get("model_catalog_json").and_then(Item::as_str)
        .is_some_and(|path| home.join(path) == home.join(CC_SWITCH_NATIVE_CATALOG));
    if uses_external_catalog(&config) && !projection {
        return Ok(serde_json::json!({ "status": "unavailable" }));
    }
    let model_name = requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .or_else(|| config.get("model").and_then(Item::as_str))
        .unwrap_or_default();
    let path = home.join(if projection { CC_SWITCH_NATIVE_CATALOG } else { "models_cache.json" });
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
    let mut result = match window {
        Some(window) => serde_json::json!({
            "status": "ok", "model": model_name, "contextWindow": window
        }),
        None => serde_json::json!({ "status": "unavailable" }),
    };
    if projection && result["status"] == "ok" {
        result["config"] = serde_json::json!({"model_context_window": model.unwrap()["context_window"]});
        if let Some(limit) = model.and_then(|model| model["auto_compact_token_limit"].as_u64()) {
            result["config"]["model_auto_compact_token_limit"] = limit.into();
        }
    }
    Ok(result)
}

pub fn sync_service_tier_catalog_in_home(home: &Path) -> anyhow::Result<bool> {
    let mut projected = false;
    if home.join("config.toml").exists() {
        let settings_path = crate::paths::default_settings_path();
        if settings_path.exists() {
            let settings = crate::settings::SettingsStore::new(settings_path).load()?;
            let db_path = if settings.ccs_db_path.is_empty() { crate::ccs_import::default_ccs_db_path() }
                else { settings.ccs_db_path.clone().into() };
            projected = sync_cc_switch_catalog(home, &settings, &db_path)?;
        }
    }
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
    let replaces_invalid_gpt6_reasoning = matches!(
        config.get("model").and_then(Item::as_str),
        Some("gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna")
    ) && config.get("model_reasoning_effort").and_then(Item::as_str) == Some("none");
    let mut changed = patch_native_model_cache(home, &config)? || projected;

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
    let mut changed = false;
    for model in models.iter_mut().filter_map(Value::as_object_mut) {
        let mut metadata = context.clone();
        let slug = model.get("slug").and_then(Value::as_str).unwrap_or_default();
        if matches!(slug, "gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna") {
            for (key, value) in &gpt6_compat_metadata(slug) {
                // 新模型保留原生窗口，兼容模板仅补缺失值；显式配置仍优先。
                if slug != "gpt-6-astra"
                    && matches!(
                        key.as_str(),
                        "context_window" | "max_context_window"
                            | "effective_context_window_percent" | "auto_compact_token_limit"
                    )
                    && model.contains_key(key)
                {
                    continue;
                }
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

fn gpt6_compat_metadata(slug: &str) -> Map<String, Value> {
    let metadata = crate::model_suffix::runtime_model_metadata_entry(slug)
        .expect("bundled GPT-6 metadata");
    [
        "default_reasoning_level",
        "supported_reasoning_levels",
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
