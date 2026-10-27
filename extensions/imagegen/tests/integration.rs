#[test]
fn imagegen_snapshot_and_host_contract_are_intact() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("python3")
        .arg(root.join("extensions/imagegen/sync.py"))
        .arg("--check").arg("--target").arg(&root).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[allow(dead_code)]
mod host_contract {
    include!("../integration/build_check.rs");
}

#[test]
fn imagegen_build_guard_rejects_changed_facades_and_lost_hook_calls() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let integration = root.join("extensions/imagegen/integration");
    std::fs::create_dir_all(&integration).unwrap();
    std::fs::write(integration.join("hooks.tsv"), "adapter.rs\thook\t2\n").unwrap();
    std::fs::write(integration.join("facades.tsv"), "facade.rs\tcomment\\ndelegate\n").unwrap();
    std::fs::write(root.join("adapter.rs"), "hook\nhook\n").unwrap();
    std::fs::write(root.join("facade.rs"), "comment\r\ndelegate\r\n").unwrap();
    host_contract::check_host(root);
    std::fs::write(root.join("facade.rs"), "delegate\nunexpected implementation\n").unwrap();
    assert!(std::panic::catch_unwind(|| host_contract::check_host(root)).is_err());
    std::fs::write(root.join("facade.rs"), "comment\ndelegate\n").unwrap();
    std::fs::write(root.join("adapter.rs"), "hook\n").unwrap();
    assert!(std::panic::catch_unwind(|| host_contract::check_host(root)).is_err());
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

#[test]
fn imagegen_proxy_images_use_native_preview_items() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extensions/imagegen");
    let output = std::process::Command::new("node")
        .arg(root.join("tests/native-preview.cjs"))
        .arg(root.join("ui/renderer-runtime.js")).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn imagegen_converts_native_image_ingress_before_caching() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extensions/imagegen");
    let output = std::process::Command::new("node")
        .arg(root.join("tests/native-image-ingress.cjs"))
        .arg(root.join("ui/renderer-runtime.js")).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn imagegen_restores_followups_through_native_manager_rpc() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let extension = root.join("extensions/imagegen");
    let output = std::process::Command::new("node")
        .arg(extension.join("tests/native-manager-restore.cjs"))
        .arg(extension.join("ui/renderer-runtime.js"))
        .arg(&root).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn imagegen_opens_raw_tool_images_without_a_native_gallery() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let extension = root.join("extensions/imagegen");
    let output = std::process::Command::new("node")
        .arg(extension.join("tests/native-preview-open.cjs"))
        .arg(extension.join("ui/renderer-runtime.js"))
        .arg(&root).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}
