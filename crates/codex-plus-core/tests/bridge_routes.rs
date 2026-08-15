use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use codex_plus_core::launcher::{
    CodexLaunch, LaunchHooks, LaunchOptions, ProcessWaitStrategy, launch_and_inject_with_hooks,
};
use codex_plus_core::models::{
    DeleteResult, DeleteStatus, ExportResult, ExportStatus, GeneratedImage, GeneratedImagesResult,
    GeneratedImagesStatus, SessionRef,
};
use codex_plus_core::routes::{
    BridgeContext, BridgeDataService, BridgeRuntimeService, BridgeSettingsService,
    CoreRuntimeService, handle_bridge_request,
};
use codex_plus_core::settings::BackendSettings;
use codex_plus_core::status::StatusStore;
use codex_plus_core::token_cost::{MAX_RENDERER_EVENT_BYTES, TokenCostService};
use codex_plus_core::user_scripts::UserScriptManager;
use serde_json::{Value, json};

#[tokio::test]
async fn bridge_routes_cover_all_current_paths() {
    let ctx = test_context();

    let cases = [
        ("/settings/get", json!({})),
        ("/settings/set", json!({"providerSyncEnabled": true})),
        ("/user-scripts/list", json!({})),
        ("/user-scripts/set-enabled", json!({"enabled": false})),
        (
            "/user-scripts/set-script-enabled",
            json!({"key": "user:a.js", "enabled": false}),
        ),
        ("/user-scripts/delete", json!({"key": "user:a.js"})),
        ("/user-scripts/reload", json!({})),
        ("/devtools/open", json!({})),
        ("/manager/open", json!({})),
        ("/manager/open-transient", json!({})),
        ("/backend/status", json!({})),
        (
            "/token-cost/bootstrap",
            json!({"instance_id": "route-page"}),
        ),
        (
            "/token-cost/event",
            json!({"instance_id": "route-page", "event": renderer_turn_started()}),
        ),
        (
            "/token-cost/action",
            json!({"action": {"type": "query_diagnostics", "instance_id": "route-page"}}),
        ),
        (
            "/token-cost/lazy-asset",
            json!({"instance_id": "route-page", "asset": "settings"}),
        ),
        ("/codex-model-catalog", json!({})),
        ("/codex-config-model", json!({})),
        (
            "/llm-proxy",
            json!({"url": "http://example.com", "method": "POST"}),
        ),
        ("/ads", json!({})),
        ("/zed-remote/status", json!({})),
        (
            "/zed-remote/resolve-host",
            json!({"hostId": "remote-ssh-codex-managed:remote"}),
        ),
        (
            "/zed-remote/fallback-request",
            json!({"hostId": "remote-ssh-codex-managed:remote"}),
        ),
        (
            "/zed-remote/open",
            json!({"ssh": {"host": "example.com"}, "path": "/home/app.py"}),
        ),
        ("/zed-remote/projects", json!({})),
        (
            "/zed-remote/remember-project",
            json!({"ssh": {"host": "example.com"}, "path": "/home/app.py"}),
        ),
        (
            "/zed-remote/forget-project",
            json!({"id": "zed-remote-project:test"}),
        ),
        ("/upstream-worktree/status", json!({})),
        ("/upstream-worktree/defaults", json!({"repoPath": "/repo"})),
        (
            "/upstream-worktree/prepare",
            json!({"repoPath": "/repo", "remote": "upstream", "baseBranch": "main"}),
        ),
        (
            "/upstream-worktree/create",
            json!({"repoPath": "/repo", "branchName": "feature/demo"}),
        ),
        ("/stepwise/settings", json!({})),
        (
            "/stepwise/generate",
            json!({"request": {"lastUserMessage": "请继续", "lastAssistantMessage": "已完成"}}),
        ),
        ("/stepwise/test", json!({})),
        ("/delete", json!({"session_id": "s1", "title": "First"})),
        ("/undo", json!({"undo_token": "undo-1"})),
        (
            "/export-markdown",
            json!({"session_id": "s1", "title": "First"}),
        ),
        (
            "/thread-generated-images",
            json!({"session_id": "s1", "title": "First"}),
        ),
        (
            "/thread-usage-history",
            json!({"session_id": "s1", "title": "First"}),
        ),
        ("/archived-thread", json!({"title": "Archived"})),
        (
            "/move-thread-workspace",
            json!({"session_id": "s1", "title": "First", "target_cwd": "/new"}),
        ),
        (
            "/thread-sort-key",
            json!({"session_id": "s1", "title": "First"}),
        ),
        (
            "/thread-sort-keys",
            json!({"sessions": [{"session_id": "s1", "title": "First"}]}),
        ),
    ];

    for (path, payload) in cases {
        let result = handle_bridge_request(ctx.clone(), path, payload).await;
        assert_ne!(
            result["message"], "Unknown bridge path",
            "{path} should be routed"
        );
    }
}

#[tokio::test]
async fn token_cost_routes_expose_bootstrap_event_action_and_lazy_asset() {
    let service = TokenCostService::in_memory();
    let _pushes = service.subscribe();
    let ctx = test_context().with_token_cost(Arc::clone(&service));
    let status_before = handle_bridge_request(ctx.clone(), "/backend/status", json!({})).await;

    let bootstrap = handle_bridge_request(
        ctx.clone(),
        "/token-cost/bootstrap",
        json!({"instance_id": "page-1"}),
    )
    .await;
    assert_eq!(bootstrap["status"], "ok");
    assert_eq!(bootstrap["instance_id"], "page-1");
    assert_eq!(bootstrap["config"]["schema_version"], 1);
    assert_eq!(bootstrap["snapshot"]["revision"], 0);
    assert!(service.capture_enabled());

    let event = handle_bridge_request(
        ctx.clone(),
        "/token-cost/event",
        json!({"instance_id": "page-1", "event": renderer_turn_started()}),
    )
    .await;
    assert_eq!(event["status"], "ok");
    assert_eq!(event["outcome"]["type"], "applied");
    assert_eq!(event["outcome"]["revision"], 1);

    let action = handle_bridge_request(
        ctx.clone(),
        "/token-cost/action",
        json!({"action": {"type": "query_diagnostics", "instance_id": "page-1"}}),
    )
    .await;
    assert_eq!(action["status"], "ok");
    assert_eq!(action["response"]["type"], "diagnostics");
    assert_eq!(action["response"]["diagnostics"]["events_ingested"], 1);

    let lazy = handle_bridge_request(
        ctx.clone(),
        "/token-cost/lazy-asset",
        json!({"instance_id": "page-1", "asset": "settings"}),
    )
    .await;
    assert_eq!(lazy, json!({"status": "ok"}));

    let status_after = handle_bridge_request(ctx, "/backend/status", json!({})).await;
    assert_eq!(status_after, status_before);
}

#[tokio::test]
async fn token_cost_routes_reject_non_strict_wrappers_without_echoing_payloads() {
    let service = TokenCostService::in_memory();
    let _pushes = service.subscribe();
    let ctx = test_context().with_token_cost(service);
    let sentinel = "secret-token-cost-payload-sentinel";

    let cases = [
        (
            "/token-cost/bootstrap",
            json!({"instance_id": "page", "unexpected": sentinel}),
        ),
        (
            "/token-cost/event",
            json!({"instance_id": "page", "event": renderer_turn_started(), "unexpected": sentinel}),
        ),
        (
            "/token-cost/action",
            json!({"action": {"type": "query_diagnostics", "instance_id": "page"}, "unexpected": sentinel}),
        ),
        (
            "/token-cost/lazy-asset",
            json!({"instance_id": "page", "asset": "settings", "unexpected": sentinel}),
        ),
        ("/token-cost/bootstrap", json!({"instance_id": 7})),
        (
            "/token-cost/event",
            json!({"instance_id": 7, "event": renderer_turn_started()}),
        ),
        (
            "/token-cost/action",
            json!({"action": {"type": "query_diagnostics", "instance_id": 7}}),
        ),
        (
            "/token-cost/lazy-asset",
            json!({"instance_id": 7, "asset": "settings"}),
        ),
        ("/token-cost/bootstrap", json!({})),
        (
            "/token-cost/event",
            json!({"event": renderer_turn_started()}),
        ),
        (
            "/token-cost/action",
            json!({"action": {"type": "query_diagnostics"}}),
        ),
        ("/token-cost/lazy-asset", json!({"asset": "settings"})),
    ];

    for (path, payload) in cases {
        let response = handle_bridge_request(ctx.clone(), path, payload).await;
        assert_eq!(response["status"], "failed", "{path}: {response}");
        assert_eq!(
            response["category"], "invalid_request",
            "{path}: {response}"
        );
        assert!(
            !response.to_string().contains(sentinel),
            "{path}: {response}"
        );
    }
}

#[tokio::test]
async fn token_cost_routes_enforce_page_instance_id_boundaries() {
    let service = TokenCostService::in_memory();
    let _pushes = service.subscribe();
    let ctx = test_context().with_token_cost(service);

    for invalid_id in [String::new(), "x".repeat(129)] {
        let cases = [
            ("/token-cost/bootstrap", json!({"instance_id": invalid_id})),
            (
                "/token-cost/event",
                json!({"instance_id": invalid_id, "event": renderer_turn_started()}),
            ),
            (
                "/token-cost/action",
                json!({"action": {"type": "query_diagnostics", "instance_id": invalid_id}}),
            ),
            (
                "/token-cost/lazy-asset",
                json!({"instance_id": invalid_id, "asset": "settings"}),
            ),
        ];
        for (path, payload) in cases {
            let response = handle_bridge_request(ctx.clone(), path, payload).await;
            assert_eq!(response["status"], "failed", "{path}: {response}");
            assert_eq!(
                response["category"], "invalid_instance",
                "{path}: {response}"
            );
        }
    }
}

#[tokio::test]
async fn token_cost_event_route_checks_raw_size_and_renderer_source_before_ingest() {
    let service = TokenCostService::in_memory();
    let ctx = test_context().with_token_cost(Arc::clone(&service));
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/token-cost/bootstrap",
            json!({"instance_id": "page-size"}),
        )
        .await["status"],
        "ok"
    );

    let exact = serialized_renderer_event_of_size(MAX_RENDERER_EVENT_BYTES, "");
    let exact_response = handle_bridge_request(
        ctx.clone(),
        "/token-cost/event",
        json!({"instance_id": "page-size", "event": exact}),
    )
    .await;
    assert_eq!(exact_response["status"], "failed");
    assert_eq!(exact_response["category"], "invalid_request");

    let sentinel = "oversized-secret-marker";
    let over = serialized_renderer_event_of_size(MAX_RENDERER_EVENT_BYTES + 1, sentinel);
    let over_response = handle_bridge_request(
        ctx.clone(),
        "/token-cost/event",
        json!({"instance_id": "page-size", "event": over}),
    )
    .await;
    assert_eq!(over_response["status"], "failed");
    assert_eq!(over_response["category"], "payload_too_large");
    assert!(!over_response.to_string().contains(sentinel));

    let mut protocol = renderer_turn_started();
    protocol["meta"]["source"] = json!("protocol_proxy");
    let protocol_response = handle_bridge_request(
        ctx,
        "/token-cost/event",
        json!({"instance_id": "page-size", "event": protocol}),
    )
    .await;
    assert_eq!(protocol_response["status"], "failed");
    assert_eq!(protocol_response["category"], "invalid_event");
}

