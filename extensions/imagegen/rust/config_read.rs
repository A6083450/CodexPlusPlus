fn configured_image_generation(home: &std::path::Path) -> Option<bool> {
    let text = std::fs::read_to_string(home.join("config.toml")).ok()?;
    let config: toml::Value = toml::from_str(&text).ok()?;
    config.get("features")?.get("image_generation")?.as_bool()
}

fn configured_image_generation_proxy(home: &std::path::Path, settings: &crate::settings::BackendSettings) -> Option<serde_json::Value> {
    if !settings.enhancements_enabled || !settings.active_relay_profile().image_generation_proxy { return None; }
    let (provider, _) = crate::relay_config::live_image_generation_profile(home).ok()??;
    Some(serde_json::json!({"provider": provider, "baseUrl": crate::protocol_proxy::local_responses_proxy_base_url(crate::protocol_proxy::protocol_proxy_port())}))
}
