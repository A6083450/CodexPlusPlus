pub fn renderer_script() -> &'static str {
    static COMPOSED: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        const IMAGEGEN_RENDERER_EXTENSION: &str = include_str!("../ui/renderer-runtime.js");
        const SLOT: &str = "  /* @codex-imagegen:runtime */\n\n";
        assert_eq!(RENDERER_SCRIPT.matches(SLOT).count(), 1, "imagegen integration slot missing or duplicated");
        RENDERER_SCRIPT.replace(SLOT, IMAGEGEN_RENDERER_EXTENSION)
    });
    &COMPOSED
}