#[tokio::test]
async fn token_cost_replacement_and_dispose_reject_every_stale_operation() {
    let service = TokenCostService::in_memory();
    let _pushes = service.subscribe();
    let ctx = test_context().with_token_cost(Arc::clone(&service));
    for instance_id in ["page-old", "page-current"] {
        assert_eq!(
            handle_bridge_request(
                ctx.clone(),
                "/token-cost/bootstrap",
                json!({"instance_id": instance_id}),
            )
            .await["status"],
            "ok"
        );
    }
    assert!(service.capture_enabled());

    let stale_cases = [
        (
            "/token-cost/event",
            json!({"instance_id": "page-old", "event": renderer_turn_started()}),
        ),
        (
            "/token-cost/action",
            json!({"action": {"type": "set_visibility", "instance_id": "page-old", "hub_visible": false, "output_rate_visible": false, "profile_visible": false}}),
        ),
        (
            "/token-cost/lazy-asset",
            json!({"instance_id": "page-old", "asset": "settings"}),
        ),
        (
            "/token-cost/action",
            json!({"action": {"type": "dispose_instance", "instance_id": "page-old"}}),
        ),
    ];
    for (path, payload) in stale_cases {
        let response = handle_bridge_request(ctx.clone(), path, payload).await;
        assert_eq!(response["status"], "failed", "{path}: {response}");
        assert_eq!(response["category"], "stale_instance", "{path}: {response}");
    }
    assert!(service.capture_enabled());

    let disposed = handle_bridge_request(
        ctx.clone(),
        "/token-cost/action",
        json!({"action": {"type": "dispose_instance", "instance_id": "page-current"}}),
    )
    .await;
    assert_eq!(disposed["status"], "ok");
    assert_eq!(disposed["response"]["type"], "disposed");
    assert!(!service.capture_enabled());

    for (path, payload) in [
        (
            "/token-cost/event",
            json!({"instance_id": "page-current", "event": renderer_turn_started()}),
        ),
        (
            "/token-cost/action",
            json!({"action": {"type": "query_diagnostics", "instance_id": "page-current"}}),
        ),
        (
            "/token-cost/lazy-asset",
            json!({"instance_id": "page-current", "asset": "settings"}),
        ),
    ] {
        let response = handle_bridge_request(ctx.clone(), path, payload).await;
        assert_eq!(response["category"], "stale_instance", "{path}: {response}");
    }
}

#[tokio::test]
async fn token_cost_mutating_actions_validate_and_only_advance_changed_config() {
    let service = TokenCostService::in_memory();
    let ctx = test_context().with_token_cost(service);
    handle_bridge_request(
        ctx.clone(),
        "/token-cost/bootstrap",
        json!({"instance_id": "page-actions"}),
    )
    .await;

    let visibility = json!({"action": {
        "type": "set_visibility",
        "instance_id": "page-actions",
        "hub_visible": false,
        "output_rate_visible": false,
        "profile_visible": false
    }});
    let first = handle_bridge_request(ctx.clone(), "/token-cost/action", visibility.clone()).await;
    assert_eq!(first["status"], "ok");
    assert_eq!(first["response"]["config"]["hub_visible"], false);
    assert_eq!(first["response"]["snapshot"]["hub_visible"], false);
    let revision = first["response"]["snapshot"]["revision"].as_u64().unwrap();
    let repeated = handle_bridge_request(ctx.clone(), "/token-cost/action", visibility).await;
    assert_eq!(repeated["response"]["snapshot"]["revision"], revision);

    let price = json!({
        "input_nanos_per_million": 10,
        "cached_input_nanos_per_million": 5,
        "cache_write_nanos_per_million": null,
        "output_nanos_per_million": 20
    });
    for action in [
        json!({"type": "save_price", "instance_id": "page-actions", "model": "gpt-test", "price": price}),
        json!({"type": "reset_price", "instance_id": "page-actions", "model": "gpt-test"}),
        json!({"type": "save_price", "instance_id": "page-actions", "model": "gpt-test", "price": price}),
        json!({"type": "delete_price", "instance_id": "page-actions", "model": "gpt-test"}),
        json!({"type": "save_profile", "instance_id": "page-actions", "profile": {
            "display_name": "Native Profile",
            "username": "native-profile",
            "email": "native@example.com",
            "plan_type": "pro_20x",
            "plan_label": "Pro 20x",
            "workspace_name": "Local",
            "avatar_data_url": null
        }}),
    ] {
        let response =
            handle_bridge_request(ctx.clone(), "/token-cost/action", json!({"action": action}))
                .await;
        assert_eq!(response["status"], "ok", "{response}");
        assert_eq!(response["response"]["type"], "updated", "{response}");
    }

    let analytics = handle_bridge_request(
        ctx,
        "/token-cost/action",
        json!({"action": {"type": "query_analytics", "instance_id": "page-actions", "range": {"type": "today"}, "model": null}}),
    )
    .await;
    assert_eq!(analytics["status"], "ok", "{analytics}");
    assert_eq!(analytics["response"]["type"], "analytics");
    assert!(analytics["response"]["analytics"]["days"].is_array());
    assert!(analytics["response"]["analytics"]["models"].is_array());
}

