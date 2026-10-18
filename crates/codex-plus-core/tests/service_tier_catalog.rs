use codex_plus_core::service_tier_catalog::{
    MANAGED_SERVICE_TIER_CATALOG, sync_native_model_cache_in_home,
    sync_service_tier_catalog_in_home,
};

#[test]
fn cc_switch_projection_uses_saved_windows_and_native_fast_without_mutating_source() {
    use codex_plus_core::service_tier_catalog::sync_cc_switch_catalog;
    use codex_plus_core::settings::BackendSettings;
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let config = "model=\"gpt-6.1-sol\"\nmodel_provider=\"relay\"\nmodel_context_window=1000000\nmodel_auto_compact_token_limit=950000\nmodel_catalog_json=\"model-catalogs/relay-old.json\"\n[model_providers.relay]\nbase_url=\"https://test.invalid/v1\"\n";
    std::fs::write(home.join("config.toml"), config).unwrap();
    let source = serde_json::json!({"models":[
        {"slug":"gpt-6.1-sol","context_window":272000,"effective_context_window_percent":95,"service_tiers":[],"additional_speed_tiers":[]},
        {"slug":"gpt-6-sol","context_window":272000,"effective_context_window_percent":95,"service_tiers":[],"additional_speed_tiers":[]}
    ]});
    let source_text = serde_json::to_string(&source).unwrap();
    std::fs::write(home.join("cc-switch-model-catalog.json"), &source_text).unwrap();
    let db_path = home.join("cc-switch.db");
    let db = rusqlite::Connection::open(&db_path).unwrap();
    db.execute_batch("CREATE TABLE providers(app_type TEXT,is_current INTEGER,settings_config TEXT)").unwrap();
    let saved = serde_json::json!({"config":config,"modelCatalog":{"models":[
        {"model":"gpt-6.1-sol","contextWindow":1000000},
        {"model":"gpt-6-sol","contextWindow":500000}
    ]}});
    db.execute("INSERT INTO providers VALUES('codex',1,?1)", [saved.to_string()]).unwrap();
    let mut settings = BackendSettings::default();
    settings.relay_profiles_enabled = false;
    settings.enhancements_enabled = true;
    settings.codex_app_native_fast_unlock = true;
    assert!(sync_cc_switch_catalog(home, &settings, &db_path).unwrap());
    let projected: serde_json::Value = serde_json::from_slice(&std::fs::read(home.join("model-catalogs/cc-switch-native.json")).unwrap()).unwrap();
    for (index, window) in [1000000, 500000].into_iter().enumerate() {
        let model = &projected["models"][index];
        assert_eq!(model["context_window"], window);
        assert_eq!(model["effective_context_window_percent"], 100);
        assert_eq!(model["auto_compact_token_limit"], window * 95 / 100);
        assert_eq!(model["service_tiers"][0]["id"], "priority");
        assert_eq!(model["additional_speed_tiers"][0], "fast");
    }
    let live = std::fs::read_to_string(home.join("config.toml")).unwrap();
    assert!(!live.contains("model_context_window"));
    assert!(!live.contains("model_auto_compact_token_limit"));
    assert_eq!(std::fs::read_to_string(home.join("cc-switch-model-catalog.json")).unwrap(), source_text);
    assert!(!sync_cc_switch_catalog(home, &settings, &db_path).unwrap());
    settings.codex_app_native_fast_unlock = false;
    assert!(sync_cc_switch_catalog(home, &settings, &db_path).unwrap());
    let projected: serde_json::Value = serde_json::from_slice(&std::fs::read(home.join("model-catalogs/cc-switch-native.json")).unwrap()).unwrap();
    assert_eq!(projected["models"][0]["service_tiers"], serde_json::json!([]));
    settings.relay_profiles_enabled = true;
    std::fs::write(home.join("config.toml"), config).unwrap();
    assert!(!sync_cc_switch_catalog(home, &settings, &db_path).unwrap());
    settings.relay_profiles_enabled = false;
    std::fs::write(home.join("config.toml"), config.replace("model-catalogs/relay-old.json", "custom.json")).unwrap();
    assert!(!sync_cc_switch_catalog(home, &settings, &db_path).unwrap());
    std::fs::write(home.join("config.toml"), config.replace("https://test.invalid/v1", "https://other.invalid/v1")).unwrap();
    assert!(!sync_cc_switch_catalog(home, &settings, &db_path).unwrap());
}

