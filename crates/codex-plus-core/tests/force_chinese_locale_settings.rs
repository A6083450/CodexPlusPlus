use codex_plus_core::assets::{force_chinese_locale_config, injection_script_with_settings};
use codex_plus_core::settings::BackendSettings;
use std::io::Write;
use std::process::Command;

#[test]
fn force_chinese_locale_defaults_to_true() {
    let settings = BackendSettings::default();
    assert!(settings.codex_app_force_chinese_locale);
    assert!(!settings.codex_app_fast_startup);

    let json = serde_json::to_value(&settings).expect("serialize default settings");
    assert_eq!(
        json.get("codexAppForceChineseLocale")
            .and_then(|v| v.as_bool()),
        Some(true),
        "default BackendSettings JSON should include codexAppForceChineseLocale = true"
    );
    assert_eq!(
        json.get("codexAppFastStartup").and_then(|v| v.as_bool()),
        Some(false),
        "default BackendSettings JSON should include codexAppFastStartup = false"
    );
}

#[test]
fn force_chinese_locale_missing_from_old_json_defaults_to_true() {
    let json = serde_json::json!({
        "codexAppPath": "",
        "enhancementsEnabled": true,
    });

    let parsed: BackendSettings = serde_json::from_value(json)
        .expect("old settings JSON without codexAppForceChineseLocale should still load");
    assert!(parsed.codex_app_force_chinese_locale);
    assert!(!parsed.codex_app_fast_startup);
}

#[test]
fn force_chinese_locale_false_round_trips_through_json() {
    let mut settings = BackendSettings::default();
    settings.codex_app_force_chinese_locale = false;

    let json = serde_json::to_value(&settings).expect("serialize");
    assert_eq!(
        json.get("codexAppForceChineseLocale")
            .and_then(|v| v.as_bool()),
        Some(false)
    );

    let parsed: BackendSettings =
        serde_json::from_value(json).expect("deserialize codexAppForceChineseLocale");
    assert!(!parsed.codex_app_force_chinese_locale);
}

#[test]
fn force_chinese_locale_config_reflects_setting() {
    let mut settings = BackendSettings::default();
    assert_eq!(
        force_chinese_locale_config(&settings),
        serde_json::json!({ "enabled": true, "locale": "zh-CN" })
    );

    settings.codex_app_force_chinese_locale = false;
    assert_eq!(
        force_chinese_locale_config(&settings),
        serde_json::json!({ "enabled": false, "locale": "zh-CN" })
    );
}

#[test]
fn injection_script_includes_force_chinese_locale_global_and_patch() {
    let mut settings = BackendSettings::default();
    settings.codex_app_force_chinese_locale = true;
    settings.codex_app_fast_startup = true;
    let script = injection_script_with_settings(0, &settings);
    assert!(script.contains(
        "window.__CODEX_PLUS_FORCE_CHINESE_LOCALE__ = {\"enabled\":true,\"locale\":\"zh-CN\"};"
    ));
    assert!(script.contains(
        "window.__CODEX_PLUS_FAST_STARTUP__ = {\"enabled\":true,\"statsigTimeoutMs\":800};"
    ));
    assert!(script.contains("__codexPlusForceChineseLocaleInstalled"));
    assert!(script.contains("__codexPlusFastStartupInstalled"));
    assert!(script.contains("72216192"));
    assert!(script.contains("enable_i18n"));
    assert!(script.contains("locale_source"));
    assert!(script.contains("vscode://codex/${method}"));
    assert!(script.contains("\"get-setting\""));
    assert!(script.contains("\"set-setting\""));
    assert!(script.contains("{ key: \"localeOverride\", value: locale }"));
    assert!(script.contains("window.location.reload()"));
    assert!(script.contains("codexPlus.forceChineseLocale.managed.v1"));
    assert!(!script.contains("setItem(\"localeOverride\""));

    settings.codex_app_force_chinese_locale = false;
    let script = injection_script_with_settings(0, &settings);
    assert!(script.contains(
        "window.__CODEX_PLUS_FORCE_CHINESE_LOCALE__ = {\"enabled\":false,\"locale\":\"zh-CN\"};"
    ));
}