#[tokio::test]
async fn token_cost_analytics_queries_real_bounded_turn_rollups() {
    let service = TokenCostService::in_memory();
    let ctx = test_context().with_token_cost(service);
    handle_bridge_request(
        ctx.clone(),
        "/token-cost/bootstrap",
        json!({"instance_id": "page-analytics"}),
    )
    .await;

    ingest_analytics_turn(
        &ctx,
        "page-analytics",
        "turn-a",
        "model-a",
        1_704_067_200_000,
        100,
        300,
        (10, 2, 3, 4),
    )
    .await;
    ingest_analytics_turn(
        &ctx,
        "page-analytics",
        "turn-b",
        "model-b",
        1_704_153_600_000,
        50,
        200,
        (20, 3, 5, 8),
    )
    .await;
    let today_start = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        / 86_400_000)
        * 86_400_000;
    ingest_analytics_turn(
        &ctx,
        "page-analytics",
        "turn-today",
        "model-today",
        today_start,
        25,
        10,
        (3, 1, 1, 2),
    )
    .await;

    let custom = token_cost_analytics_action(
        &ctx,
        json!({"type": "custom", "from_day": "2024-01-01", "to_day": "2024-01-02"}),
        None,
    )
    .await;
    let custom = &custom["response"]["analytics"];
    assert_eq!(custom["totals"]["turns"], 2);
    assert_eq!(custom["totals"]["input"], 30);
    assert_eq!(custom["totals"]["cached_input"], 5);
    assert_eq!(custom["totals"]["cache_write"], 8);
    assert_eq!(custom["totals"]["output"], 12);
    assert_eq!(custom["totals"]["first_token_total_ms"], 150);
    assert_eq!(custom["totals"]["first_token_samples"], 2);
    assert_eq!(custom["totals"]["generation_ms"], 500);
    assert_eq!(custom["totals"]["generation_output_tokens"], 12);
    assert_eq!(custom["days"].as_array().unwrap().len(), 2);
    assert_eq!(custom["days"][0]["day"], "2024-01-01");
    assert_eq!(custom["days"][1]["day"], "2024-01-02");
    assert_eq!(custom["models"].as_array().unwrap().len(), 2);

    let filtered = token_cost_analytics_action(
        &ctx,
        json!({"type": "custom", "from_day": "2024-01-01", "to_day": "2024-01-02"}),
        Some("model-a"),
    )
    .await;
    let filtered = &filtered["response"]["analytics"];
    assert_eq!(filtered["totals"]["turns"], 1);
    assert_eq!(filtered["totals"]["cache_write"], 3);
    assert_eq!(filtered["totals"]["generation_ms"], 300);
    assert_eq!(filtered["days"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["models"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["models"][0]["model"], "model-a");

    let today = token_cost_analytics_action(&ctx, json!({"type": "today"}), None).await;
    let today = &today["response"]["analytics"];
    assert_eq!(today["totals"]["turns"], 1);
    assert_eq!(today["totals"]["input"], 3);
    assert_eq!(today["totals"]["cache_write"], 1);
    assert_eq!(today["totals"]["generation_ms"], 10);
}

#[tokio::test]
async fn token_cost_analytics_totals_and_days_survive_recent_turn_eviction() {
    let service = TokenCostService::in_memory();
    let ctx = test_context().with_token_cost(service);
    handle_bridge_request(
        ctx.clone(),
        "/token-cost/bootstrap",
        json!({"instance_id": "page-analytics"}),
    )
    .await;

    for index in 0..257_u64 {
        let (day_start, day_index) = if index == 0 {
            (1_704_067_200_000, 0)
        } else {
            (1_704_153_600_000, index - 1)
        };
        let turn_id = format!("evicted-turn-{index}");
        let started = handle_bridge_request(
            ctx.clone(),
            "/token-cost/event",
            json!({
                "instance_id": "page-analytics",
                "event": {
                    "type": "turn_started",
                    "meta": renderer_meta(
                        &turn_id,
                        &format!("{turn_id}-start"),
                        &format!("correlation-{turn_id}"),
                        day_start + day_index,
                    ),
                    "model": "model-eviction",
                    "fast": false
                }
            }),
        )
        .await;
        assert_eq!(started["status"], "ok", "index {index}: {started}");
        let response = handle_bridge_request(
            ctx.clone(),
            "/token-cost/event",
            json!({
                "instance_id": "page-analytics",
                "event": {
                    "type": "turn_completed",
                    "meta": renderer_meta(
                        &turn_id,
                        &format!("{turn_id}-complete"),
                        &format!("correlation-{turn_id}"),
                        day_start + day_index,
                    ),
                    "usage": {"input": 1, "cached_input": 0, "cache_write": 0, "output": 1}
                }
            }),
        )
        .await;
        assert_eq!(response["status"], "ok", "index {index}: {response}");
    }

    let analytics = token_cost_analytics_action(
        &ctx,
        json!({"type": "custom", "from_day": "2024-01-01", "to_day": "2024-01-02"}),
        None,
    )
    .await;
    let analytics = &analytics["response"]["analytics"];
    assert_eq!(analytics["totals"]["turns"], 257);
    assert_eq!(analytics["totals"]["input"], 257);
    assert_eq!(analytics["days"].as_array().unwrap().len(), 2);
    assert_eq!(analytics["days"][0]["day"], "2024-01-01");
    assert_eq!(analytics["days"][0]["totals"]["turns"], 1);
    assert_eq!(analytics["days"][1]["day"], "2024-01-02");
    assert_eq!(analytics["days"][1]["totals"]["turns"], 256);
    assert_eq!(analytics["models"].as_array().unwrap().len(), 1);
    assert_eq!(analytics["models"][0]["model"], "model-eviction");
    assert_eq!(analytics["models"][0]["totals"]["turns"], 257);

    let filtered = token_cost_analytics_action(
        &ctx,
        json!({"type": "custom", "from_day": "2024-01-01", "to_day": "2024-01-02"}),
        Some("model-eviction"),
    )
    .await;
    let filtered = &filtered["response"]["analytics"];
    assert_eq!(filtered["totals"]["turns"], 257);
    assert_eq!(filtered["totals"]["input"], 257);
    assert_eq!(filtered["days"].as_array().unwrap().len(), 2);
    assert_eq!(filtered["days"][0]["totals"]["turns"], 1);
    assert_eq!(filtered["days"][1]["totals"]["turns"], 256);
}

#[tokio::test]
async fn token_cost_analytics_model_slots_age_with_the_retained_day_horizon() {
    const DAY_MS: u64 = 86_400_000;
    const FIRST_DAY_MS: u64 = 1_704_067_200_000;

    let service = TokenCostService::in_memory();
    let ctx = test_context().with_token_cost(service);
    handle_bridge_request(
        ctx.clone(),
        "/token-cost/bootstrap",
        json!({"instance_id": "page-analytics"}),
    )
    .await;

    for model_index in 0..20 {
        ingest_analytics_turn(
            &ctx,
            "page-analytics",
            &format!("day-0-model-{model_index}"),
            &format!("model-{model_index}"),
            FIRST_DAY_MS + model_index,
            1,
            1,
            (1, 0, 0, 1),
        )
        .await;
    }
    for day in 1..=30 {
        ingest_analytics_turn(
            &ctx,
            "page-analytics",
            &format!("retained-model-day-{day}"),
            "model-0",
            FIRST_DAY_MS + day * DAY_MS,
            1,
            1,
            (1, 0, 0, 1),
        )
        .await;
    }
    ingest_analytics_turn(
        &ctx,
        "page-analytics",
        "new-model-day-31",
        "model-new",
        FIRST_DAY_MS + 31 * DAY_MS,
        1,
        1,
        (1, 0, 0, 1),
    )
    .await;

    let unfiltered = token_cost_analytics_action(
        &ctx,
        json!({"type": "custom", "from_day": "2024-02-01", "to_day": "2024-02-01"}),
        None,
    )
    .await;
    let unfiltered = &unfiltered["response"]["analytics"];
    assert_eq!(unfiltered["totals"]["turns"], 1);
    assert_eq!(unfiltered["days"][0]["totals"]["turns"], 1);
    assert_eq!(unfiltered["models"].as_array().unwrap().len(), 1);
    assert_eq!(unfiltered["models"][0]["model"], "model-new");
    assert_eq!(unfiltered["models"][0]["totals"]["turns"], 1);

    let filtered = token_cost_analytics_action(
        &ctx,
        json!({"type": "custom", "from_day": "2024-02-01", "to_day": "2024-02-01"}),
        Some("model-new"),
    )
    .await;
    let filtered = &filtered["response"]["analytics"];
    assert_eq!(filtered["totals"]["turns"], 1);
    assert_eq!(filtered["days"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["days"][0]["totals"]["turns"], 1);
    assert_eq!(filtered["models"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["models"][0]["model"], "model-new");
}

async fn ingest_analytics_turn(
    ctx: &BridgeContext,
    instance_id: &str,
    turn_id: &str,
    model: &str,
    started_at_ms: u64,
    first_token_ms: u64,
    generation_ms: u64,
    usage: (u64, u64, u64, u64),
) {
    let correlation_id = format!("correlation-{turn_id}");
    let events = [
        json!({
            "type": "turn_started",
            "meta": renderer_meta(turn_id, &format!("{turn_id}-start"), &correlation_id, started_at_ms),
            "model": model,
            "fast": false
        }),
        json!({
            "type": "output_delta",
            "meta": renderer_meta(turn_id, &format!("{turn_id}-delta-1"), &correlation_id, started_at_ms + first_token_ms),
            "estimated_output_tokens": 1
        }),
        json!({
            "type": "output_delta",
            "meta": renderer_meta(turn_id, &format!("{turn_id}-delta-2"), &correlation_id, started_at_ms + first_token_ms + generation_ms),
            "estimated_output_tokens": usage.3
        }),
        json!({
            "type": "usage",
            "meta": renderer_meta(turn_id, &format!("{turn_id}-usage"), &correlation_id, started_at_ms + first_token_ms + generation_ms + 1),
            "usage": {"input": usage.0, "cached_input": usage.1, "cache_write": usage.2, "output": usage.3},
            "exact": true
        }),
        json!({
            "type": "turn_completed",
            "meta": renderer_meta(turn_id, &format!("{turn_id}-complete"), &correlation_id, started_at_ms + first_token_ms + generation_ms + 2),
            "usage": null
        }),
    ];
    for event in events {
        let response = handle_bridge_request(
            ctx.clone(),
            "/token-cost/event",
            json!({"instance_id": instance_id, "event": event}),
        )
        .await;
        assert_eq!(response["status"], "ok", "{response}");
    }
}

fn renderer_meta(
    turn_id: &str,
    event_id: &str,
    correlation_id: &str,
    occurred_at_ms: u64,
) -> Value {
    json!({
        "source": "renderer",
        "session_id": "analytics-session",
        "turn_id": turn_id,
        "event_id": event_id,
        "correlation_id": correlation_id,
        "occurred_at_ms": occurred_at_ms
    })
}

async fn token_cost_analytics_action(
    ctx: &BridgeContext,
    range: Value,
    model: Option<&str>,
) -> Value {
    handle_bridge_request(
        ctx.clone(),
        "/token-cost/action",
        json!({"action": {
            "type": "query_analytics",
            "instance_id": "page-analytics",
            "range": range,
            "model": model
        }}),
    )
    .await
}

#[tokio::test]
async fn token_cost_cc_switch_sync_is_single_bounded_and_resets_its_guard() {
    use std::time::Duration;

    let Some(listener) = bind_cc_switch_listener().await else {
        eprintln!("skipping fixed-port CC Switch test because 127.0.0.1:17888 is occupied");
        return;
    };
    let service = TokenCostService::in_memory();
    let ctx = test_context().with_token_cost(service);
    handle_bridge_request(
        ctx.clone(),
        "/token-cost/bootstrap",
        json!({"instance_id": "page-sync"}),
    )
    .await;

    let success_body = serde_json::to_vec(&json!({
        "ok": true,
        "turns": [
            {
                "turn_id": "cc-turn-1",
                "model": "gpt-5.6-sol",
                "occurred_at_ms": 86_400_000,
                "usage": {
                    "input": 10,
                    "cached_input": 2,
                    "cache_write": 1,
                    "output": 4
                }
            },
            {
                "turn_id": "cc-turn-2",
                "model": "gpt-5.6-sol",
                "occurred_at_ms": 86_400_001,
                "usage": {
                    "input": 20,
                    "cached_input": 3,
                    "cache_write": 2,
                    "output": 6
                }
            }
        ]
    }))
    .unwrap();
    let success_server =
        serve_cc_switch_response(listener, success_body.clone(), Duration::ZERO, None);
    let synced = token_cost_sync_action(&ctx).await;
    assert_eq!(synced["status"], "ok", "{synced}");
    assert_eq!(synced["response"]["type"], "synced");
    assert_eq!(synced["response"]["imported_turns"], 2);
    assert_eq!(synced["response"]["analytics"]["totals"]["input"], 30);
    assert_eq!(success_server.await.unwrap(), 1);

    let reordered_update = serde_json::to_vec(&json!({
        "ok": true,
        "turns": [
            {
                "turn_id": "cc-turn-2",
                "model": "gpt-5.6-sol",
                "occurred_at_ms": 86_400_001,
                "usage": {
                    "input": 25,
                    "cached_input": 4,
                    "cache_write": 3,
                    "output": 7
                }
            },
            {
                "turn_id": "cc-turn-1",
                "model": "gpt-5.6-sol",
                "occurred_at_ms": 86_400_000,
                "usage": {
                    "input": 10,
                    "cached_input": 2,
                    "cache_write": 1,
                    "output": 4
                }
            }
        ]
    }))
    .unwrap();
    let listener = bind_cc_switch_listener().await.unwrap();
    let reordered_server =
        serve_cc_switch_response(listener, reordered_update, Duration::ZERO, None);
    let reordered = token_cost_sync_action(&ctx).await;
    assert_eq!(reordered["status"], "ok", "{reordered}");
    assert_eq!(reordered["response"]["imported_turns"], 0);
    assert_eq!(
        reordered["response"]["analytics"]["totals"]["input"], 35,
        "a reordered exact update must replace the old turn usage"
    );
    assert_eq!(reordered["response"]["analytics"]["totals"]["output"], 11);
    assert_eq!(reordered_server.await.unwrap(), 1);

    let listener = bind_cc_switch_listener().await.unwrap();
    let invalid_server =
        serve_cc_switch_response(listener, b"{not-json".to_vec(), Duration::ZERO, None);
    let invalid = token_cost_sync_action(&ctx).await;
    assert_eq!(invalid["category"], "cc_switch_error", "{invalid}");
    assert_eq!(invalid_server.await.unwrap(), 1);

    let listener = bind_cc_switch_listener().await.unwrap();
    let reset_server =
        serve_cc_switch_response(listener, success_body.clone(), Duration::ZERO, None);
    assert_eq!(token_cost_sync_action(&ctx).await["status"], "ok");
    assert_eq!(reset_server.await.unwrap(), 1);

    let listener = bind_cc_switch_listener().await.unwrap();
    let oversized_server =
        serve_cc_switch_response(listener, vec![b'x'; 1024 * 1024 + 1], Duration::ZERO, None);
    let oversized = token_cost_sync_action(&ctx).await;
    assert_eq!(oversized["category"], "cc_switch_error", "{oversized}");
    assert_eq!(oversized_server.await.unwrap(), 1);

    for invalid_body in [
        serde_json::to_vec(&json!({"ok": false, "turns": []})).unwrap(),
        serde_json::to_vec(&json!({
            "ok": true,
            "turns": [{
                "turn_id": "x".repeat(161),
                "model": "gpt-5.6-sol",
                "occurred_at_ms": 1,
                "usage": {"input": 1, "cached_input": 0, "cache_write": 0, "output": 1}
            }]
        }))
        .unwrap(),
        serde_json::to_vec(&json!({
            "ok": true,
            "turns": [{
                "turn_id": "invalid-usage",
                "model": "gpt-5.6-sol",
                "occurred_at_ms": 1,
                "usage": {"input": 1, "cached_input": 2, "cache_write": 0, "output": 1}
            }]
        }))
        .unwrap(),
        serde_json::to_vec(&json!({
            "ok": true,
            "turns": [{
                "turn_id": "unsupported-calendar-day",
                "model": "gpt-5.6-sol",
                "occurred_at_ms": 253_402_300_800_000_u64,
                "usage": {"input": 1, "cached_input": 0, "cache_write": 0, "output": 1}
            }]
        }))
        .unwrap(),
        serde_json::to_vec(&json!({
            "ok": true,
            "turns": [{
                "turn_id": "maximum-u64-time",
                "model": "gpt-5.6-sol",
                "occurred_at_ms": u64::MAX,
                "usage": {"input": 1, "cached_input": 0, "cache_write": 0, "output": 1}
            }]
        }))
        .unwrap(),
        serde_json::to_vec(&json!({
            "ok": true,
            "turns": (0..257).map(|index| json!({
                "turn_id": format!("turn-{index}"),
                "model": "gpt-5.6-sol",
                "occurred_at_ms": index + 1,
                "usage": {"input": 1, "cached_input": 0, "cache_write": 0, "output": 1}
            })).collect::<Vec<_>>()
        }))
        .unwrap(),
    ] {
        let listener = bind_cc_switch_listener().await.unwrap();
        let invalid_schema_server =
            serve_cc_switch_response(listener, invalid_body, Duration::ZERO, None);
        let invalid_schema = token_cost_sync_action(&ctx).await;
        assert_eq!(
            invalid_schema["category"], "cc_switch_error",
            "{invalid_schema}"
        );
        assert_eq!(invalid_schema_server.await.unwrap(), 1);
    }

    let listener = bind_cc_switch_listener().await.unwrap();
    let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
    let delayed_server = serve_cc_switch_response(
        listener,
        success_body.clone(),
        Duration::from_millis(250),
        Some(accepted_tx),
    );
    let first_ctx = ctx.clone();
    let first = tokio::spawn(async move { token_cost_sync_action(&first_ctx).await });
    accepted_rx.await.unwrap();
    let concurrent = token_cost_sync_action(&ctx).await;
    assert_eq!(concurrent["category"], "sync_in_progress", "{concurrent}");
    assert_eq!(first.await.unwrap()["status"], "ok");
    assert_eq!(delayed_server.await.unwrap(), 1);

    let listener = bind_cc_switch_listener().await.unwrap();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    let cancelled_server = serve_cc_switch_response(
        listener,
        success_body.clone(),
        Duration::from_millis(250),
        Some(cancel_tx),
    );
    let cancelled_ctx = ctx.clone();
    let cancelled = tokio::spawn(async move { token_cost_sync_action(&cancelled_ctx).await });
    cancel_rx.await.unwrap();
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    assert_eq!(cancelled_server.await.unwrap(), 1);

    let listener = bind_cc_switch_listener().await.unwrap();
    let cancel_reset_server =
        serve_cc_switch_response(listener, success_body.clone(), Duration::ZERO, None);
    assert_eq!(token_cost_sync_action(&ctx).await["status"], "ok");
    assert_eq!(cancel_reset_server.await.unwrap(), 1);

    let listener = bind_cc_switch_listener().await.unwrap();
    let timeout_server = serve_cc_switch_response(
        listener,
        success_body.clone(),
        Duration::from_millis(2_200),
        None,
    );
    let started = std::time::Instant::now();
    let timed_out = token_cost_sync_action(&ctx).await;
    assert_eq!(timed_out["category"], "cc_switch_error", "{timed_out}");
    assert!(started.elapsed() >= Duration::from_millis(1_800));
    assert!(started.elapsed() < Duration::from_millis(2_500));
    assert_eq!(timeout_server.await.unwrap(), 1);

    let listener = bind_cc_switch_listener().await.unwrap();
    let final_server = serve_cc_switch_response(listener, success_body, Duration::ZERO, None);
    assert_eq!(token_cost_sync_action(&ctx).await["status"], "ok");
    assert_eq!(final_server.await.unwrap(), 1);
}

async fn token_cost_sync_action(ctx: &BridgeContext) -> Value {
    handle_bridge_request(
        ctx.clone(),
        "/token-cost/action",
        json!({"action": {"type": "sync_cc_switch", "instance_id": "page-sync"}}),
    )
    .await
}

async fn bind_cc_switch_listener() -> Option<tokio::net::TcpListener> {
    match tokio::net::TcpListener::bind(("127.0.0.1", 17_888)).await {
        Ok(listener) => Some(listener),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => None,
        Err(error) => panic!("failed to bind CC Switch test listener: {error}"),
    }
}

fn serve_cc_switch_response(
    listener: tokio::net::TcpListener,
    body: Vec<u8>,
    delay: std::time::Duration,
    accepted: Option<tokio::sync::oneshot::Sender<()>>,
) -> tokio::task::JoinHandle<usize> {
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut buffer).await.unwrap();
            assert!(read > 0, "CC Switch request closed before headers");
            request.extend_from_slice(&buffer[..read]);
            assert!(
                request.len() <= 8 * 1024,
                "CC Switch request headers are unbounded"
            );
        }
        assert!(
            request.starts_with(b"GET /cc-switch/turns?refresh=1 HTTP/1.1\r\n"),
            "unexpected CC Switch request: {}",
            String::from_utf8_lossy(&request)
        );
        if let Some(accepted) = accepted {
            let _ = accepted.send(());
        }
        tokio::time::sleep(delay).await;
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(headers.as_bytes()).await;
        let _ = stream.write_all(&body).await;
        let _ = stream.shutdown().await;

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(120), listener.accept())
                .await
                .is_err(),
            "CC Switch sync retried the request"
        );
        1
    })
}

