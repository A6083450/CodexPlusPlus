use std::path::{Path, PathBuf};

const BUNDLED_IMAGEGEN_SKILL: &str = include_str!("../../../assets/skills/imagegen/SKILL.md");
const BUNDLED_IMAGEGEN_MATERIALIZER: &str =
    include_str!("../../../assets/skills/imagegen/scripts/materialize_latest.py");
const BUNDLED_RESPONSES_IMAGEGEN: &str =
    include_str!("../../../assets/skills/imagegen/scripts/responses_image_gen.py");
const BUNDLED_RESPONSES_TRANSPORT: &str =
    include_str!("../../../assets/skills/imagegen/scripts/responses_transport.py");

const BUNDLED_IMAGEGEN_FILES: &[(&str, &[u8])] = &[
    ("SKILL.md", BUNDLED_IMAGEGEN_SKILL.as_bytes()),
    (
        "LICENSE.txt",
        include_bytes!("../../../assets/skills/imagegen/LICENSE.txt"),
    ),
    (
        "agents/openai.yaml",
        include_bytes!("../../../assets/skills/imagegen/agents/openai.yaml"),
    ),
    (
        "assets/imagegen-small.svg",
        include_bytes!("../../../assets/skills/imagegen/assets/imagegen-small.svg"),
    ),
    (
        "assets/imagegen.png",
        include_bytes!("../../../assets/skills/imagegen/assets/imagegen.png"),
    ),
    (
        "references/cli.md",
        include_bytes!("../../../assets/skills/imagegen/references/cli.md"),
    ),
    (
        "references/codex-network.md",
        include_bytes!("../../../assets/skills/imagegen/references/codex-network.md"),
    ),
    (
        "references/image-api.md",
        include_bytes!("../../../assets/skills/imagegen/references/image-api.md"),
    ),
    (
        "references/prompting.md",
        include_bytes!("../../../assets/skills/imagegen/references/prompting.md"),
    ),
    (
        "references/sample-prompts.md",
        include_bytes!("../../../assets/skills/imagegen/references/sample-prompts.md"),
    ),
    (
        "scripts/image_gen.py",
        include_bytes!("../../../assets/skills/imagegen/scripts/image_gen.py"),
    ),
    (
        "scripts/materialize_latest.py",
        BUNDLED_IMAGEGEN_MATERIALIZER.as_bytes(),
    ),
    (
        "scripts/remove_chroma_key.py",
        include_bytes!("../../../assets/skills/imagegen/scripts/remove_chroma_key.py"),
    ),
    (
        "scripts/responses_image_gen.py",
        BUNDLED_RESPONSES_IMAGEGEN.as_bytes(),
    ),
    (
        "scripts/responses_transport.py",
        BUNDLED_RESPONSES_TRANSPORT.as_bytes(),
    ),
];

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImagegenSkillStatus {
    pub skill_dir: PathBuf,
    pub skill_file: PathBuf,
    pub covered: bool,
    pub missing_files: Vec<String>,
    pub changed_files: Vec<String>,
}

pub fn bundled_imagegen_skill_status(codex_home: &Path) -> ImagegenSkillStatus {
    let skill_dir = codex_home.join("skills/.system/imagegen");
    let skill_file = skill_dir.join("SKILL.md");
    let mut missing_files = Vec::new();
    let mut changed_files = Vec::new();

    for (relative_path, contents) in BUNDLED_IMAGEGEN_FILES {
        let local_path = skill_dir.join(relative_path);
        match std::fs::read(&local_path) {
            Ok(local_contents) if local_contents == *contents => {}
            Ok(_) => changed_files.push((*relative_path).to_string()),
            Err(_) if local_path.exists() => changed_files.push((*relative_path).to_string()),
            Err(_) => missing_files.push((*relative_path).to_string()),
        }
    }

    ImagegenSkillStatus {
        skill_dir,
        skill_file,
        covered: missing_files.is_empty() && changed_files.is_empty(),
        missing_files,
        changed_files,
    }
}

pub fn install_bundled_imagegen_skill(codex_home: &Path) -> anyhow::Result<PathBuf> {
    let skill_dir = codex_home.join("skills/.system/imagegen");
    for (relative_path, contents) in BUNDLED_IMAGEGEN_FILES {
        crate::settings::atomic_write(&skill_dir.join(relative_path), contents)?;
    }
    Ok(skill_dir.join("SKILL.md"))
}
