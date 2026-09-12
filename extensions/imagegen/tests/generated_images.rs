use base64::Engine;
use codex_plus_core::models::{GeneratedImagesStatus, SessionRef};
use codex_plus_data::generated_images_from_paths;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use tempfile::tempdir;

fn create_thread_db(path: &Path, rollout_path: &Path, thread_id: &str) {
    let db = Connection::open(path).unwrap();
    db.execute(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO threads (id, rollout_path, title) VALUES (?1, ?2, 'Image task')",
        (thread_id, rollout_path.to_string_lossy().to_string()),
    )
    .unwrap();
}

#[test]
fn completed_image_generation_is_bound_to_the_following_assistant_message() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout_path = tmp.path().join("rollout.jsonl");
    fs::write(
        &rollout_path,
        concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-preface\",\"role\":\"assistant\",\"phase\":\"commentary\",\"content\":[{\"type\":\"output_text\",\"text\":\"Generating\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-1\",\"status\":\"completed\",\"revised_prompt\":\"A tower at sunset\",\"result\":\"iVBORw0KGgoAAAANSUhEUg==\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-final\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"Generated\"}]}}\n",
        ),
    )
    .unwrap();
    create_thread_db(&db_path, &rollout_path, "thread-1");

    let result = generated_images_from_paths(
        [db_path],
        &SessionRef::new("local:thread-1", "Image task").unwrap(),
    );

    assert_eq!(result.status, GeneratedImagesStatus::Found);
    assert_eq!(result.session_id, "thread-1");
    assert_eq!(result.images.len(), 1);
    assert_eq!(result.images[0].id, "ig-1");
    assert_eq!(result.images[0].assistant_message_id, "msg-final");
    assert_eq!(result.images[0].assistant_response_index, Some(0));
    assert_eq!(result.images[0].media_type, "image/png");
    assert_eq!(result.images[0].base64_data, "iVBORw0KGgoAAAANSUhEUg==");
    assert_eq!(
        result.images[0].revised_prompt.as_deref(),
        Some("A tower at sunset")
    );
}

#[test]
fn generated_images_keep_their_final_response_order_across_multiple_turns() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout_path = tmp.path().join("rollout.jsonl");
    fs::write(
        &rollout_path,
        concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-first\",\"status\":\"completed\",\"result\":\"iVBORw0\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-first\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-progress\",\"role\":\"assistant\",\"phase\":\"commentary\",\"content\":[]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-second\",\"status\":\"completed\",\"result\":\"iVBORw1\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-second\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[]}}\n",
        ),
    )
    .unwrap();
    create_thread_db(&db_path, &rollout_path, "thread-multi");

    let result = generated_images_from_paths(
        [db_path],
        &SessionRef::new("thread-multi", "Image task").unwrap(),
    );

    assert_eq!(result.status, GeneratedImagesStatus::Found);
    assert_eq!(result.images.len(), 2);
    assert_eq!(result.images[0].assistant_response_index, Some(0));
    assert_eq!(result.images[1].assistant_response_index, Some(1));
}

#[test]
fn incomplete_or_empty_image_generation_results_are_not_rendered() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout_path = tmp.path().join("rollout.jsonl");
    fs::write(
        &rollout_path,
        concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-running\",\"status\":\"in_progress\",\"result\":\"iVBORw0\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-empty\",\"status\":\"completed\",\"result\":\"\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-final\",\"role\":\"assistant\",\"content\":[]}}\n",
        ),
    )
    .unwrap();
    create_thread_db(&db_path, &rollout_path, "thread-2");

    let result = generated_images_from_paths(
        [db_path],
        &SessionRef::new("thread-2", "Image task").unwrap(),
    );

    assert_eq!(result.status, GeneratedImagesStatus::Empty);
    assert!(result.images.is_empty());
}

