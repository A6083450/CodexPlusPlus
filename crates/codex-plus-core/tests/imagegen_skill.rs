use codex_plus_core::imagegen_skill::{
    bundled_imagegen_materializer_script, bundled_imagegen_skill, bundled_imagegen_skill_status,
    bundled_responses_imagegen_script, bundled_responses_transport_script,
    install_bundled_imagegen_skill,
};
use serde_json::json;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TEST_IMAGE_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nresponses-image";

fn python_command() -> &'static str {
    if cfg!(windows) { "python" } else { "python3" }
}

#[test]
fn bundled_skill_contains_durable_delivery_contract() {
    let skill = bundled_imagegen_skill();

    assert!(skill.contains("Built-in chat-delivery contract:"));
    assert!(skill.contains("generatedImage(result)"));
    assert!(skill.contains("exactly one inline image"));
    assert!(skill.contains("[打开原图](/absolute/path/image.png)"));
    assert!(skill.contains("Never scan directories"));
    assert!(skill.contains("modification time, filename similarity, directory order"));
    assert!(skill.contains("do not add Markdown image syntax"));
    assert!(!skill.contains(
        "a normal successful turn must contain both the forwarded image output and an absolute-path Markdown image"
    ));
}

#[test]
fn bundled_skill_keeps_top_level_image_generation_available() {
    let skill = bundled_imagegen_skill();

    assert!(skill.contains("Call the top-level `image_gen` tool directly when it is available"));
    assert!(skill.contains(
        "Do not use `functions.exec`, `ALL_TOOLS`, or the nested tool catalog to decide"
    ));
    assert!(!skill.contains("tools.image_gen__imagegen"));
    assert!(skill.contains("CODEX_THREAD_ID"));
    assert!(skill.contains("materialize_latest.py"));
    assert!(skill.contains("--snapshot"));
    assert!(skill.contains("--after-snapshot"));
}

#[test]
fn bundled_skill_routes_generation_to_configured_responses_helper() {
    let skill = bundled_imagegen_skill();

    assert!(skill.contains("responses_image_gen.py"));
    assert!(skill.contains("--prompt"));
    assert!(skill.contains("--out"));
}

#[test]
fn bundled_materializer_uses_exact_thread_and_generation_ids() {
    let script = bundled_imagegen_materializer_script();

    assert!(script.contains("CODEX_THREAD_ID"));
    assert!(script.contains("image_generation_call"));
    assert!(script.contains("--after-id"));
    assert!(!script.contains("getmtime"));
}

#[test]
fn install_bundled_imagegen_skill_creates_expected_path() {
    let temp = tempfile::tempdir().unwrap();

    let installed_path = install_bundled_imagegen_skill(temp.path()).unwrap();

    assert_eq!(
        installed_path,
        temp.path().join("skills/.system/imagegen/SKILL.md")
    );
    assert_eq!(
        std::fs::read_to_string(installed_path).unwrap(),
        bundled_imagegen_skill()
    );
    assert_eq!(
        std::fs::read_to_string(
            temp.path()
                .join("skills/.system/imagegen/scripts/materialize_latest.py")
        )
        .unwrap(),
        bundled_imagegen_materializer_script()
    );
    assert_eq!(
        std::fs::read_to_string(
            temp.path()
                .join("skills/.system/imagegen/scripts/responses_image_gen.py")
        )
        .unwrap(),
        bundled_responses_imagegen_script()
    );
    assert_eq!(
        std::fs::read_to_string(
            temp.path()
                .join("skills/.system/imagegen/scripts/responses_transport.py")
        )
        .unwrap(),
        bundled_responses_transport_script()
    );
}

#[test]
fn install_bundled_imagegen_skill_overwrites_stale_content() {
    let temp = tempfile::tempdir().unwrap();
    let skill_path = temp.path().join("skills/.system/imagegen/SKILL.md");
    std::fs::create_dir_all(skill_path.parent().unwrap()).unwrap();
    std::fs::write(&skill_path, "stale imagegen skill\n").unwrap();

    install_bundled_imagegen_skill(temp.path()).unwrap();

    assert_eq!(
        std::fs::read_to_string(skill_path).unwrap(),
        bundled_imagegen_skill()
    );
}

