impl RelayProfile {
    pub fn image_generation_uses_protocol_proxy(&self) -> bool {
        self.image_generation_proxy
            && self.protocol == RelayProtocol::Responses
            && (self.relay_mode != RelayMode::Official || self.official_mix_api_key)
            && self.has_image_generation_models()
    }

    pub(crate) fn has_image_generation_models(&self) -> bool {
        self.model_list.lines()
            .chain(std::iter::once(crate::relay_config::relay_profile_model(self).as_str()))
            .any(|model| model.trim().to_ascii_lowercase().starts_with("gpt-image-"))
    }
}
