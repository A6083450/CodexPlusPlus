use std::collections::BTreeMap;

use codex_plus_core::paths::{
    TOKEN_COST_UI_FILE, default_codex_plus_config_dir, token_cost_ui_path,
};
use codex_plus_core::token_cost::{
    BoundedEventQueue, DEDUPE_FINGERPRINT_LIMIT, EVENT_QUEUE_CAPACITY, EventMeta, IngestOutcome,
    MAX_EMAIL_BYTES, MAX_MODEL_BYTES, MAX_PROFILE_AVATAR_BYTES, MAX_PROFILE_TEXT_BYTES, ModelPrice,
    ProfileConfig, QueueAdmission, RECENT_TURN_LIMIT, RuntimeState, TokenCostAction,
    TokenCostActionResponse, TokenCostEvent, TokenCostService, TokenCostSnapshot, TokenUsage,
    UiConfig, UiConfigStore, UsageSource, default_model_price, fast_multiplier_millis,
    usage_cost_nanos,
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

fn runtime_meta(
    source: UsageSource,
    session_id: &str,
    turn_id: &str,
    event_id: impl Into<String>,
    correlation_id: impl Into<String>,
    occurred_at_ms: u64,
) -> EventMeta {
    EventMeta {
        source,
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        event_id: event_id.into(),
        correlation_id: correlation_id.into(),
        occurred_at_ms,
    }
}

fn turn_started(
    session_id: &str,
    turn_id: &str,
    event_id: impl Into<String>,
    correlation_id: impl Into<String>,
    occurred_at_ms: u64,
) -> TokenCostEvent {
    TokenCostEvent::TurnStarted {
        meta: runtime_meta(
            UsageSource::Renderer,
            session_id,
            turn_id,
            event_id,
            correlation_id,
            occurred_at_ms,
        ),
        model: "gpt-5.6-sol".to_string(),
        fast: false,
    }
}

fn output_delta(
    session_id: &str,
    turn_id: &str,
    event_id: impl Into<String>,
    correlation_id: impl Into<String>,
    occurred_at_ms: u64,
    estimated_output_tokens: u64,
) -> TokenCostEvent {
    TokenCostEvent::OutputDelta {
        meta: runtime_meta(
            UsageSource::Renderer,
            session_id,
            turn_id,
            event_id,
            correlation_id,
            occurred_at_ms,
        ),
        estimated_output_tokens,
    }
}

fn exact_usage(
    source: UsageSource,
    session_id: &str,
    turn_id: &str,
    event_id: impl Into<String>,
    correlation_id: impl Into<String>,
    occurred_at_ms: u64,
    usage: TokenUsage,
) -> TokenCostEvent {
    TokenCostEvent::Usage {
        meta: runtime_meta(
            source,
            session_id,
            turn_id,
            event_id,
            correlation_id,
            occurred_at_ms,
        ),
        usage,
        exact: true,
    }
}

fn turn_completed(
    source: UsageSource,
    session_id: &str,
    turn_id: &str,
    event_id: impl Into<String>,
    correlation_id: impl Into<String>,
    occurred_at_ms: u64,
    usage: Option<TokenUsage>,
) -> TokenCostEvent {
    TokenCostEvent::TurnCompleted {
        meta: runtime_meta(
            source,
            session_id,
            turn_id,
            event_id,
            correlation_id,
            occurred_at_ms,
        ),
        usage,
    }
}

fn tool_started(
    session_id: &str,
    turn_id: &str,
    event_id: impl Into<String>,
    correlation_id: impl Into<String>,
    occurred_at_ms: u64,
    call_id: &str,
) -> TokenCostEvent {
    TokenCostEvent::ToolStarted {
        meta: runtime_meta(
            UsageSource::Renderer,
            session_id,
            turn_id,
            event_id,
            correlation_id,
            occurred_at_ms,
        ),
        call_id: call_id.to_string(),
        name: "shell".to_string(),
    }
}

fn tool_completed(
    session_id: &str,
    turn_id: &str,
    event_id: impl Into<String>,
    correlation_id: impl Into<String>,
    occurred_at_ms: u64,
    call_id: &str,
) -> TokenCostEvent {
    TokenCostEvent::ToolCompleted {
        meta: runtime_meta(
            UsageSource::Renderer,
            session_id,
            turn_id,
            event_id,
            correlation_id,
            occurred_at_ms,
        ),
        call_id: call_id.to_string(),
    }
}

fn snapshot(service: &TokenCostService) -> TokenCostSnapshot {
    service.bootstrap("page-1").unwrap().snapshot
}

async fn diagnostics(
    service: &TokenCostService,
) -> codex_plus_core::token_cost::TokenCostDiagnostics {
    match service
        .apply_action(TokenCostAction::QueryDiagnostics {
            instance_id: "page-1".to_string(),
        })
        .await
        .unwrap()
    {
        TokenCostActionResponse::Diagnostics { diagnostics } => diagnostics,
        response => panic!("unexpected diagnostics response: {response:?}"),
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

#[tokio::test]
async fn capture_requires_bootstrap_and_only_the_current_instance_can_dispose() {
    let service = TokenCostService::in_memory();
    let _receiver = service.subscribe();
    assert!(!service.capture_enabled());
    assert_eq!(
        service.ingest(turn_started("s-disabled", "t-disabled", "start", "c-1", 0)),
        IngestOutcome::Rejected {
            reason: "capture_disabled",
        }
    );

    let bootstrap = service.bootstrap("page-1").unwrap();
    assert_eq!(bootstrap.instance_id, "page-1");
    assert_eq!(bootstrap.config, UiConfig::default());
    assert_eq!(bootstrap.snapshot.revision, 0);
    assert!(service.capture_enabled());

    let stale = service
        .apply_action(TokenCostAction::DisposeInstance {
            instance_id: "stale-page".to_string(),
        })
        .await;
    assert!(stale.is_err());
    assert!(service.capture_enabled());
    assert_eq!(snapshot(&service).revision, 0);

    assert_eq!(
        service
            .apply_action(TokenCostAction::DisposeInstance {
                instance_id: "page-1".to_string(),
            })
            .await
            .unwrap(),
        TokenCostActionResponse::Disposed
    );
    assert!(!service.capture_enabled());
}

#[test]
fn explicit_and_lazy_turn_starts_count_once_and_duplicate_ids_preserve_revision() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();

    assert_eq!(
        service.ingest(turn_started("s-explicit", "t-1", "start-1", "c-1", 100)),
        IngestOutcome::Applied { revision: 1 }
    );
    let started = snapshot(&service);
    assert!(started.running);
    assert_eq!(started.turns, 1);
    assert_eq!(started.steps, 1);

    let first_delta = output_delta("s-explicit", "t-1", "delta-1", "c-1", 150, 8);
    assert_eq!(
        service.ingest(first_delta.clone()),
        IngestOutcome::Applied { revision: 2 }
    );
    assert_eq!(
        service.ingest(first_delta),
        IngestOutcome::NoChange { revision: 2 }
    );
    assert_eq!(snapshot(&service).turns, 1);
    assert_eq!(snapshot(&service).output, 8);
    assert_eq!(
        service.ingest(output_delta(
            "s-explicit",
            "t-1",
            "lower-delta",
            "c-1",
            200,
            7,
        )),
        IngestOutcome::NoChange { revision: 2 }
    );

    let lazy = TokenCostService::in_memory();
    lazy.bootstrap("page-1").unwrap();
    assert_eq!(
        lazy.ingest(output_delta("s-lazy", "t-2", "delta-2", "c-2", 500, 3)),
        IngestOutcome::Applied { revision: 1 }
    );
    let lazy_snapshot = snapshot(&lazy);
    assert!(lazy_snapshot.running);
    assert_eq!(lazy_snapshot.turns, 1);
    assert_eq!(lazy_snapshot.steps, 1);
    assert_eq!(lazy_snapshot.first_token_average_ms, Some(0));

    let lazy_usage = TokenCostService::in_memory();
    lazy_usage.bootstrap("page-1").unwrap();
    assert_eq!(
        lazy_usage.ingest(exact_usage(
            UsageSource::ProtocolProxy,
            "s-lazy-usage",
            "t-lazy-usage",
            "usage",
            "c-usage",
            700,
            TokenUsage {
                input: 5,
                cached_input: 1,
                cache_write: 0,
                output: 2,
            },
        )),
        IngestOutcome::Applied { revision: 1 }
    );
    let lazy_usage_snapshot = snapshot(&lazy_usage);
    assert!(lazy_usage_snapshot.running);
    assert_eq!(lazy_usage_snapshot.turns, 1);
    assert_eq!(lazy_usage_snapshot.steps, 1);
    assert_eq!(lazy_usage_snapshot.input, 5);
    assert_eq!(lazy_usage_snapshot.output, 2);
}

#[test]
fn first_token_steps_and_overlapping_tool_time_use_only_event_timestamps() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();

    service.ingest(turn_started("s-time", "t-time", "start", "c-1", 1_000));
    service.ingest(output_delta(
        "s-time", "t-time", "delta-1", "c-1", 1_300, 10,
    ));
    service.ingest(tool_started(
        "s-time",
        "t-time",
        "tool-a-start",
        "c-1",
        1_400,
        "call-a",
    ));
    service.ingest(tool_started(
        "s-time",
        "t-time",
        "tool-b-start",
        "c-1",
        1_500,
        "call-b",
    ));
    service.ingest(tool_completed(
        "s-time",
        "t-time",
        "tool-a-end",
        "c-1",
        1_800,
        "call-a",
    ));
    service.ingest(tool_completed(
        "s-time",
        "t-time",
        "tool-b-end",
        "c-1",
        2_000,
        "call-b",
    ));
    service.ingest(output_delta(
        "s-time", "t-time", "delta-2", "c-2", 2_200, 20,
    ));
    service.ingest(turn_completed(
        UsageSource::Renderer,
        "s-time",
        "t-time",
        "complete",
        "c-2",
        2_400,
        None,
    ));

    let result = snapshot(&service);
    assert!(!result.running);
    assert_eq!(result.turns, 1);
    assert_eq!(result.steps, 2);
    assert_eq!(result.first_token_average_ms, Some(250));
    assert_eq!(result.tool_ms, 600);
    assert_eq!(result.llm_ms, 800);
    assert_eq!(result.output, 20);
}

#[test]
fn output_rate_uses_exact_output_over_measured_generation_time() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();

    service.ingest(turn_started("s-rate", "t-rate", "start", "c-1", 1_000));
    service.ingest(output_delta(
        "s-rate", "t-rate", "delta-1", "c-1", 1_100, 10,
    ));
    service.ingest(output_delta(
        "s-rate", "t-rate", "delta-2", "c-1", 2_100, 40,
    ));
    service.ingest(exact_usage(
        UsageSource::ProtocolProxy,
        "s-rate",
        "t-rate",
        "usage",
        "c-1",
        2_150,
        TokenUsage {
            input: 20,
            cached_input: 0,
            cache_write: 0,
            output: 30,
        },
    ));
    service.ingest(turn_completed(
        UsageSource::ProtocolProxy,
        "s-rate",
        "t-rate",
        "complete",
        "c-1",
        2_200,
        None,
    ));

    let result = snapshot(&service);
    assert_eq!(result.output, 30);
    assert_eq!(result.output_rate_milli_tokens_per_second, 30_000);
}

