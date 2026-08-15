use std::collections::BTreeMap;

use codex_plus_core::paths::{
    TOKEN_COST_UI_FILE, default_codex_plus_config_dir, token_cost_ui_path,
};
use codex_plus_core::token_cost::{
    EventMeta, MAX_EMAIL_BYTES, MAX_MODEL_BYTES, MAX_PROFILE_AVATAR_BYTES, MAX_PROFILE_TEXT_BYTES,
    ModelPrice, ProfileConfig, TokenCostEvent, TokenUsage, UiConfig, UiConfigStore, UsageSource,
    default_model_price, fast_multiplier_millis, usage_cost_nanos,
};
use serde_json::json;

fn meta(source: UsageSource) -> EventMeta {
    EventMeta {
        source,
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        event_id: "event-1".to_string(),
        correlation_id: "correlation-1".to_string(),
        occurred_at_ms: 42,
    }
}

fn config_with_profile(profile: ProfileConfig) -> UiConfig {
    UiConfig {
        profile,
        ..UiConfig::default()
    }
}

fn meta_json(source: &str) -> serde_json::Value {
    json!({
        "source": source,
        "session_id": "session-1",
        "turn_id": "turn-1",
        "event_id": "event-1",
        "correlation_id": "correlation-1",
        "occurred_at_ms": 42
    })
}

#[test]
fn event_models_use_the_exact_wire_tags() {
    assert_eq!(
        serde_json::to_value(UsageSource::ProtocolProxy).unwrap(),
        json!("protocol_proxy")
    );
    assert_eq!(
        serde_json::to_value(UsageSource::Renderer).unwrap(),
        json!("renderer")
    );

    let usage = TokenUsage {
        input: 10,
        cached_input: 2,
        cache_write: 3,
        output: 4,
    };
    let cases = vec![
        (
            TokenCostEvent::TurnStarted {
                meta: meta(UsageSource::ProtocolProxy),
                model: "gpt-5.6-sol".to_string(),
                fast: true,
            },
            json!({
                "type": "turn_started",
                "meta": meta_json("protocol_proxy"),
                "model": "gpt-5.6-sol",
                "fast": true
            }),
            &["meta", "model", "fast"][..],
        ),
        (
            TokenCostEvent::OutputDelta {
                meta: meta(UsageSource::Renderer),
                estimated_output_tokens: 7,
            },
            json!({
                "type": "output_delta",
                "meta": meta_json("renderer"),
                "estimated_output_tokens": 7
            }),
            &["meta", "estimated_output_tokens"],
        ),
        (
            TokenCostEvent::ToolStarted {
                meta: meta(UsageSource::Renderer),
                call_id: "call-1".to_string(),
                name: "shell".to_string(),
            },
            json!({
                "type": "tool_started",
                "meta": meta_json("renderer"),
                "call_id": "call-1",
                "name": "shell"
            }),
            &["meta", "call_id", "name"],
        ),
        (
            TokenCostEvent::ToolCompleted {
                meta: meta(UsageSource::ProtocolProxy),
                call_id: "call-1".to_string(),
            },
            json!({
                "type": "tool_completed",
                "meta": meta_json("protocol_proxy"),
                "call_id": "call-1"
            }),
            &["meta", "call_id"],
        ),
        (
            TokenCostEvent::Usage {
                meta: meta(UsageSource::ProtocolProxy),
                usage,
                exact: true,
            },
            json!({
                "type": "usage",
                "meta": meta_json("protocol_proxy"),
                "usage": {
                    "input": 10,
                    "cached_input": 2,
                    "cache_write": 3,
                    "output": 4
                },
                "exact": true
            }),
            &["meta", "usage", "exact"],
        ),
        (
            TokenCostEvent::TurnCompleted {
                meta: meta(UsageSource::Renderer),
                usage: Some(usage),
            },
            json!({
                "type": "turn_completed",
                "meta": meta_json("renderer"),
                "usage": {
                    "input": 10,
                    "cached_input": 2,
                    "cache_write": 3,
                    "output": 4
                }
            }),
            &["meta"],
        ),
        (
            TokenCostEvent::TurnFailed {
                meta: meta(UsageSource::ProtocolProxy),
            },
            json!({
                "type": "turn_failed",
                "meta": meta_json("protocol_proxy")
            }),
            &["meta"],
        ),
    ];

    for (event, expected, required_fields) in cases {
        assert_eq!(serde_json::to_value(&event).unwrap(), expected);
        assert_eq!(
            serde_json::from_value::<TokenCostEvent>(expected.clone()).unwrap(),
            event
        );

        let mut with_unknown = expected.clone();
        with_unknown["unexpected"] = json!(true);
        assert!(serde_json::from_value::<TokenCostEvent>(with_unknown).is_err());

        for required_field in required_fields {
            let mut missing_required = expected.clone();
            missing_required
                .as_object_mut()
                .unwrap()
                .remove(*required_field);
            assert!(
                serde_json::from_value::<TokenCostEvent>(missing_required).is_err(),
                "{required_field} must be required in {expected}"
            );
        }
    }
}

