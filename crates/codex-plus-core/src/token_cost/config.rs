use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    MAX_EMAIL_BYTES, MAX_MODEL_BYTES, MAX_PROFILE_AVATAR_BYTES, MAX_PROFILE_TEXT_BYTES, ModelPrice,
};

static LOAD_FAILURE_DIAGNOSTIC_EMITTED: AtomicBool = AtomicBool::new(false);
const MAX_PRICE_OVERRIDES: usize = 64;

#[derive(Clone, Debug)]
pub struct UiConfigStore {
    path: Option<PathBuf>,
}

impl UiConfigStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    pub fn in_memory() -> Self {
        Self { path: None }
    }

    pub fn load(&self) -> UiConfig {
        let Some(path) = &self.path else {
            return UiConfig::default();
        };
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return UiConfig::default();
            }
            Err(error) => {
                emit_load_failure_diagnostic(path, &error.to_string());
                return UiConfig::default();
            }
        };
        let loaded = serde_json::from_slice::<UiConfig>(&bytes)
            .context("token cost UI config is not valid JSON")
            .and_then(|config| {
                config.validate()?;
                Ok(config)
            });
        match loaded {
            Ok(config) => config,
            Err(error) => {
                emit_load_failure_diagnostic(path, &error.to_string());
                UiConfig::default()
            }
        }
    }

    pub fn save(&self, config: &UiConfig) -> anyhow::Result<()> {
        config.validate()?;
        let Some(path) = &self.path else {
            return Ok(());
        };
        let bytes = serde_json::to_vec_pretty(config)?;
        crate::settings::atomic_write(path, &bytes)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct UiConfig {
    pub schema_version: u8,
    pub hub_visible: bool,
    pub output_rate_visible: bool,
    pub profile_visible: bool,
    pub price_overrides: BTreeMap<String, ModelPrice>,
    pub profile: ProfileConfig,
}

impl UiConfig {
    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        ensure!(self.schema_version == 1, "schema_version must be 1");
        ensure!(
            self.price_overrides.len() <= MAX_PRICE_OVERRIDES,
            "price_overrides must not exceed {MAX_PRICE_OVERRIDES} entries"
        );
        for model in self.price_overrides.keys() {
            ensure!(!model.is_empty(), "model must not be empty");
            ensure!(
                model.len() <= MAX_MODEL_BYTES,
                "model must not exceed {MAX_MODEL_BYTES} bytes"
            );
        }
        self.profile.validate()
    }
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            hub_visible: true,
            output_rate_visible: true,
            profile_visible: true,
            price_overrides: BTreeMap::new(),
            profile: ProfileConfig::default(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileConfig {
    pub display_name: String,
    pub username: String,
    pub email: String,
    pub plan_type: String,
    pub plan_label: String,
    pub workspace_name: String,
    pub avatar_data_url: Option<String>,
}

impl ProfileConfig {
    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        validate_profile_text("display_name", &self.display_name)?;
        validate_profile_text("plan_type", &self.plan_type)?;
        validate_profile_text("plan_label", &self.plan_label)?;
        validate_profile_text("workspace_name", &self.workspace_name)?;
        ensure!(
            (3..=20).contains(&self.username.len())
                && self.username.is_ascii()
                && self.username.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                }),
            "username must be 3-20 ASCII letters, numbers, '.', '_' or '-'"
        );
        ensure!(
            self.email.len() <= MAX_EMAIL_BYTES,
            "email must not exceed {MAX_EMAIL_BYTES} bytes"
        );
        if let Some(avatar) = &self.avatar_data_url {
            validate_avatar_data_url(avatar)?;
        }
        Ok(())
    }
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            display_name: "Local Usage".to_string(),
            username: "codex-local-usage".to_string(),
            email: "sama@openai.com".to_string(),
            plan_type: "pro_20x".to_string(),
            plan_label: "Pro 20x".to_string(),
            workspace_name: String::new(),
            avatar_data_url: None,
        }
    }
}

