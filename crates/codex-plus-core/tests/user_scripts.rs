use codex_plus_core::user_scripts::UserScriptManager;
use serde_json::Value;
use tempfile::tempdir;

const SCRIPT_KEY: &str = "user:market-codex-ds-style-cost.js";

fn script_with_header(version: &str) -> String {
    format!(
        "// ==UserScript==\n// @name         DS Style Cost\n// @version      {version}\n// ==/UserScript==\n(() => {{}})();\n"
    )
}

fn manager_with_installed_script(
    script_source: &str,
    market_version: Option<&str>,
) -> (tempfile::TempDir, UserScriptManager) {
    let dir = tempdir().unwrap();
    let builtin_dir = dir.path().join("builtin");
    let user_dir = dir.path().join("user");
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(
        user_dir.join("market-codex-ds-style-cost.js"),
        script_source,
    )
    .unwrap();
    let market = market_version.map(|version| {
        format!(
            r#"    "{SCRIPT_KEY}": {{
      "id": "codex-live-token-cost",
      "name": "Codex Live Token Cost",
      "version": "{version}",
      "script_url": "https://example.com/codex-live-token-cost.js",
      "homepage": "",
      "installed_at": "1786672754"
    }}"#
        )
    });
    let config = format!(
        r#"{{
  "enabled": true,
  "scripts": {{"{SCRIPT_KEY}": true}},
  "market": {{
{}
  }}
}}"#,
        market.unwrap_or_default()
    );
    std::fs::write(dir.path().join("user_scripts.json"), config).unwrap();
    let manager =
        UserScriptManager::new(builtin_dir, user_dir, dir.path().join("user_scripts.json"));
    (dir, manager)
}

fn inventory_version(manager: &UserScriptManager) -> String {
    let inventory = manager.inventory().expect("inventory should build");
    inventory["scripts"]
        .as_array()
        .expect("scripts should be an array")
        .iter()
        .find_map(|script| {
            (script["key"] == Value::String(SCRIPT_KEY.to_string()))
                .then(|| script["version"].as_str().unwrap_or("").to_string())
        })
        .unwrap_or_default()
}

#[test]
fn inventory_version_prefers_script_header_over_market_snapshot() {
    let (_dir, manager) =
        manager_with_installed_script(&script_with_header("1.0.0"), Some("0.7.2"));
    assert_eq!(inventory_version(&manager), "1.0.0");
}

#[test]
fn inventory_version_falls_back_to_market_snapshot_without_header() {
    let (_dir, manager) = manager_with_installed_script("(() => {})();", Some("0.7.2"));
    assert_eq!(inventory_version(&manager), "0.7.2");
}

#[test]
fn inventory_version_is_empty_without_header_or_snapshot() {
    let (_dir, manager) = manager_with_installed_script("(() => {})();", None);
    assert_eq!(inventory_version(&manager), "");
}