#[test]
fn exact_usage_replaces_estimates_and_protocol_exact_outranks_renderer_exact() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();
    service.ingest(turn_started("s-usage", "t-usage", "start", "c-1", 0));
    service.ingest(output_delta("s-usage", "t-usage", "delta", "c-1", 100, 40));

    let renderer_usage = TokenUsage {
        input: 100,
        cached_input: 10,
        cache_write: 0,
        output: 30,
    };
    service.ingest(exact_usage(
        UsageSource::Renderer,
        "s-usage",
        "t-usage",
        "renderer-usage",
        "c-1",
        200,
        renderer_usage,
    ));
    assert_eq!(snapshot(&service).output, 30);

    let revision_before_precedence = snapshot(&service).revision;
    assert_eq!(
        service.ingest(exact_usage(
            UsageSource::ProtocolProxy,
            "s-usage",
            "t-usage",
            "protocol-same",
            "c-1",
            250,
            renderer_usage,
        )),
        IngestOutcome::NoChange {
            revision: revision_before_precedence,
        }
    );
    assert_eq!(
        service.ingest(exact_usage(
            UsageSource::Renderer,
            "s-usage",
            "t-usage",
            "renderer-late",
            "c-1",
            300,
            TokenUsage {
                output: 99,
                ..renderer_usage
            },
        )),
        IngestOutcome::NoChange {
            revision: revision_before_precedence,
        }
    );

    assert!(matches!(
        service.ingest(exact_usage(
            UsageSource::ProtocolProxy,
            "s-usage",
            "t-usage",
            "protocol-replacement",
            "c-1",
            350,
            TokenUsage {
                input: 120,
                cached_input: 10,
                cache_write: 0,
                output: 35,
            },
        )),
        IngestOutcome::Applied { .. }
    ));
    let replaced = snapshot(&service);
    assert_eq!(replaced.input, 120);
    assert_eq!(replaced.cached_input, 10);
    assert_eq!(replaced.output, 35);
    assert_eq!(replaced.cost_nanos, 1_605_000);
}