fn run_force_chinese_locale_harness(initial_locale: Option<&str>) -> serde_json::Value {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let script_path = temp.path().join("renderer-inject.js");
    let harness_path = temp.path().join("force-chinese-locale-harness.cjs");
    std::fs::write(
        &script_path,
        injection_script_with_settings(57321, &BackendSettings::default()),
    )
    .expect("injection script should be written");

    let mut harness = std::fs::File::create(&harness_path).expect("harness should be created");
    write!(
        harness,
        r#"
const scriptPath = {script_path};
const initialLocale = {initial_locale};
const requests = [];
const storage = new Map();
const listeners = new Map();
const intervalCallbacks = [];
let reactRoot = null;

function node() {{
  return {{
    appendChild() {{}}, prepend() {{}}, remove() {{}}, setAttribute() {{}}, removeAttribute() {{}},
    addEventListener() {{}}, querySelector() {{ return null; }}, querySelectorAll() {{ return []; }},
    closest() {{ return null; }}, classList: {{ add() {{}}, remove() {{}}, toggle() {{}}, contains() {{ return false; }} }},
    dataset: {{}}, style: {{}}, children: [], isConnected: true, textContent: "", innerHTML: "",
  }};
}}

globalThis.window = globalThis;
window.addEventListener = (name, callback) => {{
  const callbacks = listeners.get(name) || new Set();
  callbacks.add(callback);
  listeners.set(name, callbacks);
}};
window.removeEventListener = (name, callback) => listeners.get(name)?.delete(callback);
window.dispatchEvent = (event) => listeners.get(event.type)?.forEach((callback) => callback(event));
globalThis.document = {{
  scripts: [], documentElement: node(), body: node(), createElement: () => node(),
  getElementById: (id) => id === "root" ? reactRoot : null,
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {{}}, removeEventListener() {{}},
}};
globalThis.localStorage = {{
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.Navigator = class Navigator {{}};
globalThis.navigator = new Navigator();
globalThis.MutationObserver = class MutationObserver {{
  observe() {{}}
  disconnect() {{}}
}};
globalThis.fetch = () => new Promise(() => {{}});
globalThis.performance = {{ getEntriesByType: () => [] }};
let reloadCount = 0;
globalThis.location = {{
  href: "app://-/index.html", pathname: "/index.html", search: "", hash: "",
  reload: () => {{ reloadCount += 1; }},
}};
window.location = globalThis.location;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {{}};
window.setTimeout = () => 1;
window.clearTimeout = () => {{}};
window.setInterval = (callback) => {{ intervalCallbacks.push(callback); return intervalCallbacks.length; }};
window.clearInterval = () => {{}};
window.electronBridge = {{
  sendMessageFromView(message) {{
    if (!message?.url?.startsWith("vscode://codex/")) return Promise.resolve();
    const body = JSON.parse(message.body || "null");
    requests.push({{ method: message.url.slice("vscode://codex/".length), body }});
    const valid = body && body.key === "localeOverride";
    const response = valid
      ? {{ type: "fetch-response", requestId: message.requestId, responseType: "success", status: 200,
          bodyJsonString: JSON.stringify(message.url.endsWith("get-setting") ? {{ value: initialLocale }} : {{}}) }}
      : {{ type: "fetch-response", requestId: message.requestId, responseType: "error",
          error: "Cannot read properties of undefined (reading 'default')", bodyJsonString: "" }};
    queueMicrotask(() => window.dispatchEvent({{ type: "message", data: response }}));
    return Promise.resolve();
  }},
}};

require(scriptPath);
const appDynamicConfig = {{
  name: "72216192",
  value: {{ enable_i18n: false, locale_source: "IDE" }},
  get(key, fallback) {{ return this.value[key] ?? fallback; }},
}};
const localeMemoCache = [appDynamicConfig, false];
reactRoot = node();
reactRoot["__reactContainer$test"] = {{
  updateQueue: {{ memoCache: {{ data: [localeMemoCache] }} }},
  alternate: null,
  child: null,
  sibling: null,
}};
let valuesUpdatedCount = 0;
const lateConfig = {{
  value: {{ enable_i18n: false, locale_source: "IDE" }},
  get(key, fallback) {{ return this.value[key] ?? fallback; }},
}};
const lateClient = {{
  loadingStatus: "Ready",
  _listeners: {{ values_updated: [() => {{ valuesUpdatedCount += 1; }}] }},
  getContext() {{ return {{ values: null }}; }},
  getDynamicConfig() {{ return lateConfig; }},
}};
window.__STATSIG__ = {{}};
const cachedInstances = window.__STATSIG__.instances ??= {{}};
cachedInstances.primary = lateClient;
intervalCallbacks
  .filter((callback) => String(callback).includes("patchStatsigI18nConfig"))
  .forEach((callback) => callback());
const lateClientConfig = lateClient.getDynamicConfig("72216192");
setImmediate(() => setImmediate(() => process.stdout.write(JSON.stringify({{
  requests,
  reloadCount,
  cachedInstancesIsGlobal: cachedInstances === window.__STATSIG__.instances,
  reactCache: {{
    enableI18n: localeMemoCache[1],
    configEnableI18n: appDynamicConfig.get("enable_i18n", false),
    valuesUpdatedCount,
  }},
  lateClientConfig: {{
    enableI18n: lateClientConfig.get("enable_i18n", false),
    localeSource: lateClientConfig.get("locale_source", "IDE"),
  }},
}}))));
"#,
        script_path = serde_json::to_string(&script_path.to_string_lossy().to_string())
            .expect("script path should serialize"),
        initial_locale = serde_json::to_string(&initial_locale).expect("locale should serialize")
    )
    .expect("harness should be written");
    drop(harness);

    let output = Command::new("node")
        .arg(&harness_path)
        .output()
        .expect("node should run force Chinese locale harness");
    assert!(
        output.status.success(),
        "node harness failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("harness stdout should be JSON")
}

#[test]
fn force_chinese_locale_uses_the_codex_setting_api_request_shape() {
    let result = run_force_chinese_locale_harness(None);
    assert_eq!(
        result["requests"],
        serde_json::json!([
            { "method": "get-setting", "body": { "key": "localeOverride" } },
            { "method": "set-setting", "body": { "key": "localeOverride", "value": "zh-CN" } }
        ])
    );
    assert_eq!(result["reloadCount"], 1);
    assert_eq!(result["cachedInstancesIsGlobal"], true);
    assert_eq!(
        result["lateClientConfig"],
        serde_json::json!({ "enableI18n": true, "localeSource": "SYSTEM" })
    );
}

#[test]
fn force_chinese_locale_reloads_once_when_the_setting_is_already_applied() {
    let result = run_force_chinese_locale_harness(Some("zh-CN"));

    assert_eq!(
        result["requests"],
        serde_json::json!([
            { "method": "get-setting", "body": { "key": "localeOverride" } }
        ])
    );
    assert_eq!(result["reloadCount"], 1);
}

#[test]
fn force_chinese_locale_repairs_the_rendered_config_cache() {
    let result = run_force_chinese_locale_harness(Some("zh-CN"));

    assert_eq!(
        result["reactCache"],
        serde_json::json!({
            "enableI18n": true,
            "configEnableI18n": true,
            "valuesUpdatedCount": 1,
        })
    );
}
