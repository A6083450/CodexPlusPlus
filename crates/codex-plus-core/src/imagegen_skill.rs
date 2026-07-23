use std::path::{Path, PathBuf};

const BUNDLED_IMAGEGEN_SKILL: &str = include_str!("../../../assets/skills/imagegen/SKILL.md");
const BUNDLED_IMAGEGEN_MATERIALIZER: &str =
    include_str!("../../../assets/skills/imagegen/scripts/materialize_latest.py");
const BUNDLED_RESPONSES_IMAGEGEN: &str =
    include_str!("../../../assets/skills/imagegen/scripts/responses_image_gen.py");
const BUNDLED_RESPONSES_TRANSPORT: &str =
    include_str!("../../../assets/skills/imagegen/scripts/responses_transport.py");

pub fn bundled_imagegen_skill() -> &'static str {
    BUNDLED_IMAGEGEN_SKILL
}

pub fn bundled_imagegen_materializer_script() -> &'static str {
    BUNDLED_IMAGEGEN_MATERIALIZER
}

pub fn bundled_responses_imagegen_script() -> &'static str {
    BUNDLED_RESPONSES_IMAGEGEN
}

pub fn bundled_responses_transport_script() -> &'static str {
    BUNDLED_RESPONSES_TRANSPORT
}

pub fn install_bundled_imagegen_skill(codex_home: &Path) -> anyhow::Result<PathBuf> {
    let skill_path = codex_home.join("skills/.system/imagegen/SKILL.md");
    crate::settings::atomic_write(&skill_path, BUNDLED_IMAGEGEN_SKILL.as_bytes())?;
    crate::settings::atomic_write(
        &codex_home.join("skills/.system/imagegen/scripts/materialize_latest.py"),
        BUNDLED_IMAGEGEN_MATERIALIZER.as_bytes(),
    )?;
    crate::settings::atomic_write(
        &codex_home.join("skills/.system/imagegen/scripts/responses_image_gen.py"),
        BUNDLED_RESPONSES_IMAGEGEN.as_bytes(),
    )?;
    crate::settings::atomic_write(
        &codex_home.join("skills/.system/imagegen/scripts/responses_transport.py"),
        BUNDLED_RESPONSES_TRANSPORT.as_bytes(),
    )?;
    Ok(skill_path)
}