#[test]
fn exact_usage_establishes_only_missing_steps() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();
    service.ingest(turn_started("s-step", "t-step", "start", "c-1", 0));
    service.ingest(exact_usage(
        UsageSource::ProtocolProxy,
        "s-step",
        "t-step",
        "usage-1",
        "c-1",
        10,
        TokenUsage {
            output: 1,
            ..TokenUsage::default()
        },
    ));
    assert_eq!(snapshot(&service).steps, 1);

    service.ingest(exact_usage(
        UsageSource::ProtocolProxy,
        "s-step",
        "t-step",
        "usage-2",
        "c-2",
        20,
        TokenUsage {
            output: 2,
            ..TokenUsage::default()
        },
    ));
    assert_eq!(snapshot(&service).steps, 2);
    service.ingest(output_delta("s-step", "t-step", "delta-2", "c-2", 30, 3));
    assert_eq!(snapshot(&service).steps, 2);

    let observed = TokenCostService::in_memory();
    observed.bootstrap("page-1").unwrap();
    observed.ingest(turn_started("s-seen", "t-seen", "start", "c-1", 100));
    observed.ingest(tool_started(
        "s-seen",
        "t-seen",
        "tool-start",
        "c-1",
        110,
        "call",
    ));
    observed.ingest(tool_completed(
        "s-seen", "t-seen", "tool-end", "c-1", 120, "call",
    ));
    observed.ingest(output_delta("s-seen", "t-seen", "delta", "c-2", 130, 2));
    observed.ingest(exact_usage(
        UsageSource::Renderer,
        "s-seen",
        "t-seen",
        "usage",
        "c-2",
        140,
        TokenUsage {
            output: 2,
            ..TokenUsage::default()
        },
    ));
    assert_eq!(snapshot(&observed).steps, 2);
}

