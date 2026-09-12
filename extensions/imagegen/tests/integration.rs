#[test]
fn imagegen_snapshot_and_host_contract_are_intact() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("python3")
        .arg(root.join("extensions/imagegen/sync.py"))
        .arg("--check").arg("--target").arg(&root).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn imagegen_sync_refuses_to_overwrite_local_work_or_accept_missing_hooks() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("python3")
        .arg(root.join("extensions/imagegen/tests/test_sync.py")).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn imagegen_prepares_loaded_threads_before_first_turn() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extensions/imagegen");
    let output = std::process::Command::new("node")
        .arg(root.join("tests/turn-preparation.cjs"))
        .arg(root.join("ui/renderer-runtime.js")).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}
