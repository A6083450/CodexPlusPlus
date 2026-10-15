pub(crate) fn live_image_generation_profile(home: &std::path::Path) -> anyhow::Result<Option<(String, RelayProfile)>> {
    let config = read_optional_text(&home.join("config.toml"))?;
    let doc = parse_toml_document(&config)?;
    let provider = doc.get("model_provider").and_then(toml_edit::Item::as_str).unwrap_or("openai");
    if provider == "openai" { return Ok(None); }
    let Some(transport) = doc.get("model_providers").and_then(|v| v.get(provider)) else { return Ok(None); };
    if transport.get("wire_api").and_then(toml_edit::Item::as_str).unwrap_or("responses") != "responses" { return Ok(None); }
    if transport.get("auth").is_some() || transport.get("query_params").is_some() { return Ok(None); }
    let base_url = transport.get("base_url").and_then(toml_edit::Item::as_str).unwrap_or_default();
    if base_url.is_empty() { return Ok(None); }
    let endpoint = reqwest::Url::parse(base_url)?;
    let loopback = endpoint.host_str().is_some_and(|host| host.eq_ignore_ascii_case("localhost")
        || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()));
    if !matches!(endpoint.scheme(), "http" | "https")
        || (loopback && endpoint.port_or_known_default() == Some(crate::protocol_proxy::protocol_proxy_port())) { return Ok(None); }
    let auth = read_optional_text(&home.join("auth.json"))?;
    let requires_auth = transport.get("requires_openai_auth").and_then(toml_edit::Item::as_bool).unwrap_or(false);
    let api_key = if let Some(key) = transport.get("env_key").and_then(toml_edit::Item::as_str) {
        let value = std::env::var(key).map_err(|_| anyhow::anyhow!("生图供应商所需环境变量未设置：{key}"))?;
        anyhow::ensure!(!value.trim().is_empty(), "生图供应商所需环境变量为空：{key}");
        value
    } else {
        experimental_bearer_token_from_config(&config)?
            .or_else(|| requires_auth.then(|| codex_auth_api_key(&auth)).flatten()).unwrap_or_default()
    };
    if requires_auth && api_key.is_empty() { return Ok(None); }
    let mut headers = std::collections::BTreeMap::new();
    for (field, from_env) in [("http_headers", false), ("env_http_headers", true)] {
        if let Some(table) = transport.get(field).and_then(toml_edit::Item::as_table_like) {
            for (key, value) in table.iter() {
                let Some(value) = value.as_str() else { continue; };
                let value = if from_env { std::env::var(value).ok() } else { Some(value.to_string()) };
                if let Some(value) = value {
                    if key.eq_ignore_ascii_case("authorization") && !api_key.is_empty() { continue; }
                    headers.insert(key.to_ascii_lowercase(), crate::settings::RelayHeaderKeyValue { key: key.to_string(), value });
                }
            }
        }
    }
    let custom_headers = headers.into_values().collect::<Vec<_>>();
    crate::relay_headers::validate(&custom_headers)?;
    let profile = RelayProfile {
        id: "codex-plus-live-imagegen".to_string(), name: "当前 Codex 生图配置".to_string(),
        relay_mode: crate::settings::RelayMode::PureApi,
        base_url: base_url.to_string(), upstream_base_url: base_url.to_string(),
        no_auth: api_key.is_empty(), custom_headers,
        // 固定本次解析出的有效凭据，避免旧 config token 再次盖过 env_key。
        auth_contents: serde_json::json!({"OPENAI_API_KEY": api_key}).to_string(),
        api_key, config_contents: config.clone(),
        ..RelayProfile::default()
    };
    Ok(Some((provider.to_string(), profile)))
}

fn apply_image_generation_compatibility(profile: &RelayProfile, config_text: &str) -> anyhow::Result<String> {
    if profile.image_generation_proxy
        || profile.protocol != RelayProtocol::Responses
        || (profile.relay_mode == crate::settings::RelayMode::Official && !profile.official_mix_api_key)
        || !profile.has_image_generation_models()
    {
        return Ok(config_text.to_string());
    }
    // 直连图片模型由上游提供托管生图；关闭客户端同名函数，避免 image_gen.imagegen 冲突。
    // 必须在公共配置合并后执行，否则 image_generation = true 会重新开启重复声明。
    let mut doc = parse_toml_document(&config_text)?;
    table_mut_or_insert(&mut doc, "features")?["image_generation"] = toml_edit::value(false);
    Ok(normalize_optional_toml(doc))
}