#[test]
fn completion_before_usage_and_repeated_final_usage_never_double_count() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();
    service.ingest(turn_started("s-late", "t-late", "start", "c-1", 1_000));
    service.ingest(turn_completed(
        UsageSource::Renderer,
        "s-late",
        "t-late",
        "complete",
        "c-1",
        1_100,
        None,
    ));
    assert_eq!(snapshot(&service).output, 0);

    let usage = TokenUsage {
        input: 10,
        cached_input: 2,
        cache_write: 1,
        output: 4,
    };
    assert!(matches!(
        service.ingest(exact_usage(
            UsageSource::ProtocolProxy,
            "s-late",
            "t-late",
            "late-usage",
            "c-1",
            1_200,
            usage,
        )),
        IngestOutcome::Applied { .. }
    ));
    let after_late = snapshot(&service);
    assert_eq!(after_late.input, 10);
    assert_eq!(after_late.cached_input, 2);
    assert_eq!(after_late.output, 4);

    assert_eq!(
        service.ingest(exact_usage(
            UsageSource::ProtocolProxy,
            "s-late",
            "t-late",
            "late-usage-repeat",
            "c-1",
            1_300,
            usage,
        )),
        IngestOutcome::NoChange {
            revision: after_late.revision,
        }
    );
    assert_eq!(snapshot(&service).input, 10);
    assert_eq!(snapshot(&service).output, 4);

    let completed_with_usage = TokenCostService::in_memory();
    completed_with_usage.bootstrap("page-1").unwrap();
    completed_with_usage.ingest(turn_started("s-final", "t-final", "start", "c-1", 0));
    completed_with_usage.ingest(turn_completed(
        UsageSource::Renderer,
        "s-final",
        "t-final",
        "complete",
        "c-1",
        100,
        Some(usage),
    ));
    completed_with_usage.ingest(exact_usage(
        UsageSource::ProtocolProxy,
        "s-final",
        "t-final",
        "protocol-final",
        "c-1",
        110,
        usage,
    ));
    assert_eq!(snapshot(&completed_with_usage).input, 10);
    assert_eq!(snapshot(&completed_with_usage).output, 4);
}

