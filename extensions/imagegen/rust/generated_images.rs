use base64::Engine;
use codex_plus_core::models::{
    GeneratedImage, GeneratedImagesResult, GeneratedImagesStatus, SessionRef,
};
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::markdown::{
    ThreadLookup, lookup_thread_record, lookup_thread_record_by_title, normalize_session_id,
};

pub fn generated_images_from_paths(
    db_paths: impl IntoIterator<Item = PathBuf>,
    session: &SessionRef,
) -> GeneratedImagesResult {
    let thread_id = normalize_session_id(&session.session_id);
    let mut message = "未找到对应会话".to_string();
    let mut saw_database = false;

    for db_path in db_paths {
        if !db_path.exists() {
            continue;
        }
        saw_database = true;
        match generated_images_from_database(&db_path, &thread_id, &session.title) {
            Ok(Some(result)) => return result,
            Ok(None) => {}
            Err(error) => message = format!("读取生成图片失败：{error}"),
        }
    }

    if !saw_database {
        message = "未配置本地 Codex 数据库".to_string();
    }
    failed(&thread_id, message)
}

fn generated_images_from_database(
    db_path: &Path,
    thread_id: &str,
    title: &str,
) -> anyhow::Result<Option<GeneratedImagesResult>> {
    let db = Connection::open(db_path)?;
    let lookup = lookup_thread_record(&db, db_path, thread_id)?;
    let lookup = if matches!(lookup, ThreadLookup::Missing | ThreadLookup::Unsupported)
        && thread_id.starts_with("client-new-thread:")
        && !title.trim().is_empty()
    {
        lookup_thread_record_by_title(&db, title.trim())?
    } else {
        lookup
    };
    let record = match lookup {
        ThreadLookup::Found(record) => record,
        ThreadLookup::Missing | ThreadLookup::Unsupported => return Ok(None),
    };
    let resolved_thread_id = record.id;
    let Some(rollout_path) = record
        .rollout_path
        .filter(|path| !path.as_os_str().is_empty())
    else {
        return Ok(Some(failed(
            &resolved_thread_id,
            "会话缺少 rollout 文件路径",
        )));
    };
    if !rollout_path.is_file() {
        return Ok(Some(failed(
            &resolved_thread_id,
            format!("rollout 文件不存在：{}", rollout_path.to_string_lossy()),
        )));
    }

    let scan = load_generated_images(&rollout_path)?;
    materialize_generated_images(db_path, &resolved_thread_id, &scan)?;
    let images: Vec<_> = scan.images.into_iter().filter(|image| {
        !scan.markdown_image_ids.contains(&image.id)
            && !scan.native_image_hashes.contains(&encoded_hash(&image.base64_data))
    }).collect();
    let status = if images.is_empty() {
        GeneratedImagesStatus::Empty
    } else {
        GeneratedImagesStatus::Found
    };
    let message = if images.is_empty() {
        "未找到已完成的生成图片".to_string()
    } else {
        format!("found {} generated image(s)", images.len())
    };
    Ok(Some(GeneratedImagesResult {
        status,
        session_id: resolved_thread_id,
        message,
        images,
    }))
}

struct GeneratedImageScan {
    images: Vec<GeneratedImage>,
    completed_indices: HashSet<usize>,
    native_image_hashes: HashSet<String>,
    markdown_image_ids: HashSet<String>,
    message_ids: HashSet<String>,
}

