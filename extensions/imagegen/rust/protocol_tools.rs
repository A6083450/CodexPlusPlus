fn image_generation_settings_for_request(
    settings: &crate::settings::BackendSettings,
    home: &std::path::Path,
) -> anyhow::Result<Option<crate::settings::BackendSettings>> {
    if settings.relay_profiles_enabled || !settings.enhancements_enabled
        || !settings.active_relay_profile().image_generation_proxy
        { return Ok(None); }
    let Some((_, profile)) = crate::relay_config::live_image_generation_profile(home)? else { return Ok(None); };
    let mut effective = settings.clone();
    effective.active_relay_id = profile.id.clone();
    effective.relay_profiles = vec![profile];
    effective.active_aggregate_relay_id.clear();
    effective.relay_profiles_enabled = true;
    Ok(Some(effective))
}

fn normalize_image_generation_tools(body: &mut Value) {
    let image_model = body.get("model").and_then(Value::as_str)
        .is_some_and(|model| model.trim().to_ascii_lowercase().starts_with("gpt-image-"));
    let additional_tools = body.get("input").and_then(Value::as_array).into_iter().flatten()
        .filter(|item| item["type"] == "additional_tools")
        .filter_map(|item| item["tools"].as_array());
    let hosted = body.get("tools").and_then(Value::as_array).into_iter()
        .chain(additional_tools).flatten().any(|tool| tool["type"] == "image_generation");
    if !image_model && !hosted {
        return;
    }
    if image_model && !hosted {
        if matches!(body.get("tools"), None | Some(Value::Null)) {
            body["tools"] = json!([]);
        }
        if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
            tools.push(json!({"type": "image_generation"}));
        }
    }
    // 托管生图占用 image_gen.imagegen；Code Mode 的 additional_tools 也必须清理。
    let strip_conflicting = |tools: &mut Vec<Value>| {
        for tool in tools.iter_mut() {
            if tool["type"] == "namespace" && tool["name"] == "image_gen" {
                if let Some(children) = tool.get_mut("tools").and_then(Value::as_array_mut) {
                    children.retain(|child| !(child["type"] == "function" && child["name"] == "imagegen"));
                }
            }
        }
        tools.retain(|tool| {
            !(tool["type"] == "function" && tool["name"] == "image_gen.imagegen")
                && !(tool["type"] == "namespace" && tool["name"] == "image_gen"
                    && tool["tools"].as_array().is_some_and(Vec::is_empty))
        });
    };
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        strip_conflicting(tools);
    }
    for item in body.get_mut("input").and_then(Value::as_array_mut).into_iter().flatten() {
        if item["type"] == "additional_tools" {
            if let Some(tools) = item.get_mut("tools").and_then(Value::as_array_mut) {
                strip_conflicting(tools);
            }
        }
    }
    if body["tool_choice"]["type"] == "function"
        && (body["tool_choice"]["name"] == "image_gen.imagegen"
            || (body["tool_choice"]["namespace"] == "image_gen"
                && body["tool_choice"]["name"] == "imagegen"))
    {
        body["tool_choice"] = json!({"type": "image_generation"});
    }
}

#[cfg(test)]
mod image_generation_live_config_tests {
    use super::*;

    #[test]
    fn image_session_uses_live_credentials_without_managing_provider_files() {
        let home = tempfile::tempdir().unwrap();
        let config = "model = \"gpt-6\"\nmodel_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://live.example/v1\"\nwire_api = \"responses\"\nexperimental_bearer_token = \"provider-key\"\n";
        std::fs::write(home.path().join("config.toml"), config).unwrap();
        let auth = r#"{"OPENAI_API_KEY":"stale-auth-key"}"#;
        std::fs::write(home.path().join("auth.json"), auth).unwrap();
        let settings = crate::settings::BackendSettings { relay_profiles_enabled: false, enhancements_enabled: true, ..Default::default() };
        let effective = image_generation_settings_for_request(&settings, home.path()).unwrap().unwrap();
        let profile = effective.active_relay_profile();
        assert_eq!(profile.base_url, "https://live.example/v1");
        assert_eq!(crate::relay_config::relay_profile_api_key(&profile), "provider-key");
        assert_eq!(std::fs::read_to_string(home.path().join("config.toml")).unwrap(), config);
        assert_eq!(std::fs::read_to_string(home.path().join("auth.json")).unwrap(), auth);
        let managed = crate::settings::BackendSettings { relay_profiles_enabled: true, ..settings.clone() };
        assert!(image_generation_settings_for_request(&managed, home.path()).unwrap().is_none());
        let mut disabled = settings;
        disabled.relay_profiles = vec![crate::settings::RelayProfile { image_generation_proxy: false, ..Default::default() }];
        disabled.active_relay_id = disabled.relay_profiles[0].id.clone();
        assert!(image_generation_settings_for_request(&disabled, home.path()).unwrap().is_none());
    }