#[test]
fn late_turn_completed_usage_replaces_recent_without_moving_completion_time() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();
    service.ingest(turn_started(
        "s-late-completion",
        "t-late-completion",
        "start",
        "c-1",
        1_000,
    ));
    service.ingest(turn_completed(
        UsageSource::Renderer,
        "s-late-completion",
        "t-late-completion",
        "renderer-complete",
        "c-1",
        1_100,
        None,
    ));
    let completed = snapshot(&service);
    assert_eq!(completed.llm_ms, 100);
    assert_eq!(completed.input, 0);

    assert_eq!(
        service.ingest(turn_completed(
            UsageSource::ProtocolProxy,
            "s-late-completion",
            "t-late-completion",
            "protocol-complete",
            "c-1",
            9_000,
            Some(TokenUsage {
                input: 10,
                cached_input: 2,
                cache_write: 0,
                output: 4,
            }),
        )),
        IngestOutcome::Applied {
            revision: completed.revision + 1,
        }
    );
    let replaced = snapshot(&service);
    assert_eq!(replaced.llm_ms, 100);
    assert_eq!(replaced.input, 10);
    assert_eq!(replaced.cached_input, 2);
    assert_eq!(replaced.output, 4);
    assert_eq!(replaced.cost_nanos, 161_000);
}

#[test]
fn equal_protocol_turn_completion_promotes_rank_for_future_renderer_usage() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();
    let usage = TokenUsage {
        input: 10,
        cached_input: 2,
        cache_write: 0,
        output: 4,
    };
    service.ingest(turn_started(
        "s-completion-rank",
        "t-completion-rank",
        "start",
        "c-1",
        1_000,
    ));
    service.ingest(turn_completed(
        UsageSource::Renderer,
        "s-completion-rank",
        "t-completion-rank",
        "renderer-complete",
        "c-1",
        1_100,
        Some(usage),
    ));
    let renderer = snapshot(&service);

    assert_eq!(
        service.ingest(turn_completed(
            UsageSource::ProtocolProxy,
            "s-completion-rank",
            "t-completion-rank",
            "protocol-complete",
            "c-1",
            5_000,
            Some(usage),
        )),
        IngestOutcome::NoChange {
            revision: renderer.revision,
        }
    );
    assert_eq!(snapshot(&service), renderer);

    assert_eq!(
        service.ingest(exact_usage(
            UsageSource::Renderer,
            "s-completion-rank",
            "t-completion-rank",
            "renderer-late-change",
            "c-1",
            6_000,
            TokenUsage { output: 5, ..usage },
        )),
        IngestOutcome::NoChange {
            revision: renderer.revision,
        }
    );
    assert_eq!(snapshot(&service), renderer);
}

#[test]
fn failed_turn_closes_without_inventing_usage() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();
    service.ingest(turn_started("s-fail", "t-fail", "start", "c-1", 5_000));
    service.ingest(TokenCostEvent::TurnFailed {
        meta: runtime_meta(
            UsageSource::Renderer,
            "s-fail",
            "t-fail",
            "failed",
            "c-1",
            5_100,
        ),
    });

    let failed = snapshot(&service);
    assert!(!failed.running);
    assert_eq!(failed.turns, 1);
    assert_eq!(failed.steps, 1);
    assert_eq!(failed.llm_ms, 100);
    assert_eq!(failed.input, 0);
    assert_eq!(failed.cached_input, 0);
    assert_eq!(failed.output, 0);
    assert_eq!(failed.cost_nanos, 0);
}

#[test]
fn missing_turn_tool_completion_is_a_semantic_no_op() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();
    let before = snapshot(&service);

    assert_eq!(
        service.ingest(tool_completed(
            "s-missing-tool",
            "t-missing-tool",
            "tool-complete",
            "c-1",
            1_000,
            "missing-call",
        )),
        IngestOutcome::NoChange {
            revision: before.revision,
        }
    );
    let after = snapshot(&service);
    assert_eq!(after, before);
    assert!(!after.running);
    assert_eq!(after.turns, 0);
}

#[test]
fn late_turn_start_cannot_change_a_completed_turns_display_state() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();
    service.ingest(turn_started(
        "s-late-start",
        "t-late-start",
        "start",
        "c-1",
        1_000,
    ));
    service.ingest(turn_completed(
        UsageSource::Renderer,
        "s-late-start",
        "t-late-start",
        "complete",
        "c-1",
        1_100,
        None,
    ));
    let completed = snapshot(&service);
    assert_eq!(completed.model, "gpt-5.6-sol");
    assert!(!completed.fast);

    assert_eq!(
        service.ingest(TokenCostEvent::TurnStarted {
            meta: runtime_meta(
                UsageSource::Renderer,
                "s-late-start",
                "t-late-start",
                "late-start",
                "c-1",
                9_000,
            ),
            model: "late-wrong-model".to_string(),
            fast: true,
        }),
        IngestOutcome::NoChange {
            revision: completed.revision,
        }
    );
    assert_eq!(snapshot(&service), completed);
}

