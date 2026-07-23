use base64::Engine;
use chrono::{SecondsFormat, Utc};
use codex_plus_core::models::{
    GeneratedImage, GeneratedImagesResult, GeneratedImagesStatus, SessionRef,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
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
    materialize_generated_images(db_path, &rollout_path, &resolved_thread_id, &scan)?;
    let images = scan.images;
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
        if !text.contains("![已生成图像]") {
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
    rollout_path: &Path,
    thread_id: &str,
    scan: &GeneratedImageScan,
) -> anyhow::Result<()> {
    let Some(codex_home) = db_path.parent() else {
        return Ok(());
    };
    let output_dir = codex_home.join("generated_images").join(thread_id);
    let mut events = Vec::new();

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
        events.push(json!({
            "timestamp": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": message_id,
                "role": "assistant",
                "phase": "final_answer",
                "content": [{
                    "type": "output_text",
                    "text": format!("![已生成图像](<{}>)", image_path.to_string_lossy()),
                }],
            },
        }));
    }

    append_rollout_events(rollout_path, &events)
}

fn append_rollout_events(path: &Path, events: &[Value]) -> anyhow::Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let mut existing = File::open(path)?;
    let length = existing.metadata()?.len();
    let needs_newline = if length == 0 {
        false
    } else {
        existing.seek(SeekFrom::End(-1))?;
        let mut last = [0_u8; 1];
        existing.read_exact(&mut last)?;
        last[0] != b'\n'
    };
    let mut output = OpenOptions::new().append(true).open(path)?;
    if needs_newline {
        output.write_all(b"\n")?;
    }
    for event in events {
        serde_json::to_writer(&mut output, event)?;
        output.write_all(b"\n")?;
    }
    output.flush()?;
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