fn native_context_fixture() -> (tempfile::TempDir, &'static str, serde_json::Value) {
    let temp = tempfile::tempdir().unwrap();
    let config = "model = \"gpt-5.4\"\nmodel_context_window = 512000\nmodel_auto_compact_token_limit = 460000\n";
    std::fs::write(temp.path().join("config.toml"), config).unwrap();
    let cache = serde_json::json!({"models": [
        {"slug":"gpt-5.4","context_window":272000,"max_context_window":272000,"effective_context_window_percent":95,"auto_compact_token_limit":200000,"input_modalities":["text","image"],"default_reasoning_level":"low"},
        {"slug":"deepseek-v4-pro","context_window":128000,"max_context_window":128000,"effective_context_window_percent":90,"input_modalities":["text"],"service_tiers":[],"default_reasoning_level":"high"}
    ]});
    std::fs::write(
        temp.path().join("models_cache.json"),
        serde_json::to_vec(&cache).unwrap(),
    )
    .unwrap();
    (temp, config, cache)
}

#[test]
fn native_context_config_applies_to_non_gpt6_models_without_changing_capabilities() {
    let (temp, config, cache) = native_context_fixture();
    assert!(sync_service_tier_catalog_in_home(temp.path()).unwrap());
    let patched: serde_json::Value =
        serde_json::from_slice(&std::fs::read(temp.path().join("models_cache.json")).unwrap())
            .unwrap();
    for (index, model) in patched["models"].as_array().unwrap().iter().enumerate() {
        assert_eq!(model["context_window"], 512000);
        assert_eq!(model["max_context_window"], 512000);
        assert_eq!(model["effective_context_window_percent"], 100);
        assert_eq!(model["auto_compact_token_limit"], 460000);
        assert_eq!(
            model["input_modalities"],
            cache["models"][index]["input_modalities"]
        );
        assert_eq!(
            model["default_reasoning_level"],
            cache["models"][index]["default_reasoning_level"]
        );
        assert_eq!(
            model["service_tiers"],
            cache["models"][index]["service_tiers"]
        );
    }
    assert_eq!(
        std::fs::read_to_string(temp.path().join("config.toml")).unwrap(),
        config
    );
    assert!(!temp.path().join(MANAGED_SERVICE_TIER_CATALOG).exists());
    assert!(!sync_service_tier_catalog_in_home(temp.path()).unwrap());
}

#[test]
fn native_context_lookup_uses_current_model_and_updated_config() {
    let (temp, config, _) = native_context_fixture();
    assert_eq!(
        sync_native_model_cache_in_home(temp.path(), None).unwrap()["model"],
        "gpt-5.4"
    );
    let selected = sync_native_model_cache_in_home(temp.path(), Some("deepseek-v4-pro")).unwrap();
    assert_eq!(selected["model"], "deepseek-v4-pro");
    assert_eq!(selected["contextWindow"], 512000);
    assert_eq!(
        sync_native_model_cache_in_home(temp.path(), Some("missing-model")).unwrap()["status"],
        "unavailable"
    );
    std::fs::write(
        temp.path().join("config.toml"),
        config.replace("512000", "768000"),
    )
    .unwrap();
    assert_eq!(
        sync_native_model_cache_in_home(temp.path(), Some("deepseek-v4-pro")).unwrap()["contextWindow"],
        768000
    );
}

#[test]
fn native_context_invalid_values_preserve_cached_defaults() {
    let temp = tempfile::tempdir().unwrap();
    let cache = r#"{"models":[{"slug":"custom-model","context_window":200000,"max_context_window":400000,"effective_context_window_percent":95,"auto_compact_token_limit":170000}]}"#;
    std::fs::write(temp.path().join("models_cache.json"), cache).unwrap();
    for value in ["0", "-1", "\"1M\""] {
        std::fs::write(temp.path().join("config.toml"), format!("model=\"custom-model\"\nmodel_context_window={value}\nmodel_auto_compact_token_limit={value}\n")).unwrap();
        assert!(!sync_service_tier_catalog_in_home(temp.path()).unwrap());
        assert_eq!(
            sync_native_model_cache_in_home(temp.path(), None).unwrap()["contextWindow"],
            190000
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("models_cache.json")).unwrap(),
            cache
        );
    }
}