#[test]
fn client_new_thread_id_recovers_generated_images_by_exact_title() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout_path = tmp.path().join("rollout.jsonl");
    fs::write(
        &rollout_path,
        concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-title\",\"status\":\"completed\",\"result\":\"iVBORw0\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-title\",\"role\":\"assistant\",\"content\":[]}}\n",
        ),
    )
    .unwrap();
    create_thread_db(&db_path, &rollout_path, "real-thread-id");

    let result = generated_images_from_paths(
        [db_path],
        &SessionRef::new("local:client-new-thread:temporary-id", "Image task").unwrap(),
    );

    assert_eq!(result.status, GeneratedImagesStatus::Found);
    assert_eq!(result.session_id, "real-thread-id");
    assert_eq!(result.images[0].id, "ig-title");
}

#[test]
fn completed_generation_materializes_image_without_modifying_native_history() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout_path = tmp.path().join("rollout.jsonl");
    let image_bytes = b"durable generated image";
    let encoded = base64::engine::general_purpose::STANDARD.encode(image_bytes);
    fs::write(
        &rollout_path,
        format!(
            concat!(
                "{{\"type\":\"response_item\",\"payload\":{{\"type\":\"image_generation_call\",\"id\":\"ig-native\",\"status\":\"completed\",\"result\":\"{}\"}}}}\n",
                "{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"id\":\"msg-final\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[]}}}}\n",
                "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\"}}}}\n",
            ),
            encoded
        ),
    )
    .unwrap();
    create_thread_db(&db_path, &rollout_path, "thread-native");
    let session = SessionRef::new("thread-native", "Image task").unwrap();
    let original = fs::read(&rollout_path).unwrap();

    generated_images_from_paths([db_path.clone()], &session);
    generated_images_from_paths([db_path], &session);

    let image_path = tmp
        .path()
        .join("generated_images/thread-native/ig-native.png");
    assert_eq!(fs::read(&image_path).unwrap(), image_bytes);
    let events = fs::read_to_string(&rollout_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let native_messages = events
        .iter()
        .filter(|event| {
            event["type"] == "response_item"
                && event["payload"]["type"] == "message"
                && event["payload"]["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("msg_codex_plus_generated_"))
        })
        .collect::<Vec<_>>();

    assert!(native_messages.is_empty());
    assert_eq!(original, fs::read(&rollout_path).unwrap());
}

#[test]
fn paginated_rollout_ordinals_and_bytes_are_preserved_after_image_recovery() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout_path = tmp.path().join("rollout.jsonl");
    let original = concat!(
        "{\"ordinal\":0,\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-page\",\"status\":\"completed\",\"result\":\"aW1hZ2U=\"}}\n",
        "{\"ordinal\":1,\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-final\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[]}}\n",
        "{\"ordinal\":2,\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n",
    );
    fs::write(&rollout_path, original).unwrap();
    create_thread_db(&db_path, &rollout_path, "paged-thread");
    for _ in 0..2 {
        let result = generated_images_from_paths([db_path.clone()], &SessionRef::new("paged-thread", "").unwrap());
        assert_eq!(GeneratedImagesStatus::Found, result.status);
        assert_eq!(original.as_bytes(), fs::read(&rollout_path).unwrap());
    }
}

#[test]
fn generation_is_not_materialized_before_task_completion() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout_path = tmp.path().join("rollout.jsonl");
    fs::write(
        &rollout_path,
        concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-running-turn\",\"status\":\"completed\",\"result\":\"aW1hZ2U=\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-final\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[]}}\n",
        ),
    )
    .unwrap();
    create_thread_db(&db_path, &rollout_path, "thread-running-turn");

    generated_images_from_paths(
        [db_path],
        &SessionRef::new("thread-running-turn", "Image task").unwrap(),
    );

    assert!(
        !tmp.path()
            .join("generated_images/thread-running-turn")
            .exists()
    );
    assert!(
        !fs::read_to_string(rollout_path)
            .unwrap()
            .contains("msg_codex_plus_generated_")
    );
}