fn validate_profile_text(field: &str, value: &str) -> anyhow::Result<()> {
    ensure!(
        value.len() <= MAX_PROFILE_TEXT_BYTES,
        "{field} must not exceed {MAX_PROFILE_TEXT_BYTES} bytes"
    );
    Ok(())
}

fn validate_avatar_data_url(value: &str) -> anyhow::Result<()> {
    ensure!(
        value.len() <= MAX_PROFILE_AVATAR_BYTES,
        "avatar_data_url must not exceed {MAX_PROFILE_AVATAR_BYTES} bytes"
    );
    let (image_kind, payload) = [
        (AvatarImageKind::Png, "data:image/png;base64,"),
        (AvatarImageKind::Jpeg, "data:image/jpeg;base64,"),
        (AvatarImageKind::WebP, "data:image/webp;base64,"),
    ]
    .into_iter()
    .find_map(|(image_kind, prefix)| {
        value
            .strip_prefix(prefix)
            .map(|payload| (image_kind, payload))
    })
    .context("avatar_data_url must be a PNG, JPEG or WebP base64 data URL")?;
    let decoded = decode_avatar_base64(payload)?;
    let header_matches = match image_kind {
        AvatarImageKind::Png => decoded.starts_with(b"\x89PNG\r\n\x1a\n"),
        AvatarImageKind::Jpeg => decoded.starts_with(&[0xff, 0xd8, 0xff]),
        AvatarImageKind::WebP => {
            decoded.len() >= 12 && &decoded[..4] == b"RIFF" && &decoded[8..12] == b"WEBP"
        }
    };
    ensure!(
        header_matches,
        "avatar_data_url MIME type must match the decoded image header"
    );
    Ok(())
}

#[derive(Clone, Copy)]
enum AvatarImageKind {
    Png,
    Jpeg,
    WebP,
}

fn decode_avatar_base64(payload: &str) -> anyhow::Result<Vec<u8>> {
    ensure!(
        !payload.is_empty(),
        "avatar_data_url payload must not be empty"
    );
    ensure!(
        payload.len() % 4 == 0,
        "avatar_data_url payload must use complete base64 groups"
    );

    let encoded = payload.as_bytes();
    let padding = if encoded.ends_with(b"==") {
        2
    } else if encoded.ends_with(b"=") {
        1
    } else {
        0
    };
    let data_len = encoded.len() - padding;
    ensure!(
        encoded[..data_len]
            .iter()
            .all(|byte| base64_value(*byte).is_some()),
        "avatar_data_url payload contains invalid base64 characters or padding"
    );
    ensure!(
        encoded[data_len..].iter().all(|byte| *byte == b'='),
        "avatar_data_url payload contains invalid base64 padding"
    );
    if padding == 1 {
        ensure!(
            base64_value(encoded[encoded.len() - 2]).unwrap() & 0b11 == 0,
            "avatar_data_url payload contains non-canonical base64 padding"
        );
    } else if padding == 2 {
        ensure!(
            base64_value(encoded[encoded.len() - 3]).unwrap() & 0b1111 == 0,
            "avatar_data_url payload contains non-canonical base64 padding"
        );
    }

    let decoded_len = encoded.len() / 4 * 3 - padding;
    let mut decoded = Vec::with_capacity(decoded_len);
    for chunk in encoded.chunks_exact(4) {
        let first = base64_value(chunk[0]).unwrap();
        let second = base64_value(chunk[1]).unwrap();
        let third = base64_value(chunk[2]).unwrap_or(0);
        let fourth = base64_value(chunk[3]).unwrap_or(0);
        decoded.push((first << 2) | (second >> 4));
        if chunk[2] != b'=' {
            decoded.push((second << 4) | (third >> 2));
        }
        if chunk[3] != b'=' {
            decoded.push((third << 6) | fourth);
        }
    }
    debug_assert_eq!(decoded.len(), decoded_len);
    Ok(decoded)
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn emit_load_failure_diagnostic(path: &std::path::Path, error: &str) {
    if LOAD_FAILURE_DIAGNOSTIC_EMITTED
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "token_cost.ui_config_load_failed",
            json!({
                "path": path.to_string_lossy(),
                "error": error,
            }),
        );
    }
}