#[test]
fn sync_service_tier_catalog_patches_gpt6_in_default_model_cache() {
    let temp = tempfile::tempdir().unwrap();
    let config = concat!(
        "model = \"gpt-6-astra\"\n",
        "model_context_window = 1000000\n",
        "model_auto_compact_token_limit = 950000\n",
        "model_provider = \"custom\"\n",
    );
    let cache = br#"{"models":[{"slug":"gpt-6-astra","context_window":272000,"max_context_window":272000,"effective_context_window_percent":95,"auto_compact_token_limit":null,"input_modalities":["text"],"supports_image_detail_original":false,"default_reasoning_level":"none","supported_reasoning_levels":[{"effort":"none","description":"No configurable reasoning"}],"additional_speed_tiers":[],"service_tiers":[]},{"slug":"gpt-5.6-sol","additional_speed_tiers":[],"service_tiers":[]}]}"#;
    std::fs::write(temp.path().join("config.toml"), config).unwrap();
    std::fs::write(temp.path().join("models_cache.json"), cache).unwrap();

    assert!(sync_service_tier_catalog_in_home(temp.path()).unwrap());
    assert_eq!(
        std::fs::read_to_string(temp.path().join("config.toml")).unwrap(),
        config
    );

    let patched: serde_json::Value =
        serde_json::from_slice(&std::fs::read(temp.path().join("models_cache.json")).unwrap())
            .unwrap();
    let gpt6 = &patched["models"][0];
    assert_eq!(
        gpt6["supported_reasoning_levels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|level| level["effort"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["low", "medium", "high", "xhigh", "max", "ultra"]
    );
    assert_eq!(gpt6["default_reasoning_level"], "medium");
    assert_eq!(gpt6["service_tiers"], serde_json::json!([]));
    assert_eq!(gpt6["additional_speed_tiers"], serde_json::json!([]));
    assert_eq!(
        gpt6["input_modalities"],
        serde_json::json!(["text", "image"])
    );
    assert_eq!(gpt6["supports_image_detail_original"], true);
    assert_eq!(gpt6["context_window"], 1_000_000);
    assert_eq!(gpt6["max_context_window"], 1_000_000);
    assert_eq!(gpt6["effective_context_window_percent"], 100);
    assert_eq!(gpt6["auto_compact_token_limit"], 950_000);
    assert_eq!(patched["models"][1]["service_tiers"], serde_json::json!([]));
    assert!(!temp.path().join(MANAGED_SERVICE_TIER_CATALOG).exists());
    let runtime =
        codex_plus_core::service_tier_catalog::sync_native_model_cache_in_home(temp.path(), None)
            .unwrap();
    assert_eq!(
        runtime,
        serde_json::json!({ "status": "ok", "model": "gpt-6-astra", "contextWindow": 1_000_000 })
    );
}

#[test]
fn sync_service_tier_catalog_replaces_invalid_gpt6_none_reasoning() {
    for (slug, window) in [("gpt-6-astra", 1_050_000), ("gpt-6-sol", 272_000), ("gpt-6-luna", 272_000)] {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("config.toml"),
            concat!(
                "model = \"gpt-6-astra\"\n",
                "model_reasoning_effort = \"none\"\n",
                "model_provider = \"custom\"\n",
            ).replace("gpt-6-astra", slug),
        )
        .unwrap();
        std::fs::write(
            temp.path().join("models_cache.json"),
            r#"{"models":[{"slug":"gpt-6-astra","context_window":272000,"max_context_window":272000,"input_modalities":["text"],"supports_image_detail_original":false,"default_reasoning_level":"none","supported_reasoning_levels":[{"effort":"none"}],"additional_speed_tiers":[],"service_tiers":[]}]}"#.replace("gpt-6-astra", slug),
        )
        .unwrap();

        assert!(sync_service_tier_catalog_in_home(temp.path()).unwrap());

        let config = std::fs::read_to_string(temp.path().join("config.toml")).unwrap();
        assert!(config.contains("model_reasoning_effort = \"medium\""));
        assert!(config.contains("model_provider = \"custom\""));
        let patched: serde_json::Value =
            serde_json::from_slice(&std::fs::read(temp.path().join("models_cache.json")).unwrap())
                .unwrap();
        assert_eq!(patched["models"][0]["context_window"], window);
        assert_eq!(patched["models"][0]["max_context_window"], window);
        assert_eq!(
            patched["models"][0]["input_modalities"],
            serde_json::json!(["text", "image"])
        );
    }
}

#[test]
fn gpt6_cache_metadata_never_injects_or_replaces_native_speed_tiers() {
    for slug in ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] {
        for tiers in [
            serde_json::json!({}),
            serde_json::json!({"service_tiers": [], "additional_speed_tiers": []}),
            serde_json::json!({
                "service_tiers": [{"id": "priority", "name": "Native Fast"}, {"id": "ultrafast"}],
                "additional_speed_tiers": ["fast", "ultrafast"]
            }),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let mut model = tiers.clone();
            model["slug"] = slug.into();
            std::fs::write(
                temp.path().join("models_cache.json"),
                serde_json::to_vec(&serde_json::json!({"models": [model]})).unwrap(),
            )
            .unwrap();
            assert!(sync_service_tier_catalog_in_home(temp.path()).unwrap());
            let patched: serde_json::Value = serde_json::from_slice(
                &std::fs::read(temp.path().join("models_cache.json")).unwrap(),
            )
            .unwrap();
            for key in ["service_tiers", "additional_speed_tiers"] {
                assert_eq!(patched["models"][0].get(key), tiers.get(key), "{slug}: {key}");
            }
            assert_eq!(patched["models"][0]["default_reasoning_level"], "medium");
            assert!(!sync_service_tier_catalog_in_home(temp.path()).unwrap());
        }
    }
}