#[test]
fn native_image_output_is_not_materialized_again() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout_path = tmp.path().join("rollout.jsonl");
    fs::write(
        &rollout_path,
        concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-native-output\",\"status\":\"completed\",\"result\":\"aW1hZ2U=\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"call-native\",\"output\":[{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,aW1hZ2U=\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-final\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[]}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n",
        ),
    )
    .unwrap();
    create_thread_db(&db_path, &rollout_path, "thread-native-output");

    generated_images_from_paths(
        [db_path],
        &SessionRef::new("thread-native-output", "Image task").unwrap(),
    );

    assert!(
        !tmp.path()
            .join("generated_images/thread-native-output")
            .exists()
    );
    assert!(
        !fs::read_to_string(rollout_path)
            .unwrap()
            .contains("msg_codex_plus_generated_")
    );
}

#[test]
fn native_markdown_delivery_is_not_materialized_again() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout_path = tmp.path().join("rollout.jsonl");
    fs::write(
        &rollout_path,
        concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-markdown\",\"status\":\"completed\",\"result\":\"aW1hZ2U=\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-final\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"![已生成图像](</tmp/generated_images/thread-markdown/ig-markdown.png>)\"}]}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n",
        ),
    )
    .unwrap();
    create_thread_db(&db_path, &rollout_path, "thread-markdown");

    let result = generated_images_from_paths(
        [db_path],
        &SessionRef::new("thread-markdown", "Image task").unwrap(),
    );

    assert!(!tmp.path().join("generated_images/thread-markdown").exists());
    assert!(result.images.is_empty(), "native Markdown must not also be injected");
    assert!(
        !fs::read_to_string(rollout_path)
            .unwrap()
            .contains("msg_codex_plus_generated_")
    );
}

#[test]
fn archived_image_references_are_portable_and_keep_ordinals() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout = tmp.path().join("rollout.jsonl");
    let original = concat!(
        "{\"ordinal\":0,\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig-portable\",\"status\":\"completed\",\"result\":\"aW1hZ2U=\"}}\n",
        "{\"ordinal\":1,\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg-final\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"![风景](/mnt/data/0.png)\"}]}}\n",
        "{\"ordinal\":2,\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n",
    );
    let original = original.replace("{\"ordinal\":1", "{\"ordinal\":3,\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"AgentMessage\",\"id\":\"msg-final\",\"content\":[{\"type\":\"Text\",\"text\":\"![风景](/mnt/data/0.png)\"}]}}}\n{\"ordinal\":1");
    fs::write(&rollout, &original).unwrap();
    let history = Connection::open(tmp.path().join("thread_history_1.sqlite")).unwrap();
    for table in ["thread_items", "thread_turns", "thread_realtime_items", "thread_history_projection_state"] {
        history.execute(&format!("CREATE TABLE {table}(thread_id TEXT)"), []).unwrap();
        history.execute(&format!("INSERT INTO {table}(thread_id) VALUES ('portable'), ('other')"), []).unwrap();
    }
    history.execute("ALTER TABLE thread_items ADD COLUMN item_id TEXT", []).unwrap();
    history.execute("INSERT INTO thread_items(thread_id,item_id) VALUES ('old-alias','msg-final')", []).unwrap();
    create_thread_db(&db_path, &rollout, "portable");
    let db = Connection::open(&db_path).unwrap();
    db.execute("ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0", []).unwrap();
    let session = SessionRef::new("portable", "Image task").unwrap();
    let persist = || codex_plus_data::generated_images::persist_generated_images_from_paths([db_path.clone()], &session);
    assert!(persist().is_err());
    assert_eq!(fs::read_to_string(&rollout).unwrap(), original);
    db.execute("UPDATE threads SET archived=1", []).unwrap();
    assert_eq!(persist().unwrap(), 1);
    let repaired = fs::read_to_string(&rollout).unwrap();
    let rows: Vec<Value> = repaired.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(rows.iter().map(|v| v["ordinal"].as_u64().unwrap()).collect::<Vec<_>>(), vec![0,3,1,2]);
    let image = tmp.path().join("generated_images/portable/ig-portable.png");
    assert_eq!(fs::read(&image).unwrap(), b"image");
    assert!(rows[2]["payload"]["content"][0]["text"].as_str().unwrap().contains(image.to_str().unwrap()));
    assert!(!repaired.contains("/mnt/data/0.png"));
    assert!(rows[1]["payload"]["item"]["content"][0]["text"].as_str().unwrap().contains(image.to_str().unwrap()));
    for table in ["thread_items", "thread_turns", "thread_realtime_items", "thread_history_projection_state"] {
        let remaining: String = history.query_row(&format!("SELECT thread_id FROM {table}"), [], |r| r.get(0)).unwrap();
        assert_eq!(remaining, "other");
    }
    assert_eq!(persist().unwrap(), 0);
    assert_eq!(fs::read_to_string(&rollout).unwrap(), repaired);
    assert!(generated_images_from_paths([db_path], &session).images.is_empty());
}

