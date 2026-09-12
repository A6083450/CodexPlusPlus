// Build-time contract: upstream merges must not silently remove imagegen hooks.
fn main() {
    let root = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let contract = root.join("extensions/imagegen/integration/hooks.tsv");
    println!("cargo:rerun-if-changed={}", contract.display());
    for line in std::fs::read_to_string(&contract).expect("imagegen contract missing").lines() {
        if line.is_empty() || line.starts_with('#') { continue; }
        let (file, marker) = line.split_once('\t').expect("invalid imagegen contract");
        let path = root.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(content.contains(marker), "imagegen integration missing: {file}: {marker}. See extensions/imagegen/README.md");
    }
}