fn renderer_turn_started() -> Value {
    json!({
        "type": "turn_started",
        "meta": {
            "source": "renderer",
            "session_id": "session-1",
            "turn_id": "turn-1",
            "event_id": "event-1",
            "correlation_id": "correlation-1",
            "occurred_at_ms": 42
        },
        "model": "gpt-5.6-sol",
        "fast": false
    })
}

fn serialized_renderer_event_of_size(target: usize, marker: &str) -> Value {
    let mut event = renderer_turn_started();
    event["padding"] = json!(marker);
    let base = serde_json::to_vec(&event).unwrap().len();
    assert!(base <= target);
    event["padding"] = json!(format!("{marker}{}", "x".repeat(target - base)));
    assert_eq!(serde_json::to_vec(&event).unwrap().len(), target);
    event
}

#[tokio::test]
async fn llm_proxy_rejects_local_addresses() {
    let ctx = test_context();

    let result = handle_bridge_request(
        ctx,
        "/llm-proxy",
        json!({
            "url": "https://127.0.0.1/v1/chat/completions",
            "method": "POST",
            "headers": {"Authorization": "Bearer sk-test"},
            "body": "{}"
        }),
    )
    .await;

    assert_eq!(result["status"], json!("failed"));
    assert_eq!(result["message"], json!("Base URL 不得指向本机或私有网络"));
}

#[tokio::test]
async fn llm_proxy_requires_https() {
    let ctx = test_context();

    let result = handle_bridge_request(
        ctx,
        "/llm-proxy",
        json!({
            "url": "http://api.example.com/v1/chat/completions",
            "method": "POST",
            "body": "{}"
        }),
    )
    .await;

    assert_eq!(result["status"], json!("failed"));
    assert_eq!(result["message"], json!("Base URL 必须使用 HTTPS"));
}

#[tokio::test]
async fn llm_proxy_rejects_non_post_methods() {
    let ctx = test_context();

    let result = handle_bridge_request(
        ctx,
        "/llm-proxy",
        json!({
            "url": "https://api.example.com/v1/chat/completions",
            "method": "GET",
            "body": "{}"
        }),
    )
    .await;

    assert_eq!(result["status"], json!("failed"));
    assert_eq!(result["message"], json!("LLM Bridge 仅支持 POST 请求"));
}

#[tokio::test]
async fn settings_get_includes_runtime_codex_app_version() {
    let ctx = BridgeContext::new(
        Arc::new(FakeSettings::with_codex_app_version("26.601.21317")),
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
    );

    let result = handle_bridge_request(ctx, "/settings/get", json!({})).await;

    assert_eq!(result["codexAppVersion"], json!("26.601.21317"));
    assert_eq!(result["codexAppPluginMarketplaceUnlock"], json!(true));
    assert_eq!(result.get("codexAppForcePluginInstall"), None);
    assert_eq!(result["codexAppThreadIdBadge"], json!(false));
}

#[tokio::test]
async fn settings_get_does_not_expose_stepwise_api_key_to_renderer() {
    let settings = BackendSettings {
        codex_app_stepwise_api_key: "sk-secret".to_string(),
        ..BackendSettings::default()
    };
    let ctx = BridgeContext::new(
        Arc::new(FakeSettings::with_settings(settings)),
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
    );

    let result = handle_bridge_request(ctx, "/settings/get", json!({})).await;

    assert!(result.get("codexAppStepwiseApiKey").is_none());
    assert_eq!(
        result["codexAppStepwiseApiKeyEnv"],
        json!("CODEX_STEPWISE_API_KEY")
    );
}

#[tokio::test]
async fn settings_set_does_not_persist_runtime_codex_app_version() {
    let settings = Arc::new(FakeSettings::with_codex_app_version("26.601.21317"));
    let ctx = BridgeContext::new(
        settings.clone(),
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
    );

    let result = handle_bridge_request(
        ctx,
        "/settings/set",
        json!({
            "codexAppVersion": "1.2.3",
            "codexAppPluginMarketplaceUnlock": false
        }),
    )
    .await;

    assert_eq!(result["codexAppVersion"], json!("26.601.21317"));
    assert_eq!(result["codexAppPluginMarketplaceUnlock"], json!(false));

    let persisted = settings.settings.lock().unwrap().clone();
    let persisted_value = serde_json::to_value(persisted).unwrap();
    assert!(persisted_value.get("codexAppVersion").is_none());
}

#[tokio::test]
async fn bridge_context_core_with_app_dir_exposes_runtime_codex_app_version() {
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp
        .path()
        .join("OpenAI.Codex_26.601.21317.0_x64__abc")
        .join("app");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("Codex.exe"), "").unwrap();
    let ctx = BridgeContext::core_with_data_and_app_dir(
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
        app_dir,
    );

    let result = handle_bridge_request(ctx, "/settings/get", json!({})).await;

    assert_eq!(result["codexAppVersion"], json!("26.601.21317.0"));
}

#[tokio::test]
async fn upstream_worktree_routes_are_dispatched_to_runtime() {
    let ctx = test_context();

    assert_eq!(
        handle_bridge_request(ctx.clone(), "/upstream-worktree/status", json!({})).await,
        json!({"status": "ok", "feature": "upstream-worktree"})
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/upstream-worktree/defaults",
            json!({"repoPath": "/repo"}),
        )
        .await,
        json!({
            "status": "ok",
            "repoRoot": "/repo",
            "defaultRemote": "upstream",
            "defaultBaseBranch": "main",
        })
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/upstream-worktree/create",
            json!({"repoPath": "/repo", "branchName": "feature/demo"}),
        )
        .await,
        json!({
            "status": "ok",
            "repoRoot": "/repo",
            "branchName": "feature/demo",
            "worktreePath": "/repo-feature-demo",
        })
    );
    assert_eq!(
        handle_bridge_request(
            ctx,
            "/upstream-worktree/prepare",
            json!({"repoPath": "/repo", "remote": "upstream", "baseBranch": "main"}),
        )
        .await,
        json!({
            "status": "ok",
            "repoRoot": "/repo",
            "sourceRef": "upstream/main",
            "qualifiedSourceRef": "refs/remotes/upstream/main",
        })
    );
}

#[tokio::test]
async fn stepwise_routes_use_settings_service() {
    let settings = BackendSettings {
        codex_app_stepwise_enabled: false,
        codex_app_stepwise_direct_send: true,
        codex_app_stepwise_model: "settings-service-stepwise".to_string(),
        codex_app_stepwise_max_items: 3,
        ..BackendSettings::default()
    };
    let ctx = BridgeContext::new(
        Arc::new(FakeSettings::with_settings(settings)),
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
    );

    let public_settings = handle_bridge_request(ctx.clone(), "/stepwise/settings", json!({})).await;
    assert_eq!(public_settings["settings"]["enabled"], json!(false));
    assert_eq!(public_settings["settings"]["directSend"], json!(true));
    assert_eq!(
        public_settings["settings"]["model"],
        json!("settings-service-stepwise")
    );
    assert_eq!(public_settings["settings"]["maxItems"], json!(3));
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/stepwise/generate",
            json!({"request": {"lastUserMessage": "请继续", "lastAssistantMessage": "已完成"}}),
        )
        .await,
        json!({
            "status": "ok",
            "disabled": true,
            "items": []
        })
    );
    assert_eq!(
        handle_bridge_request(ctx, "/stepwise/test", json!({})).await,
        json!({
            "status": "ok",
            "disabled": true,
            "items": []
        })
    );
}

#[tokio::test]
async fn unknown_bridge_path_preserves_empty_session_id_shape() {
    let result = handle_bridge_request(
        test_context(),
        "/missing",
        json!({"session_id": "should-not-leak"}),
    )
    .await;

    assert_eq!(
        result,
        json!({
            "status": "failed",
            "session_id": "",
            "message": "Unknown bridge path"
        })
    );
}

#[tokio::test]
async fn settings_routes_use_settings_service() {
    let ctx = test_context();

    let updated = handle_bridge_request(
        ctx.clone(),
        "/settings/set",
        json!({"providerSyncEnabled": true, "codexAppSessionDelete": false, "codexAppServiceTierControls": true, "codexAppPetRealMouseLook": true}),
    )
    .await;
    let loaded = handle_bridge_request(ctx, "/settings/get", json!({})).await;

    assert_eq!(updated["providerSyncEnabled"], true);
    assert_eq!(updated["codexAppSessionDelete"], false);
    assert_eq!(updated["codexAppServiceTierControls"], true);
    assert_eq!(updated["codexAppPetRealMouseLook"], true);
    assert_eq!(loaded, updated);
}

