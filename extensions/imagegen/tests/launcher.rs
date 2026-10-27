    #[tokio::test]
    async fn helper_responses_and_exec_compatibility_preserves_generated_images() {
        use base64::Engine;
        use wiremock::{Mock, MockServer, ResponseTemplate, matchers::method};

        let _log_guard = crate::request_log::request_log_test_guard();
        let _settings_guard = crate::paths::settings_path_test_guard();
        let _home_guard = crate::codex_home::CODEX_HOME_ENV_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let settings_path = temp.path().join("settings.json");
        let log_path = temp.path().join("request-log.jsonl");
        struct Restore {
            settings: Option<PathBuf>,
            home: Option<std::ffi::OsString>,
        }
        impl Drop for Restore {
            fn drop(&mut self) {
                crate::paths::set_settings_path_for_tests(self.settings.take());
                crate::request_log::set_request_log_path_for_tests(None);
                unsafe {
                    match self.home.take() {
                        Some(home) => std::env::set_var("CODEX_HOME", home),
                        None => std::env::remove_var("CODEX_HOME"),
                    }
                }
            }
        }
        let _restore = Restore {
            settings: crate::paths::set_settings_path_for_tests(Some(settings_path.clone())),
            home: std::env::var_os("CODEX_HOME"),
        };
        crate::request_log::set_request_log_path_for_tests(Some(log_path.clone()));
        unsafe { std::env::set_var("CODEX_HOME", temp.path()) };
        let store = SettingsStore::new(settings_path.clone());
        for (exec, streaming, buffered, size) in [
            (false, true, true, 13), (false, true, true, 3 * 1024 * 1024 + 1),
            (true, false, false, 13), (true, true, false, 13), (true, true, false, 3 * 1024 * 1024 + 1),
            (false, false, false, 13), (false, true, false, 13), (false, true, false, 3 * 1024 * 1024 + 1),
        ] {
            let image_bytes = vec![b'x'; size];
            let upstream = MockServer::start().await;
            store
                .save(&BackendSettings {
                    protocol_proxy_auto_retry_mode: if buffered { "buffered" } else { "streaming" }.into(),
                    active_relay_id: format!("exec-images-{exec}-{streaming}-{size}"),
                    relay_profiles: vec![crate::settings::RelayProfile {
                        id: format!("exec-images-{exec}-{streaming}-{size}"),
                        base_url: format!("{}/v1", upstream.uri()),
                        api_key: "fixture-key".into(),
                        relay_mode: crate::settings::RelayMode::PureApi,
                        ..Default::default()
                    }],
                    ..store.load().unwrap()
                })
                .unwrap();
            let response = serde_json::json!({
                "id": "resp_exec_image", "object": "response", "status": "completed",
                "usage": {"input_tokens":111, "output_tokens":22},
                "output": [{"id":format!("ig_{exec}_{streaming}_{size}"), "type":"image_generation_call",
                    "status":"completed", "result":base64::engine::general_purpose::STANDARD.encode(&image_bytes)}]
            });
            let attempts = Arc::new(AtomicUsize::new(0));
            let count = Arc::clone(&attempts);
            let patch = "*** Begin Patch\n+hello\n*** End Patch";
            let patch_event = if exec && streaming {
                format!("event: response.output_item.done\ndata: {}\n\n", serde_json::json!({
                    "type":"response.output_item.done", "output_index":1,
                    "item":{"type":"custom_tool_call", "name":"apply_patch",
                        "input":serde_json::json!({"input":patch}).to_string()}
                }))
            } else { String::new() };
            Mock::given(method("POST"))
                .respond_with(move |_: &wiremock::Request| {
                    let attempt = count.fetch_add(1, Ordering::SeqCst);
                    if exec && attempt == 0 {
                        ResponseTemplate::new(400).set_body_json(serde_json::json!({
                            "error":{"type":"invalid_request_error", "param":"tools[0]",
                                "message":"Unsupported custom tool: 'exec'. Only 'apply_patch' is supported."}
                        }))
                    } else if streaming {
                        ResponseTemplate::new(200)
                            .insert_header("Content-Type", "text/event-stream")
                            .set_body_string(format!("{patch_event}event: response.completed\ndata: {}\n\n", serde_json::json!({
                                "type":"response.completed", "sequence_number":0, "response":response
                            })))
                    } else {
                        ResponseTemplate::new(200).set_body_json(&response)
                    }
                })
                .mount(&upstream)
                .await;
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let helper = tokio::spawn(async move {
                let (socket, remote) = listener.accept().await.unwrap();
                handle_helper_connection(socket, Some(remote))
                    .await
                    .unwrap();
            });
            let mut tools = vec![serde_json::json!({"type":"image_generation"})];
            if exec {
                tools.insert(0, serde_json::json!({"type":"custom", "name":"exec", "format":{"type":"text"}}));
                tools.push(serde_json::json!({"type":"custom", "name":"apply_patch", "format":{"type":"text"}}));
            }
            let response = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .post(format!("http://{address}/v1/responses"))
                .json(&serde_json::json!({
                    "model":"fixture-model", "input":"draw", "stream":streaming,
                    "tools":tools
                }))
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success());
            let body = response.text().await.unwrap();
            helper.await.unwrap();
            assert_eq!(attempts.load(Ordering::SeqCst), if exec { 2 } else { 1 });
            assert!(
                body.contains("已生成图像"),
                "exec={exec}, stream={streaming}, buffered={buffered}, size={size}: {}",
                &body[..body.len().min(500)]
            );
            if exec && streaming {
                let patch_item = body.lines().filter_map(|line| {
                    serde_json::from_str::<serde_json::Value>(line.strip_prefix("data:")?.trim()).ok()
                }).find(|event| event.pointer("/item/name").and_then(serde_json::Value::as_str) == Some("apply_patch"))
                    .expect("apply_patch event");
                assert_eq!(patch_item["item"]["input"], patch);
            }
            let logs = crate::request_log::read_request_logs_at(&log_path, 1).unwrap();
            let logged = &logs[0];
            assert!(logged.success, "{logged:?}");
            if size == 13 {
                let usage = logged.usage.as_ref().expect("response usage");
                assert_eq!((usage.input_tokens, usage.output_tokens), (111, 22));
            }
            if streaming {
                assert!(logged.first_token_ms.is_some(), "{logged:?}");
            }
            let assets = std::fs::read_dir(temp.path().join("generated_images/response-assets"))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            assert!(
                assets
                    .iter()
                    .any(|path| std::fs::read(path).unwrap() == image_bytes)
            );
        }
    }
