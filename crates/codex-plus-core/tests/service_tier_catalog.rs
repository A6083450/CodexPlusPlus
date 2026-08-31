use codex_plus_core::service_tier_catalog::{
    MANAGED_SERVICE_TIER_CATALOG, sync_service_tier_catalog_in_home,
};

#[test]
fn sync_service_tier_catalog_preserves_models_and_enables_gpt56_priority() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("config.toml"),
        "model = \"gpt-5.6-sol\"\nmodel_provider = \"custom\"\n",
    )
    .unwrap();
    std::fs::write(
        temp.path().join("models_cache.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "fetched_at": "2026-08-31T00:00:00Z",
            "models": [
                {
                    "slug": "gpt-5.6-sol",
                    "display_name": "GPT-5.6-Sol",
                    "context_window": 272000,
                    "additional_speed_tiers": [],
                    "service_tiers": []
                },
                {
                    "slug": "custom-model",
                    "display_name": "Custom Model",
                    "context_window": 123456,
                    "service_tiers": []
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    assert!(sync_service_tier_catalog_in_home(temp.path()).unwrap());

    let config = std::fs::read_to_string(temp.path().join("config.toml")).unwrap();
    assert!(config.contains(&format!(
        "model_catalog_json = \"{MANAGED_SERVICE_TIER_CATALOG}\""
    )));

    let catalog: serde_json::Value = serde_json::from_slice(
        &std::fs::read(temp.path().join(MANAGED_SERVICE_TIER_CATALOG)).unwrap(),
    )
    .unwrap();
    let models = catalog["models"].as_array().unwrap();
    assert_eq!(models.len(), 2);

    let sol = models
        .iter()
        .find(|model| model["slug"] == "gpt-5.6-sol")
        .unwrap();
    assert_eq!(sol["additional_speed_tiers"], serde_json::json!(["fast"]));
    assert_eq!(sol["service_tiers"][0]["id"], "priority");

    let custom = models
        .iter()
        .find(|model| model["slug"] == "custom-model")
        .unwrap();
    assert_eq!(custom["context_window"], 123456);
    assert_eq!(custom["service_tiers"], serde_json::json!([]));
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
}