#[tokio::test]
async fn runtime_routes_keep_user_script_inventory_shape() {
    let ctx = test_context();

    let listed = handle_bridge_request(ctx.clone(), "/user-scripts/list", json!({})).await;
    let global = handle_bridge_request(
        ctx.clone(),
        "/user-scripts/set-enabled",
        json!({"enabled": false}),
    )
    .await;
    let script = handle_bridge_request(
        ctx.clone(),
        "/user-scripts/set-script-enabled",
        json!({"key": "user:a.js", "enabled": false}),
    )
    .await;
    let reloaded = handle_bridge_request(ctx, "/user-scripts/reload", json!({})).await;

    assert_eq!(listed["enabled"], true);
    assert_eq!(listed["scripts"][0]["key"], "builtin:demo.js");
    assert_eq!(global["enabled"], false);
    assert_eq!(script["scripts"][1]["enabled"], false);
    assert_eq!(reloaded["reloaded"], true);
    assert_eq!(reloaded["scripts"][0]["key"], "builtin:demo.js");
}

#[tokio::test]
async fn runtime_status_devtools_repair_and_ads_routes_are_dispatched() {
    let ctx = test_context();

    assert_eq!(
        handle_bridge_request(ctx.clone(), "/devtools/open", json!({})).await,
        json!({"status": "ok", "opened": true})
    );
    assert_eq!(
        handle_bridge_request(ctx.clone(), "/manager/open", json!({})).await,
        json!({"status": "ok", "opened": "manager"})
    );
    assert_eq!(
        handle_bridge_request(ctx.clone(), "/manager/open-transient", json!({})).await,
        json!({"status": "ok", "opened": "manager-transient"})
    );
    assert_eq!(
        handle_bridge_request(ctx.clone(), "/backend/status", json!({})).await,
        json!({"status": "ok", "message": "后端已连接", "version": codex_plus_core::version::VERSION, "hideOfficialUsageAlert": false})
    );
    assert_eq!(
        handle_bridge_request(ctx.clone(), "/ads", json!({})).await,
        json!({"version": 1, "ads": [{"id": "runtime-ad"}]})
    );
    assert_eq!(
        handle_bridge_request(ctx.clone(), "/zed-remote/status", json!({})).await,
        json!({"status": "ok", "platformSupported": true, "zedAppFound": true, "zedCliFound": false})
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/zed-remote/resolve-host",
            json!({"hostId": "remote-ssh-codex-managed:remote"}),
        )
        .await,
        json!({"status": "ok", "ssh": {"user": "longnv", "host": "192.168.100.31", "port": null}})
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/zed-remote/fallback-request",
            json!({"hostId": "remote-ssh-codex-managed:remote"}),
        )
        .await,
        json!({
            "status": "ok",
            "request": {
                "hostId": "remote-ssh-codex-managed:remote",
                "ssh": {"user": "longnv", "host": "192.168.100.31", "port": null},
                "path": "/Users/longnv/bin/repo/sealos-skills",
            }
        })
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/zed-remote/open",
            json!({"ssh": {"host": "example.com"}, "path": "/home/app.py"}),
        )
        .await,
        json!({"status": "ok", "url": "ssh://example.com/home/app.py", "strategy": "addToFocusedWorkspace"})
    );
    assert_eq!(
        handle_bridge_request(ctx.clone(), "/zed-remote/projects", json!({})).await,
        json!({
            "status": "ok",
            "projects": [{
                "id": "zed-remote-project:test",
                "label": "sealos-skills",
                "hostId": "remote-ssh-codex-managed:remote",
                "ssh": {"user": "longnv", "host": "192.168.100.31", "port": null},
                "path": "/Users/longnv/bin/repo/sealos-skills",
                "url": "ssh://longnv@192.168.100.31/Users/longnv/bin/repo/sealos-skills",
                "source": "codexRemoteProject",
                "lastOpenedAtMs": null,
                "isCurrent": false
            }]
        })
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/zed-remote/remember-project",
            json!({"ssh": {"host": "example.com"}, "path": "/home/app.py"}),
        )
        .await,
        json!({"status": "ok", "remembered": true})
    );
    assert_eq!(
        handle_bridge_request(
            ctx,
            "/zed-remote/forget-project",
            json!({"id": "zed-remote-project:test"}),
        )
        .await,
        json!({"status": "ok", "removed": 1})
    );
}

#[tokio::test]
async fn backend_status_includes_active_official_usage_alert_setting() {
    let settings = BackendSettings {
        active_relay_id: "official".to_string(),
        relay_profiles: vec![codex_plus_core::settings::RelayProfile {
            id: "official".to_string(),
            relay_mode: codex_plus_core::settings::RelayMode::Official,
            hide_official_usage_alert: true,
            ..Default::default()
        }],
        ..Default::default()
    };
    let ctx = BridgeContext::new(
        Arc::new(FakeSettings::with_settings(settings)),
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
    );

    let result = handle_bridge_request(ctx, "/backend/status", json!({})).await;

    assert_eq!(result["hideOfficialUsageAlert"], true);
}

#[tokio::test]
async fn data_routes_forward_payloads_to_data_service() {
    let ctx = test_context();

    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/delete",
            json!({"session_id": "s1", "title": "First"}),
        )
        .await["undo_token"],
        "undo-s1"
    );
    assert_eq!(
        handle_bridge_request(ctx.clone(), "/undo", json!({"undo_token": "undo-s1"})).await,
        json!({
            "status": "undone",
            "session_id": "s1",
            "message": "undone",
            "undo_token": "undo-s1",
            "backup_path": null
        })
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/export-markdown",
            json!({"session_id": "s1", "title": "First"}),
        )
        .await["filename"],
        "First.md"
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/thread-generated-images",
            json!({"session_id": "s1", "title": "First"}),
        )
        .await,
        json!({
            "status": "found",
            "session_id": "s1",
            "message": "found 1 generated image",
            "images": [{
                "id": "ig-1",
                "assistant_message_id": "msg-final",
                "assistant_response_index": 0,
                "media_type": "image/png",
                "base64_data": "iVBORw0KGgo=",
                "revised_prompt": "A tower at sunset"
            }]
        })
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/thread-usage-history",
            json!({"session_id": "s1", "title": "First"}),
        )
        .await,
        json!({
            "status": "ok",
            "session_id": "s1",
            "history": [
                {
                    "source": "rollout-history",
                    "conversation_id": "local:s1",
                    "turn_id": "turn-1",
                    "observed_at": "2026-06-02T05:00:00Z",
                    "usage": {
                        "inputTokens": 1200,
                        "outputTokens": 120,
                        "totalTokens": 1320,
                        "cachedTokens": 900,
                        "cacheReadTokens": 0,
                        "cacheCreationTokens": 0,
                        "contextUsed": 1320,
                        "contextLimit": 258400,
                        "hasBreakdown": true
                    }
                }
            ]
        })
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/archived-thread",
            json!({"title": "Archived"})
        )
        .await,
        json!({"session_id": "archived-1", "title": "Archived"})
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/move-thread-workspace",
            json!({"session_id": "s1", "title": "First", "target_cwd": "/new"}),
        )
        .await,
        json!({"status": "moved", "session_id": "s1", "target_cwd": "/new"})
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/thread-sort-key",
            json!({"session_id": "s1", "title": "First"}),
        )
        .await,
        json!({"status": "ok", "session_id": "s1", "updated_at": 123})
    );
    assert_eq!(
        handle_bridge_request(
            ctx,
            "/thread-sort-keys",
            json!({"sessions": [{"session_id": "s1", "title": "First"}, null, {"session_id": "s2"}]}),
        )
        .await,
        json!({"status": "ok", "sort_keys": [{"session_id": "s1"}, {"session_id": "s2"}]})
    );
}

#[tokio::test]
async fn bridge_context_core_with_data_uses_injected_data_service() {
    let ctx = BridgeContext::core_with_data(
        Arc::new(CoreRuntimeService::new(9229, StatusStore::default())),
        Arc::new(FakeData::default()),
    );

    let result = handle_bridge_request(
        ctx,
        "/delete",
        json!({"session_id": "s1", "title": "First"}),
    )
    .await;

    assert_eq!(result["status"], "local_deleted");
    assert_eq!(result["undo_token"], "undo-s1");
    assert_ne!(
        result["message"],
        "Delete service is not wired in core launcher hooks"
    );
}

#[tokio::test]
async fn user_script_manager_scans_and_persists_inventory_shape() {
    let temp = tempfile::tempdir().unwrap();
    let builtin_dir = temp.path().join("builtin");
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&builtin_dir).unwrap();
    std::fs::write(builtin_dir.join("demo.js"), "window.demo = true;").unwrap();
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(user_dir.join("a.js"), "window.a = true;").unwrap();
    std::fs::write(user_dir.join("ignore.txt"), "not js").unwrap();
    let manager = UserScriptManager::new(
        builtin_dir.clone(),
        user_dir.clone(),
        temp.path().join("user_scripts.json"),
    );

    let listed = manager.inventory().unwrap();
    manager.set_global_enabled(false).unwrap();
    let disabled = manager.inventory().unwrap();
    manager.set_script_enabled("user:a.js", false).unwrap();
    let script_disabled = manager.inventory().unwrap();
    manager.delete_user_script("user:a.js").unwrap();
    let deleted = manager.inventory().unwrap();

    assert_eq!(listed["enabled"], true);
    assert_eq!(
        listed["builtin_dir"].as_str().unwrap(),
        builtin_dir.to_string_lossy()
    );
    assert_eq!(
        listed["user_dir"].as_str().unwrap(),
        user_dir.to_string_lossy()
    );
    assert_eq!(listed["scripts"][0]["key"], "builtin:demo.js");
    assert_eq!(listed["scripts"][0]["source"], "builtin");
    assert_eq!(listed["scripts"][0]["enabled"], true);
    assert_eq!(listed["scripts"][0]["status"], "not_loaded");
    assert_eq!(listed["scripts"][0]["error"], "");
    assert_eq!(listed["scripts"][1]["key"], "user:a.js");
    assert_eq!(disabled["enabled"], false);
    assert_eq!(disabled["scripts"][0]["status"], "disabled");
    assert_eq!(script_disabled["scripts"][1]["enabled"], false);
    assert_eq!(deleted["scripts"].as_array().unwrap().len(), 1);
    assert!(!user_dir.join("a.js").exists());
    assert_eq!(
        serde_json::from_str::<Value>(
            &std::fs::read_to_string(temp.path().join("user_scripts.json")).unwrap()
        )
        .unwrap(),
        json!({"enabled": false, "scripts": {}})
    );
}

#[test]
fn user_script_manager_installs_ds_style_cost_script_name() {
    let temp = tempfile::tempdir().unwrap();
    let user_dir = temp.path().join("user");
    let manager = UserScriptManager::new(
        temp.path().join("builtin"),
        user_dir.clone(),
        temp.path().join("user_scripts.json"),
    );

    let installed = manager.install_missing_bundled_market_scripts().unwrap();

    assert_eq!(
        installed.scripts.get("user:market-codex-ds-style-cost.js"),
        Some(&true)
    );
    assert!(
        !installed
            .scripts
            .contains_key("user:market-codex-live-token-cost.js")
    );
    assert!(user_dir.join("market-codex-ds-style-cost.js").is_file());
    assert!(!user_dir.join("market-codex-live-token-cost.js").exists());
}