#[test]
fn model_types_reject_unknown_fields() {
    assert!(
        serde_json::from_value::<EventMeta>(json!({
            "source": "renderer",
            "session_id": "session-1",
            "turn_id": "turn-1",
            "event_id": "event-1",
            "correlation_id": "correlation-1",
            "occurred_at_ms": 42,
            "request_body": "must not be accepted"
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<TokenUsage>(json!({
            "input": 1,
            "cached_input": 0,
            "cache_write": 0,
            "output": 1,
            "total": 2
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<TokenCostEvent>(json!({
            "type": "turn_failed",
            "meta": serde_json::to_value(meta(UsageSource::ProtocolProxy)).unwrap(),
            "message": "must not be accepted"
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<ModelPrice>(json!({
            "input_nanos_per_million": 1,
            "cached_input_nanos_per_million": null,
            "cache_write_nanos_per_million": null,
            "output_nanos_per_million": 1,
            "currency": "USD"
        }))
        .is_err()
    );
}

#[test]
fn profile_and_ui_config_defaults_match_the_local_usage_contract() {
    assert_eq!(
        ProfileConfig::default(),
        ProfileConfig {
            display_name: "Local Usage".to_string(),
            username: "codex-local-usage".to_string(),
            email: "sama@openai.com".to_string(),
            plan_type: "pro_20x".to_string(),
            plan_label: "Pro 20x".to_string(),
            workspace_name: String::new(),
            avatar_data_url: None,
        }
    );
    assert_eq!(
        UiConfig::default(),
        UiConfig {
            schema_version: 1,
            hub_visible: true,
            output_rate_visible: true,
            profile_visible: true,
            price_overrides: BTreeMap::new(),
            profile: ProfileConfig::default(),
        }
    );

    let parsed: UiConfig = serde_json::from_value(json!({})).unwrap();
    assert_eq!(parsed, UiConfig::default());
}

#[test]
fn config_types_reject_unknown_fields() {
    let mut profile = serde_json::to_value(ProfileConfig::default()).unwrap();
    profile["credential"] = json!("must not be accepted");
    assert!(serde_json::from_value::<ProfileConfig>(profile).is_err());

    let mut config = serde_json::to_value(UiConfig::default()).unwrap();
    config["legacy_storage"] = json!(true);
    assert!(serde_json::from_value::<UiConfig>(config).is_err());
}

#[test]
fn ui_config_store_rejects_oversized_profile_text_fields() {
    for field in ["display_name", "plan_type", "plan_label", "workspace_name"] {
        let mut profile = ProfileConfig::default();
        let oversized = "x".repeat(MAX_PROFILE_TEXT_BYTES + 1);
        match field {
            "display_name" => profile.display_name = oversized,
            "plan_type" => profile.plan_type = oversized,
            "plan_label" => profile.plan_label = oversized,
            "workspace_name" => profile.workspace_name = oversized,
            _ => unreachable!(),
        }

        let error = UiConfigStore::in_memory()
            .save(&config_with_profile(profile))
            .unwrap_err();
        assert!(
            error.to_string().contains(field),
            "unexpected error: {error}"
        );
    }
}

#[test]
fn ui_config_store_counts_utf8_limits_in_bytes() {
    let mut profile = ProfileConfig::default();
    profile.display_name = "用".repeat(MAX_PROFILE_TEXT_BYTES / 3 + 1);
    assert!(
        UiConfigStore::in_memory()
            .save(&config_with_profile(profile))
            .unwrap_err()
            .to_string()
            .contains("display_name")
    );

    let mut config = UiConfig::default();
    config
        .price_overrides
        .insert("模".repeat(MAX_MODEL_BYTES / 3 + 1), ModelPrice::default());
    assert!(
        UiConfigStore::in_memory()
            .save(&config)
            .unwrap_err()
            .to_string()
            .contains("model")
    );
}

#[test]
fn ui_config_store_accepts_exact_string_and_username_boundaries() {
    for username in ["abc".to_string(), "x".repeat(20)] {
        let profile = ProfileConfig {
            display_name: "d".repeat(MAX_PROFILE_TEXT_BYTES),
            username,
            email: "e".repeat(MAX_EMAIL_BYTES),
            plan_type: "t".repeat(MAX_PROFILE_TEXT_BYTES),
            plan_label: "l".repeat(MAX_PROFILE_TEXT_BYTES),
            workspace_name: "w".repeat(MAX_PROFILE_TEXT_BYTES),
            avatar_data_url: None,
        };
        let mut config = config_with_profile(profile);
        config
            .price_overrides
            .insert("m".repeat(MAX_MODEL_BYTES), ModelPrice::default());
        UiConfigStore::in_memory().save(&config).unwrap();
    }
}

#[test]
fn ui_config_store_rejects_invalid_usernames() {
    for username in [
        "ab".to_string(),
        "x".repeat(21),
        "not allowed".to_string(),
        "not/allowed".to_string(),
        "not:allowed".to_string(),
        "codex-\u{7528}\u{6237}".to_string(),
    ] {
        let mut profile = ProfileConfig::default();
        profile.username = username;
        let error = UiConfigStore::in_memory()
            .save(&config_with_profile(profile))
            .unwrap_err();
        assert!(
            error.to_string().contains("username"),
            "unexpected error: {error}"
        );
    }
}

#[test]
fn ui_config_store_rejects_oversized_email_and_model_names() {
    let mut profile = ProfileConfig::default();
    profile.email = "x".repeat(MAX_EMAIL_BYTES + 1);
    assert!(
        UiConfigStore::in_memory()
            .save(&config_with_profile(profile))
            .unwrap_err()
            .to_string()
            .contains("email")
    );

    let mut config = UiConfig::default();
    config
        .price_overrides
        .insert("x".repeat(MAX_MODEL_BYTES + 1), ModelPrice::default());
    assert!(
        UiConfigStore::in_memory()
            .save(&config)
            .unwrap_err()
            .to_string()
            .contains("model")
    );

    let mut config = UiConfig::default();
    config
        .price_overrides
        .insert(String::new(), ModelPrice::default());
    assert!(
        UiConfigStore::in_memory()
            .save(&config)
            .unwrap_err()
            .to_string()
            .contains("model")
    );
}

#[test]
fn ui_config_store_validates_avatar_data_urls_and_size() {
    for avatar in [
        "data:image/png;base64,iVBORw0KGgo=",
        "data:image/jpeg;base64,/9j/4A==",
        "data:image/webp;base64,UklGRgQAAABXRUJQ",
    ] {
        let mut profile = ProfileConfig::default();
        profile.avatar_data_url = Some(avatar.to_string());
        UiConfigStore::in_memory()
            .save(&config_with_profile(profile))
            .unwrap();
    }

    for avatar in [
        "https://example.com/avatar.png".to_string(),
        "data:image/gif;base64,AAAA".to_string(),
        "data:image/png;base64,".to_string(),
        "data:image/png;base64,not valid".to_string(),
        "data:image/png;base64,/9j/4A==".to_string(),
        "data:image/jpeg;base64,iVBORw0KGgo=".to_string(),
        "data:image/webp;base64,iVBORw0KGgo=".to_string(),
        "data:image/png;base64,AAAA".to_string(),
        "data:image/png;base64,====".to_string(),
        "data:image/png;base64,iVBORw0KGgo===".to_string(),
        "data:image/png;base64,AAAAA".to_string(),
        "data:image/png;base64,iVBORw0KGgo*".to_string(),
        "data:image/jpeg;base64,/9j/4B==".to_string(),
    ] {
        let mut profile = ProfileConfig::default();
        profile.avatar_data_url = Some(avatar);
        assert!(
            UiConfigStore::in_memory()
                .save(&config_with_profile(profile))
                .is_err()
        );
    }

    let prefix = "data:image/webp;base64,";
    let payload = format!(
        "UklGRgQAAABXRUJQ{}",
        "AAAA".repeat((MAX_PROFILE_AVATAR_BYTES - prefix.len() - 16) / 4)
    );
    assert_eq!(prefix.len() + payload.len(), MAX_PROFILE_AVATAR_BYTES - 1);
    assert!(prefix.len() + payload.len() + 4 > MAX_PROFILE_AVATAR_BYTES);
    let mut profile = ProfileConfig::default();
    profile.avatar_data_url = Some(format!("{prefix}{payload}"));
    UiConfigStore::in_memory()
        .save(&config_with_profile(profile.clone()))
        .unwrap();

    profile.avatar_data_url.as_mut().unwrap().push_str("AAAA");
    assert!(
        UiConfigStore::in_memory()
            .save(&config_with_profile(profile))
            .unwrap_err()
            .to_string()
            .contains("avatar_data_url")
    );
}

#[test]
fn default_prices_match_the_fallback_table_in_integer_nanodollars() {
    let cases = [
        (
            "gpt-5.6-sol",
            5_000_000_000,
            Some(500_000_000),
            Some(6_250_000_000),
            30_000_000_000,
        ),
        (
            "gpt-5.6-terra",
            2_500_000_000,
            Some(250_000_000),
            Some(3_125_000_000),
            15_000_000_000,
        ),
        (
            "gpt-5.6-luna",
            1_000_000_000,
            Some(100_000_000),
            Some(1_250_000_000),
            6_000_000_000,
        ),
        (
            "gpt-5.3-codex",
            1_750_000_000,
            Some(175_000_000),
            None,
            14_000_000_000,
        ),
        (
            "gpt-5.4",
            2_500_000_000,
            Some(250_000_000),
            None,
            15_000_000_000,
        ),
        (
            "gpt-5.4-mini",
            750_000_000,
            Some(75_000_000),
            None,
            4_500_000_000,
        ),
        (
            "gpt-5.4-nano",
            200_000_000,
            Some(20_000_000),
            None,
            1_250_000_000,
        ),
        ("gpt-5.4-pro", 30_000_000_000, None, None, 180_000_000_000),
        (
            "gpt-5.5",
            5_000_000_000,
            Some(500_000_000),
            None,
            30_000_000_000,
        ),
        ("gpt-5.5-pro", 30_000_000_000, None, None, 180_000_000_000),
    ];

    for (model, input, cached_input, cache_write, output) in cases {
        assert_eq!(
            default_model_price(model),
            Some(ModelPrice {
                input_nanos_per_million: input,
                cached_input_nanos_per_million: cached_input,
                cache_write_nanos_per_million: cache_write,
                output_nanos_per_million: output,
            }),
            "wrong fallback price for {model}"
        );
    }
    assert_eq!(default_model_price("unknown-model"), None);
}

#[test]
fn fast_multipliers_match_model_families_without_prefix_collisions() {
    assert_eq!(fast_multiplier_millis("gpt-5.6"), 2_000);
    assert_eq!(fast_multiplier_millis("gpt-5.6-sol"), 2_000);
    assert_eq!(fast_multiplier_millis("gpt-5.5-pro"), 2_500);
    assert_eq!(fast_multiplier_millis("gpt-5.4_mini"), 2_000);
    assert_eq!(fast_multiplier_millis("gpt-5.60"), 1_000);
    assert_eq!(fast_multiplier_millis("unknown-model"), 1_000);
}

#[test]
fn usage_cost_uses_integer_components_and_fallback_prices() {
    let usage = TokenUsage {
        input: 2_000_000,
        cached_input: 1_000_000,
        cache_write: 1_000_000,
        output: 500_000,
    };
    let price = ModelPrice {
        input_nanos_per_million: 1_000_000_000,
        cached_input_nanos_per_million: None,
        cache_write_nanos_per_million: None,
        output_nanos_per_million: 4_000_000_000,
    };

    assert_eq!(usage_cost_nanos(usage, price, 1_000), 5_000_000_000);
    assert_eq!(usage_cost_nanos(usage, price, 2_500), 12_500_000_000);
}

#[test]
fn usage_cost_saturates_input_subtraction_and_clamps_u128_math() {
    let cached_exceeds_input = TokenUsage {
        input: 1,
        cached_input: 1_000_000,
        cache_write: 0,
        output: 0,
    };
    let one_dollar = ModelPrice {
        input_nanos_per_million: 1_000_000_000,
        cached_input_nanos_per_million: Some(1_000_000_000),
        cache_write_nanos_per_million: None,
        output_nanos_per_million: 0,
    };
    assert_eq!(
        usage_cost_nanos(cached_exceeds_input, one_dollar, 1_000),
        1_000_000_000
    );

    assert_eq!(
        usage_cost_nanos(
            TokenUsage {
                input: u64::MAX,
                cached_input: u64::MAX,
                cache_write: u64::MAX,
                output: u64::MAX,
            },
            ModelPrice {
                input_nanos_per_million: u64::MAX,
                cached_input_nanos_per_million: Some(u64::MAX),
                cache_write_nanos_per_million: Some(u64::MAX),
                output_nanos_per_million: u64::MAX,
            },
            u32::MAX,
        ),
        u64::MAX
    );
}

#[test]
fn ui_config_path_is_isolated_from_existing_app_state_files() {
    assert_eq!(TOKEN_COST_UI_FILE, "token-cost-ui.json");
    assert_eq!(
        token_cost_ui_path(),
        default_codex_plus_config_dir().join(TOKEN_COST_UI_FILE)
    );
    assert!(!token_cost_ui_path().ends_with(".codex-session-delete/settings.json"));
    assert!(!token_cost_ui_path().ends_with(".codex-session-delete/latest-status.json"));
}

#[test]
fn ui_config_store_loads_only_its_exact_path_and_in_memory_stays_ephemeral() {
    let temp = tempfile::tempdir().unwrap();
    let exact_path = temp.path().join("nested").join("custom-ui.json");
    std::fs::write(
        temp.path().join(TOKEN_COST_UI_FILE),
        serde_json::to_vec(&UiConfig {
            hub_visible: false,
            ..UiConfig::default()
        })
        .unwrap(),
    )
    .unwrap();

    let store = UiConfigStore::new(exact_path.clone());
    assert_eq!(store.load(), UiConfig::default());

    let persisted = UiConfig {
        output_rate_visible: false,
        ..UiConfig::default()
    };
    store.save(&persisted).unwrap();
    assert_eq!(store.load(), persisted);
    assert!(exact_path.is_file());

    let in_memory = UiConfigStore::in_memory();
    in_memory
        .save(&UiConfig {
            hub_visible: false,
            ..UiConfig::default()
        })
        .unwrap();
    assert_eq!(in_memory.load(), UiConfig::default());
}

#[test]
fn invalid_configs_fall_back_and_emit_only_one_diagnostic() {
    let temp = tempfile::tempdir().unwrap();
    let diagnostic_path = temp.path().join("diagnostic.log");
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(Some(
        diagnostic_path.clone(),
    ));

    let malformed_path = temp.path().join("malformed.json");
    std::fs::write(&malformed_path, b"{malformed").unwrap();
    assert_eq!(
        UiConfigStore::new(malformed_path).load(),
        UiConfig::default()
    );

    let unreadable_path = temp.path().join("unreadable.json");
    std::fs::create_dir(&unreadable_path).unwrap();
    assert_eq!(
        UiConfigStore::new(unreadable_path).load(),
        UiConfig::default()
    );

    let wrong_schema_path = temp.path().join("wrong-schema.json");
    std::fs::write(
        &wrong_schema_path,
        serde_json::to_vec(&UiConfig {
            schema_version: 2,
            ..UiConfig::default()
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        UiConfigStore::new(wrong_schema_path).load(),
        UiConfig::default()
    );

    let invalid_value_path = temp.path().join("invalid-value.json");
    let mut invalid_value = UiConfig::default();
    invalid_value
        .price_overrides
        .insert(String::new(), ModelPrice::default());
    std::fs::write(
        &invalid_value_path,
        serde_json::to_vec(&invalid_value).unwrap(),
    )
    .unwrap();
    assert_eq!(
        UiConfigStore::new(invalid_value_path).load(),
        UiConfig::default()
    );

    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(None);
    let diagnostics = std::fs::read_to_string(diagnostic_path).unwrap();
    assert_eq!(diagnostics.lines().count(), 1);
    assert!(diagnostics.contains("token_cost.ui_config_load_failed"));
}

#[test]
fn ui_config_store_atomically_replaces_without_a_leftover_temp_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("token-cost-ui.json");
    let store = UiConfigStore::new(path.clone());
    store.save(&UiConfig::default()).unwrap();

    let replacement = UiConfig {
        hub_visible: false,
        profile_visible: false,
        ..UiConfig::default()
    };
    store.save(&replacement).unwrap();

    assert_eq!(
        serde_json::from_slice::<UiConfig>(&std::fs::read(&path).unwrap()).unwrap(),
        replacement
    );
    assert!(!temp.path().join("token-cost-ui.json.tmp").exists());
}