#[test]
fn new_generation_replaces_reused_local_image_reference() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout = tmp.path().join("rollout.jsonl");
    let old = tmp.path().join("generated_images/portable/ig-old.png");
    let events = [
        json!({"type":"response_item","payload":{"type":"image_generation_call","id":"ig-new","status":"completed","result":"aW1hZ2U="}}),
        json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"msg-new","content":[{"type":"Text","text":format!("![新图](<{}>)",old.display())}]}}}),
        json!({"type":"response_item","payload":{"type":"message","id":"msg-new","role":"assistant","content":[{"type":"output_text","text":format!("![新图](<{}>)",old.display())}]}}),
        json!({"type":"event_msg","payload":{"type":"task_complete"}}),
    ];
    fs::write(&rollout, events.iter().map(|e| format!("{e}\n")).collect::<String>()).unwrap();
    create_thread_db(&db_path, &rollout, "portable");
    Connection::open(&db_path).unwrap().execute("ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 1", []).unwrap();
    let session = SessionRef::new("portable", "Image").unwrap();
    assert_eq!(codex_plus_data::generated_images::persist_generated_images_from_paths([db_path.clone()], &session).unwrap(), 1);
    let text = fs::read_to_string(&rollout).unwrap();
    assert!(!text.contains("ig-old.png"));
    assert_eq!(text.matches("ig-new.png").count(), 3);
    assert!(generated_images_from_paths([db_path], &session).images.is_empty());
}

#[test]
fn text_only_image_reply_keeps_text_and_persists_native_image() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("state_5.sqlite");
    let rollout = tmp.path().join("rollout.jsonl");
    let events = [
        json!({"type":"response_item","payload":{"type":"image_generation_call","id":"ig-text-only","status":"completed","result":"aW1hZ2U="}}),
        json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"msg-new","content":[{"type":"Text","text":"已换一张。"}]}}}),
        json!({"type":"response_item","payload":{"type":"message","id":"msg-new","role":"assistant","content":[{"type":"output_text","text":"已换一张。"}]}}),
        json!({"type":"event_msg","payload":{"type":"task_complete"}}),
    ];
    fs::write(&rollout, events.iter().map(|e| format!("{e}\n")).collect::<String>()).unwrap();
    create_thread_db(&db_path, &rollout, "portable");
    Connection::open(&db_path).unwrap().execute("ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 1", []).unwrap();
    let session = SessionRef::new("portable", "Image").unwrap();
    let persist = || codex_plus_data::generated_images::persist_generated_images_from_paths([db_path.clone()], &session).unwrap();
    assert_eq!(persist(), 1);
    let text = fs::read_to_string(&rollout).unwrap();
    assert_eq!(text.matches("ig-text-only.png").count(), 3);
    assert_eq!(text.matches("已换一张。").count(), 3);
    assert_eq!(persist(), 0);
    assert_eq!(fs::read_to_string(&rollout).unwrap(), text);
    assert!(generated_images_from_paths([db_path], &session).images.is_empty());
}