#[test]
fn user_script_manager_migrates_legacy_cost_script_name() {
    let temp = tempfile::tempdir().unwrap();
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(
        user_dir.join("market-codex-live-token-cost.js"),
        "window.localOverride = true;",
    )
    .unwrap();
    let manager = UserScriptManager::new(
        temp.path().join("builtin"),
        user_dir.clone(),
        temp.path().join("user_scripts.json"),
    );
    manager
        .set_script_enabled("user:market-codex-live-token-cost.js", false)
        .unwrap();

    let migrated = manager.install_missing_bundled_market_scripts().unwrap();

    assert!(!user_dir.join("market-codex-live-token-cost.js").exists());
    assert_eq!(
        std::fs::read_to_string(user_dir.join("market-codex-ds-style-cost.js")).unwrap(),
        "window.localOverride = true;"
    );
    assert!(
        !migrated
            .scripts
            .contains_key("user:market-codex-live-token-cost.js")
    );
    assert_eq!(
        migrated.scripts.get("user:market-codex-ds-style-cost.js"),
        Some(&false)
    );
}

#[test]
fn user_script_manager_installs_missing_bundled_market_scripts_and_reinstalls_on_request() {
    let temp = tempfile::tempdir().unwrap();
    let user_dir = temp.path().join("user");
    let bundled_source = include_str!("../../../assets/user_scripts/market-codex-ds-style-cost.js");
    let ds_style_cost_path = user_dir.join("market-codex-ds-style-cost.js");
    let manager = UserScriptManager::new(
        temp.path().join("builtin"),
        user_dir.clone(),
        temp.path().join("user_scripts.json"),
    );

    let installed = manager.install_missing_bundled_market_scripts().unwrap();
    assert_eq!(
        installed.scripts.get("user:market-codex-ds-style-cost.js"),
        Some(&true)
    );
    assert_eq!(
        installed.scripts.get("user:market-codex-zhcn-translate.js"),
        Some(&true)
    );
    assert!(
        std::fs::read_to_string(&ds_style_cost_path)
            .unwrap()
            .contains("Codex Live Token Cost")
    );
    assert!(
        std::fs::read_to_string(user_dir.join("market-codex-zhcn-translate.js"))
            .unwrap()
            .contains("Codex简体中文汉化")
    );

    manager
        .set_script_enabled("user:market-codex-ds-style-cost.js", false)
        .unwrap();
    std::fs::write(
        &ds_style_cost_path,
        "// ==UserScript==\n// @version      0.8.3\n// ==/UserScript==\nwindow.oldBundle = true;",
    )
    .unwrap();
    let upgraded = manager.install_missing_bundled_market_scripts().unwrap();
    assert_eq!(
        upgraded.scripts.get("user:market-codex-ds-style-cost.js"),
        Some(&false)
    );
    let upgraded_source = std::fs::read_to_string(&ds_style_cost_path).unwrap();
    assert_eq!(upgraded_source, bundled_source);
    assert!(upgraded_source.contains("@version      1.0.0"));
    assert!(upgraded_source.len() <= 61_440);
    for legacy_identifier in [
        "localStorage",
        "indexedDB",
        "__codexLiveTokenCostPriceOverridesV1",
        "__codexLiveTokenCostDailyUsageV1",
        "__codexLiveTokenCostAnalyticsRollupV1",
        "__codexLiveTokenCostProfilePrefsV1",
        "codex-live-token-cost-profile",
    ] {
        assert!(
            !upgraded_source.contains(legacy_identifier),
            "bundled ds style cost script still contains {legacy_identifier}"
        );
    }

    std::fs::write(&ds_style_cost_path, "window.localOverride = true;").unwrap();
    let existing = manager.install_missing_bundled_market_scripts().unwrap();
    assert_eq!(
        existing.scripts.get("user:market-codex-ds-style-cost.js"),
        Some(&false)
    );
    assert_eq!(
        std::fs::read_to_string(&ds_style_cost_path).unwrap(),
        "window.localOverride = true;"
    );

    let reinstalled = manager.reinstall_bundled_market_scripts().unwrap();
    assert_eq!(
        reinstalled
            .scripts
            .get("user:market-codex-ds-style-cost.js"),
        Some(&true)
    );
    assert_eq!(
        std::fs::read_to_string(&ds_style_cost_path).unwrap(),
        bundled_source
    );
}

#[test]
fn user_script_manager_preserves_newer_ds_style_cost_override() {
    let temp = tempfile::tempdir().unwrap();
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&user_dir).unwrap();
    let ds_style_cost_path = user_dir.join("market-codex-ds-style-cost.js");
    let newer_source = "// ==UserScript==\n// @version      1.0.1\n// ==/UserScript==\nwindow.newerOverride = true;";
    std::fs::write(&ds_style_cost_path, newer_source).unwrap();
    let manager = UserScriptManager::new(
        temp.path().join("builtin"),
        user_dir,
        temp.path().join("user_scripts.json"),
    );
    manager
        .set_script_enabled("user:market-codex-ds-style-cost.js", false)
        .unwrap();

    let config = manager.install_missing_bundled_market_scripts().unwrap();

    assert_eq!(
        config.scripts.get("user:market-codex-ds-style-cost.js"),
        Some(&false)
    );
    assert_eq!(
        std::fs::read_to_string(ds_style_cost_path).unwrap(),
        newer_source
    );
}

#[test]
fn user_script_manager_upgrades_older_bundled_translation_script() {
    let temp = tempfile::tempdir().unwrap();
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(
        user_dir.join("market-codex-zhcn-translate.js"),
        "// ==UserScript==\n// @version      1.1\n// ==/UserScript==\nwindow.oldTranslation = true;",
    )
    .unwrap();
    let manager = UserScriptManager::new(
        temp.path().join("builtin"),
        user_dir.clone(),
        temp.path().join("user_scripts.json"),
    );
    manager
        .set_script_enabled("user:market-codex-zhcn-translate.js", false)
        .unwrap();

    let upgraded = manager.install_missing_bundled_market_scripts().unwrap();

    assert_eq!(
        upgraded.scripts.get("user:market-codex-zhcn-translate.js"),
        Some(&false)
    );
    let upgraded_source =
        std::fs::read_to_string(user_dir.join("market-codex-zhcn-translate.js")).unwrap();
    assert_eq!(
        upgraded_source,
        include_str!("../../../assets/user_scripts/market-codex-zhcn-translate.js")
    );
    assert!(upgraded_source.contains("@version      1.2"));
    assert!(upgraded_source.contains("轻度(low)"));
    assert!(upgraded_source.contains("极高(ultra)"));
}

#[tokio::test]
async fn user_script_inventory_merges_renderer_runtime_status() {
    let temp = tempfile::tempdir().unwrap();
    let builtin_dir = temp.path().join("builtin");
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&builtin_dir).unwrap();
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(user_dir.join("loaded.js"), "window.loaded = true;").unwrap();
    std::fs::write(user_dir.join("failed.js"), "throw new Error('boom');").unwrap();
    let manager =
        UserScriptManager::new(builtin_dir, user_dir, temp.path().join("user_scripts.json"));
    let runtime_status = json!({
        "user:loaded.js": {"status": "loaded", "error": ""},
        "user:failed.js": {"status": "failed", "error": "boom"}
    });

    let inventory = manager
        .inventory_with_runtime_status(Some(&runtime_status))
        .unwrap();
    let scripts = inventory["scripts"].as_array().unwrap();
    let loaded = scripts
        .iter()
        .find(|script| script["key"] == "user:loaded.js")
        .unwrap();
    let failed = scripts
        .iter()
        .find(|script| script["key"] == "user:failed.js")
        .unwrap();

    assert_eq!(loaded["status"], "loaded");
    assert_eq!(loaded["error"], "");
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["error"], "boom");
}

#[tokio::test]
async fn user_script_manager_deletes_market_script_metadata_and_rejects_builtin_delete() {
    let temp = tempfile::tempdir().unwrap();
    let builtin_dir = temp.path().join("builtin");
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&builtin_dir).unwrap();
    std::fs::write(builtin_dir.join("demo.js"), "window.demo = true;").unwrap();
    std::fs::create_dir_all(&user_dir).unwrap();
    let manager = UserScriptManager::new(
        builtin_dir,
        user_dir.clone(),
        temp.path().join("user_scripts.json"),
    );
    let script = codex_plus_core::script_market::MarketScript {
        id: "demo".to_string(),
        name: "Demo".to_string(),
        description: String::new(),
        version: "1.0.0".to_string(),
        author: String::new(),
        tags: Vec::new(),
        homepage: "https://example.com/demo".to_string(),
        script_url: "https://example.com/demo.js".to_string(),
        sha256: String::new(),
    };

    codex_plus_core::script_market::install_market_script_content(
        &manager,
        &script,
        b"window.demo = true;",
    )
    .unwrap();
    manager
        .set_script_enabled("user:market-demo.js", false)
        .unwrap();

    let error = manager.delete_user_script("builtin:demo.js").unwrap_err();
    assert!(error.to_string().contains("only user scripts"));
    manager.delete_user_script("user:market-demo.js").unwrap();

    assert!(!user_dir.join("market-demo.js").exists());
    assert!(
        manager.inventory().unwrap()["scripts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|script| script["market_id"] != "demo")
    );
    let saved = serde_json::from_str::<Value>(
        &std::fs::read_to_string(temp.path().join("user_scripts.json")).unwrap(),
    )
    .unwrap();
    assert!(saved.get("market").is_none());
    assert_eq!(saved["scripts"], json!({}));
}

#[tokio::test]
async fn core_runtime_reload_evaluates_enabled_user_bundle_and_status_is_ok() {
    let temp = tempfile::tempdir().unwrap();
    let builtin_dir = temp.path().join("builtin");
    std::fs::create_dir_all(&builtin_dir).unwrap();
    std::fs::write(builtin_dir.join("demo.js"), "window.demo = true;").unwrap();
    let manager = UserScriptManager::new(
        builtin_dir,
        temp.path().join("user"),
        temp.path().join("user_scripts.json"),
    );
    let evaluated = Arc::new(Mutex::new(Vec::<String>::new()));
    let runtime = CoreRuntimeService::new(9229, StatusStore::default())
        .with_user_scripts(manager)
        .with_user_script_evaluator({
            let evaluated = evaluated.clone();
            Arc::new(move |websocket_url, script| {
                evaluated
                    .lock()
                    .unwrap()
                    .push(format!("{websocket_url}:{script}"));
                Ok(json!({"status": "ok"}))
            })
        })
        .with_websocket_url("ws://page");
    let ctx = BridgeContext::core_with_data(Arc::new(runtime), Arc::new(FakeData::default()));

    let status = handle_bridge_request(ctx.clone(), "/backend/status", json!({})).await;
    let reloaded = handle_bridge_request(ctx, "/user-scripts/reload", json!({})).await;

    assert_eq!(
        status,
        json!({"status": "ok", "message": "后端已连接", "version": codex_plus_core::version::VERSION, "hideOfficialUsageAlert": false})
    );
    assert_eq!(reloaded["scripts"][0]["key"], "builtin:demo.js");
    let evaluated = evaluated.lock().unwrap();
    assert_eq!(evaluated.len(), 1);
    assert!(evaluated[0].starts_with("ws://page:"));
    assert!(evaluated[0].contains("window.demo = true;"));
}

#[tokio::test]
async fn core_runtime_open_devtools_uses_inspector_url_opener() {
    let opened = Arc::new(Mutex::new(Vec::<String>::new()));
    let runtime = CoreRuntimeService::new(9229, StatusStore::default())
        .with_devtools_opener({
            let opened = opened.clone();
            Arc::new(move |url| {
                opened.lock().unwrap().push(url.to_string());
                Ok(())
            })
        })
        .with_devtools_target_id("page-1");
    let ctx = BridgeContext::core_with_data(Arc::new(runtime), Arc::new(FakeData::default()));

    let result = handle_bridge_request(ctx, "/devtools/open", json!({})).await;

    assert_eq!(result["status"], "ok");
    assert_eq!(result["target_id"], "page-1");
    assert_eq!(
        opened.lock().unwrap().as_slice(),
        ["http://127.0.0.1:9229/devtools/inspector.html?ws=127.0.0.1:9229/devtools/page/page-1"]
    );
}

