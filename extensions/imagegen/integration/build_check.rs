// Build-time contract: upstream merges must not silently remove imagegen hooks.
fn main() {
    let root = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    check_host(&root);
}

pub(crate) fn check_host(root: &std::path::Path) {
    println!("cargo:rerun-if-changed={}", root.join("crates/codex-plus-core/build.rs").display());
    println!("cargo:rerun-if-changed={}", root.join("extensions/imagegen/integration/build_check.rs").display());
    let contract = root.join("extensions/imagegen/integration/hooks.tsv");
    println!("cargo:rerun-if-changed={}", contract.display());
    for line in std::fs::read_to_string(&contract).expect("imagegen contract missing").lines() {
        if line.is_empty() || line.starts_with('#') { continue; }
        let mut parts = line.split('\t');
        let file = parts.next().expect("invalid imagegen contract");
        let marker = parts.next().expect("invalid imagegen contract");
        let path = root.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(content.contains(marker), "imagegen integration missing: {file}: {marker}. See extensions/imagegen/README.md");
        if let Some(count) = parts.next() {
            assert_eq!(content.matches(marker).count(), count.parse::<usize>().expect("invalid hook count"),
                "imagegen host hook count changed: {file}: {marker}");
        }
    }
    let facades = root.join("extensions/imagegen/integration/facades.tsv");
    println!("cargo:rerun-if-changed={}", facades.display());
    for line in std::fs::read_to_string(facades).expect("imagegen facades missing").lines() {
        if line.is_empty() || line.starts_with('#') { continue; }
        let (file, expected) = line.split_once('\t').expect("invalid imagegen facade");
        let path = root.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        let content = std::fs::read_to_string(path).unwrap_or_default().replace("\r\n", "\n");
        assert_eq!(content.trim_end(), expected.replace("\\n", "\n"),
            "imagegen host facade changed: {file}. Keep implementation in extensions/imagegen");
    }
}