#[test]
fn gpt6_cache_preserves_native_ultra_and_the_selected_effort() {
    for slug in ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] {
        let temp = tempfile::tempdir().unwrap();
        let config = format!("model=\"{slug}\"\nmodel_reasoning_effort=\"ultra\"\n");
        let cache = serde_json::json!({"models":[{
            "slug":slug, "context_window":512000, "max_context_window":512000,
            "service_tiers":[{"id":"priority"},{"id":"ultrafast"}],
            "multi_agent_version":"v2", "multi_agent_reasoning_effort":"xhigh",
            "supported_reasoning_levels":[
                {"effort":"none"},
                {"effort":"low","description":"Native low"},
                {"effort":"ultra","description":"Native automatic delegation"}
            ]
        }]});
        std::fs::write(temp.path().join("config.toml"), &config).unwrap();
        std::fs::write(
            temp.path().join("models_cache.json"),
            serde_json::to_vec(&cache).unwrap(),
        )
        .unwrap();
        assert!(sync_service_tier_catalog_in_home(temp.path()).unwrap());
        let patched: serde_json::Value =
            serde_json::from_slice(&std::fs::read(temp.path().join("models_cache.json")).unwrap())
                .unwrap();
        assert_eq!(patched["models"][0]["service_tiers"][1]["id"], "ultrafast");
        if slug != "gpt-6-astra" {
            assert_eq!(patched["models"][0]["context_window"], 512000);
            assert_eq!(patched["models"][0]["max_context_window"], 512000);
        }
        let levels = patched["models"][0]["supported_reasoning_levels"]
            .as_array()
            .unwrap();
        assert_eq!(levels[0]["description"], "Native low");
        assert_eq!(levels.last().unwrap()["effort"], "ultra");
        assert_eq!(
            levels.last().unwrap()["description"],
            "Native automatic delegation"
        );
        assert!(!levels.iter().any(|level| level["effort"] == "none"));
        assert_eq!(patched["models"][0]["multi_agent_version"], "v2");
        assert_eq!(patched["models"][0]["multi_agent_reasoning_effort"], "xhigh");
        assert_eq!(
            std::fs::read_to_string(temp.path().join("config.toml")).unwrap(),
            config
        );
        assert!(!sync_service_tier_catalog_in_home(temp.path()).unwrap());
    }
}

#[test]
fn sync_service_tier_catalog_retires_managed_catalog_pointer() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("config.toml"),
        format!(
            "model = \"gpt-6-astra\"\nmodel_catalog_json = \"{MANAGED_SERVICE_TIER_CATALOG}\"\n"
        ),
    )
    .unwrap();
    std::fs::write(
        temp.path().join("models_cache.json"),
        br#"{"models":[{"slug":"gpt-5.6-sol","additional_speed_tiers":[],"service_tiers":[]}]}"#,
    )
    .unwrap();

    assert!(sync_service_tier_catalog_in_home(temp.path()).unwrap());

    let config = std::fs::read_to_string(temp.path().join("config.toml")).unwrap();
    assert!(!config.contains("model_catalog_json"));
}

#[test]
fn sync_service_tier_catalog_preserves_user_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let original = concat!(
        "model = \"gpt-5.6-sol\"\n",
        "model_catalog_json = \"D:/metadata/custom-models.json\"\n"
    );
    std::fs::write(temp.path().join("config.toml"), original).unwrap();
    std::fs::write(
        temp.path().join("models_cache.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "models": [{
                "slug": "gpt-5.6-sol",
                "additional_speed_tiers": [],
                "service_tiers": []
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    assert!(!sync_service_tier_catalog_in_home(temp.path()).unwrap());
    assert_eq!(
        std::fs::read_to_string(temp.path().join("config.toml")).unwrap(),
        original
    );
    assert!(!temp.path().join(MANAGED_SERVICE_TIER_CATALOG).exists());
    assert_eq!(
        sync_native_model_cache_in_home(temp.path(), None).unwrap()["status"],
        "unavailable"
    );
}