#[tokio::test]
async fn core_runtime_manager_route_attempts_to_open_manager_binary() {
    let ctx = BridgeContext::core(Arc::new(CoreRuntimeService::new(
        9229,
        StatusStore::default(),
    )));

    let result = handle_bridge_request(ctx, "/manager/open", json!({})).await;

    assert_ne!(result["message"], "管理工具启动未接入当前运行时");
}

#[tokio::test]
async fn bridge_backend_status_writes_diagnostic_log() {
    let temp = tempfile::tempdir().unwrap();
    let log_path = temp.path().join("codex-plus.log");
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(Some(log_path.clone()));
    let ctx = BridgeContext::core(Arc::new(CoreRuntimeService::new(
        9229,
        StatusStore::default(),
    )));

    let result = handle_bridge_request(ctx, "/backend/status", json!({})).await;

    assert_eq!(result["status"], "ok");
    let contents = std::fs::read_to_string(&log_path).unwrap();
    assert!(contents.contains("bridge.request"));
    assert!(contents.contains("bridge.backend_status_ok"));
    assert!(contents.contains("/backend/status"));
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(None);
}

#[test]
fn user_script_manager_tolerates_bad_config_fields_and_updates_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("user_scripts.json");
    std::fs::write(
        &config_path,
        r#"{"enabled":"not bool","scripts":{"user:a.js":false,"user:b.js":"bad"},"custom":true}"#,
    )
    .unwrap();
    let manager = UserScriptManager::new(
        temp.path().join("builtin"),
        temp.path().join("user"),
        config_path.clone(),
    );

    assert_eq!(manager.load_config().enabled, true);
    assert_eq!(manager.load_config().scripts.get("user:a.js"), Some(&false));
    assert!(!manager.load_config().scripts.contains_key("user:b.js"));

    manager.set_script_enabled("user:c.js", false).unwrap();
    let saved = serde_json::from_str::<Value>(&std::fs::read_to_string(config_path).unwrap())
        .expect("config should remain valid JSON");

    assert_eq!(saved["enabled"], true);
    assert_eq!(saved["scripts"]["user:a.js"], false);
    assert_eq!(saved["scripts"]["user:c.js"], false);
}

#[test]
fn script_market_manifest_filters_invalid_entries() {
    let raw = serde_json::json!({
        "version": 1,
        "updated_at": "2026-05-21T00:00:00Z",
        "scripts": [
            {
                "id": "demo",
                "name": "Demo",
                "description": "Useful demo",
                "version": "1.0.0",
                "author": "BigPizzaV3",
                "tags": ["ui", 42],
                "homepage": "https://example.com/demo",
                "script_url": "https://example.com/demo.js",
                "sha256": ""
            },
            { "id": "", "name": "Bad", "version": "1", "script_url": "https://example.com/bad.js" },
            { "id": "missing-url", "name": "Bad", "version": "1" }
        ]
    });

    let manifest = codex_plus_core::script_market::parse_market_manifest(raw).unwrap();

    assert_eq!(manifest.version, 1);
    assert_eq!(manifest.updated_at.as_deref(), Some("2026-05-21T00:00:00Z"));
    assert_eq!(manifest.scripts.len(), 1);
    assert_eq!(manifest.scripts[0].id, "demo");
    assert_eq!(manifest.scripts[0].tags, vec!["ui"]);
}

#[test]
fn user_script_inventory_includes_market_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(user_dir.join("market-demo.js"), "window.demo = true;").unwrap();
    let manager = UserScriptManager::new(
        temp.path().join("builtin"),
        user_dir,
        temp.path().join("user_scripts.json"),
    );

    manager
        .record_market_install(&codex_plus_core::script_market::MarketScript {
            id: "demo".to_string(),
            name: "Demo".to_string(),
            description: "Useful demo".to_string(),
            version: "1.0.0".to_string(),
            author: "BigPizzaV3".to_string(),
            tags: vec!["ui".to_string()],
            homepage: "https://example.com/demo".to_string(),
            script_url: "https://example.com/demo.js".to_string(),
            sha256: String::new(),
        })
        .unwrap();

    let inventory = manager.inventory().unwrap();

    assert_eq!(inventory["scripts"][0]["key"], "user:market-demo.js");
    assert_eq!(inventory["scripts"][0]["market_id"], "demo");
    assert_eq!(inventory["scripts"][0]["version"], "1.0.0");
    assert_eq!(inventory["scripts"][0]["installed"], true);
    assert_eq!(
        inventory["scripts"][0]["source_url"],
        "https://example.com/demo.js"
    );
    assert_eq!(
        inventory["scripts"][0]["homepage"],
        "https://example.com/demo"
    );
}

#[test]
fn install_market_script_writes_file_and_records_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let manager = UserScriptManager::new(
        temp.path().join("builtin"),
        temp.path().join("user"),
        temp.path().join("user_scripts.json"),
    );
    let script = codex_plus_core::script_market::MarketScript {
        id: "demo".to_string(),
        name: "Demo".to_string(),
        description: String::new(),
        version: "1.0.0".to_string(),
        author: String::new(),
        tags: Vec::new(),
        homepage: "https://example.com/demo".to_string(),
        script_url: "https://example.com/demo.js".to_string(),
        sha256: String::new(),
    };

    codex_plus_core::script_market::install_market_script_content(
        &manager,
        &script,
        b"window.demo = true;",
    )
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(temp.path().join("user").join("market-demo.js")).unwrap(),
        "window.demo = true;"
    );
    let inventory = manager.inventory().unwrap();
    assert_eq!(inventory["scripts"][0]["market_id"], "demo");
}

#[test]
fn install_market_script_ignores_checksum_mismatch_and_replaces_existing_file() {
    let temp = tempfile::tempdir().unwrap();
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(user_dir.join("market-demo.js"), "old").unwrap();
    let manager = UserScriptManager::new(
        temp.path().join("builtin"),
        user_dir.clone(),
        temp.path().join("user_scripts.json"),
    );
    let script = codex_plus_core::script_market::MarketScript {
        id: "demo".to_string(),
        name: "Demo".to_string(),
        description: String::new(),
        version: "1.0.0".to_string(),
        author: String::new(),
        tags: Vec::new(),
        homepage: String::new(),
        script_url: "https://example.com/demo.js".to_string(),
        sha256: "0000".to_string(),
    };

    codex_plus_core::script_market::install_market_script_content(&manager, &script, b"new")
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(user_dir.join("market-demo.js")).unwrap(),
        "new"
    );
}

#[tokio::test]
async fn launch_lifecycle_uses_hook_supplied_bridge_context_for_injection() {
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let hooks = ContextHooks {
        events: events.clone(),
    };

    launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: 9229,
            helper_port: 57321,
            status_store: StatusStore::new(temp.path().join("latest-status.json")),
        },
        &hooks,
    )
    .await
    .unwrap();

    assert_eq!(
        *events.lock().unwrap(),
        vec![
            "bridge-context:9229",
            "inject-bridge:9229:57321",
            "watchdog:9229:57321",
            "status:running",
        ]
    );
}

fn test_context() -> BridgeContext {
    BridgeContext::new(
        Arc::new(FakeSettings::default()),
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
    )
}

#[derive(Default)]
struct FakeSettings {
    settings: Mutex<BackendSettings>,
    codex_app_version: Mutex<String>,
}

impl FakeSettings {
    fn with_settings(settings: BackendSettings) -> Self {
        Self {
            settings: Mutex::new(settings),
            codex_app_version: Mutex::new(String::new()),
        }
    }

    fn with_codex_app_version(version: &str) -> Self {
        Self {
            settings: Mutex::new(BackendSettings::default()),
            codex_app_version: Mutex::new(version.to_string()),
        }
    }
}

#[async_trait]
impl BridgeSettingsService for FakeSettings {
    async fn get_settings(&self) -> anyhow::Result<BackendSettings> {
        Ok(self.settings.lock().unwrap().clone())
    }

    async fn set_settings(&self, payload: Value) -> anyhow::Result<BackendSettings> {
        let current = self.settings.lock().unwrap().clone();
        let mut raw = serde_json::to_value(current).unwrap();
        let raw = raw.as_object_mut().unwrap();
        if let Some(value) = payload.get("providerSyncEnabled").and_then(Value::as_bool) {
            raw.insert("providerSyncEnabled".to_string(), json!(value));
        }
        if let Some(value) = payload.get("enhancementsEnabled").and_then(Value::as_bool) {
            raw.insert("enhancementsEnabled".to_string(), json!(value));
        }
        for key in [
            "codexAppPluginMarketplaceUnlock",
            "codexAppModelWhitelistUnlock",
            "codexAppSessionDelete",
            "codexAppMarkdownExport",
            "codexAppForceChineseLocale",
            "codexAppProjectMove",
            "codexAppThreadIdBadge",
            "codexAppConversationView",
            "codexAppThreadScrollRestore",
            "codexAppZedRemoteOpen",
            "codexAppUpstreamWorktreeCreate",
            "codexAppNativeMenuPlacement",
            "codexAppServiceTierControls",
            "codexAppPetRealMouseLook",
        ] {
            if let Some(value) = payload.get(key).and_then(Value::as_bool) {
                raw.insert(key.to_string(), json!(value));
            }
        }
        if let Some(value) = payload.get("launchMode").and_then(Value::as_str) {
            raw.insert("launchMode".to_string(), json!(value));
        }
        if let Some(value) = payload.get("relayBaseUrl").and_then(Value::as_str) {
            raw.insert("relayBaseUrl".to_string(), json!(value));
        }
        if let Some(value) = payload.get("relayApiKey").and_then(Value::as_str) {
            raw.insert("relayApiKey".to_string(), json!(value));
        }
        let updated: BackendSettings = serde_json::from_value(Value::Object(raw.clone())).unwrap();
        *self.settings.lock().unwrap() = updated.clone();
        Ok(updated)
    }

    async fn codex_app_version(&self) -> anyhow::Result<String> {
        Ok(self.codex_app_version.lock().unwrap().clone())
    }
}

struct FakeRuntime {
    enabled: Mutex<bool>,
    script_enabled: Mutex<bool>,
}

impl Default for FakeRuntime {
    fn default() -> Self {
        Self {
            enabled: Mutex::new(true),
            script_enabled: Mutex::new(true),
        }
    }
}

#[async_trait]
impl BridgeRuntimeService for FakeRuntime {
    async fn user_script_inventory(&self) -> anyhow::Result<Value> {
        Ok(self.inventory(false))
    }

    async fn set_user_scripts_enabled(&self, enabled: bool) -> anyhow::Result<Value> {
        *self.enabled.lock().unwrap() = enabled;
        Ok(self.inventory(false))
    }

    async fn set_user_script_enabled(&self, key: String, enabled: bool) -> anyhow::Result<Value> {
        assert_eq!(key, "user:a.js");
        *self.script_enabled.lock().unwrap() = enabled;
        Ok(self.inventory(false))
    }

    async fn delete_user_script(&self, key: String) -> anyhow::Result<Value> {
        assert_eq!(key, "user:a.js");
        *self.script_enabled.lock().unwrap() = false;
        Ok(self.inventory(false))
    }

    async fn reload_user_scripts(&self) -> anyhow::Result<Value> {
        Ok(self.inventory(true))
    }