fn load_generated_images(path: &Path) -> anyhow::Result<GeneratedImageScan> {
    let file = File::open(path)?;
    let mut images = Vec::new();
    let mut pending = Vec::new();
    let mut awaiting_completion = Vec::new();
    let mut completed_indices = HashSet::new();
    let mut native_image_hashes = HashSet::new();
    let mut markdown_image_ids = HashSet::new();
    let mut message_ids = HashSet::new();
    let mut assistant_response_index = 0;

    for line in BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let event: Value = serde_json::from_str(&line)?;
        if event.get("type").and_then(Value::as_str) == Some("event_msg") {
            if event["payload"].get("type").and_then(Value::as_str) == Some("task_complete") {
                completed_indices.extend(awaiting_completion.drain(..));
            }
            continue;
        }
        if event.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let payload = &event["payload"];
        match payload.get("type").and_then(Value::as_str) {
            Some("image_generation_call")
                if payload.get("status").and_then(Value::as_str) == Some("completed") =>
            {
                let result = payload
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if result.is_empty() {
                    continue;
                }
                images.push(GeneratedImage {
                    id: payload
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    assistant_message_id: String::new(),
                    assistant_response_index: None,
                    media_type: image_media_type(result).to_string(),
                    base64_data: result.to_string(),
                    revised_prompt: payload
                        .get("revised_prompt")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
                pending.push(images.len() - 1);
            }
            Some("message") if payload.get("role").and_then(Value::as_str) == Some("assistant") => {
                if let Some(message_id) = payload.get("id").and_then(Value::as_str) {
                    message_ids.insert(message_id.to_string());
                }
                if payload.get("phase").and_then(Value::as_str) == Some("commentary") {
                    continue;
                }
                collect_markdown_image_ids(payload, &images, &mut markdown_image_ids);
                let message_id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !message_id.is_empty() {
                    for index in pending.drain(..) {
                        images[index].assistant_message_id = message_id.to_string();
                        images[index].assistant_response_index = Some(assistant_response_index);
                        awaiting_completion.push(index);
                    }
                }
                assistant_response_index += 1;
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                collect_native_image_hashes(payload, &mut native_image_hashes);
            }
            _ => {}
        }
    }
    Ok(GeneratedImageScan {
        images,
        completed_indices,
        native_image_hashes,
        markdown_image_ids,
        message_ids,
    })
}

fn collect_markdown_image_ids(
    payload: &Value,
    images: &[GeneratedImage],
    image_ids: &mut HashSet<String>,
) {
    let Some(content) = payload.get("content").and_then(Value::as_array) else {
        return;
    };
    for text in content.iter().filter_map(|item| {
        (item.get("type").and_then(Value::as_str) == Some("output_text"))
            .then(|| item.get("text").and_then(Value::as_str))
            .flatten()
    }) {
        if !text.contains("![") {
            continue;
        }
        image_ids.extend(
            images
                .iter()
                .filter(|image| !image.id.is_empty() && text.contains(&image.id))
                .map(|image| image.id.clone()),
        );
    }
}

/// Only the native app may unload/archive a thread before this operation.
/// Never rewrite an active rollout: its append handle and ordinal allocator belong to Codex.
pub fn persist_generated_images_from_paths(
    db_paths: impl IntoIterator<Item = PathBuf>,
    session: &SessionRef,
) -> anyhow::Result<usize> {
    let thread_id = normalize_session_id(&session.session_id);
    for db_path in db_paths {
        if !db_path.is_file() { continue; }
        let db = Connection::open(&db_path)?;
        let ThreadLookup::Found(record) = lookup_thread_record(&db, &db_path, &thread_id)? else { continue; };
        let archived: bool = db.query_row("SELECT archived FROM threads WHERE id = ?1", [&thread_id], |r| r.get(0))?;
        anyhow::ensure!(archived, "图片引用只能在会话卸载后修复");
        let path = record.rollout_path.ok_or_else(|| anyhow::anyhow!("会话缺少日志路径"))?;
        let scan = load_generated_images(&path)?;
        materialize_generated_images(&db_path, &thread_id, &scan)?;
        let original = std::fs::read_to_string(&path)?;
        let output_dir = db_path.parent().unwrap().join("generated_images").join(&thread_id);
        // 模型可能复用历史里的本地图片路径；本轮生成结果才是该回复的图片来源。
        let invalid = regex::Regex::new(&format!(r"!\[([^\]]*)\]\((?:<?/mnt/data/[^)]+|attachment://[^)]+|<?{}/[^)]+)\)", regex::escape(&output_dir.to_string_lossy())))?;
        let mut changed = 0;
        let mut repaired = String::with_capacity(original.len());
        for line in original.split_inclusive('\n') {
            let mut event: Value = serde_json::from_str(line)?;
            let payload = &mut event["payload"];
            let id = payload.get("id").and_then(Value::as_str).unwrap_or_default();
            let images: Vec<_> = scan.images.iter().enumerate()
                .filter(|(i, image)| scan.completed_indices.contains(i) && image.assistant_message_id == id
                    && !scan.markdown_image_ids.contains(&image.id)
                    && !scan.native_image_hashes.contains(&encoded_hash(&image.base64_data)))
                .map(|(_, image)| image).collect();
            if event_is_assistant_message(payload) && !images.is_empty() {
                let mut paths = images.iter().map(|image| {
                    db_path.parent().unwrap().join("generated_images").join(&thread_id)
                        .join(format!("{}.{}", safe_file_stem(&image.id, &native_message_id(&thread_id, &image.id)), image_extension(&image.media_type)))
                });
                let content = payload.get_mut("content").and_then(Value::as_array_mut)
                    .ok_or_else(|| anyhow::anyhow!("Invalid assistant content"))?;
                let mut replaced = false;
                for part in content.iter_mut() {
                    if part["type"] != "output_text" { continue; }
                    if let Some(text) = part["text"].as_str() {
                        let next = invalid.replace_all(text, |caps: &regex::Captures<'_>| {
                            if let Some(path) = paths.next() {
                                replaced = true;
                                format!("![{}](<{}>)", &caps[1], path.display())
                            } else { caps[0].to_string() }
                        }).into_owned();
                        part["text"] = Value::String(next);
                    }
                }
                // 即使模型只返回说明文字，也必须把尚未引用的本轮图片写入原生消息。
                let remaining = paths.map(|p| format!("![生成的图片](<{}>)", p.display())).collect::<Vec<_>>();
                if !remaining.is_empty() {
                    content.push(serde_json::json!({"type":"output_text","text":remaining.join("\n")}));
                    replaced = true;
                }
                if replaced {
                    repaired.push_str(&serde_json::to_string(&event)?);
                    repaired.push('\n');
                    changed += 1;
                    continue;
                }
            }
            repaired.push_str(line);
        }
        if changed > 0 {
            // 原生 UI 使用 item_completed 投影；响应正文和事件必须保持一致。
            let messages: HashMap<String, String> = repaired.lines().filter_map(|line| {
                let event: Value = serde_json::from_str(line).ok()?;
                let p = &event["payload"];
                if event["type"] != "response_item" || !event_is_assistant_message(p)
                    || !scan.images.iter().any(|image| p["id"].as_str() == Some(image.assistant_message_id.as_str())) { return None; }
                let text = p["content"].as_array()?.iter().filter_map(|v| v["text"].as_str()).collect::<Vec<_>>().join("\n");
                Some((p["id"].as_str()?.to_owned(), text))
            }).collect();
            let mut last_message = None;
            repaired = repaired.split_inclusive('\n').map(|line| -> anyhow::Result<String> {
                let mut event: Value = serde_json::from_str(line)?;
                let p = &mut event["payload"];
                if event_is_assistant_message(p) { last_message = p["id"].as_str().and_then(|id| messages.get(id)).cloned(); }
                let mut modified = false;
                if let Some(text) = p["item"]["id"].as_str().and_then(|id| messages.get(id)) {
                    if p["item"]["type"] == "AgentMessage" {
                        p["item"]["content"] = serde_json::json!([{"type":"Text", "text":text}]);
                        modified = true;
                    }
                }
                if p["type"] == "task_complete" {
                    if let Some(text) = last_message.take() { p["last_agent_message"] = Value::String(text); modified = true; }
                }
                Ok(if modified { format!("{}\n", serde_json::to_string(&event)?) } else { line.to_owned() })
            }).collect::<anyhow::Result<String>>()?;
            let backup = path.with_extension(format!("image-backup-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()));
            codex_plus_core::settings::atomic_write(&backup, original.as_bytes())?;
            anyhow::ensure!(std::fs::read_to_string(&path)? == original, "会话日志已变化，未覆盖");
            let archived: bool = db.query_row("SELECT archived FROM threads WHERE id = ?1", [&thread_id], |r| r.get(0))?;
            anyhow::ensure!(archived, "会话已恢复，未覆盖");
            // 删除的仅是本会话的可重建投影；原生 resume 从修正后的日志重建字节偏移和消息。
            let history_path = db_path.parent().unwrap().join("thread_history_1.sqlite");
            let mut history = if history_path.is_file() { Some(Connection::open(&history_path)?) } else { None };
            let transaction = history.as_mut().map(Connection::transaction).transpose()?;
            if let Some(tx) = &transaction {
                // 旧版迁移可能留下仅存在于历史库的别名；按消息 ID 找到它，不能误清其他真实会话。
                let mut projection_ids = HashSet::from([thread_id.clone()]);
                let has_items: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_items')", [], |r| r.get(0))?;
                if has_items {
                    let mut statement = tx.prepare("SELECT DISTINCT thread_id FROM thread_items WHERE item_id = ?1")?;
                    for id in messages.keys() {
                        for alias in statement.query_map([id], |r| r.get::<_, String>(0))? {
                            let alias = alias?;
                            let real_thread: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)", [&alias], |r| r.get(0))?;
                            if !real_thread { projection_ids.insert(alias); }
                        }
                    }
                }
                for table in ["thread_items", "thread_turns", "thread_realtime_items", "thread_history_projection_state"] {
                    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table], |r| r.get(0))?;
                    if exists { for id in &projection_ids { tx.execute(&format!("DELETE FROM {table} WHERE thread_id = ?1"), [id])?; } }
                }
            }
            codex_plus_core::settings::atomic_write(&path, repaired.as_bytes())?;
            if let Some(tx) = transaction {
                if let Err(error) = tx.commit() {
                    codex_plus_core::settings::atomic_write(&path, original.as_bytes())?;
                    return Err(error.into());
                }
            }
        }
        return Ok(changed);
    }
    anyhow::bail!("未找到图片会话")
}

