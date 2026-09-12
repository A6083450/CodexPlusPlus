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