#[test]
fn bundled_imagegen_skill_status_reports_missing_files_before_install() {
    let temp = tempfile::tempdir().unwrap();

    let status = bundled_imagegen_skill_status(temp.path());

    assert!(!status.covered);
    assert_eq!(
        status.skill_dir,
        temp.path().join("skills/.system/imagegen")
    );
    assert_eq!(
        status.skill_file,
        temp.path().join("skills/.system/imagegen/SKILL.md")
    );
    assert!(status.missing_files.contains(&"SKILL.md".to_string()));
    assert!(status.changed_files.is_empty());
}

#[test]
fn bundled_imagegen_skill_status_reports_covered_after_manual_install() {
    let temp = tempfile::tempdir().unwrap();

    install_bundled_imagegen_skill(temp.path()).unwrap();
    let status = bundled_imagegen_skill_status(temp.path());

    assert!(status.covered);
    assert!(status.missing_files.is_empty());
    assert!(status.changed_files.is_empty());
}

#[test]
fn bundled_imagegen_skill_status_reports_changed_files() {
    let temp = tempfile::tempdir().unwrap();
    install_bundled_imagegen_skill(temp.path()).unwrap();
    std::fs::write(
        temp.path()
            .join("skills/.system/imagegen/scripts/responses_transport.py"),
        "changed transport\n",
    )
    .unwrap();

    let status = bundled_imagegen_skill_status(temp.path());

    assert!(!status.covered);
    assert!(status.missing_files.is_empty());
    assert_eq!(
        status.changed_files,
        vec!["scripts/responses_transport.py".to_string()]
    );
}

#[tokio::test]
async fn responses_helper_streams_active_provider_when_builtin_tool_is_unavailable() {
    // Given: a Codex home configured for a Responses provider and API-key auth.
    let server = MockServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join("codex-home");
    let script_path = temp.path().join("responses_image_gen.py");
    let output_path = temp.path().join("generated/pearl-river.png");
    std::fs::create_dir_all(&codex_home).unwrap();
    std::fs::write(&script_path, bundled_responses_imagegen_script()).unwrap();
    std::fs::write(
        temp.path().join("responses_transport.py"),
        bundled_responses_transport_script(),
    )
    .unwrap();
    std::fs::write(
        codex_home.join("config.toml"),
        format!(
            r#"model = "test-main-model"
model_provider = "relay"

[model_providers.relay]
base_url = "{}/v1"
wire_api = "responses"
requires_openai_auth = true

[model_providers.relay.http_headers]
x-codex-plus-test = "enabled"
"#,
            server.uri()
        ),
    )
    .unwrap();
    std::fs::write(
        codex_home.join("auth.json"),
        r#"{"OPENAI_API_KEY":"test-secret-key"}"#,
    )
    .unwrap();
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .and(header("authorization", "Bearer test-secret-key"))
        .and(header("accept", "text/event-stream"))
        .and(header("x-codex-plus-test", "enabled"))
        .and(body_partial_json(json!({
            "model": "test-main-model",
            "input": "Generate Guangzhou Pearl River at night",
            "stream": true,
            "tools": [{"type": "image_generation", "action": "generate"}]
        })))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(
                format!(
                    "event: response.created\ndata: {{\"type\":\"response.created\"}}\n\nevent: response.completed\ndata: {}\n\n",
                    json!({
                        "type": "response.completed",
                        "response": {
                            "id": "resp_test",
                            "output": [{
                                "id": "ig_test",
                                "type": "image_generation_call",
                                "status": "completed",
                                "result": base64::Engine::encode(
                                    &base64::engine::general_purpose::STANDARD,
                                    TEST_IMAGE_BYTES,
                                )
                            }]
                        }
                    })
                ),
                "text/event-stream",
            ),
        )
        .expect(1)
        .mount(&server)
        .await;

    // When: the bundled helper generates through the active provider.
    let result = tokio::process::Command::new(python_command())
        .arg(&script_path)
        .arg("--codex-home")
        .arg(&codex_home)
        .arg("--prompt")
        .arg("Generate Guangzhou Pearl River at night")
        .arg("--out")
        .arg(&output_path)
        .output()
        .await
        .unwrap();

    // Then: the exact returned image is saved and credentials stay out of output.
    assert!(
        result.status.success(),
        "helper failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(std::fs::read(&output_path).unwrap(), TEST_IMAGE_BYTES);
    let stdout = String::from_utf8(result.stdout).unwrap();
    let summary: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(summary["status"], "completed");
    assert_eq!(
        std::fs::canonicalize(summary["path"].as_str().unwrap()).unwrap(),
        output_path.canonicalize().unwrap()
    );
    assert!(!stdout.contains("test-secret-key"));
}