fn event_is_assistant_message(payload: &Value) -> bool {
    payload["type"] == "message" && payload["role"] == "assistant" && payload["phase"] != "commentary"
}

fn collect_native_image_hashes(payload: &Value, hashes: &mut HashSet<String>) {
    let Some(output) = payload.get("output").and_then(Value::as_array) else {
        return;
    };
    for item in output {
        if item.get("type").and_then(Value::as_str) != Some("input_image") {
            continue;
        }
        let Some(image_url) = item.get("image_url").and_then(Value::as_str) else {
            continue;
        };
        let encoded = image_url
            .split_once(',')
            .map_or(image_url, |(_, data)| data);
        hashes.insert(encoded_hash(encoded));
    }
}

fn materialize_generated_images(
    db_path: &Path,
    thread_id: &str,
    scan: &GeneratedImageScan,
) -> anyhow::Result<()> {
    // 会话日志及 ordinal 由 Codex 独占写入；这里只保存图片文件。
    let Some(codex_home) = db_path.parent() else {
        return Ok(());
    };
    let output_dir = codex_home.join("generated_images").join(thread_id);

    for (index, image) in scan.images.iter().enumerate() {
        if !scan.completed_indices.contains(&index)
            || scan
                .native_image_hashes
                .contains(&encoded_hash(&image.base64_data))
            || scan.markdown_image_ids.contains(&image.id)
        {
            continue;
        }
        let message_id = native_message_id(thread_id, &image.id);
        if scan.message_ids.contains(&message_id) {
            continue;
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(&image.base64_data)?;
        let image_path = output_dir.join(format!(
            "{}.{}",
            safe_file_stem(&image.id, &message_id),
            image_extension(&image.media_type)
        ));
        if image_path.exists() {
            anyhow::ensure!(
                std::fs::read(&image_path)? == bytes,
                "generated image path already contains different data: {}",
                image_path.display()
            );
        } else {
            codex_plus_core::settings::atomic_write(&image_path, &bytes)?;
        }
    }

    Ok(())
}

fn native_message_id(thread_id: &str, image_id: &str) -> String {
    let digest = Sha256::digest(format!("{thread_id}\0{image_id}"));
    let suffix = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("msg_codex_plus_generated_{suffix}")
}

fn safe_file_stem(image_id: &str, fallback: &str) -> String {
    let stem = image_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if stem.is_empty() {
        fallback.to_string()
    } else {
        stem
    }
}

fn image_extension(media_type: &str) -> &'static str {
    match media_type {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn encoded_hash(encoded: &str) -> String {
    let digest = Sha256::digest(encoded.as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn image_media_type(base64_data: &str) -> &'static str {
    if base64_data.starts_with("/9j/") {
        "image/jpeg"
    } else if base64_data.starts_with("UklGR") {
        "image/webp"
    } else {
        "image/png"
    }
}

fn failed(session_id: &str, message: impl Into<String>) -> GeneratedImagesResult {
    GeneratedImagesResult {
        status: GeneratedImagesStatus::Failed,
        session_id: session_id.to_string(),
        message: message.into(),
        images: Vec::new(),
    }
}