    #[test]
    fn live_image_proxy_preserves_native_credential_selection() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("auth.json"), r#"{"OPENAI_API_KEY":"unrelated-key"}"#).unwrap();
        let base = "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://live.example/v1\"\nrequires_openai_auth = false\n";
        std::fs::write(home.path().join("config.toml"), base).unwrap();
        let (_, profile) = crate::relay_config::live_image_generation_profile(home.path()).unwrap().unwrap();
        assert!(profile.no_auth);
        assert!(crate::relay_config::relay_profile_api_key(&profile).is_empty());
        std::fs::write(home.path().join("config.toml"), format!("{base}env_key = \"PATH\"\nexperimental_bearer_token = \"old-key\"\n")).unwrap();
        let (_, profile) = crate::relay_config::live_image_generation_profile(home.path()).unwrap().unwrap();
        assert_eq!(crate::relay_config::relay_profile_api_key(&profile), std::env::var("PATH").unwrap());
        let missing = format!("CODEX_PLUS_MISSING_KEY_{}", uuid::Uuid::new_v4().simple());
        std::fs::write(home.path().join("config.toml"), format!("{base}env_key = \"{missing}\"\nexperimental_bearer_token = \"old-key\"\n")).unwrap();
        assert!(crate::relay_config::live_image_generation_profile(home.path()).is_err());
    }

    #[test]
    fn live_image_proxy_keeps_headers_and_excludes_unsupported_or_recursive_transports() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.toml");
        let base = "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://live.example/v1\"\nhttp_headers = { X-API-Key = \"header-key\", X-Tenant = \"tenant\" }\n";
        std::fs::write(&path, base).unwrap();
        let (_, profile) = crate::relay_config::live_image_generation_profile(home.path()).unwrap().unwrap();
        assert!(profile.no_auth);
        assert_eq!(profile.custom_headers.len(), 2);
        assert!(profile.custom_headers.iter().any(|header| header.key == "X-API-Key" && header.value == "header-key"));
        for field in ["query_params = { api_version = \"v1\" }", "auth = { command = \"test\" }"] {
            std::fs::write(&path, format!("{base}{field}\n")).unwrap();
            assert!(crate::relay_config::live_image_generation_profile(home.path()).unwrap().is_none());
        }
        for host in ["127.0.0.1", "localhost", "[::1]"] {
            let url = format!("http://{host}:{}/v1", crate::protocol_proxy::protocol_proxy_port());
            std::fs::write(&path, base.replace("https://live.example/v1", &url)).unwrap();
            assert!(crate::relay_config::live_image_generation_profile(home.path()).unwrap().is_none());
        }
        let port = if crate::protocol_proxy::protocol_proxy_port() == 63392 { 63393 } else { 63392 };
        std::fs::write(&path, base.replace("https://live.example/v1", &format!("http://localhost:{port}/v1"))).unwrap();
        assert!(crate::relay_config::live_image_generation_profile(home.path()).unwrap().is_some());
        std::fs::write(&path, "model_provider = \"openai\"\n").unwrap();
        let settings = crate::settings::BackendSettings { relay_profiles_enabled: false, enhancements_enabled: true, ..Default::default() };
        assert!(image_generation_settings_for_request(&settings, home.path()).unwrap().is_none());
    }
}