#[tokio::test]
async fn completed_history_and_dedupe_fingerprints_stay_hard_bounded() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();

    for index in 0..(RECENT_TURN_LIMIT + 1) {
        let turn_id = format!("turn-{index}");
        let correlation_id = format!("correlation-{index}");
        service.ingest(turn_started(
            "s-bounds",
            &turn_id,
            format!("start-{index}"),
            correlation_id.clone(),
            index as u64 * 10,
        ));
        service.ingest(turn_completed(
            UsageSource::ProtocolProxy,
            "s-bounds",
            &turn_id,
            format!("complete-{index}"),
            correlation_id,
            index as u64 * 10 + 5,
            Some(TokenUsage {
                input: 1,
                cached_input: 0,
                cache_write: 0,
                output: 1,
            }),
        ));
    }

    let bounded = diagnostics(&service).await;
    assert_eq!(bounded.recent_turns, RECENT_TURN_LIMIT as u64);
    assert!(bounded.dedupe_fingerprints <= DEDUPE_FINGERPRINT_LIMIT as u64);
    assert!(bounded.queue_depth <= EVENT_QUEUE_CAPACITY as u64);
    assert!(bounded.queue_high_water <= EVENT_QUEUE_CAPACITY as u64);
    let totals = snapshot(&service);
    assert_eq!(totals.turns, (RECENT_TURN_LIMIT + 1) as u32);
    assert_eq!(totals.input, (RECENT_TURN_LIMIT + 1) as u64);
    assert_eq!(totals.output, (RECENT_TURN_LIMIT + 1) as u64);
}

#[tokio::test]
async fn dedupe_windows_are_removed_after_sequential_sessions_complete() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();

    for index in 0..2_048_u64 {
        let session_id = format!("sequential-session-{index}");
        service.ingest(turn_started(
            &session_id,
            "turn",
            "start",
            "correlation",
            index * 10,
        ));
        service.ingest(turn_completed(
            UsageSource::ProtocolProxy,
            &session_id,
            "turn",
            "complete",
            "correlation",
            index * 10 + 5,
            Some(TokenUsage {
                input: 1,
                cached_input: 0,
                cache_write: 0,
                output: 1,
            }),
        ));
    }

    let bounded = diagnostics(&service).await;
    assert_eq!(bounded.recent_turns, RECENT_TURN_LIMIT as u64);
    assert_eq!(bounded.dedupe_fingerprints, 0);
    assert_eq!(snapshot(&service).turns, 2_048);
}

#[test]
fn late_usage_for_the_257th_evicted_turn_is_ignored() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();

    for index in 0..=RECENT_TURN_LIMIT {
        let turn_id = format!("eviction-turn-{index}");
        let correlation_id = format!("eviction-correlation-{index}");
        service.ingest(turn_started(
            "s-eviction",
            &turn_id,
            format!("start-{index}"),
            correlation_id.clone(),
            index as u64 * 10,
        ));
        service.ingest(turn_completed(
            UsageSource::ProtocolProxy,
            "s-eviction",
            &turn_id,
            format!("complete-{index}"),
            correlation_id,
            index as u64 * 10 + 5,
            Some(TokenUsage {
                input: 1,
                cached_input: 0,
                cache_write: 0,
                output: 1,
            }),
        ));
    }

    let before_late = snapshot(&service);
    assert_eq!(before_late.turns, 257);
    assert_eq!(before_late.input, 257);
    assert!(!before_late.running);
    assert_eq!(
        service.ingest(exact_usage(
            UsageSource::ProtocolProxy,
            "s-eviction",
            "eviction-turn-0",
            "late-evicted-usage",
            "eviction-correlation-0",
            50_000,
            TokenUsage {
                input: 100,
                cached_input: 0,
                cache_write: 0,
                output: 100,
            },
        )),
        IngestOutcome::NoChange {
            revision: before_late.revision,
        }
    );
    assert_eq!(snapshot(&service), before_late);

    assert_eq!(
        service.ingest(TokenCostEvent::TurnStarted {
            meta: runtime_meta(
                UsageSource::Renderer,
                "s-eviction",
                "eviction-turn-0",
                "late-evicted-start",
                "eviction-correlation-0",
                60_000,
            ),
            model: "late-wrong-model".to_string(),
            fast: true,
        }),
        IngestOutcome::NoChange {
            revision: before_late.revision,
        }
    );
    assert_eq!(snapshot(&service), before_late);
}

