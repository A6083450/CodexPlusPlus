use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 17888;
const HELPER_DIR_NAME: &str = "codex-token-cost-helper";
const HELPER_SCRIPT_NAME: &str = "codex-local-usage-helper.cjs";

/// Starts the optional CC Switch bridge when the packaged helper is available.
///
/// The bridge is intentionally best-effort: local capture and the Rust helper remain usable if
/// Node.js is unavailable or the bundled script cannot be started.
pub fn ensure_started() {
    #[cfg(any(target_os = "macos", windows))]
    ensure_started_on_supported_platform();
}

#[cfg(any(target_os = "macos", windows))]
fn ensure_started_on_supported_platform() {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DEFAULT_PORT);
    if TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() {
        return;
    }

    let Some(resource_dir) = current_helper_resource_dir() else {
        return;
    };
    let script = resource_dir.join(HELPER_SCRIPT_NAME);
    if !script.is_file() {
        return;
    }

    #[cfg(target_os = "macos")]
    let spawn_result = Command::new("/bin/sh")
        .arg(resource_dir.join("start-helper.sh"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    #[cfg(windows)]
    let spawn_result = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(resource_dir.join("start-helper.ps1"))
        .creation_flags(crate::windows_create_no_window())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    match spawn_result {
        Ok(_) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "token_cost_helper.start_requested",
                serde_json::json!({
                    "port": DEFAULT_PORT,
                    "script": script.to_string_lossy(),
                }),
            );
        }
        Err(error) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "token_cost_helper.start_failed",
                serde_json::json!({
                    "port": DEFAULT_PORT,
                    "script": script.to_string_lossy(),
                    "message": error.to_string(),
                }),
            );
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
fn current_helper_resource_dir() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok();
    let candidates = executable
        .as_deref()
        .map(resource_dirs_from_exe)
        .unwrap_or_default();
    candidates
        .into_iter()
        .find(|dir| dir.join(HELPER_SCRIPT_NAME).is_file())
}

#[cfg(any(target_os = "macos", windows))]
fn resource_dirs_from_exe(exe: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(exe_dir) = exe.parent() {
        if let Some(contents_dir) = exe_dir.parent() {
            candidates.push(contents_dir.join("Resources").join(HELPER_DIR_NAME));
            if let Some(app_bundle) = contents_dir.parent() {
                if let Some(applications_dir) = app_bundle.parent() {
                    candidates.push(
                        applications_dir
                            .join("Codex++ 管理工具.app")
                            .join("Contents")
                            .join("Resources")
                            .join(HELPER_DIR_NAME),
                    );
                }
            }
        }
    }

    let is_test_binary = exe
        .components()
        .any(|component| component.as_os_str() == "deps");
    if !is_test_binary {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("scripts"),
        );
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::resource_dirs_from_exe;
    use std::path::Path;

    #[test]
    fn packaged_silent_app_finds_the_companion_manager_resources() {
        let executable = Path::new("/Applications/Codex++.app/Contents/MacOS/CodexPlusPlus");
        let candidates = resource_dirs_from_exe(executable);

        assert!(candidates.iter().any(|path| {
            path == Path::new(
                "/Applications/Codex++ 管理工具.app/Contents/Resources/codex-token-cost-helper",
            )
        }));
    }
}
