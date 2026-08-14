use base64::Engine;
use codex_plus_core::models::{GeneratedImagesStatus, SessionRef};
use codex_plus_data::generated_images_from_paths;
use rusqlite::Connection;
use serde_json::Value;
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
fn completed_generation_is_materialized_once_for_native_history() {
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

    assert_eq!(native_messages.len(), 1);
    let markdown = native_messages[0]["payload"]["content"][0]["text"]
        .as_str()
        .unwrap();
    let markdown_path = markdown
        .strip_prefix("![已生成图像](<")
        .and_then(|value| value.strip_suffix(">)"))
        .unwrap();
    assert_eq!(
        Path::new(markdown_path).canonicalize().unwrap(),
        image_path.canonicalize().unwrap()
    );
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

    generated_images_from_paths(
        [db_path],
        &SessionRef::new("thread-markdown", "Image task").unwrap(),
    );

    assert!(!tmp.path().join("generated_images/thread-markdown").exists());
    assert!(
        !fs::read_to_string(rollout_path)
            .unwrap()
            .contains("msg_codex_plus_generated_")
    );
}