#[test]
fn bounded_queue_coalesces_cumulative_events_under_ten_thousand_delta_pressure() {
    let mut queue = BoundedEventQueue::new(EVENT_QUEUE_CAPACITY);
    for index in 0..10_000_u64 {
        let admission = queue.push(output_delta(
            "s-pressure",
            "t-pressure",
            format!("delta-{index}"),
            "c-1",
            index,
            index,
        ));
        assert_eq!(
            admission,
            if index == 0 {
                QueueAdmission::Enqueued
            } else {
                QueueAdmission::Coalesced
            }
        );
        assert!(queue.len() <= EVENT_QUEUE_CAPACITY);
        assert!(queue.high_water() <= EVENT_QUEUE_CAPACITY);
    }
    assert_eq!(queue.len(), 1);
    assert_eq!(queue.high_water(), 1);
    assert!(matches!(
        queue.pop_front(),
        Some(TokenCostEvent::OutputDelta {
            estimated_output_tokens: 9_999,
            ..
        })
    ));

    let mut estimated_usage = BoundedEventQueue::new(EVENT_QUEUE_CAPACITY);
    assert_eq!(
        estimated_usage.push(TokenCostEvent::Usage {
            meta: runtime_meta(
                UsageSource::Renderer,
                "s-estimate",
                "t-estimate",
                "estimate-1",
                "c-1",
                1,
            ),
            usage: TokenUsage {
                input: 10,
                cached_input: 2,
                cache_write: 1,
                output: 4,
            },
            exact: false,
        }),
        QueueAdmission::Enqueued
    );
    assert_eq!(
        estimated_usage.push(TokenCostEvent::Usage {
            meta: runtime_meta(
                UsageSource::Renderer,
                "s-estimate",
                "t-estimate",
                "estimate-2",
                "c-1",
                2,
            ),
            usage: TokenUsage {
                input: 20,
                cached_input: 4,
                cache_write: 3,
                output: 8,
            },
            exact: false,
        }),
        QueueAdmission::Coalesced
    );
    assert!(matches!(
        estimated_usage.pop_front(),
        Some(TokenCostEvent::Usage {
            usage: TokenUsage {
                input: 20,
                cached_input: 4,
                cache_write: 3,
                output: 8,
            },
            exact: false,
            ..
        })
    ));
}

#[test]
fn public_ingest_merges_inexact_usage_fields_monotonically() {
    let service = TokenCostService::in_memory();
    service.bootstrap("page-1").unwrap();
    service.ingest(turn_started(
        "s-estimate-state",
        "t-estimate-state",
        "start",
        "c-1",
        0,
    ));

    let estimate = |event_id: &str, occurred_at_ms: u64, usage: TokenUsage| TokenCostEvent::Usage {
        meta: runtime_meta(
            UsageSource::Renderer,
            "s-estimate-state",
            "t-estimate-state",
            event_id,
            "c-1",
            occurred_at_ms,
        ),
        usage,
        exact: false,
    };

    service.ingest(estimate(
        "estimate-1",
        10,
        TokenUsage {
            input: 100,
            cached_input: 50,
            cache_write: 20,
            output: 30,
        },
    ));
    let before_merge = snapshot(&service);
    assert_eq!(
        service.ingest(estimate(
            "estimate-2",
            20,
            TokenUsage {
                input: 90,
                cached_input: 60,
                cache_write: 10,
                output: 25,
            },
        )),
        IngestOutcome::Applied {
            revision: before_merge.revision + 1,
        }
    );
    let merged = snapshot(&service);
    assert_eq!(merged.input, 100);
    assert_eq!(merged.cached_input, 60);
    assert_eq!(merged.output, 30);

    assert_eq!(
        service.ingest(estimate(
            "estimate-3",
            30,
            TokenUsage {
                input: 80,
                cached_input: 55,
                cache_write: 15,
                output: 29,
            },
        )),
        IngestOutcome::NoChange {
            revision: merged.revision,
        }
    );
    assert_eq!(snapshot(&service), merged);
}

