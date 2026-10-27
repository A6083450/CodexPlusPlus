use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const MESSAGE_ID_PREFIX: &str = "msg_cpp_images_";
const MESSAGE_HASH_LENGTH: usize = 32;

pub fn normalize_history_ids(body: &mut Value) {
    let Some(items) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    for item in items {
        if item["type"] != "message" || item["role"] != "assistant" {
            continue;
        }
        let Some(hash) = item["id"]
            .as_str()
            .and_then(|id| id.strip_prefix(MESSAGE_ID_PREFIX))
        else {
            continue;
        };
        if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            item["id"] = json!(format!(
                "{MESSAGE_ID_PREFIX}{}",
                &hash[..MESSAGE_HASH_LENGTH]
            ));
        }
    }
}

pub struct ImageDeliveryStream {
    buffer: Vec<u8>,
    home: PathBuf,
}

impl ImageDeliveryStream {
    pub fn new(home: PathBuf) -> Self {
        Self {
            buffer: Vec::new(),
            home,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
        self.buffer.extend_from_slice(bytes);
        anyhow::ensure!(
            self.buffer.len() <= 64 * 1024 * 1024,
            "Responses SSE event exceeds 64 MiB"
        );
        let mut out = Vec::new();
        loop {
            let boundary = self
                .buffer
                .windows(2)
                .position(|v| v == b"\n\n")
                .map(|i| (i, 2))
                .into_iter()
                .chain(
                    self.buffer
                        .windows(4)
                        .position(|v| v == b"\r\n\r\n")
                        .map(|i| (i, 4)),
                )
                .min_by_key(|(i, _)| *i);
            let Some((end, size)) = boundary else {
                break;
            };
            let frame: Vec<u8> = self.buffer.drain(..end + size).collect();
            let text = std::str::from_utf8(&frame)?;
            let data = text
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(str::trim)
                .collect::<Vec<_>>()
                .join("\n");
            let Ok(mut event) = serde_json::from_str::<Value>(&data) else {
                out.extend(frame);
                continue;
            };
            if event["type"] != "response.completed" {
                out.extend(frame);
                continue;
            }
            let message = attach_images(&mut event["response"], &self.home)?;
            let Some((index, item)) = message else {
                out.extend(frame);
                continue;
            };
            let mut sequence = event["sequence_number"].as_u64().unwrap_or(0);
            let part = item["content"][0].clone();
            let mut added = item.clone();
            added["status"] = json!("in_progress");
            added["content"] = json!([]);
            for mut extra in [
                json!({"type":"response.output_item.added","output_index":index,"item":added}),
                json!({"type":"response.content_part.added","output_index":index,"item_id":item["id"],"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}),
                json!({"type":"response.output_text.delta","output_index":index,"item_id":item["id"],"content_index":0,"delta":part["text"]}),
                json!({"type":"response.output_text.done","output_index":index,"item_id":item["id"],"content_index":0,"text":part["text"]}),
                json!({"type":"response.content_part.done","output_index":index,"item_id":item["id"],"content_index":0,"part":part}),
                json!({"type":"response.output_item.done","output_index":index,"item":item}),
            ] {
                extra["sequence_number"] = json!(sequence);
                sequence += 1;
                write_event(&mut out, &extra)?;
            }
            event["sequence_number"] = json!(sequence);
            write_event(&mut out, &event)?;
        }
        Ok(out)
    }

    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buffer)
    }
}

fn write_event(out: &mut Vec<u8>, event: &Value) -> anyhow::Result<()> {
    out.extend_from_slice(
        format!(
            "event: {}\ndata: ",
            event["type"].as_str().unwrap_or_default()
        )
        .as_bytes(),
    );
    serde_json::to_writer(&mut *out, event)?;
    out.extend_from_slice(b"\n\n");
    Ok(())
}

// 通过正常响应让 Codex 保存消息和 ordinal，不从外部改写 rollout。
pub fn attach_images(response: &mut Value, home: &Path) -> anyhow::Result<Option<(usize, Value)>> {
    let Some(output) = response.get_mut("output").and_then(Value::as_array_mut) else {
        return Ok(None);
    };
    let mut links = Vec::new();
    for item in output.iter() {
        if item["type"] != "image_generation_call" || item["status"] != "completed" {
            continue;
        }
        let Some(encoded) = item["result"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let encoded = if encoded.starts_with("data:") {
            encoded.split_once(',').map_or(encoded, |(_, v)| v)
        } else {
            encoded
        };
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let id: String = item["id"]
            .as_str()
            .unwrap_or("image")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .take(120)
            .collect();
        let ext = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            "jpg"
        } else if bytes.starts_with(b"RIFF") {
            "webp"
        } else {
            "png"
        };
        let path = home
            .join("generated_images/response-assets")
            .join(format!("{id}-{}.{ext}", &digest[..16]));
        if path.exists() {
            anyhow::ensure!(
                std::fs::read(&path)? == bytes,
                "image asset content mismatch"
            );
        } else {
            crate::settings::atomic_write(&path, &bytes)?;
        }
        let path = path
            .to_string_lossy()
            .replace('<', "%3C")
            .replace('>', "%3E");
        links.push(format!("![已生成图像](<{path}>)"));
    }
    if links.is_empty() {
        return Ok(None);
    }
    let text = links.join("\n\n");
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let id = format!("{MESSAGE_ID_PREFIX}{}", &hash[..MESSAGE_HASH_LENGTH]);
    if output.iter().any(|item| item["id"] == id) {
        return Ok(None);
    }
    let item = json!({"id":id,"type":"message","role":"assistant","status":"completed","phase":"final_answer",
        "content":[{"type":"output_text","text":text,"annotations":[]}]});
    let index = output.len();
    output.push(item.clone());
    Ok(Some((index, item)))
}
