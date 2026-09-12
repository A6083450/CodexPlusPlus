fn configured_image_generation(home: &std::path::Path) -> Option<bool> {
    let text = std::fs::read_to_string(home.join("config.toml")).ok()?;
    let config: toml::Value = toml::from_str(&text).ok()?;
    config.get("features")?.get("image_generation")?.as_bool()
}