    async fn open_devtools(&self) -> anyhow::Result<Value> {
        Ok(json!({"status": "ok", "opened": true}))
    }

    async fn open_manager(&self) -> anyhow::Result<Value> {
        Ok(json!({"status": "ok", "opened": "manager"}))
    }

    async fn open_transient_manager(&self) -> anyhow::Result<Value> {
        Ok(json!({"status": "ok", "opened": "manager-transient"}))
    }

    async fn backend_status(&self) -> anyhow::Result<Value> {
        Ok(
            json!({"status": "ok", "message": "后端已连接", "version": codex_plus_core::version::VERSION}),
        )
    }

    async fn codex_model_catalog(&self) -> anyhow::Result<Value> {
        Ok(json!({
            "status": "ok",
            "model": "qwen3-coder",
            "default_model": "qwen3-coder",
            "model_provider": "relay",
            "provider_name": "Relay",
            "models": ["qwen3-coder"],
            "sources": []
        }))
    }

    async fn ads(&self) -> anyhow::Result<Value> {
        Ok(json!({"version": 1, "ads": [{"id": "runtime-ad"}]}))
    }

    async fn zed_remote_status(&self) -> anyhow::Result<Value> {
        Ok(json!({
            "status": "ok",
            "platformSupported": true,
            "zedAppFound": true,
            "zedCliFound": false
        }))
    }

    async fn resolve_zed_remote_host(&self, payload: Value) -> anyhow::Result<Value> {
        assert_eq!(payload["hostId"], json!("remote-ssh-codex-managed:remote"));
        Ok(json!({
            "status": "ok",
            "ssh": {"user": "longnv", "host": "192.168.100.31", "port": null}
        }))
    }

    async fn fallback_zed_remote_request(&self, payload: Value) -> anyhow::Result<Value> {
        assert_eq!(payload["hostId"], json!("remote-ssh-codex-managed:remote"));
        Ok(json!({
            "status": "ok",
            "request": {
                "hostId": "remote-ssh-codex-managed:remote",
                "ssh": {"user": "longnv", "host": "192.168.100.31", "port": null},
                "path": "/Users/longnv/bin/repo/sealos-skills",
            }
        }))
    }

    async fn open_zed_remote(&self, payload: Value) -> anyhow::Result<Value> {
        assert_eq!(payload["path"], json!("/home/app.py"));
        Ok(
            json!({"status": "ok", "url": "ssh://example.com/home/app.py", "strategy": "addToFocusedWorkspace"}),
        )
    }

    async fn list_zed_remote_projects(&self, _payload: Value) -> anyhow::Result<Value> {
        Ok(json!({
            "status": "ok",
            "projects": [{
                "id": "zed-remote-project:test",
                "label": "sealos-skills",
                "hostId": "remote-ssh-codex-managed:remote",
                "ssh": {"user": "longnv", "host": "192.168.100.31", "port": null},
                "path": "/Users/longnv/bin/repo/sealos-skills",
                "url": "ssh://longnv@192.168.100.31/Users/longnv/bin/repo/sealos-skills",
                "source": "codexRemoteProject",
                "lastOpenedAtMs": null,
                "isCurrent": false
            }]
        }))
    }

    async fn remember_zed_remote_project(&self, payload: Value) -> anyhow::Result<Value> {
        assert_eq!(payload["path"], json!("/home/app.py"));
        Ok(json!({"status": "ok", "remembered": true}))
    }

    async fn forget_zed_remote_project(&self, payload: Value) -> anyhow::Result<Value> {
        assert_eq!(payload["id"], json!("zed-remote-project:test"));
        Ok(json!({"status": "ok", "removed": 1}))
    }

    async fn upstream_worktree_status(&self) -> anyhow::Result<Value> {
        Ok(json!({"status": "ok", "feature": "upstream-worktree"}))
    }

    async fn upstream_worktree_defaults(&self, payload: Value) -> anyhow::Result<Value> {
        assert_eq!(payload["repoPath"], json!("/repo"));
        Ok(json!({
            "status": "ok",
            "repoRoot": "/repo",
            "defaultRemote": "upstream",
            "defaultBaseBranch": "main",
        }))
    }

    async fn upstream_worktree_prepare(&self, payload: Value) -> anyhow::Result<Value> {
        assert_eq!(payload["repoPath"], json!("/repo"));
        assert_eq!(payload["remote"], json!("upstream"));
        assert_eq!(payload["baseBranch"], json!("main"));
        Ok(json!({
            "status": "ok",
            "repoRoot": "/repo",
            "sourceRef": "upstream/main",
            "qualifiedSourceRef": "refs/remotes/upstream/main",
        }))
    }

    async fn upstream_worktree_create(&self, payload: Value) -> anyhow::Result<Value> {
        assert_eq!(payload["repoPath"], json!("/repo"));
        assert_eq!(payload["branchName"], json!("feature/demo"));
        Ok(json!({
            "status": "ok",
            "repoRoot": "/repo",
            "branchName": "feature/demo",
            "worktreePath": "/repo-feature-demo",
        }))
    }
}

impl FakeRuntime {
    fn inventory(&self, reloaded: bool) -> Value {
        json!({
            "enabled": *self.enabled.lock().unwrap(),
            "reloaded": reloaded,
            "scripts": [
                {"key": "builtin:demo.js", "name": "demo.js", "enabled": true},
                {"key": "user:a.js", "name": "a.js", "enabled": *self.script_enabled.lock().unwrap()}
            ]
        })
    }
}

struct FakeData;

impl Default for FakeData {
    fn default() -> Self {
        Self
    }
}

#[async_trait]
impl BridgeDataService for FakeData {
    async fn delete(&self, session: SessionRef) -> anyhow::Result<DeleteResult> {
        Ok(DeleteResult {
            status: DeleteStatus::LocalDeleted,
            session_id: session.session_id.clone(),
            message: format!("deleted {}", session.title),
            undo_token: Some(format!("undo-{}", session.session_id)),
            backup_path: None,
        })
    }

    async fn undo(&self, undo_token: String) -> anyhow::Result<DeleteResult> {
        Ok(DeleteResult {
            status: DeleteStatus::Undone,
            session_id: "s1".to_string(),
            message: "undone".to_string(),
            undo_token: Some(undo_token),
            backup_path: None,
        })
    }

    async fn export_markdown(&self, session: SessionRef) -> anyhow::Result<ExportResult> {
        Ok(ExportResult {
            status: ExportStatus::Exported,
            session_id: session.session_id,
            message: "exported".to_string(),
            filename: Some("First.md".to_string()),
            markdown: Some("# First\n".to_string()),
        })
    }

    async fn generated_images(&self, session: SessionRef) -> anyhow::Result<GeneratedImagesResult> {
        Ok(GeneratedImagesResult {
            status: GeneratedImagesStatus::Found,
            session_id: session.session_id,
            message: "found 1 generated image".to_string(),
            images: vec![GeneratedImage {
                id: "ig-1".to_string(),
                assistant_message_id: "msg-final".to_string(),
                assistant_response_index: Some(0),
                media_type: "image/png".to_string(),
                base64_data: "iVBORw0KGgo=".to_string(),
                revised_prompt: Some("A tower at sunset".to_string()),
            }],
        })
    }

    async fn thread_usage_history(&self, session: SessionRef) -> anyhow::Result<Value> {
        Ok(json!({
            "status": "ok",
            "session_id": session.session_id,
            "history": [
                {
                    "source": "rollout-history",
                    "conversation_id": "local:s1",
                    "turn_id": "turn-1",
                    "observed_at": "2026-06-02T05:00:00Z",
                    "usage": {
                        "inputTokens": 1200,
                        "outputTokens": 120,
                        "totalTokens": 1320,
                        "cachedTokens": 900,
                        "cacheReadTokens": 0,
                        "cacheCreationTokens": 0,
                        "contextUsed": 1320,
                        "contextLimit": 258400,
                        "hasBreakdown": true
                    }
                }
            ]
        }))
    }

    async fn find_archived_thread_by_title(
        &self,
        title: String,
    ) -> anyhow::Result<Option<SessionRef>> {
        Ok(Some(SessionRef {
            session_id: "archived-1".to_string(),
            title,
        }))
    }

    async fn move_thread_workspace(
        &self,
        session: SessionRef,
        target_cwd: String,
    ) -> anyhow::Result<Value> {
        Ok(json!({"status": "moved", "session_id": session.session_id, "target_cwd": target_cwd}))
    }

    async fn thread_sort_key(&self, session: SessionRef) -> anyhow::Result<Value> {
        Ok(json!({"status": "ok", "session_id": session.session_id, "updated_at": 123}))
    }

    async fn thread_sort_keys(&self, sessions: Vec<SessionRef>) -> anyhow::Result<Value> {
        Ok(json!({
            "status": "ok",
            "sort_keys": sessions
                .into_iter()
                .map(|session| json!({"session_id": session.session_id}))
                .collect::<Vec<_>>()
        }))
    }
}

#[derive(Clone)]
struct ContextHooks {
    events: Arc<Mutex<Vec<String>>>,
}

impl ContextHooks {
    fn event(&self, event: impl Into<String>) {
        self.events.lock().unwrap().push(event.into());
    }
}

#[async_trait(?Send)]
impl LaunchHooks for ContextHooks {
    fn resolve_app_dir(
        &self,
        app_dir: Option<&std::path::Path>,
        _settings: &BackendSettings,
    ) -> anyhow::Result<std::path::PathBuf> {
        app_dir
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| anyhow::anyhow!("missing app dir"))
    }

    fn select_debug_port(&self, requested: u16) -> u16 {
        requested
    }

    fn select_helper_port(&self, requested: u16) -> u16 {
        requested
    }

    async fn load_settings(&self) -> anyhow::Result<BackendSettings> {
        Ok(BackendSettings::default())
    }

    async fn run_provider_sync(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn run_remote_control_session_recovery(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn start_helper(&self, _helper_port: u16) -> anyhow::Result<()> {
        Ok(())
    }

    async fn launch_codex(
        &self,
        _app_dir: &std::path::Path,
        _debug_port: u16,
        _settings: &BackendSettings,
        _extra_args: &[String],
    ) -> anyhow::Result<CodexLaunch> {
        Ok(CodexLaunch::Process {
            command: vec!["codex".to_string()],
            wait_strategy: ProcessWaitStrategy::TrackedChild,
            macos_cleanup_policy: None,
        })
    }

    async fn bridge_context(
        &self,
        debug_port: u16,
        _app_dir: &std::path::Path,
    ) -> anyhow::Result<Option<BridgeContext>> {
        self.event(format!("bridge-context:{debug_port}"));
        Ok(Some(test_context()))
    }

    async fn inject(&self, _debug_port: u16, _helper_port: u16) -> anyhow::Result<()> {
        anyhow::bail!("legacy inject should not run when bridge context is supplied")
    }

    async fn inject_bridge(
        &self,
        debug_port: u16,
        helper_port: u16,
        _ctx: BridgeContext,
    ) -> anyhow::Result<()> {
        self.event(format!("inject-bridge:{debug_port}:{helper_port}"));
        Ok(())
    }

    async fn start_bridge_watchdog(&self, debug_port: u16, helper_port: u16) -> anyhow::Result<()> {
        self.event(format!("watchdog:{debug_port}:{helper_port}"));
        Ok(())
    }

    async fn write_status(&self, status: &str) {
        self.event(format!("status:{status}"));
    }

    async fn wait_for_codex_exit(
        &self,
        _launch: &CodexLaunch,
        _debug_port: u16,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    async fn shutdown_helper(&self, _helper_port: u16) {}

    async fn terminate_codex(&self, _launch: &CodexLaunch) {}
}