#[test]
fn bounded_queue_never_allows_ordinary_events_to_displace_critical_events() {
    let mut queue = BoundedEventQueue::new(EVENT_QUEUE_CAPACITY);
    for index in 0..EVENT_QUEUE_CAPACITY {
        assert_eq!(
            queue.push(turn_started(
                "s-critical",
                &format!("turn-{index}"),
                format!("start-{index}"),
                format!("correlation-{index}"),
                index as u64,
            )),
            QueueAdmission::Enqueued
        );
    }
    assert_eq!(queue.len(), EVENT_QUEUE_CAPACITY);
    assert_eq!(queue.high_water(), EVENT_QUEUE_CAPACITY);
    assert_eq!(
        queue.push(output_delta(
            "s-critical",
            "ordinary",
            "ordinary-delta",
            "ordinary-correlation",
            1_000,
            1,
        )),
        QueueAdmission::Rejected
    );
    assert_eq!(queue.len(), EVENT_QUEUE_CAPACITY);

    let next_critical = turn_completed(
        UsageSource::Renderer,
        "s-critical",
        "turn-0",
        "complete-0",
        "correlation-0",
        2_000,
        None,
    );
    assert_eq!(
        queue.push(next_critical.clone()),
        QueueAdmission::RequiresDrain
    );
    let oldest = queue.pop_front().unwrap();
    let mut state = RuntimeState::new();
    assert!(state.apply(oldest, &UiConfig::default()));
    assert_eq!(state.snapshot(&UiConfig::default()).turns, 1);
    assert_eq!(queue.push(next_critical), QueueAdmission::Enqueued);
    assert_eq!(queue.len(), EVENT_QUEUE_CAPACITY);
}

#[test]
fn full_ordinary_queue_requires_drain_without_removing_an_event() {
    let mut queue = BoundedEventQueue::new(EVENT_QUEUE_CAPACITY);
    for index in 0..EVENT_QUEUE_CAPACITY {
        assert_eq!(
            queue.push(output_delta(
                "s-ordinary",
                &format!("turn-{index}"),
                format!("delta-{index}"),
                format!("correlation-{index}"),
                index as u64,
                1,
            )),
            QueueAdmission::Enqueued
        );
    }

    assert_eq!(
        queue.push(output_delta(
            "s-ordinary",
            "turn-256",
            "delta-256",
            "correlation-256",
            256,
            1,
        )),
        QueueAdmission::RequiresDrain
    );
    assert_eq!(queue.len(), EVENT_QUEUE_CAPACITY);

    let mut turn_ids = Vec::new();
    while let Some(TokenCostEvent::OutputDelta { meta, .. }) = queue.pop_front() {
        turn_ids.push(meta.turn_id);
    }
    assert_eq!(turn_ids.len(), EVENT_QUEUE_CAPACITY);
    assert!(turn_ids.iter().any(|turn_id| turn_id == "turn-0"));
    assert!(!turn_ids.iter().any(|turn_id| turn_id == "turn-256"));
}

#[test]
fn critical_events_evict_only_coalescible_entries_and_exact_usage_never_coalesces() {
    let mut queue = BoundedEventQueue::new(EVENT_QUEUE_CAPACITY);
    queue.push(output_delta("s-mixed", "t-delta", "delta", "c-delta", 0, 1));
    for index in 0..(EVENT_QUEUE_CAPACITY - 1) {
        queue.push(turn_started(
            "s-mixed",
            &format!("turn-{index}"),
            format!("start-{index}"),
            format!("correlation-{index}"),
            index as u64 + 1,
        ));
    }
    assert_eq!(queue.len(), EVENT_QUEUE_CAPACITY);
    assert_eq!(
        queue.push(turn_completed(
            UsageSource::Renderer,
            "s-mixed",
            "turn-0",
            "complete",
            "correlation-0",
            10_000,
            None,
        )),
        QueueAdmission::Enqueued
    );
    let mut deltas = 0;
    while let Some(event) = queue.pop_front() {
        if matches!(event, TokenCostEvent::OutputDelta { .. }) {
            deltas += 1;
        }
    }
    assert_eq!(deltas, 0);

    let mut exact = BoundedEventQueue::new(EVENT_QUEUE_CAPACITY);
    let usage = TokenUsage {
        output: 1,
        ..TokenUsage::default()
    };
    assert_eq!(
        exact.push(exact_usage(
            UsageSource::Renderer,
            "s-exact",
            "t-exact",
            "exact-1",
            "c-1",
            1,
            usage,
        )),
        QueueAdmission::Enqueued
    );
    assert_eq!(
        exact.push(exact_usage(
            UsageSource::Renderer,
            "s-exact",
            "t-exact",
            "exact-2",
            "c-1",
            2,
            usage,
        )),
        QueueAdmission::Enqueued
    );
    assert_eq!(exact.len(), 2);
}
