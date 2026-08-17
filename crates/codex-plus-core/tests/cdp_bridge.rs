use base64::Engine;
use codex_plus_core::assets;
use codex_plus_core::bridge::{self, BRIDGE_BINDING_NAME};
use codex_plus_core::cdp::{
    CdpTarget, is_avatar_overlay_page_target, is_primary_codex_page_target,
    is_quick_chat_page_target, list_targets, pick_injectable_codex_page_target, pick_page_target,
    validate_cdp_websocket_url,
};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::future::Future;
use std::io::Write;
use std::net::SocketAddr;
use std::pin::Pin;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

fn target(id: &str, kind: &str, title: &str, url: &str, websocket_url: Option<&str>) -> CdpTarget {
    CdpTarget {
        id: id.to_string(),
        target_type: kind.to_string(),
        title: title.to_string(),
        url: url.to_string(),
        web_socket_debugger_url: websocket_url.map(str::to_string),
    }
}

#[test]
fn bridge_script_defines_expected_globals_and_binding() {
    let script = bridge::build_bridge_script(BRIDGE_BINDING_NAME);

    assert!(script.contains("window.__codexSessionDeleteBridge"));
    assert!(script.contains("window.__codexSessionDeleteResolve"));
    assert!(script.contains("window.__codexSessionDeleteReject"));
    assert!(script.contains("codexSessionDeleteV2"));
}

#[test]
fn screenshot_command_uses_png_from_surface() {
    assert_eq!(
        bridge::capture_screenshot_params(),
        json!({
            "format": "png",
            "fromSurface": true,
            "captureBeyondViewport": false
        })
    );
}

#[test]
fn injection_script_prefixes_helper_url_and_metadata() {
    let script = assets::injection_script(57321);

    assert!(script.contains("!window.electronBridge"));
    assert!(script.contains(r#"!/^app:\/\/\-\//i.test(window.location.href)"#));
    assert!(script.contains("window.__CODEX_SESSION_DELETE_HELPER__"));
    assert!(script.contains("http://127.0.0.1:57321"));
    assert!(!script.contains("window.__CODEX_PLUS_SPONSOR_IMAGES__"));
    assert!(script.contains("window.__CODEX_PLUS_VERSION__"));
    assert!(script.contains(codex_plus_core::version::VERSION));
    assert!(script.contains("https://discord.gg/y96kX7A76v"));
    assert!(script.contains("data-codex-plus-discord"));
}

#[test]
fn injection_script_omits_sponsorship_and_recommendation_ui() {
    let script = assets::injection_script(57321);

    for forbidden in [
        "data-codex-plus-tab=\"sponsor\"",
        "data-codex-plus-panel=\"sponsor\"",
        "fetchCodexPlusAds",
        "BigPizzaV3/Ad-List",
        "请作者喝杯咖啡",
    ] {
        assert!(
            !script.contains(forbidden),
            "injection script still contains {forbidden}"
        );
    }
}

#[test]
fn injection_script_recovers_generated_images_through_the_bridge() {
    let script = assets::injection_script(57321);

    assert!(script.contains("/thread-generated-images"));
    assert!(script.contains("data-codex-generated-images"));
    assert!(script.contains("window.__codexPlusPostJson"));
    assert!(script.contains("window.__codexPlusCurrentSessionRef"));
}

#[test]
fn generated_image_waits_for_its_exact_assistant_message_target() {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let script_path = temp.path().join("generated-images-inject.js");
    let harness_path = temp.path().join("generated-images-target-harness.cjs");
    std::fs::write(&script_path, assets::generated_images_script())
        .expect("generated images script should be written");
    let mut harness = std::fs::File::create(&harness_path).expect("harness should be created");
    write!(
        harness,
        r#"
const scriptPath = {script_path};
let timers = [];
let observer = null;

function element(tagName = "div") {{
  const attributes = new Map();
  const listeners = new Map();
  return {{
    tagName, attributes, children: [], style: {{}}, className: "", parentElement: null,
    setAttribute(name, value) {{ attributes.set(name, String(value)); }},
    getAttribute(name) {{ return attributes.get(name) ?? null; }},
    appendChild(child) {{ child.parentElement = this; this.children.push(child); return child; }},
    addEventListener(name, callback) {{ listeners.set(name, callback); }},
    click() {{ listeners.get("click")?.({{ target: this }}); }},
    showModal() {{ this.setAttribute("open", ""); }},
    close() {{ listeners.get("close")?.({{ target: this }}); }},
    remove() {{
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }},
    querySelector(selector) {{
      if (selector === ':scope > [data-codex-generated-images]') {{
        return this.children.find((child) => child.getAttribute?.("data-codex-generated-images") !== null) || null;
      }}
      return null;
    }},
  }};
}}

function responseTarget(messageId) {{
  const target = element();
  target.setAttribute("data-response-annotation-target", messageId);
  const markdown = element();
  markdown.setAttribute("data-selected-text-overlay-target", "markdown");
  const actions = element();
  actions.setAttribute("data-test-actions", "true");
  target.appendChild(markdown);
  target.appendChild(actions);
  target.markdown = markdown;
  return target;
}}

function descendants(root) {{
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}}

function imageCount(root) {{
  return descendants(root).filter((child) => child.getAttribute?.("data-codex-generated-image-id") !== null).length;
}}

const targets = [responseTarget("msg-last")];
globalThis.window = globalThis;
window.innerWidth = 1800;
window.innerHeight = 1130;
globalThis.document = {{
  body: element("body"), documentElement: element("html"),
  createElement: (tagName) => element(tagName),
  querySelectorAll(selector) {{
    if (selector === "[data-response-annotation-target]") return targets;
    if (selector === "[data-codex-generated-image-id]") {{
      return targets.flatMap((target) => descendants(target)).filter(
        (child) => child.getAttribute?.("data-codex-generated-image-id") !== null,
      );
    }}
    return [];
  }},
}};
globalThis.MutationObserver = class MutationObserver {{
  constructor(callback) {{ this.callback = callback; observer = this; }}
  observe() {{}}
  disconnect() {{}}
}};
globalThis.setTimeout = (callback) => {{ timers.push(callback); return timers.length; }};
globalThis.clearTimeout = () => {{}};
window.__codexPlusCurrentSessionRef = () => ({{ session_id: "thread-1" }});
window.__codexPlusPostJson = async () => ({{
  status: "found",
  images: [{{
    id: "image-1", assistant_message_id: "msg-final", media_type: "image/png",
    assistant_response_index: 1,
    base64_data: "aW1hZ2U=",
    revised_prompt: "Use case: historical-scene Asset type: scenic travel image Primary request: a serene landmark",
  }}],
}});

async function flushTimers() {{
  while (timers.length) {{
    const callbacks = timers.splice(0);
    callbacks.forEach((callback) => callback());
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }}
}}

(async () => {{
  require(scriptPath);
  await flushTimers();
  const beforeExactTarget = imageCount(targets[0]);

  const exactTarget = responseTarget("msg-final");
  targets.push(exactTarget);
  observer.callback();
  await flushTimers();
  const afterExactTarget = {{ old: imageCount(targets[0]), exact: imageCount(exactTarget) }};
  const renderedImage = descendants(exactTarget).find(
    (child) => child.getAttribute?.("data-codex-generated-image-id") === "image-1",
  );
  const renderedContainer = descendants(exactTarget).find(
    (child) => child.getAttribute?.("data-codex-generated-images") !== null,
  );
  renderedImage.naturalWidth = 1536;
  renderedImage.naturalHeight = 1024;
  renderedImage?.parentElement?.click();
  const previewDialog = descendants(document.body).find(
    (child) => child.getAttribute?.("data-codex-generated-image-preview") !== null,
  );
  const previewDescendants = previewDialog ? descendants(previewDialog) : [];
  const zoomLevel = previewDescendants.find(
    (child) => child.getAttribute?.("data-codex-generated-image-zoom-level") !== null,
  );
  const zoomIn = previewDescendants.find((child) => child.getAttribute?.("aria-label") === "放大图片");
  const zoomOut = previewDescendants.find((child) => child.getAttribute?.("aria-label") === "缩小图片");
  const download = previewDescendants.find((child) => child.getAttribute?.("aria-label") === "下载图片");
  const close = previewDescendants.find(
    (child) => child.getAttribute?.("aria-label") === "关闭图片预览",
  );
  const previewTitle = previewDescendants.find(
    (child) => child.getAttribute?.("data-codex-generated-image-preview-title") !== null,
  );
  const imageViewport = previewDescendants.find(
    (child) => child.getAttribute?.("data-codex-generated-image-preview-viewport") !== null,
  );
  const initialZoom = zoomLevel?.textContent || "";
  zoomIn?.click();
  const zoomedIn = zoomLevel?.textContent || "";
  zoomOut?.click();
  const zoomedBackOut = zoomLevel?.textContent || "";
  const nativePreview = {{
    containerInMarkdown: renderedContainer?.parentElement === exactTarget.markdown,
    targetChildren: exactTarget.children.length,
    imageParentTag: renderedImage?.parentElement?.tagName || "",
    imageClass: renderedImage?.className || "",
    imageStyle: renderedImage?.style?.cssText || "",
    previewDialogTag: previewDialog?.tagName || "",
    previewDialogClass: previewDialog?.className || "",
    previewDialogOpen: previewDialog?.getAttribute?.("open") !== null,
    previewTitle: previewTitle?.textContent || "",
    imageViewportClass: imageViewport?.className || "",
    downloadTag: download?.tagName || "",
    downloadHref: download?.getAttribute?.("href") || "",
    downloadName: download?.getAttribute?.("download") || "",
    hasZoomOut: Boolean(zoomOut),
    hasZoomIn: Boolean(zoomIn),
    initialZoom,
    zoomedIn,
    zoomedBackOut,
    hasClose: Boolean(close),
  }};
  close?.click();
  nativePreview.previewRemovedAfterClose = !descendants(document.body).includes(previewDialog);

  delete require.cache[require.resolve(scriptPath)];
  require(scriptPath);
  await flushTimers();
  const afterReinjection = {{ old: imageCount(targets[0]), exact: imageCount(exactTarget) }};

  targets.splice(
    0,
    targets.length,
    responseTarget("item-4"),
    responseTarget("item-5"),
    responseTarget("item-6"),
  );
  delete window.__codexPlusGeneratedImagesState;
  window.__codexPlusPostJson = async () => ({{
    status: "found",
    images: [{{
      id: "image-cold-start", assistant_message_id: "msg-stable", media_type: "image/png",
      assistant_response_index: 1,
      base64_data: "aW1hZ2U=", revised_prompt: "A restored image",
    }}],
  }});
  delete require.cache[require.resolve(scriptPath)];
  require(scriptPath);
  await flushTimers();
  const coldStartFallback = {{
    first: imageCount(targets[0]),
    middle: imageCount(targets[1]),
    last: imageCount(targets[2]),
  }};

  process.stdout.write(JSON.stringify({{
    beforeExactTarget, afterExactTarget, afterReinjection, coldStartFallback, nativePreview,
  }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"#,
        script_path = serde_json::to_string(&script_path.to_string_lossy().to_string())
            .expect("script path should serialize")
    )
    .expect("harness should be written");
    drop(harness);

    let output = Command::new("node")
        .arg(&harness_path)
        .output()
        .expect("node should run generated image target harness");
    assert!(
        output.status.success(),
        "node harness failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("harness stdout should be JSON");
    assert_eq!(result["beforeExactTarget"], 0);
    assert_eq!(result["afterExactTarget"], json!({ "old": 0, "exact": 1 }));
    assert_eq!(result["afterReinjection"], json!({ "old": 0, "exact": 1 }));
    assert_eq!(
        result["coldStartFallback"],
        json!({ "first": 0, "middle": 1, "last": 0 })
    );
    assert_eq!(result["nativePreview"]["containerInMarkdown"], true);
    assert_eq!(result["nativePreview"]["targetChildren"], 2);
    assert_eq!(result["nativePreview"]["imageParentTag"], "button");
    assert_eq!(result["nativePreview"]["previewDialogTag"], "dialog");
    assert_eq!(result["nativePreview"]["previewDialogOpen"], true);
    assert!(
        result["nativePreview"]["previewDialogClass"]
            .as_str()
            .is_some_and(|classes| classes.contains("codex-dialog")
                && classes.contains("h-[100dvh]")
                && classes.contains("w-screen"))
    );
    assert_eq!(result["nativePreview"]["previewTitle"], "生成的图片");
    assert!(
        result["nativePreview"]["imageViewportClass"]
            .as_str()
            .is_some_and(|classes| classes.contains("flex-1")
                && classes.contains("touch-none")
                && classes.contains("overflow-auto"))
    );
    assert_eq!(result["nativePreview"]["downloadTag"], "a");
    assert!(
        result["nativePreview"]["downloadHref"]
            .as_str()
            .is_some_and(|href| href.starts_with("data:image/png;base64,"))
    );
    assert_eq!(result["nativePreview"]["downloadName"], "生成的图片");
    assert_eq!(result["nativePreview"]["hasZoomOut"], true);
    assert_eq!(result["nativePreview"]["hasZoomIn"], true);
    assert_ne!(
        result["nativePreview"]["initialZoom"],
        result["nativePreview"]["zoomedIn"]
    );
    assert_eq!(
        result["nativePreview"]["initialZoom"],
        result["nativePreview"]["zoomedBackOut"]
    );
    assert_eq!(result["nativePreview"]["hasClose"], true);
    assert_eq!(result["nativePreview"]["previewRemovedAfterClose"], true);
    assert!(
        result["nativePreview"]["imageClass"]
            .as_str()
            .is_some_and(|classes| classes.contains("max-h-[10rem]")
                && classes.contains("border-token-border"))
    );
    assert!(
        result["nativePreview"]["imageStyle"]
            .as_str()
            .is_some_and(|style| !style.contains("70vh"))
    );
}

#[test]
fn pet_real_mouse_settings_are_gated_to_windows_in_injected_ui() {
    let script = assets::injection_script(57321);

    assert!(script.contains("codexPlusIsWindowsPlatform"));
    assert!(script.contains(r#"/\bWindows\b/i.test(navigator.userAgent || "")"#));
    assert!(script.contains("codexPlusIsWindowsPlatform ? `<div"));
}

#[test]
fn pet_real_mouse_script_uses_cdp_push_and_native_avatar_event() {
    let script = assets::pet_real_mouse_script();

    assert!(script.contains("avatar-overlay-computer-use-cursor-changed"));
    assert!(script.contains("data-avatar-mascot"));
    assert!(script.contains("nativeCursorActive"));
    assert!(script.contains("transport: \"cdp-push\""));
    assert!(script.contains("updateScreenPoint(point)"));
    assert!(script.contains("localPoint.x >= bounds.left"));
    assert!(script.contains("localPoint.y <= bounds.bottom"));
    assert!(!script.contains("document.elementFromPoint"));
    assert!(script.contains("if (mascotHovered)"));
    assert!(script.contains(
        "document.visibilityState !== \"visible\" || interaction.active() || nativeCursorActive"
    ));
    assert!(script.contains("sendPoint(null).catch(disableUpdates)"));
    assert!(script.contains("void cleared.catch(disableUpdates)"));
    assert!(script.contains("dispatcher.dispatchHostMessage({ type: eventType, point: null })"));
    assert!(script.contains("__codexPlusPetInteraction"));
    assert!(script.contains("setPointerCapture"));
    assert!(script.contains("releasePointerCapture"));
    assert!(script.contains("mascotAtPoint"));
    assert!(script.contains("if (!ownsPointer) return"));
    assert!(script.contains("document.addEventListener(\"pointermove\", onPointerMove, true)"));
    assert!(script.contains("movementHoldMs = 1400"));
    assert!(script.contains("activationRadius = 480"));
    assert!(!script.contains("/pet/cursor-position"));
    assert!(!script.contains("X-Codex-Plus-Pet-Token"));
    assert!(script.contains("delete window.__codexPlusPetRealMouseLook"));
    assert!(script.contains("retired during dispatcher setup"));
    assert!(script.contains("nextUnsubscribe?.()"));
    assert!(script.contains("const runtimeVersion = \"7\""));
}

#[test]
fn pet_real_mouse_cancel_releases_pointer_capture_on_blur_and_stop() {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let script_path = temp.path().join("pet-real-mouse.js");
    let harness_path = temp.path().join("pet-real-mouse-cancel-harness.cjs");
    std::fs::write(&script_path, assets::pet_real_mouse_script())
        .expect("pet real-mouse script should be written");
    let mut harness = std::fs::File::create(&harness_path).expect("harness should be created");
    write!(
        harness,
        r#"
const scriptPath = {script_path};
const documentListeners = new Map();
const windowListeners = new Map();
const setCalls = [];
const releaseCalls = [];

class MockElement {{
  closest(selector) {{ return selector === '[data-avatar-mascot="true"]' ? this : null; }}
  getBoundingClientRect() {{ return {{ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }}; }}
  setPointerCapture(pointerId) {{ setCalls.push(pointerId); }}
  releasePointerCapture(pointerId) {{ releaseCalls.push(pointerId); }}
}}

const mascot = new MockElement();
globalThis.Element = MockElement;
globalThis.window = globalThis;
window.screenX = 0;
window.screenY = 0;
window.addEventListener = (type, listener) => windowListeners.set(type, listener);
window.removeEventListener = (type, listener) => {{
  if (windowListeners.get(type) === listener) windowListeners.delete(type);
}};
globalThis.document = {{
  scripts: [],
  visibilityState: "visible",
  querySelector: (selector) => selector === '[data-avatar-mascot="true"]' ? mascot : null,
  querySelectorAll: () => [],
  addEventListener: (type, listener) => documentListeners.set(type, listener),
  removeEventListener: (type, listener) => {{
    if (documentListeners.get(type) === listener) documentListeners.delete(type);
  }},
}};
globalThis.performance = {{ getEntriesByType: () => [] }};

require(scriptPath);
const runtime = window.__codexPlusPetRealMouseLook;
const pointerEvent = (pointerId) => ({{
  pointerId,
  target: mascot,
  clientX: 50,
  clientY: 50,
  preventDefault() {{}},
}});

documentListeners.get("pointerdown")(pointerEvent(7));
windowListeners.get("blur")();
const activeAfterBlur = runtime.isVisualOverrideActive();

documentListeners.get("pointerdown")(pointerEvent(8));
documentListeners.get("pointerup")(pointerEvent(9));
const activeAfterForeignPointer = runtime.isVisualOverrideActive();
runtime.stop();

process.stdout.write(JSON.stringify({{
  setCalls,
  releaseCalls,
  activeAfterBlur,
  activeAfterForeignPointer,
  runtimeRemoved: window.__codexPlusPetRealMouseLook == null,
}}));
"#,
        script_path = serde_json::to_string(&script_path.to_string_lossy().to_string())
            .expect("script path should serialize")
    )
    .expect("harness should be written");
    drop(harness);

    let output = Command::new("node")
        .arg(&harness_path)
        .output()
        .expect("node should run pet pointer-cancel harness");
    assert!(
        output.status.success(),
        "node harness failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("harness stdout should be JSON");
    assert_eq!(result["setCalls"], json!([7, 8]));
    assert_eq!(result["releaseCalls"], json!([7, 8]));
    assert_eq!(result["activeAfterBlur"], false);
    assert_eq!(result["activeAfterForeignPointer"], true);
    assert_eq!(result["runtimeRemoved"], true);
}

#[test]
fn pet_real_mouse_capability_probe_rejects_v1_without_explicit_v2_evidence() {
    let probe = assets::pet_real_mouse_capability_probe_script();

    assert!(probe.contains("data-avatar-mascot"));
    assert!(probe.contains("image.naturalWidth === 1536"));
    assert!(probe.contains("image.naturalHeight === 2288"));
    assert!(probe.contains("getComputedStyle(element).backgroundImage"));
    assert!(probe.contains("const image = new Image()"));
    assert!(probe.contains("await image.decode()"));
    assert!(probe.contains("if (!await isV2Sprite(mascot)) return false"));
    assert!(!probe.contains("spriteVersionNumber"));
    assert!(probe.contains("dispatchHostMessage"));
    assert!(probe.contains("typeof value.subscribe === \"function\""));
    assert!(!probe.contains("__codexPlusPetRealMouseLook"));
    assert!(!probe.contains("runtimeVersion"));
}

#[test]
fn pet_real_mouse_update_script_stops_when_runtime_capability_is_missing() {
    let script = assets::pet_real_mouse_update_script(-125, 640);

    assert!(script.contains("data-avatar-mascot"));
    assert!(script.contains("image.naturalWidth === 1536"));
    assert!(script.contains("image.naturalHeight === 2288"));
    assert!(script.contains("getComputedStyle(element).backgroundImage"));
    assert!(script.contains("await image.decode()"));
    assert!(script.contains("__codexPlusPetV2SpriteProbe"));
    assert!(script.contains("updateScreenPoint?.({ x: -125, y: 640 }) === true"));
}

#[test]
fn pet_real_mouse_update_script_accepts_png_webp_and_blob_v2_but_rejects_v1() {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let script_path = temp.path().join("pet-update.js");
    let harness_path = temp.path().join("pet-update-harness.cjs");
    std::fs::write(&script_path, assets::pet_real_mouse_update_script(120, 240))
        .expect("pet update script should be written");
    let mut harness = std::fs::File::create(&harness_path).expect("harness should be created");
    write!(
        harness,
        r#"
const fs = require("fs");
const vm = require("vm");
const script = fs.readFileSync({script_path}, "utf8");
const sources = {{
  pngV2: "data:image/png;base64,png-v2",
  webpV2: "data:image/webp;base64,webp-v2",
  webpV1: "data:image/webp;base64,webp-v1",
  blobV2: "blob:codex-plus-pet-v2",
  unknown: "data:image/webp;base64,unknown",
}};
const dimensions = new Map([
  [sources.pngV2, [1536, 2288]],
  [sources.webpV2, [1536, 2288]],
  [sources.webpV1, [1536, 1872]],
  [sources.blobV2, [1536, 2288]],
]);
async function run({{ image = null, source = null }} = {{}}) {{
  let calls = 0;
  let decodes = 0;
  const element = {{ querySelectorAll: () => [] }};
  const mascot = {{
    querySelectorAll: (selector) => selector === "img" && image ? [image] : [element],
  }};
  class MockImage {{
    set src(value) {{ this.source = value; }}
    async decode() {{
      decodes += 1;
      const size = dimensions.get(this.source);
      if (!size) throw new Error("unsupported image");
      [this.naturalWidth, this.naturalHeight] = size;
    }}
  }}
  const context = {{
    document: {{ querySelector: () => mascot }},
    getComputedStyle: (target) => ({{ backgroundImage: target === element && source ? `url("${{source}}")` : "none" }}),
    Image: MockImage,
    window: {{ __codexPlusPetRealMouseLook: {{ updateScreenPoint: () => {{ calls += 1; return true; }} }} }},
  }};
  const result = await vm.runInNewContext(script, context);
  return {{ result, calls, decodes }};
}}
async function runSwitchSequence() {{
  let calls = 0;
  let decodes = 0;
  let source = sources.webpV2;
  const element = {{ querySelectorAll: () => [] }};
  const mascot = {{ querySelectorAll: () => [element] }};
  class MockImage {{
    set src(value) {{ this.source = value; }}
    async decode() {{
      decodes += 1;
      [this.naturalWidth, this.naturalHeight] = dimensions.get(this.source);
    }}
  }}
  const context = {{
    document: {{ querySelector: () => mascot }},
    getComputedStyle: (target) => ({{ backgroundImage: target === element ? `url("${{source}}")` : "none" }}),
    Image: MockImage,
    window: {{ __codexPlusPetRealMouseLook: {{ updateScreenPoint: () => {{ calls += 1; return true; }} }} }},
  }};
  const first = await vm.runInNewContext(script, context);
  const cached = await vm.runInNewContext(script, context);
  source = sources.webpV1;
  const afterV1Switch = await vm.runInNewContext(script, context);
  return {{ first, cached, afterV1Switch, calls, decodes }};
}}
async function runDecodeRace() {{
  let calls = 0;
  let source = sources.webpV2;
  let finishDecode;
  const element = {{ querySelectorAll: () => [] }};
  const mascot = {{ querySelectorAll: () => [element] }};
  class MockImage {{
    set src(value) {{ this.source = value; }}
    async decode() {{
      await new Promise((resolve) => {{ finishDecode = resolve; }});
      [this.naturalWidth, this.naturalHeight] = dimensions.get(this.source);
    }}
  }}
  const context = {{
    document: {{ querySelector: () => mascot }},
    getComputedStyle: (target) => ({{ backgroundImage: target === element ? `url("${{source}}")` : "none" }}),
    Image: MockImage,
    window: {{ __codexPlusPetRealMouseLook: {{ updateScreenPoint: () => {{ calls += 1; return true; }} }} }},
  }};
  const pending = vm.runInNewContext(script, context);
  source = sources.webpV1;
  finishDecode();
  return {{ result: await pending, calls }};
}}
(async () => {{
  process.stdout.write(JSON.stringify({{
    pngV2: await run({{ source: sources.pngV2 }}),
    webpV2: await run({{ source: sources.webpV2 }}),
    blobV2: await run({{ source: sources.blobV2 }}),
    webpV1: await run({{ source: sources.webpV1 }}),
    imgV2: await run({{ image: {{ naturalWidth: 1536, naturalHeight: 2288 }} }}),
    unknown: await run({{ source: sources.unknown }}),
    missing: await run(),
    switchSequence: await runSwitchSequence(),
    decodeRace: await runDecodeRace(),
  }}));
}})().catch((error) => {{ console.error(error); process.exitCode = 1; }});
"#,
        script_path = serde_json::to_string(&script_path.to_string_lossy().to_string())
            .expect("script path should serialize")
    )
    .expect("harness should be written");
    drop(harness);

    let output = Command::new("node")
        .arg(&harness_path)
        .output()
        .expect("node should run pet update harness");
    assert!(
        output.status.success(),
        "node harness failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("harness stdout should be JSON");
    assert_eq!(
        cases["pngV2"],
        json!({ "result": true, "calls": 1, "decodes": 1 })
    );
    assert_eq!(
        cases["webpV2"],
        json!({ "result": true, "calls": 1, "decodes": 1 })
    );
    assert_eq!(
        cases["blobV2"],
        json!({ "result": true, "calls": 1, "decodes": 1 })
    );
    assert_eq!(
        cases["imgV2"],
        json!({ "result": true, "calls": 1, "decodes": 0 })
    );
    assert_eq!(
        cases["webpV1"],
        json!({ "result": false, "calls": 0, "decodes": 1 })
    );
    assert_eq!(
        cases["unknown"],
        json!({ "result": false, "calls": 0, "decodes": 1 })
    );
    assert_eq!(
        cases["missing"],
        json!({ "result": false, "calls": 0, "decodes": 0 })
    );
    assert_eq!(
        cases["switchSequence"],
        json!({
            "first": true,
            "cached": true,
            "afterV1Switch": false,
            "calls": 2,
            "decodes": 2
        })
    );
    assert_eq!(cases["decodeRace"], json!({ "result": false, "calls": 0 }));
}

#[test]
fn pet_real_mouse_stop_script_retires_existing_runtime() {
    assert!(assets::pet_real_mouse_stop_script().contains("__codexPlusPetRealMouseLook?.stop?.()"));
}

#[test]
fn injection_script_exposes_image_overlay_config() {
    let temp = tempfile::tempdir().unwrap();
    let image_path = temp.path().join("overlay.png");
    std::fs::write(
        &image_path,
        base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=")
            .unwrap(),
    )
    .unwrap();
    let settings = codex_plus_core::settings::BackendSettings {
        codex_app_image_overlay_enabled: true,
        codex_app_image_overlay_path: image_path.to_string_lossy().to_string(),
        codex_app_image_overlay_opacity: 42,
        codex_app_image_overlay_fit_mode: "fill".to_string(),
        ..Default::default()
    };
    let script = assets::injection_script_with_settings(57321, &settings);

    assert!(script.contains("window.__CODEX_PLUS_IMAGE_OVERLAY__"));
    assert!(script.contains("\"enabled\":true"));
    assert!(script.contains("\"opacity\":0.42"));
    assert!(script.contains("\"fitMode\":\"fill\""));
    assert!(script.contains("\"dataUrl\":\"data:image/png;base64,"));
    assert!(script.contains("http://127.0.0.1:57321/overlay/image"));
}

#[test]
fn official_login_usage_alert_setting_controls_renderer_injection() {
    use codex_plus_core::settings::{RelayMode, RelayProfile};

    let settings = |relay_mode, hide_official_usage_alert, official_mix_api_key| {
        codex_plus_core::settings::BackendSettings {
            active_relay_id: "official".to_string(),
            relay_profiles: vec![RelayProfile {
                id: "official".to_string(),
                relay_mode,
                official_mix_api_key,
                hide_official_usage_alert,
                ..Default::default()
            }],
            ..Default::default()
        }
    };

    assert!(
        assets::injection_script_with_settings(57321, &settings(RelayMode::Official, true, false))
            .contains("window.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ = true;")
    );
    assert!(
        assets::injection_script_with_settings(57321, &settings(RelayMode::Official, true, true))
            .contains("window.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ = true;")
    );
    assert!(
        assets::injection_script_with_settings(57321, &settings(RelayMode::Official, false, false))
            .contains("window.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ = false;")
    );
    assert!(
        assets::injection_script_with_settings(57321, &settings(RelayMode::PureApi, true, false))
            .contains("window.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ = false;")
    );
}

#[test]
fn usage_alert_hider_uses_sidebar_semantics_instead_of_percentage_copy() {
    let script = assets::injection_script(57321);

    assert!(script.contains("officialUsageAlertCards"));
    assert!(script.contains("progress[max=\"100\"]"));
    assert!(script.contains("dismiss usage alert|关闭使用量提醒"));
    assert!(script.contains("codexPlusUsageAlertHidden"));
}

#[test]
fn injection_script_installs_image_overlay_from_data_uri() {
    let script = assets::injection_script(57321);

    assert!(script.contains("const source = config.dataUrl || \"\""));
    assert!(script.contains("backgroundImage: `url(\"${source.replace(/\"/g, \"%22\")}\")`"));
    assert!(script.contains(
        "fit: { size: \"contain\", position: \"center center\", repeat: \"no-repeat\" }"
    ));
    assert!(script.contains("image_overlay_installed"));
}

#[test]
fn rejects_non_loopback_cdp_websocket() {
    let error =
        validate_cdp_websocket_url("ws://example.com:9222/devtools/page/1", 9222).unwrap_err();

    assert!(error.to_string().contains("loopback"));
}

#[test]
fn rejects_mismatched_cdp_websocket_port() {
    let error =
        validate_cdp_websocket_url("ws://127.0.0.1:9333/devtools/page/1", 9222).unwrap_err();

    assert!(error.to_string().contains("port"));
}

#[test]
fn validates_ipv4_and_ipv6_loopback_cdp_websockets() {
    validate_cdp_websocket_url("ws://127.0.0.1:9222/devtools/page/1", 9222).unwrap();
    validate_cdp_websocket_url("ws://[::1]:9222/devtools/page/1", 9222).unwrap();
}

#[test]
fn rejects_cdp_websocket_with_wrong_scheme_or_missing_port() {
    assert!(validate_cdp_websocket_url("http://127.0.0.1:9222/devtools/page/1", 9222).is_err());
    assert!(validate_cdp_websocket_url("ws://127.0.0.1/devtools/page/1", 9222).is_err());
}

#[test]
fn injection_script_installs_dream_skin_from_backend_settings() {
    let mut settings = codex_plus_core::settings::BackendSettings {
        codex_app_dream_skin_enabled: true,
        codex_app_dream_skin_paused: false,
        codex_app_dream_skin_theme_config: codex_plus_core::settings::DreamSkinThemeConfig {
            name: "Upstream Theme".to_string(),
            ..Default::default()
        },
        ..Default::default()
    };
    settings
        .codex_app_dream_skin_theme_config
        .extra_fields
        .insert(
            "companion".to_string(),
            serde_json::json!({
                "dataUrl": "data:image/webp;base64,UklGRg==",
                "width": 96,
                "side": "right"
            }),
        );
    let script = assets::injection_script_with_settings(57321, &settings);

    assert!(script.contains("dreamSkinEnabled: \"codexAppDreamSkinEnabled\""));
    assert!(script.contains("dreamSkinPaused: \"codexAppDreamSkinPaused\""));
    assert!(script.contains("dreamSkinThemeConfig: \"codexAppDreamSkinThemeConfig\""));
    assert!(script.contains("dreamSkinImagePath: \"codexAppDreamSkinImagePath\""));
    assert!(!script.contains("window.__CODEX_PLUS_DREAM_SKIN_STYLES__ ="));
    assert!(!script.contains("window.__CODEX_PLUS_DREAM_SKIN_CSS__"));
    assert!(script.contains("window.__CODEX_PLUS_DREAM_SKIN_PLATFORM__"));
    assert!(script.contains("window.__CODEX_PLUS_DREAM_SKIN_REVISION__"));
    assert!(script.contains("window.__CODEX_PLUS_DREAM_SKIN_ART__"));
    assert!(script.contains(if cfg!(windows) {
        "data:image/jpeg;base64,"
    } else {
        "data:image/png;base64,"
    }));
    assert!(script.contains("codex-dream-skin-style"));
    assert!(script.contains("codex-dream-skin-chrome"));
    assert!(script.contains("URL.createObjectURL(new Blob"));
    assert!(script.contains("URL.revokeObjectURL(state.artUrl)"));
    assert!(!script.contains("/dream-skin/image?v="));
    assert!(script.contains("window.__CODEX_PLUS_EXTERNAL_DREAM_SKIN_RUNTIME__ = true"));
    assert!(script.contains("window.__CODEX_PLUS_CLEAR_DREAM_SKIN__?.();"));
    assert!(script.contains("window.__CODEX_PLUS_DREAM_SKIN_TARGET_ENGINE__"));
    assert!(script.contains("state.version = `codex-plus:"));
    assert!(script.contains("state.observer?.disconnect?.()"));
    assert!(script.contains("window.__CODEX_PLUS_DREAM_SKIN_PAYLOAD_SIGNATURE__"));
    assert!(script.contains("window.__CODEX_PLUS_DREAM_SKIN_THEME__"));
    assert!(script.contains("data:image/webp;base64,UklGRg=="));
    assert!(script.contains("codex-dream-skin-companion"));
    assert!(script.contains("removeDreamSkinCompanion"));
    if cfg!(windows) {
        assert!(script.contains(":root.codex-dream-skin"));
        assert!(!script.contains("薛凯琪专属定制皮肤"));
    }
    assert!(script.contains(".group\\\\/home-suggestions"));
    assert!(script.contains("--dream-skin-art"));
    assert!(script.contains("--dream-art"));
    assert!(script.contains("function refreshDreamSkin()"));
    assert!(script.contains(
        "codexPlusBackendSettingsLoaded && (!settings.dreamSkinEnabled || settings.dreamSkinPaused)"
    ));
    assert!(script.contains("window.__CODEX_PLUS_DREAM_SKIN_RUNTIME_REVISION__"));
    assert!(script.contains("window.__CODEX_PLUS_DREAM_SKIN_ART_SIGNATURE__"));
    assert!(!script.contains(
        "attributeFilter: [\"class\", \"data-theme\", \"data-appearance\", \"data-color-mode\", \"style\"]"
    ));
    assert!(script.contains("codexAppDreamSkinEnabled"));
    assert!(script.contains("codexAppDreamSkinPaused"));
    assert!(script.contains("codexAppDreamSkinThemeConfig"));
    assert!(script.contains("Upstream Theme"));
    assert!(script.contains("codexAppDreamSkinImagePath"));
    assert!(script.contains("const STATE_KEY = \"__CODEX_DREAM_SKIN_STATE__\""));
    assert!(!script.contains("artDataUrl.slice(-64)"));
    assert!(!script.contains("luckyGod:"));
}

#[test]
fn dream_skin_live_update_script_excludes_the_full_renderer_runtime() {
    let settings = codex_plus_core::settings::BackendSettings {
        codex_app_dream_skin_enabled: true,
        codex_app_dream_skin_theme_config: codex_plus_core::settings::DreamSkinThemeConfig {
            name: "Lightweight Theme".to_string(),
            ..Default::default()
        },
        ..Default::default()
    };

    let probe = assets::dream_skin_live_update_probe_script();
    let update = assets::dream_skin_live_update_script(&settings, true);
    let metadata_only_update = assets::dream_skin_live_update_script(&settings, false);
    let full = assets::injection_script_with_settings(57321, &settings);

    assert!(probe.contains("__CODEX_PLUS_DREAM_SKIN_RUNTIME_REVISION__"));
    assert!(probe.contains("payloadSignature"));
    assert!(probe.contains("__CODEX_DREAM_SKIN_STATE__"));
    assert!(probe.contains("__CODEX_GLASS_VISION_SKIN_STATE__"));
    assert!(update.contains("Lightweight Theme"));
    assert!(update.contains("__CODEX_PLUS_DREAM_SKIN_ART_SIGNATURE__"));
    assert!(update.contains(if cfg!(windows) {
        "data:image/jpeg;base64,"
    } else {
        "data:image/png;base64,"
    }));
    assert!(!metadata_only_update.contains("base64,"));
    assert!(!update.contains("__CODEX_PLUS_SPONSOR_IMAGES__"));
    assert!(!update.contains("__codexSessionDeleteObserver"));
    assert!(!update.contains("function refreshDreamSkin()"));
    assert!(metadata_only_update.len() < full.len());
}

#[test]
fn dream_skin_style_presets_select_their_original_target_engines() {
    for (id, expected_engine) in [
        ("caishen-lite", "dream-skin"),
        ("preset-midnight-aurora", "cidala-tiger"),
        ("codex-snow-skin", "snow"),
        ("glass-vision", "glass-vision"),
    ] {
        let settings = codex_plus_core::settings::BackendSettings {
            codex_app_dream_skin_enabled: true,
            codex_app_dream_skin_theme_config: codex_plus_core::settings::DreamSkinThemeConfig {
                id: id.to_string(),
                ..Default::default()
            },
            ..Default::default()
        };
        let script = assets::dream_skin_live_update_script(&settings, true);

        assert!(
            script.contains(&format!(
                "window.__CODEX_PLUS_DREAM_SKIN_TARGET_ENGINE__ = \"{expected_engine}\""
            )),
            "wrong target engine for {id}"
        );
        assert!(!script.contains("__DREAM_"));
        assert!(!script.contains("__GLASS_VISION_"));
    }
}

#[test]
fn cidala_target_runtime_does_not_observe_managed_style_attributes() {
    let settings = codex_plus_core::settings::BackendSettings {
        codex_app_dream_skin_enabled: true,
        codex_app_dream_skin_theme_config: codex_plus_core::settings::DreamSkinThemeConfig {
            id: "preset-midnight-aurora".to_string(),
            ..Default::default()
        },
        ..Default::default()
    };
    let script = assets::dream_skin_live_update_script(&settings, false);

    assert!(script.contains("window.__CODEX_PLUS_DREAM_SKIN_TARGET_ENGINE__ = \"cidala-tiger\""));
    assert!(!script.contains(
        "attributeFilter: [\"class\", \"data-theme\", \"data-appearance\", \"data-color-mode\", \"style\"]"
    ));
}

#[test]
fn dream_skin_bundles_a_real_default_image() {
    let (content_type, image) = assets::dream_skin_default_image();

    if cfg!(windows) {
        assert_eq!(content_type, "image/jpeg");
        assert!(image.len() > 600_000);
        assert_eq!(&image[..3], b"\xFF\xD8\xFF");
    } else {
        assert_eq!(content_type, "image/png");
        assert!(image.len() > 1_000_000);
        assert_eq!(&image[..8], b"\x89PNG\r\n\x1a\n");
    }
}

#[test]
fn injection_script_marks_diagnostic_build_and_reports_script_loaded() {
    let script = assets::injection_script(57321);

    assert!(script.contains("window.__CODEX_PLUS_BUILD__"));
    assert!(script.contains(codex_plus_core::assets::DIAGNOSTIC_BUILD_ID));
    assert!(script.contains("script_loaded"));
    assert!(script.contains("data-codex-plus-build"));
}

#[test]
fn injection_script_times_out_backend_bridge_calls_and_falls_back_to_helper() {
    let script = assets::injection_script(57321);

    assert!(script.contains("bridgeWithBackendTimeout"));
    assert!(script.contains("backend_bridge_timeout"));
    assert!(!script.contains("/backend/repair"));
    assert!(script.contains("backend_status_bridge_failed_http_fallback_ok"));
    assert!(script.contains("backend_status_bridge_and_http_failed"));
}

#[test]
fn injection_script_explains_plugin_patch_is_unneeded_in_relay_mode() {
    let script = assets::injection_script(57321);

    assert!(script.contains("兼容增强模式下无需开启"));
}

#[test]
fn injection_script_menu_exposes_marketplace_plugin_switch_only() {
    let script = assets::injection_script(57321);

    assert!(script.contains("插件市场解锁"));
    assert!(script.contains("data-codex-plus-setting=\"pluginMarketplaceUnlock\""));
    assert!(!script.contains("特殊插件强制安装"));
    assert!(!script.contains("data-codex-plus-setting=\"forcePluginInstall\""));
    assert!(!script.contains("forcePluginInstall"));
    assert!(!script.contains("强制解锁入口"));
    assert!(!script.contains("data-codex-plus-setting=\"pluginEntryUnlock\""));
}

#[test]
fn injection_script_menu_exposes_stepwise_switch_and_syncs_panel() {
    let script = assets::injection_script(57321);

    assert!(script.contains("stepwise: false"));
    assert!(script.contains("stepwise: \"codexAppStepwiseEnabled\""));
    assert!(script.contains("Stepwise"));
    assert!(script.contains("data-codex-plus-setting=\"stepwise\""));
    assert!(script.contains("function syncStepwisePanel"));
    assert!(script.contains("window.__codexStepwisePanel?.syncSettings"));
    assert!(script.contains("if (key === \"stepwise\") syncStepwisePanel(value)"));
    assert!(script.contains("if (patch?.enabled === true)"));
    assert!(script.contains("activateRuntime();"));
}

#[test]
fn stepwise_direct_send_targets_main_chat_composer() {
    let script = assets::stepwise_script();

    assert!(script.contains("function elementCenter("));
    assert!(script.contains("function horizontalOverlapRatio("));
    assert!(script.contains("function ignoredComposerContainer("));
    assert!(script.contains("function mainComposerCandidate("));
    assert!(script.contains("mainComposerCandidate(candidates)"));
    assert!(!script.contains("const target = candidates[candidates.length - 1];"));
}

#[test]
fn stepwise_scan_does_not_require_composer_for_suggestions() {
    let script = assets::stepwise_script();

    assert!(!script.contains("if (!composerCandidates().length) return false;"));
}

#[test]
fn stepwise_assistant_detection_accepts_two_action_buttons() {
    let script = assets::stepwise_script();

    assert!(script.contains("if (count >= 2) return current;"));
    assert!(script.contains("if (count < 2) continue;"));
    assert!(!script.contains("if (count >= 3) return current;"));
    assert!(!script.contains("if (count < 3) continue;"));
}

#[test]
fn stepwise_refreshes_suggestions_for_virtualized_assistant_bubbles() {
    let script = assets::stepwise_script();

    assert!(script.contains("function assistantBubbleCandidates("));
    assert!(script.contains("\".group.flex.min-w-0.flex-col\""));
    assert!(script.contains("candidates.push(...assistantBubbleCandidates())"));
    assert!(script.contains("function latestMessageByDocumentOrder("));
    assert!(script.contains("function clearPromptsForNewAssistant("));
    assert!(script.contains(
        "if (state.prompts.length || state.currentHash) clearPromptsForNewAssistant(hash);"
    ));
    assert!(script.contains("function setScanStatus("));
    assert!(script.contains("setScanStatus(\"not-ready\""));
    assert!(script.contains("setScanStatus(\"no-assistant-message\""));
    assert!(!script.contains("setScanStatus(\"surface-not-ready\""));
    assert!(!script.contains("return fallback[fallback.length - 1] || null;"));
}

#[test]
fn stepwise_exposes_manual_refresh_without_refreshing_busy_chats() {
    let script = assets::stepwise_script();

    assert!(script.contains("data-action=\"refresh\""));
    assert!(script.contains("function forceRefreshStepwise("));
    assert!(script.contains("state.bridgeStatus === \"pending\" || chatBusy()"));
    assert!(script.contains("setScanStatus(\"manual-refresh-busy\""));
    assert!(script.contains("state.bridgeCache.delete(bridgeKey)"));
    assert!(script.contains("requestBridgeStepwise(bridgeKey, userText, assistantText)"));
}

#[test]
fn stepwise_opens_manager_as_transient_window() {
    let script = assets::stepwise_script();

    assert!(script.contains("bridgeCall(\"/manager/open-transient\", {})"));
}

#[test]
fn injection_script_defers_backend_mapped_toggles_until_settings_load() {
    let script = assets::injection_script(57321);

    assert!(script.contains("const codexPlusBackendMappedSettings = new Set"));
    assert!(
        script
            .contains("codexPlusBackendMappedSettings.has(key) && !codexPlusBackendSettingsLoaded")
    );
    assert!(script.contains("button.dataset.pending = String(waitsForBackend)"));
    assert!(script.contains(
        "button.disabled = waitsForBackend || button.dataset.relayUnneeded === \"true\""
    ));
    assert!(script.contains("toggle.disabled || toggle.dataset.pending === \"true\""));
}

#[test]
fn injection_script_ignores_stale_backend_settings_responses() {
    let script = assets::injection_script(57321);

    assert!(script.contains("let codexPlusBackendSettingsSeq = 0"));
    assert!(script.contains("const seq = codexPlusBackendSettingsSeq"));
    assert!(script.contains("if (seq !== codexPlusBackendSettingsSeq)"));
    assert!(script.contains("const seq = ++codexPlusBackendSettingsSeq"));
    assert!(script.contains("if (seq === codexPlusBackendSettingsSeq)"));
}

#[test]
fn injection_script_skips_plugin_patch_work_in_relay_mode() {
    let script = assets::injection_script(57321);

    assert!(script.contains("function pluginPatchDisabledInRelayMode()"));
    assert!(script.contains("!codexPlusBackendSettingsLoaded"));
    assert!(script.contains("if (pluginPatchDisabledInRelayMode()) return"));
    assert!(script.contains("clearPluginPatchArtifacts()"));
}

#[test]
fn injection_script_omits_plugin_auto_expand() {
    let script = assets::injection_script(57321);

    assert!(!script.contains("pluginAutoExpand"));
    assert!(!script.contains("codexPluginAutoExpand"));
    assert!(!script.contains("plugin_auto_expand"));
}

#[test]
fn injection_script_defines_version_gated_plugin_unlock_strategy() {
    let script = assets::injection_script(57321);

    assert!(script.contains("codexPluginLegacyEntryUnlockBeforeVersion = \"26.601.2237\""));
    assert!(script.contains("function parseCodexVersionParts(version)"));
    assert!(script.contains("function compareCodexVersions(left, right)"));
    assert!(script.contains("function codexPluginUnlockStrategy()"));
    assert!(script.contains("const comparison = compareCodexVersions(version, codexPluginLegacyEntryUnlockBeforeVersion)"));
    assert!(script.contains("return comparison < 0 ? \"legacy\" : \"modern\""));
}

#[test]
fn injection_script_gates_legacy_and_modern_plugin_unlock_by_codex_version() {
    let script = assets::injection_script(57321);

    assert!(script.contains("const pluginUnlockStrategy = codexPluginUnlockStrategy()"));
    assert!(script.contains("if ((pluginUnlockStrategy === \"modern\" || pluginUnlockStrategy === \"unknown\") && settings.pluginMarketplaceUnlock)"));
    assert!(script.contains("plugin_unlock_strategy_selected"));
    assert!(script.contains("window.__codexPluginUnlockStrategyLogged"));
}

#[test]
fn injection_script_removes_legacy_plugin_sidebar_entry_unlock() {
    let script = assets::injection_script(57321);

    assert!(!script.contains("pluginEntryUnlock"));
    assert!(!script.contains("codexAppPluginEntryUnlock"));
    assert!(!script.contains("function spoofChatGPTAuthMethod(element)"));
    assert!(!script.contains("auth.setAuthMethod(\"chatgpt\")"));
    assert!(!script.contains("function pluginEntryButton()"));
    assert!(!script.contains("function enablePluginEntry()"));
    assert!(!script.contains("插件 - 已解锁"));
    assert!(!script.contains("Plugins - Unlocked"));
}

#[test]
fn injection_script_keeps_plugin_marketplace_unlock_separate_from_entry_unlock() {
    let script = assets::injection_script(57321);

    assert!(script.contains("pluginMarketplaceUnlock: true"));
    assert!(script.contains("pluginMarketplaceUnlock: \"codexAppPluginMarketplaceUnlock\""));
    assert!(script.contains("if (!codexPlusSettings().pluginMarketplaceUnlock) return"));
    assert!(script.contains("installPluginBuildFlavorFilterPatch"));
    assert!(script.contains("installPluginMarketplaceRequestPatch"));
}

#[test]
fn injection_script_localizes_codex_menu_commands() {
    let script = assets::injection_script(57321);

    assert!(script.contains("const codexMenuLocalizationMap = new Map"));
    assert!(script.contains("[\"Toggle Sidebar\", \"切换侧边栏\"]"));
    assert!(script.contains("[\"Toggle Bottom Panel\", \"切换底部面板\"]"));
    assert!(script.contains("[\"Toggle Pinned Summary\", \"切换置顶摘要\"]"));
    assert!(script.contains("[\"Open Terminal\", \"打开终端\"]"));
    assert!(script.contains("[\"Open Browser Tab\", \"打开浏览器标签页\"]"));
    assert!(script.contains("[\"Focus Browser Address Bar\", \"聚焦浏览器地址栏\"]"));
    assert!(script.contains("[\"Reload Browser Page\", \"重新加载浏览器页面\"]"));
    assert!(script.contains("[\"Toggle Side Panel\", \"切换侧边面板\"]"));
    assert!(script.contains("[\"Actual Size\", \"实际大小\"]"));
    assert!(script.contains("function localizeCodexMenus"));
    assert!(script.contains("localizeCodexMenus();"));
}

#[test]
fn injection_script_does_not_unlock_disabled_plugin_install_buttons() {
    let script = assets::injection_script(57321);

    assert!(script.contains("button[aria-disabled=\"true\"]"));
    assert!(script.contains("[role=\"button\"][data-disabled]"));
    assert!(!script.contains("installButtonUnlockNodes"));
    assert!(!script.contains("patchReactDisabledProps"));
    assert!(!script.contains("props[\"data-disabled\"] = undefined"));
    assert!(!script.contains("button.querySelectorAll?.(\"button, [role='button'], [disabled], [aria-disabled], [data-disabled]"));
    assert!(!script.contains("button.dataset.codexForceInstallUnlocked"));
}

#[test]
fn injection_script_keeps_bundled_marketplace_name_for_default_filter() {
    let script = assets::injection_script(57321);

    assert!(script.contains("codexPluginMarketplaceUnlockVersion = \"15\""));
    assert!(!script.contains("function pluginMarketplaceAliasForName"));
    assert!(
        !script.contains("if (name === \"openai-bundled\") return \"codex-plus-openai-bundled\"")
    );
    assert!(script.contains("if (name === \"openai-bundled\") return \"OpenAI插件1(Codex++)\""));
}

#[test]
fn injection_script_does_not_bypass_plugin_marketplace_search_filters() {
    let script = assets::injection_script(57321);

    assert!(script.contains("codexPluginMarketplaceUnlockVersion = \"15\""));
    assert!(script.contains("isCodexPluginBuildFlavorFilter"));
    assert!(script.contains("source.includes(\"!u(e.marketplaceName)||e.marketplaceName===r\")"));
    assert!(script.contains("source.includes(\"!Eu(e.marketplaceName)||e.marketplaceName===n\")"));
    assert!(script.contains("source.includes(\"!t.includes(e.name)\")"));
    assert!(!script.contains("if (!source.includes(\"marketplaceName\")) return false"));
    assert!(!script.contains("if (!source.includes(\"name\")) return false"));
}

#[test]
fn injection_script_expands_api_key_plugin_marketplace_requests() {
    let script = assets::injection_script(57321);

    assert!(script.contains("codexPluginMarketplaceUnlockVersion = \"15\""));
    assert!(script.contains("installPluginMarketplaceRequestPatch"));
    assert!(script.contains("installPluginMarketplaceBridgePatch"));
    assert!(script.contains("installPluginBuildFlavorFilterPatch"));
    assert!(script.contains("Array.prototype.filter"));
    assert!(script.contains("codexPluginBuildFlavorFilterPatch"));
    assert!(script.contains("isCodexPluginBuildFlavorFilter"));
    assert!(script.contains(
        "codexPluginOfficialMarketplaceName(plugin?.marketplaceName) && !callback(plugin)"
    ));
    assert!(script.contains("isCodexPluginMarketplaceHiddenFilter"));
    assert!(script.contains(
        "codexPluginOfficialMarketplaceName(marketplace?.name) && !callback(marketplace)"
    ));
    assert!(script.contains("plugin_marketplace_hidden_filter_bypassed"));
    assert!(script.contains("method === \"list-plugins\""));
    assert!(script.contains("method === \"vscode://codex/list-plugins\""));
    assert!(script.contains("message.type === \"fetch\""));
    assert!(script.contains("data?.type === \"fetch-response\""));
    assert!(script.contains("__codexPluginMarketplaceFetchRequestIds"));
    assert!(script.contains("__codexPluginMarketplaceFetchRequestProfiles"));
    assert!(script.contains("__codexPluginMarketplaceRequestProfiles"));
    assert!(script.contains("pluginMarketplaceRequestProfile"));
    assert!(script.contains("remoteOnlyPluginMarketplaceFallbackResult"));
    assert!(script.contains("let nextKinds = Array.isArray(next.marketplaceKinds)"));
    assert!(script.contains("if (!nextKinds.includes(\"local\")) nextKinds.push(\"local\")"));
    assert!(script.contains("if (!nextKinds.includes(\"vertical\")) nextKinds.push(\"vertical\")"));
    assert!(script.contains("next.marketplaceKinds = Array.from(new Set(nextKinds))"));
    assert!(script.contains("codexPluginBroadCatalogKindsFromVersion = \"26.803.0\""));
    assert!(script.contains("broadCatalogPreserved: true"));
    assert!(script.contains("patchPluginMarketplaceResult"));
    assert!(script.contains("__CODEX_PLUS_PLUGIN_MARKETPLACES__"));
    assert!(script.contains("mergeLocalPluginMarketplaces(result)"));
    assert!(script.contains("plugin_marketplace_local_merged"));
    assert!(script.contains("plugin_marketplace_remote_auth_fallback"));
    assert!(script.contains("cloned.marketplaceName = marketplaceName"));
    assert!(script.contains("cloned.marketplacePath = marketplaceName"));
    assert!(script.contains("restorePluginMarketplaceName"));
    assert!(script.contains(
        "next.remoteMarketplaceName = restorePluginMarketplaceName(next.remoteMarketplaceName)"
    ));
    assert!(!script.contains("marketplace.name = alias"));
    assert!(script.contains("if (name === \"openai-curated\") return \"OpenAI插件2(Codex++)\""));
    assert!(
        script.contains("if (name === \"openai-primary-runtime\") return \"OpenAI插件3(Codex++)\"")
    );
    assert!(script.contains("restored === \"openai-api-curated\""));
    assert!(script.contains("restored === \"openai-curated-remote\""));
    assert!(
        script.contains("if (name === \"openai-curated-remote\") return \"OpenAI插件5(Codex++)\"")
    );
    assert!(script.contains(
        "if (name === \"codex-plus-openai-curated-remote\") return \"openai-curated-remote\""
    ));
    assert!(script.contains("OpenAI插件1(Codex++)"));
    assert!(script.contains("OpenAI插件2(Codex++)"));
    assert!(script.contains("OpenAI插件3(Codex++)"));
    assert!(script.contains("method === \"install-plugin\""));
    assert!(script.contains("plugin_marketplace_response_expanded"));
    assert!(script.contains("plugin_build_flavor_filter_bypassed"));
    assert!(script.contains("plugin_install_request_debug"));
    assert!(script.contains("plugin_install_request_failed"));
    assert!(!script.contains("marketplace.path ="));
    assert!(!script.contains("codexPluginMarketplacePathAliasForName"));
    assert!(!script.contains("spoofAnyCodexAuthContext"));
}

#[test]
fn injection_script_preserves_vertical_marketplace_kind_for_official_plugins() {
    let script = assets::injection_script(57321);

    assert!(script.contains("plugin_marketplace_request_expanded"));
    assert!(script.contains("if (!nextKinds.includes(\"vertical\")) nextKinds.push(\"vertical\")"));
    assert!(!script.contains("codexPluginAllowedMarketplaceKinds"));
    assert!(!script.contains("codexPluginExpandedMarketplaceKinds"));
    assert!(!script.contains("delete next.marketplaceKinds"));
}

#[test]
fn injection_script_logs_marketplace_grouping_diagnostics() {
    let script = assets::injection_script(57321);

    assert!(script.contains("plugin_marketplace_response_debug"));
    assert!(script.contains("marketplaces: result.marketplaces.map"));
    assert!(script.contains("pluginMarketplaceCounts"));
    assert!(script.contains("remoteMarketplaceName"));
}

#[test]
fn injection_script_recovers_plugin_search_from_remote_auth_errors() {
    let cases = run_plugin_marketplace_search_contract_harness();

    assert_eq!(cases["initialKinds"], json!(["local", "vertical"]));
    assert_eq!(cases["latestBroadOmittedHasKinds"], false);
    assert_eq!(cases["latestBroadOmittedKinds"], serde_json::Value::Null);
    assert_eq!(cases["latestBroadNullHasKinds"], true);
    assert_eq!(cases["latestBroadNullKinds"], serde_json::Value::Null);
    assert_eq!(cases["latestExplicitKinds"], json!(["local", "vertical"]));
    assert_eq!(cases["searchKinds"], json!(["created-by-me-remote"]));
    assert_eq!(cases["searchCwds"], serde_json::Value::Null);
    assert_eq!(cases["searchRemoteOnly"], true);
    assert_eq!(cases["responsePatched"], true);
    assert_eq!(cases["responseHasError"], false);
    assert_eq!(cases["fallbackMarketplaceNames"], json!([]));
    assert_eq!(cases["fallbackPluginNames"], json!([]));
    assert_eq!(cases["fallbackFeaturedPluginIds"], json!([]));
    assert_eq!(cases["fallbackMarketplaceLoadErrors"], json!([]));
    assert_eq!(cases["remoteUnavailable"], true);
    assert_eq!(cases["subsequentKinds"], json!(["created-by-me-remote"]));
    assert_eq!(cases["subsequentCwds"], serde_json::Value::Null);
    assert_eq!(
        cases["generalAfterFallbackKinds"],
        json!(["local", "vertical"])
    );
    assert_eq!(
        cases["latestBroadAfterFallbackKinds"],
        json!(["local", "vertical"])
    );
    assert_eq!(cases["generalAfterFallbackCwds"], json!(["C:/workspace"]));
    assert_eq!(
        cases["localFallbackMarketplaceNames"],
        json!(["fixture-local"])
    );
    assert_eq!(cases["localFallbackPluginNames"], json!(["alpha"]));
    assert_eq!(cases["chatGptKinds"], json!(["created-by-me-remote"]));
    assert_eq!(cases["unrelatedErrorMatched"], false);
}

fn run_plugin_marketplace_search_contract_harness() -> serde_json::Value {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let script_path = temp.path().join("renderer-inject.js");
    let harness_path = temp.path().join("plugin-marketplace-harness.cjs");
    std::fs::write(&script_path, assets::injection_script(57321))
        .expect("injection script should be written");
    let mut harness = std::fs::File::create(&harness_path).expect("harness should be created");
    write!(
        harness,
        r#"
const scriptPath = {script_path};
const store = new Map();
function node() {{
  return {{
    appendChild() {{}}, prepend() {{}}, remove() {{}}, setAttribute() {{}}, removeAttribute() {{}},
    addEventListener() {{}}, querySelector() {{ return null; }}, querySelectorAll() {{ return []; }},
    closest() {{ return null; }},
    classList: {{ add() {{}}, remove() {{}}, toggle() {{}}, contains() {{ return false; }} }},
    dataset: {{}}, style: {{}}, children: [], isConnected: true, textContent: "", innerHTML: "",
  }};
}}
globalThis.window = globalThis;
window.__CODEX_PLUS_TEST_PLUGIN_MARKETPLACE__ = true;
window.addEventListener = () => {{}};
window.removeEventListener = () => {{}};
window.dispatchEvent = () => true;
globalThis.document = {{
  scripts: [], documentElement: node(), body: node(), createElement: () => node(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {{}}, removeEventListener() {{}},
}};
globalThis.localStorage = {{
  getItem: (key) => store.has(key) ? store.get(key) : null,
  setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key),
}};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.location = {{ href: "https://codex.test/index.html", pathname: "/index.html", search: "", hash: "" }};
window.location = globalThis.location;
globalThis.navigator = {{ userAgent: "node-test", sendBeacon: () => false }};
globalThis.performance = {{ getEntriesByType: () => [] }};
globalThis.fetch = async () => ({{ ok: true, json: async () => ({{}}) }});
require(scriptPath);
window.__CODEX_PLUS_PLUGIN_MARKETPLACES__ = [{{
  name: "fixture-local",
  displayName: "Fixture Local",
  path: "C:/fixture/marketplace.json",
  plugins: [{{ id: "alpha@fixture-local", name: "alpha", marketplaceName: "fixture-local" }}],
}}];
const api = window.__codexPlusPluginMarketplaceTest;
api.reset();
const initial = api.patchRequestParams("list-plugins", {{ cwds: ["C:/workspace"] }});
api.setCodexAppVersion("26.803.41515");
const latestBroadOmitted = api.patchRequestParams("list-plugins", {{ cwds: ["C:/workspace"] }});
const latestBroadNull = api.patchRequestParams("list-plugins", {{ cwds: ["C:/workspace"], marketplaceKinds: null }});
const latestExplicit = api.patchRequestParams("list-plugins", {{ marketplaceKinds: ["local"] }});
api.setCodexAppVersion("");
const searchMessage = api.patchRequestMessage({{
  type: "mcp-request",
  request: {{
    id: "search-1",
    method: "vscode://codex/list-plugins",
    params: {{ marketplaceKinds: ["created-by-me-remote"] }},
  }},
}});
const remoteAuthMessage = "list remote plugin catalog: chatgpt authentication required for remote plugin catalog; api key auth is not supported";
const response = {{
  type: "mcp-response",
  message: {{ id: "search-1", error: {{ code: -32600, message: remoteAuthMessage }} }},
}};
const responsePatched = api.patchResponseData(response);
const subsequent = api.patchRequestParams("list-plugins", {{ marketplaceKinds: ["created-by-me-remote"] }});
const generalAfterFallback = api.patchRequestParams("list-plugins", {{ marketplaceKinds: ["created-by-me-remote", "local", "vertical"] }});
api.setCodexAppVersion("26.803.41515");
const latestBroadAfterFallback = api.patchRequestParams("list-plugins", {{ cwds: ["C:/workspace"] }});
const fallbackMarketplaces = response.message.result?.marketplaces || [];
const localFallbackMarketplaces = api.localFallback().marketplaces || [];
const remoteUnavailable = api.remoteCatalogUnavailable();
api.reset();
const chatGpt = api.patchRequestParams("list-plugins", {{ marketplaceKinds: ["created-by-me-remote"] }});
const cases = {{
  initialKinds: initial.marketplaceKinds,
  latestBroadOmittedHasKinds: Object.prototype.hasOwnProperty.call(latestBroadOmitted, "marketplaceKinds"),
  latestBroadOmittedKinds: latestBroadOmitted.marketplaceKinds ?? null,
  latestBroadNullHasKinds: Object.prototype.hasOwnProperty.call(latestBroadNull, "marketplaceKinds"),
  latestBroadNullKinds: latestBroadNull.marketplaceKinds,
  latestExplicitKinds: latestExplicit.marketplaceKinds,
  searchKinds: searchMessage.request.params.marketplaceKinds,
  searchCwds: searchMessage.request.params.cwds ?? null,
  searchRemoteOnly: api.requestProfile({{ marketplaceKinds: ["created-by-me-remote"] }}).remoteOnly,
  responsePatched,
  responseHasError: Object.prototype.hasOwnProperty.call(response.message, "error"),
  fallbackMarketplaceNames: fallbackMarketplaces.map((marketplace) => marketplace.name),
  fallbackPluginNames: fallbackMarketplaces.flatMap((marketplace) => marketplace.plugins || []).map((plugin) => plugin.name),
  fallbackFeaturedPluginIds: response.message.result?.featuredPluginIds || [],
  fallbackMarketplaceLoadErrors: response.message.result?.marketplaceLoadErrors || [],
  remoteUnavailable,
  subsequentKinds: subsequent.marketplaceKinds,
  subsequentCwds: subsequent.cwds ?? null,
  generalAfterFallbackKinds: generalAfterFallback.marketplaceKinds,
  generalAfterFallbackCwds: generalAfterFallback.cwds,
  latestBroadAfterFallbackKinds: latestBroadAfterFallback.marketplaceKinds,
  localFallbackMarketplaceNames: localFallbackMarketplaces.map((marketplace) => marketplace.name),
  localFallbackPluginNames: localFallbackMarketplaces.flatMap((marketplace) => marketplace.plugins || []).map((plugin) => plugin.name),
  chatGptKinds: chatGpt.marketplaceKinds,
  unrelatedErrorMatched: api.remoteAuthError({{ message: "network unavailable" }}),
}};
process.stdout.write(JSON.stringify(cases));
"#,
        script_path = serde_json::to_string(&script_path.to_string_lossy().to_string())
            .expect("script path should serialize")
    )
    .expect("harness should be written");

    let output = std::process::Command::new("node")
        .arg(&harness_path)
        .output()
        .expect("node should execute plugin marketplace harness");
    assert!(
        output.status.success(),
        "plugin marketplace harness failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout)
        .expect("plugin marketplace harness output should be JSON")
}

#[test]
fn injection_script_omits_force_install_unlock_loop() {
    let script = assets::injection_script(57321);

    assert!(!script.contains("codex-force-install-unlocked"));
    assert!(!script.contains("codexForcePluginInstallRefreshIntervalMs"));
    assert!(!script.contains("refreshForcePluginInstallUnlockLoop"));
    assert!(!script.contains("__codexForcePluginInstallRefreshTimer"));
}

#[test]
fn injection_script_loads_backend_settings_before_initial_scan() {
    let script = assets::injection_script(57321);
    let startup_call = script
        .rfind("void loadBackendSettingsForStartup();")
        .expect("script should load backend settings on startup");
    let footer = &script[startup_call..];
    let initial_scan = footer
        .find("scan();")
        .expect("script should perform an initial scan");
    let footer_marker = footer
        .find("window.__codexProjectMoveApplyProjection")
        .expect("script should continue bootstrapping after the initial scan");

    assert!(initial_scan < footer_marker);
    assert!(script.contains("if (attempt < 60)"));
}

#[test]
fn injection_script_loads_service_tier_after_startup_settings() {
    // Given: service-tier controls are enabled before the renderer starts.
    let script = assets::injection_script(57321);
    let startup = script
        .find("function loadBackendSettingsForStartup")
        .expect("script should define the startup settings loader");
    let startup_body = &script[startup
        ..script[startup..]
            .find("async function setBackendSetting")
            .map(|offset| startup + offset)
            .expect("startup settings loader should end before the settings writer")];

    // When: backend settings finish loading successfully.
    // Then: the service-tier state is loaded without requiring the menu to open.
    assert!(startup_body.contains("codexPlusSettings().serviceTierControls"));
    assert!(startup_body.contains("void loadCodexServiceTierState();"));
}

#[test]
fn injection_script_exposes_conversation_view_width_control() {
    let script = assets::injection_script(57321);

    assert!(script.contains("conversationView: false"));
    assert!(script.contains("conversationView"));
    assert!(script.contains("conversationViewMaxWidth"));
    assert!(script.contains("对话居中宽度"));
    assert!(script.contains("data-codex-plus-conversation-view-width"));
    assert!(script.contains("conversationViewWidth()"));
    assert!(script.contains("normalizeConversationViewWidth"));
    assert!(
        !script.contains("conversationViewState.mo"),
        "conversation view must not observe the entire document mutation stream"
    );
}

#[test]
fn injection_script_exposes_sidebar_thread_id_badge_control() {
    let script = assets::injection_script(57321);

    assert!(script.contains("threadIdBadge: false"));
    assert!(script.contains("threadIdBadge: \"codexAppThreadIdBadge\""));
    assert!(script.contains("会话 ID 标识"));
    assert!(script.contains("data-codex-plus-setting=\"threadIdBadge\""));
    assert!(script.contains("codex-thread-id-badge"));
    assert!(script.contains("data-codex-thread-id-badge-wrap=\"true\""));
    assert!(script.contains("let threadIdBadgeActive = false"));
    assert!(script.contains("if (threadIdBadgeActive)"));
    assert!(script.contains("function refreshThreadIdBadges()"));
    assert!(script.contains("uuidV7TimestampMs(sessionId)"));
    assert!(script.contains("refreshThreadIdBadges();"));
}

#[test]
fn injection_script_keeps_session_action_buttons_in_pr_style() {
    let script = assets::injection_script(57321);

    assert!(script.contains("actionButtonClass = \"codex-session-action-button\""));
    assert!(script.contains("background: transparent;"));
    assert!(script.contains("background: #363839;"));
    assert!(script.contains("cursor: default;"));
}

#[test]
fn injection_script_activates_session_delete_once_per_click() {
    let script = assets::injection_script(57321);
    let delegated_delete = script
        .split_once("function installDeleteButtonEventDelegation()")
        .expect("delete event delegation should exist")
        .1
        .split_once("function actionGroupFromRow")
        .expect("delete event delegation should end before action group helpers")
        .0;
    let action_button_events = script
        .split_once("function installActionButtonEvents")
        .expect("action button event setup should exist")
        .1
        .split_once("function installMoreButtonEvents")
        .expect("action button setup should end before more button setup")
        .0;

    assert!(delegated_delete.contains("document.addEventListener(\"click\", handler, true);"));
    assert!(!delegated_delete.contains("document.addEventListener(\"pointerup\", handler, true);"));
    assert!(
        !action_button_events.contains("button.addEventListener(\"pointerup\", onActivate, true);")
    );
    assert!(action_button_events.contains("button.addEventListener(\"click\", (event) => {"));
}

#[test]
fn injection_script_refreshes_sidebar_after_session_undo() {
    let script = assets::injection_script(57321);
    let refresh = script
        .split_once("async function refreshRecentConversationsForHost()")
        .expect("recent conversation refresh helper should exist")
        .1
        .split_once("function refreshAfterProjectMove")
        .expect("refresh helper should end before project move refresh")
        .0;
    let toast = script
        .split_once("function showToast(message, undoToken)")
        .expect("undo toast should exist")
        .1
        .split_once("function upstreamWorktreeField")
        .expect("undo toast should end before worktree helpers")
        .0;

    assert!(refresh.contains("loadOptionalCodexAppModule(\"app-server-manager-signals-\")"));
    assert!(!refresh.contains("app-server-manager-signals-C1h8B-R-.js"));
    assert!(toast.contains("const refreshed = await refreshRecentConversationsForHost();"));
    assert!(toast.contains("if (!refreshed) window.location.reload();"));
}

#[test]
fn injection_script_guards_temporary_new_thread_ids_before_delete() {
    let script = assets::injection_script(57321);

    assert!(script.contains("function isClientNewThreadId(value)"));
    assert!(script.contains("function normalizedCodexThreadUuid(value)"));
    assert!(script.contains("function reactConversationIdFromRow(row)"));
    assert!(script.contains("__reactFiber$"));
    assert!(script.contains("props?.conversationId"));
    assert!(!script.contains("props?.threadId || props?.sessionId"));
    assert!(script.contains("|| /(?:^|[=/])(?:local:)?client-new-thread:/i.test(href)"));
    assert!(script.contains(
        "? canonicalHrefId || (!hrefIsTemporary ? reactConversationIdFromRow(row) : \"\")"
    ));
    assert!(script.contains("const openDeleteConfirm = (event) => openDeleteConfirmForRow(row, deleteButton, sessionRefFromRow(row), event)"));
    assert!(script.contains("会话仍在同步，请稍后重试"));
    assert!(script.contains("attributeFilter: [\"data-app-action-sidebar-thread-id\", \"href\"]"));

    let cases = run_session_ref_contract_harness();
    assert_eq!(
        cases["canonicalAttribute"],
        "11111111-1111-4111-8111-111111111111"
    );
    assert_eq!(
        cases["canonicalHref"],
        "22222222-2222-4222-8222-222222222222"
    );
    assert_eq!(
        cases["conversationId"],
        "33333333-3333-4333-8333-333333333333"
    );
    assert_eq!(cases["unrelatedIds"], "");
    assert_eq!(cases["temporaryHref"], "");
}

fn run_session_ref_contract_harness() -> serde_json::Value {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let script_path = temp.path().join("renderer-inject.js");
    let harness_path = temp.path().join("session-ref-harness.cjs");
    std::fs::write(&script_path, assets::injection_script(57321))
        .expect("injection script should be written");
    let mut harness = std::fs::File::create(&harness_path).expect("harness should be created");
    write!(
        harness,
        r#"
const scriptPath = {script_path};
function node() {{
  return {{
    appendChild() {{}}, prepend() {{}}, remove() {{}}, setAttribute() {{}}, removeAttribute() {{}},
    addEventListener() {{}}, querySelector() {{ return null; }}, querySelectorAll() {{ return []; }},
    closest() {{ return null; }}, getAttribute() {{ return null; }},
    classList: {{ add() {{}}, remove() {{}}, toggle() {{}}, contains() {{ return false; }} }},
    dataset: {{}}, style: {{}}, children: [], isConnected: true, textContent: "", innerHTML: "",
  }};
}}
globalThis.window = globalThis;
window.__CODEX_PLUS_TEST_SESSION_REF__ = true;
window.addEventListener = () => {{}};
window.removeEventListener = () => {{}};
window.dispatchEvent = () => true;
globalThis.MutationObserver = class {{ observe() {{}} disconnect() {{}} }};
globalThis.ResizeObserver = class {{ observe() {{}} disconnect() {{}} }};
globalThis.IntersectionObserver = class {{ observe() {{}} disconnect() {{}} }};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {{}};
globalThis.document = {{
  scripts: [], documentElement: node(), body: node(), createElement: () => node(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {{}}, removeEventListener() {{}},
}};
globalThis.localStorage = {{ getItem: () => null, setItem() {{}}, removeItem() {{}} }};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.location = {{ href: "https://codex.test/index.html", pathname: "/index.html", search: "", hash: "" }};
window.location = globalThis.location;
globalThis.navigator = {{ userAgent: "node-test", sendBeacon: () => false }};
globalThis.performance = {{ getEntriesByType: () => [] }};
globalThis.fetch = async () => ({{ ok: true, json: async () => ({{}}) }});
require(scriptPath);

const api = window.__codexPlusSessionRefTest;
const placeholder = "local:client-new-thread:fixture";
const row = (attributes, props = null) => {{
  const value = {{
    getAttribute: (name) => attributes[name] || null,
    querySelector: () => null,
    textContent: "Fixture",
  }};
  if (props) value.__reactFiber$fixture = {{ pendingProps: props, memoizedProps: null, return: null }};
  return value;
}};
const sessionId = (value) => api.fromRow(value).session_id;
const cases = {{
  canonicalAttribute: sessionId(row({{ "data-app-action-sidebar-thread-id": "11111111-1111-4111-8111-111111111111" }})),
  canonicalHref: sessionId(row({{
    "data-app-action-sidebar-thread-id": placeholder,
    href: "/thread/22222222-2222-4222-8222-222222222222",
  }})),
  conversationId: sessionId(row(
    {{ "data-app-action-sidebar-thread-id": placeholder }},
    {{ conversationId: "33333333-3333-4333-8333-333333333333" }},
  )),
  unrelatedIds: sessionId(row(
    {{ "data-app-action-sidebar-thread-id": placeholder }},
    {{ threadId: "44444444-4444-4444-8444-444444444444", sessionId: "55555555-5555-4555-8555-555555555555" }},
  )),
  temporaryHref: sessionId(row(
    {{ "data-app-action-sidebar-thread-id": placeholder, href: "/thread/client-new-thread:fixture" }},
    {{ conversationId: "66666666-6666-4666-8666-666666666666" }},
  )),
}};
process.stdout.write(JSON.stringify(cases));
process.exit(0);
"#,
        script_path = serde_json::to_string(&script_path.to_string_lossy().to_string())
            .expect("script path should serialize")
    )
    .expect("harness should be written");

    let output = Command::new("node")
        .arg(&harness_path)
        .output()
        .expect("node should execute session reference harness");
    assert!(
        output.status.success(),
        "session reference harness failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("session reference harness output should be JSON")
}

#[test]
fn injection_script_moves_export_and_project_move_into_more_menu() {
    let script = assets::injection_script(57321).replace("\r\n", "\n");

    assert!(script.contains("moreButtonClass = \"codex-session-more-button\""));
    assert!(script.contains("moreMenuClass = \"codex-session-more-menu\""));
    assert!(script.contains("configureActionButton(moreButton, \"更多操作\", \"…\")"));
    assert!(script.contains("createSessionMoreMenuItem(\"导出\""));
    assert!(script.contains("createSessionMoreMenuItem(\"移动\""));
    assert!(script.contains("group.appendChild(moreButton)"));
    assert!(script.contains("installMoreButtonEvents(row, moreButton, openMoreMenu)"));
    assert!(script.contains("installSessionMoreMenuAutoClose(row, moreMenu)"));
    assert!(script.contains("updateSessionMoreMenuDirection(moreButton, moreMenu)"));
    assert!(script.contains("positionSessionMoreMenu(moreButton, moreMenu)"));
    assert!(script.contains("document.body.appendChild(moreMenu)"));
    assert!(script.contains("position: fixed;"));
    assert!(script.contains("codex-session-more-menu-open-up"));
    assert!(script.contains("transform: translateY(calc(-100% - 34px));"));
    assert!(script.contains("positionSessionMoreMenu(moreButton, moreMenu);"));
    assert!(script.contains("row.classList.toggle(\"codex-session-more-open\""));
    assert!(script.contains(".${actionGroupClass} {"));
    assert!(script.contains("position: absolute;"));
    assert!(script.contains("pointer-events: none;"));
    assert!(script.contains("[data-codex-delete-row=\"true\"]:hover .${actionGroupClass} {\n        opacity: 1;\n        pointer-events: auto;\n      }"));
    assert!(script.contains("[data-codex-delete-row=\"true\"].codex-session-more-open .${actionGroupClass} {\n        opacity: 1;\n        pointer-events: auto;\n        z-index: 2147483201;"));
    assert!(!script.contains("installActionButtonEvents(row, moreButton, openMoreMenu)"));
    assert!(!script.contains("group.appendChild(exportButton)"));
    assert!(!script.contains("group.appendChild(moveButton)"));
}

#[test]
fn injection_script_does_not_add_delete_controls_on_archived_page() {
    let script = assets::injection_script(57321);

    assert!(script.contains("attachArchivedPageDeleteButton"));
    assert!(script.contains("data-codex-archive-row-action"));
    assert!(script.contains("dataset.codexArchiveRowAction = \"export\""));
    assert!(!script.contains("dataset.codexArchiveRowAction = \"delete\""));
    assert!(!script.contains("installArchivedDeleteAllButton"));
    assert!(!script.contains("删除全部归档"));
}

#[test]
fn injection_script_unlocks_custom_model_catalog() {
    let script = assets::injection_script(57321);

    assert!(script.contains("/codex-model-catalog"));
    assert!(script.contains("codexModelCatalog"));
    assert!(script.contains("patchModelArray"));
    assert!(script.contains("patchStatsigModelDynamicConfig"));
    assert!(script.contains("patchModelJsonResponse"));
    assert!(script.contains("modelJsonResponseLooksPatchable"));
    assert!(script.contains("installAppServerModelRequestPatch"));
    assert!(script.contains("loadAppServerRequestCandidates"));
    assert!(script.contains("appServerFallbackAssetUrls"));
    assert!(script.contains("collectAppServerRequestCandidatesFromModule"));
    assert!(script.contains("codexAppServerModelRequestPatchVersion = \"5\""));

    assert!(script.contains("list-models-for-host"));
    assert!(script.contains("appServerModelRequestMethod"));
    assert!(script.contains("codexAppServerClientAssetUrls"));
    assert!(script.contains("Missing AppServer request message handler"));
    assert!(script.contains("sendRequest=async"));
    assert!(script.contains("runtime-scan:"));
    assert!(script.contains("send-cli-request-for-host"));
    assert!(script.contains("Response.prototype.json"));
    assert!(script.contains("scheduleCodexModelWhitelistRefresh"));
    assert!(script.contains("runCodexModelWhitelistRefreshPass"));
    assert!(script.contains("model_whitelist_refresh_scheduled"));
    assert!(script.contains("available_models"));
    assert!(script.contains("modelWhitelistUnlock"));
    assert!(!script.contains("|| settingsResp.relayProfiles[0]"));
    assert!(script.contains("refreshCodexModelWhitelistFromScan"));
    assert!(script.contains("codexPlusModelListRequestIds.size === 0"));
    assert!(!script.contains("function patchReactModelState"));
    assert!(!script.contains("function patchObjectGraphForModels"));
    assert!(!script.contains("window.dispatchEvent = function patchedCodexPlusDispatchEvent"));
    assert!(script.contains("String(name) === \"107580212\""));
    assert!(script.contains("window.addEventListener(\"codex-message-from-view\""));
    assert!(!script.contains("querySelectorAll(\"button, [role='menu']"));
}

#[test]
fn injection_script_exposes_fast_service_tier_control() {
    let script = assets::injection_script(57321);

    assert!(script.contains("default-service-tier"));
    assert!(script.contains("setting-storage-"));
    assert!(script.contains("codexAppAssetUrl"));
    assert!(script.contains("codexThreadServiceTierOverrides"));
    assert!(script.contains("setCodexThreadServiceTierMode"));
    assert!(script.contains("codexServiceTierRequestOverride"));
    assert!(script.contains("codexServiceTierSupportedFastModels"));
    assert!(script.contains("\"gpt-5.4\""));
    assert!(script.contains("\"gpt-5.5\""));
    assert!(script.contains("\"gpt-5.6-sol\""));
    assert!(script.contains("\"gpt-5.6-terra\""));
    assert!(script.contains("\"gpt-5.6-luna\""));
    assert!(script.contains("codexServiceTierFastSupportedForModel"));
    assert!(script.contains("codexServiceTierModelForRequest"));
    assert!(script.contains("codexServiceTierMaybeLoadModelCatalog"));
    assert!(script.contains("fastBlocked"));
    assert!(script.contains("data-tier=\"unsupported\""));
    assert!(script.contains("nextParams.service_tier = override.serviceTier"));
    assert!(script.contains("serviceTierControls: false"));
    assert!(script.contains("data-codex-plus-setting=\"serviceTierControls\""));
    assert!(script.contains("data-codex-service-tier-controls"));
    assert!(script.contains("removeCodexServiceTierBadges"));
    assert!(script.contains("installCodexServiceTierDispatcherPatch"));
    assert!(script.contains("服务模式"));
    assert!(script.contains("data-codex-service-tier-status"));
    assert!(script.contains("data-codex-service-tier-inherit"));
    assert!(script.contains("data-codex-service-tier-standard"));
    assert!(script.contains("data-codex-service-tier-fast"));
    assert!(script.contains("data-codex-service-tier-custom"));
    assert!(script.contains("data-codex-service-tier-thread-inherit"));
    assert!(script.contains("data-codex-service-tier-thread-standard"));
    assert!(script.contains("data-codex-service-tier-thread-fast"));
    assert!(script.contains("global-standard"));
    assert!(script.contains("global-fast"));
    assert!(script.contains("defaultMode"));
    assert!(script.contains("codexServiceTierEffectiveThreadMode"));
    assert!(script.contains("codexServiceTierDefaultModeForControlMode"));
    assert!(script.contains("normalizeCodexServiceTierControlMode(state.mode) !== \"custom\""));
    assert!(script.contains("state.draft = null"));
    assert!(script.contains("后端未连接，无法切换服务模式"));
    assert!(script.contains("未连接"));
    assert!(script.contains("thread/start"));
    assert!(script.contains("thread/resume"));
    assert!(script.contains("turn/start"));
    assert!(script.contains("send-cli-request-for-host"));
    assert!(script.contains("start-conversation"));
    assert!(script.contains("applyCodexServiceTierRequestOverride(\"thread/start\", message)"));
    assert!(script.contains("codex-service-tier-badge"));
    assert!(script.contains("installCodexServiceTierBadge"));
    assert!(script.contains("toggleCodexServiceTierFromBadge"));
    assert!(script.contains("wireCodexServiceTierBadge"));
    assert!(script.contains("codexServiceTierBadgePlacement"));
    assert!(script.contains("codexServiceTierBadgeFooterGroup"));
    assert!(script.contains("codexServiceTierFindComposerEl"));
    assert!(script.contains("codexServiceTierVisibleComposerFooters"));
    assert!(script.contains("codexServiceTierBestComposerFooter"));
    assert!(script.contains("codexServiceTierComposerCandidates"));
    assert!(script.contains("codexServiceTierComposerScore"));
    assert!(script.contains("data-codex-service-tier-badge"));
    assert!(script.contains("codexServiceTierBadgeWired"));
    assert!(script.contains("setAttribute(\"role\", \"button\")"));
    assert!(script.contains("setAttribute(\"tabindex\", \"0\")"));
    assert!(script.contains("继承 Codex 默认设置"));
    assert!(script.contains("继承 config.toml"));
    assert!(script.contains("serviceTierInheritSourceLabel"));
    assert!(script.contains("resolveInheritedServiceTier"));
    assert!(script.contains("getConfigTomlServiceTier"));
    assert!(script.contains("catalog.service_tier"));
    assert!(script.contains("service_tier=\\\"priority\\\""));
    assert!(script.contains("Fast 仅支持"));
    assert!(script.contains("当前 thread"));
    assert!(script.contains("standard"));
    assert!(script.contains("fast"));
    assert!(script.contains("[\"setting-storage-\", \"app-initial-\"]"));
    assert!(script.contains("[\"setting-storage-\", \"vscode-api-\", \"app-initial-\"]"));
    assert!(script.contains("[\"vscode-api-\", \"app-initial-\"]"));
    assert!(script.contains("codexSettingStorageFromModule"));
    assert!(script.contains("codexStateApiFromModule"));
    assert!(script.contains("message.type === \"fetch\""));
    assert!(script.contains("vscode://codex/"));
    assert!(script.contains("./(?:assets/)?"));
    assert!(script.contains("dispatcher export unavailable"));
    assert!(!script.contains("data-codex-max-reasoning-control"));
    assert!(!script.contains("codexAppMaxReasoningOverride"));
}

#[test]
fn injection_script_prompts_for_markdown_export_path_when_supported() {
    let script = assets::injection_script(57321);

    assert!(script.contains("showSaveFilePicker"));
    assert!(script.contains("suggestedName: filename"));
    assert!(script.contains("createWritable()"));
    assert!(script.contains("await writable.write(markdown)"));
    assert!(script.contains("status: \"cancelled\""));
    assert!(script.contains("导出已取消"));
}

#[test]
fn injection_script_discovers_vscode_api_asset_without_hardcoded_hash() {
    let script = assets::injection_script(57321);

    assert!(script.contains("[\"vscode-api-\", \"app-initial-\"]"));
    assert!(script.contains("loadCodexAppModule(assetPrefix)"));
    assert!(script.contains("codexAppAssetUrlFromScriptText"));
    assert!(script.contains("fetch(src"));
    assert!(!script.contains("vscode-api-Dc9pX2Bc.js"));
    assert!(!script.contains("import(\"./assets/vscode-api-"));
}

#[test]
fn injection_script_discovers_dispatcher_by_runtime_shape_when_named_assets_are_absent() {
    // Given: a Codex App build whose dispatcher is no longer in a named asset.
    let script = assets::injection_script(57321);

    // When: Codex++ builds its renderer injection script.
    // Then: the script includes a shape-based fallback over loaded asset modules.
    assert!(script.contains("codexServiceTierDispatcherAssetUrls"));
    assert!(script.contains("source.includes(\"dispatchHostMessage\")"));
    assert!(script.contains("source.includes(\"dispatchMessage\")"));
    assert!(script.contains("source.includes(\"subscribe\")"));
    assert!(script.contains("runtime-scan:"));
}

#[test]
fn injection_script_supports_css_module_composer_footer() {
    // Given: a Codex App build whose composer footer uses a CSS-module class.
    let script = assets::injection_script(57321);

    // When: Codex++ builds its service-tier badge locator.
    // Then: it can find a visible footer through the live contenteditable composer.
    assert!(script.contains("[class*='_footer_']"));
    assert!(script.contains("[contenteditable='true']"));
}

#[test]
fn injection_script_uses_native_fast_indicator_beside_model_name() {
    let script = assets::injection_script(57321);
    let scan = script
        .find("function scanDeferred")
        .expect("script should define the deferred scan");
    let scan_body = &script[scan..script[scan..]
        .find("function runScanStep")
        .map(|offset| scan + offset)
        .expect("deferred scan should end before its wrapper")];

    assert!(scan_body.contains("removeCodexServiceTierBadges();"));
    assert!(!scan_body.contains("installCodexServiceTierBadge();"));
    assert!(scan_body.contains("syncCodexNativeServiceTierPicker();"));
    assert!(script.contains("function syncCodexNativeServiceTierPicker"));
    assert!(script.contains("updateQueue?.memoCache?.data"));
    assert!(script.contains("isServiceTierAllowed"));
    assert!(script.contains("selectedServiceTier"));
    assert!(script.contains("serviceTierForRequest"));
    assert!(script.contains("codexServiceTierForceNativePickerRefresh"));
    assert!(script.contains("installCodexNativeServiceTierSelectionSync"));
    assert!(script.contains("codexNativeServiceTierModeFromMenuItem"));
    assert!(script.contains("label === candidate || label.startsWith(candidate)"));
    assert!(script.contains("syncCodexNativeSolidFastIcon"));
    assert!(script.contains("data-codex-service-tier-icon=\"solid\""));

    let icon_sync = script
        .find("function syncCodexNativeSolidFastIcon")
        .expect("script should define the native Fast icon synchronizer");
    let icon_sync_body = &script[icon_sync
        ..script[icon_sync..]
            .find("function codexNativeServiceTierMemoValues")
            .map(|offset| icon_sync + offset)
            .expect("icon synchronizer should end before the native memo helper")];
    assert!(icon_sync_body.contains("patchCodexNativeSolidFastIcon"));
    assert!(!icon_sync_body.contains("codexServiceTierState.effectiveMode"));
}

#[test]
fn injection_script_places_service_tier_control_in_native_model_menu() {
    let script = assets::injection_script(57321);

    assert!(script.contains("installCodexServiceTierMenu"));
    assert!(script.contains("data-codex-service-tier-menu-trigger"));
    assert!(script.contains("data-codex-service-tier-menu-content"));
    assert!(script.contains("data-model-picker-model-row"));
    assert!(script.contains("速度"));
    assert!(script.contains("默认速度"));
    assert!(script.contains("1.5 倍速度，用量更多"));
    assert!(
        script
            .contains("setCodexServiceTierModeFromMenu(mode, selectionContext, selectionRevision)")
    );
    assert!(script.contains("menuitemradio"));
    assert!(script.contains("aria-checked"));
    assert!(script.contains("aria-activedescendant"));
    assert!(script.contains("__codexServiceTierMenuKeyboardVersion"));
    assert!(script.contains("event.stopImmediatePropagation()"));
    assert!(script.contains("codexServiceTierMenuFocusOption"));
    assert!(script.contains("ArrowDown"));
    assert!(script.contains("ArrowUp"));
    assert!(script.contains("event.key === \"Home\""));
    assert!(script.contains("event.key === \"End\""));
    assert!(script.contains("cursor-not-allowed opacity-50"));
    assert!(script.contains("ensureCodexServiceTierMenuBackendReady"));
    assert!(script.contains("codexServiceTierMenuContext"));
    assert!(script.contains("selectionRevision !== codexServiceTierMenuSelectionRevision"));
    assert!(script.contains("++codexServiceTierMenuSelectionRevision"));
    assert!(script.contains("任务已切换，请在当前任务重新选择服务模式"));
    assert!(script.contains("content.contains(activeOption) ? activeOption : fallbackOption"));
    assert!(script.contains("watchCodexServiceTierMenuLifecycle"));
    assert!(script.contains("parentMenu.isConnected"));

    let relevance = script
        .find("function scanRelevantSelector")
        .expect("script should define scan relevance");
    let relevance_body = &script[relevance
        ..script[relevance..]
            .find("function nodeSelfOrAncestorMatchesScanRelevance")
            .map(|offset| relevance + offset)
            .expect("scan relevance should end before the node matcher")];
    assert!(relevance_body.contains("[data-model-picker-model-row]"));

    let backend_check = script
        .find("async function ensureCodexServiceTierMenuBackendReady")
        .expect("script should define the live backend check");
    let backend_check_body = &script[backend_check
        ..script[backend_check..]
            .find("function codexServiceTierMenuContext")
            .map(|offset| backend_check + offset)
            .expect("backend check should end before the menu context helper")];
    assert!(backend_check_body.contains("postJson(\"/backend/status\", {})"));
    assert!(!backend_check_body.contains("status === \"ok\") return true"));

    let scan = script
        .find("function scanDeferred")
        .expect("script should define the deferred scan");
    let scan_body = &script[scan..script[scan..]
        .find("function runScanStep")
        .map(|offset| scan + offset)
        .expect("deferred scan should end before its wrapper")];
    assert!(scan_body.contains("installCodexServiceTierMenu();"));
    assert!(scan_body.contains("removeCodexServiceTierBadges();"));
    assert!(scan_body.contains("syncCodexNativeServiceTierPicker();"));
}

#[test]
fn injection_script_anchors_floating_menu_before_open_location_button() {
    let script = assets::injection_script(57321);

    assert!(script.contains("function isCodexHeaderOpenLocationButton(button)"));
    assert!(script.contains("打开位置|Open location"));
    assert!(script.contains("if (isCodexHeaderOpenLocationButton(button)) return true;"));
}

#[test]
fn injection_script_falls_back_when_legacy_service_tier_state_api_is_absent() {
    // Given: a Codex App build without the legacy setting-storage and vscode-api assets.
    let script = assets::injection_script(57321);

    // When: Codex++ reads the inherited service tier.
    // Then: missing legacy assets resolve to the declared default instead of a failed control.
    assert!(script.contains("message.includes(`未找到 Codex App asset:`)"));
    assert!(script.contains("return codexDefaultServiceTierSetting.default;"));
}

#[test]
fn injection_script_bounds_service_tier_state_read_time() {
    let script = assets::injection_script(57321);
    let loader = script
        .find("async function loadCodexServiceTierState")
        .expect("script should define the service-tier state loader");
    let loader_body = &script[loader
        ..script[loader..]
            .find("function setCodexThreadServiceTierMode")
            .map(|offset| loader + offset)
            .expect("state loader should end before the thread-mode setter")];

    assert!(script.contains("codexServiceTierReadTimeoutMs"));
    assert!(loader_body.contains("Promise.race"));
    assert!(loader_body.contains("codexDefaultServiceTierSetting.default"));
}

#[test]
fn injection_script_discovers_app_server_request_clients_without_hardcoded_hash() {
    let script = assets::injection_script(57321);

    assert!(script.contains("loadAppServerRequestCandidates"));
    assert!(script.contains("appServerFallbackAssetUrls"));
    assert!(script.contains("[\"use-host-config-\", \"app-server-manager-signals-\"]"));
    assert!(script.contains("loadOptionalCodexAppModule(assetPrefix)"));
    assert!(script.contains("candidateCount: candidates.length"));
    assert!(script.contains("discovery:"));
    // Keep legacy lookup as first attempt, but never hardcode the old hashed filename.
    assert!(
        !script.contains("app-server-manager-signals-C1h8B-R-.js")
            || script.contains("refreshRecentConversationsForHost")
    );
}

#[test]
fn injection_script_refreshes_sidebar_after_undo_without_stale_asset_exports() {
    let script = assets::injection_script(57321);

    assert!(script.contains("loadOptionalCodexAppModule(\"app-server-manager-signals-\")"));
    assert!(script.contains("Object.values(signals || {}).find"));
    assert!(script.contains("refresh-recent-conversations-for-host"));
    assert!(script.contains("const refreshed = await refreshRecentConversationsForHost()"));
    assert!(script.contains("if (!refreshed) window.location.reload()"));
    assert!(!script.contains("app-server-manager-signals-C1h8B-R-.js"));
    assert!(!script.contains("typeof signals.rn"));
}

#[test]
fn injection_script_clears_project_state_when_moving_to_projectless() {
    let script = assets::injection_script(57321);

    assert!(script.contains("async function clearThreadWorkspaceHints"));
    assert!(script.contains("async function clearThreadWritableRoots"));
    assert!(script.contains("async function clearThreadProjectlessOutputDirectories"));
    assert!(script.contains("thread-workspace-root-hints"));
    assert!(script.contains("thread-writable-roots"));
    assert!(script.contains("thread-projectless-output-directories"));
    assert!(script.contains("await clearThreadWorkspaceHints(ref)"));
    assert!(script.contains("await clearThreadWritableRoots(ref)"));
    assert!(script.contains("await clearThreadProjectlessOutputDirectories(ref)"));
}

#[test]
fn injection_script_applies_fast_service_tier_contract() {
    let cases = run_service_tier_contract_harness();

    assert_eq!(cases["supportedFast"]["serviceTier"], "priority");
    assert_eq!(cases["supportedFast"]["service_tier"], "priority");

    assert_eq!(
        cases["unsupportedModel"]["serviceTier"],
        serde_json::Value::Null
    );
    assert_eq!(
        cases["unsupportedModel"]["service_tier"],
        serde_json::Value::Null
    );

    assert_eq!(cases["turnWithoutModel"]["serviceTier"], "priority");
    assert_eq!(cases["turnWithoutModelDiagnosticModel"], "gpt-5.4");

    assert_eq!(
        cases["customInheritUnsupported"]["serviceTier"],
        serde_json::Value::Null
    );
    assert_eq!(
        cases["customInheritUnsupported"]["service_tier"],
        serde_json::Value::Null
    );

    assert_eq!(cases["inheritUnsetStatus"], "继承 Codex 默认设置：默认");
    assert_eq!(cases["inheritFastStatus"], "继承 Codex 默认设置：fast");
    assert_eq!(
        cases["inheritStandardStatus"],
        "继承 Codex 默认设置：standard"
    );
    assert_eq!(
        cases["inheritConfigTomlFastStatus"],
        "继承 config.toml：fast"
    );
    assert_eq!(cases["resolvedConfigTomlTier"]["configServiceTier"], "fast");
    assert_eq!(
        cases["resolvedConfigTomlTier"]["serviceTierSource"],
        "config-toml"
    );
    assert_eq!(
        cases["resolvedUnsetTier"]["configServiceTier"],
        serde_json::Value::Null
    );
    assert_eq!(
        cases["resolvedUnsetTier"]["serviceTierSource"],
        serde_json::Value::Null
    );
    assert_eq!(
        cases["inheritedConfigFastBlocked"]["serviceTier"],
        serde_json::Value::Null
    );
    assert_eq!(
        cases["inheritedConfigFastBlocked"]["service_tier"],
        serde_json::Value::Null
    );

    assert_eq!(cases["startConversation"]["serviceTier"], "priority");
    assert_eq!(cases["fetchStartConversation"]["serviceTier"], "priority");
    assert_eq!(
        cases["fetchSendCliRequest"]["params"]["serviceTier"],
        "priority"
    );
    assert_eq!(
        cases["fetchSendCliRequest"]["params"]["service_tier"],
        "priority"
    );
    assert_eq!(cases["solFastAvailability"]["supported"], true);
    assert_eq!(
        cases["solFastDescriptor"]["additionalSpeedTiers"],
        json!(["fast"])
    );
    assert_eq!(
        cases["solFastDescriptor"]["serviceTiers"][0]["id"],
        "priority"
    );
    assert_eq!(
        cases["existingSolDescriptor"]["serviceTiers"][0]["id"],
        "priority"
    );
    assert_eq!(
        cases["modelListResult"]["data"][0]["serviceTiers"][0]["id"],
        "priority"
    );
    assert_eq!(cases["solDescriptor"]["defaultReasoningEffort"], "low");
    assert_eq!(
        cases["solDescriptor"]["supportedReasoningEfforts"][4]["reasoningEffort"],
        "max"
    );
    assert_eq!(
        cases["solDescriptor"]["supportedReasoningEfforts"][5]["reasoningEffort"],
        "ultra"
    );
    assert_eq!(cases["dispatcherFromSingleton"], true);
    assert_eq!(cases["dispatcherFromCurrentSingleton"], true);
    assert_eq!(cases["dispatcherFromClass"], true);
    assert_eq!(cases["nativeAuthRefresh"]["selectedAuthDispatch"], true);
    assert_eq!(cases["nativeAuthRefresh"]["unrelatedDispatchCalls"], 0);
    assert_eq!(cases["nativeAuthRefresh"]["authMethod"], "apikey");
    assert_eq!(cases["nativeAuthRefresh"]["sameReference"], false);
    assert_eq!(
        cases["reactFiberKeys"],
        json!(["__reactFiber$test", "__reactProps$test"])
    );
    assert_eq!(cases["semanticModelMenuRowFound"], true);
    assert_eq!(cases["solidFastIcon"]["patched"], true);
    assert_eq!(cases["solidFastIcon"]["viewBox"], "0 0 24 24");
    assert_eq!(cases["solidFastIcon"]["marker"], "solid");
    assert_eq!(cases["solidFastIcon"]["fill"], "currentColor");
    assert_eq!(cases["solidFastIcon"]["solidPath"], true);
    assert_eq!(cases["unrelatedFastIconPatched"], false);
    assert_eq!(cases["nativeSelectionStandard"]["mode"], "global-standard");
    assert_eq!(cases["nativeSelectionStandard"]["defaultMode"], "standard");
    assert_eq!(cases["nativeSelectionStandardGuard"]["mode"], "standard");
    assert_eq!(cases["nativeSelectionStandardGuard"]["active"], true);
    assert_eq!(cases["nativeSelectionFast"]["mode"], "global-fast");
    assert_eq!(cases["nativeSelectionFast"]["defaultMode"], "fast");
    assert_eq!(cases["nestedNativeMenuStandard"], "standard");
    assert_eq!(cases["nestedNativeMenuFast"], "fast");
    assert_eq!(cases["legacySettingStorage"], true);
    assert_eq!(cases["currentSettingStorage"], true);
    assert_eq!(cases["capabilitySettingStorage"], true);
    assert_eq!(cases["legacyStateApi"], true);
    assert_eq!(cases["currentStateApi"], true);
    assert_eq!(cases["currentHeaderFound"], true);
    assert_eq!(cases["panelHeaderRejected"], true);
    assert_eq!(cases["textOnlyOpenLocationRecognized"], true);
    assert_eq!(cases["floatingMenuRightBoundary"], 1568.0);
    assert_eq!(cases["nativeMenuInsertionWithExternalStatus"], true);
    assert_eq!(cases["currentHeaderMountSchedulesScan"], true);
    assert_eq!(cases["composerFastIconReplacementSchedulesScan"], true);
    assert_eq!(cases["delayedNativeMenuRetryAvailable"], true);
    assert_eq!(cases["delayedNativeMenuRetryScheduled"], true);
    assert_eq!(cases["delayedNativeMenuHiddenWhileWaiting"], true);
    assert_eq!(cases["delayedNativeMenuRetryUsesLowFrequencyDelay"], true);
    assert_eq!(cases["delayedNativeMenuRetryPersists"], true);
    assert_eq!(cases["delayedNativeMenuRetryMigrated"], true);
    assert_eq!(cases["delayedNativeMenuRetryStopped"], true);
    assert_eq!(cases["nativePlacementNotifiesStatusRender"], true);
    assert_eq!(cases["statusUiMutationIgnored"], true);
    assert_eq!(cases["conversationViewFirstOffset"], 96.0);
    assert_eq!(cases["conversationViewRepeatedOffset"], 96.0);
    assert_eq!(cases["conversationViewInitialFrameBudget"], 2);
    assert_eq!(cases["conversationViewResizeFrameBudget"], 1);
    assert_eq!(cases["conversationViewPollFrameBudget"], 1);
    assert_eq!(cases["appServerParamsUnchanged"], true);
    assert_eq!(cases["appServerSentCount"], 2);
    assert_eq!(
        cases["providerFromMissing"]["modelProvider"],
        "vendor_alpha"
    );
    assert_eq!(cases["providerFromOpenAi"]["modelProvider"], "vendor_alpha");
    assert_eq!(cases["providerFromOtherUnchanged"], true);
    assert_eq!(cases["nonThreadProviderUnchanged"], true);
    assert_eq!(
        cases["providerWithServiceTierControlsDisabled"]["modelProvider"],
        "vendor_alpha"
    );
    assert_eq!(cases["appServerProviderOverride"], "vendor_alpha");
    assert_eq!(cases["directThreadStartedId"], "thread-mobile-direct");
    assert_eq!(cases["nestedThreadStartedId"], "thread-mobile-nested");
    assert_eq!(
        cases["browserUseRouteThreadId"],
        "thread-mobile-browser-route"
    );
    assert_eq!(cases["inactiveBrowserUseUnscheduled"], true);
    assert_eq!(cases["remoteRecoveryScheduled"], true);
    assert_eq!(cases["remoteRecoveryThreadId"], "thread-mobile-notify");
    assert_eq!(cases["remoteRecoveryCallCountAfterSuccess"], 1);
    assert_eq!(cases["remoteRecoveryDispatcherInstalled"], true);
    assert_eq!(
        cases["remoteRecoveryDispatcherThreadId"],
        "thread-mobile-dispatcher"
    );
    assert_eq!(
        cases["remoteRecoveryBrowserUseDispatcherThreadId"],
        "thread-mobile-browser-dispatcher"
    );
    assert_eq!(
        cases["remoteRecoveryOutboundRouteThreadId"],
        "thread-mobile-browser-outbound"
    );
    assert_eq!(cases["remoteRecoveryListenerInstalled"], true);
    assert_eq!(
        cases["remoteRecoveryViewEventThreadId"],
        "thread-mobile-view-event"
    );
    assert_eq!(cases["remoteRecoveryRetried"], true);
    assert_eq!(cases["remoteRecoveryRetryAttempts"], json!([0, 1]));
    assert_eq!(cases["missingActiveProviderUnchanged"], true);
    assert_eq!(cases["missingActiveRecoveryUnscheduled"], true);
    assert_eq!(cases["pureApiProviderUnchanged"], true);
    assert_eq!(cases["pureApiRecoveryUnscheduled"], true);
    assert_eq!(cases["pureOfficialProviderUnchanged"], true);
}

#[test]
fn injection_script_handles_irrelevant_mutations_without_runtime_errors() {
    let cases = run_service_tier_contract_harness();

    assert_eq!(cases["irrelevantMutationScanSucceeded"], true);
}

#[test]
fn injection_script_places_menu_in_home_header_action_slot() {
    let cases = run_service_tier_contract_harness();

    assert_eq!(cases["homeHeaderInsertionUsesActionSlot"], true);
}

#[test]
fn injection_script_normalizes_logical_direction_group_classes() {
    let cases = run_service_tier_contract_harness();

    assert_eq!(cases["logicalDirectionGroupClassesNormalized"], true);
}

fn run_service_tier_contract_harness() -> serde_json::Value {
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let script_path = temp.path().join("renderer-inject.js");
    let harness_path = temp.path().join("service-tier-harness.cjs");
    std::fs::write(&script_path, assets::injection_script(57321))
        .expect("injection script should be written");
    let mut harness = std::fs::File::create(&harness_path).expect("harness should be created");
    write!(
        harness,
        r#"
const scriptPath = {script_path};
const store = new Map();
store.set("codexPlusSettings", JSON.stringify({{
  serviceTierControls: true,
  nativeMenuPlacement: true,
}}));
function node() {{
  return {{
    appendChild() {{}},
    prepend() {{}},
    remove() {{}},
    setAttribute() {{}},
    removeAttribute() {{}},
    addEventListener() {{}},
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
    closest() {{ return null; }},
    classList: {{ add() {{}}, remove() {{}}, toggle() {{}}, contains() {{ return false; }} }},
    dataset: {{}},
    style: {{}},
    children: [],
    isConnected: true,
    textContent: "",
    innerHTML: "",
  }};
}}
globalThis.window = globalThis;
window.__CODEX_PLUS_TEST_SERVICE_TIER__ = true;
const windowListeners = new Map();
window.addEventListener = (type, listener) => windowListeners.set(type, listener);
window.removeEventListener = (type, listener) => {{
  if (windowListeners.get(type) === listener) windowListeners.delete(type);
}};
globalThis.document = {{
  scripts: [],
  documentElement: node(),
  body: node(),
  createElement: () => node(),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {{}},
  removeEventListener() {{}},
}};
globalThis.localStorage = {{
  getItem: (key) => store.has(key) ? store.get(key) : null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
}};
globalThis.location = {{ href: "https://codex.test/thread/thread-12345678", pathname: "/thread/thread-12345678", search: "", hash: "" }};
window.location = globalThis.location;
globalThis.navigator = {{ userAgent: "node-test" }};
globalThis.performance = {{ getEntriesByType: () => [] }};
require(scriptPath);
const api = window.__codexPlusServiceTierTest;
const normalizedLogicalDirectionClasses = new Set(
  api.normalizeCodexPlusTriggerClassName(
    "native gap-0 rounded-s-none border-s-0 ps-0.5 pe-1.5"
  ).split(/\s+/).filter(Boolean)
);
const logicalDirectionGroupClassesNormalized =
  !["gap-0", "rounded-s-none", "border-s-0", "ps-0.5", "pe-1.5"]
    .some((name) => normalizedLogicalDirectionClasses.has(name))
  && ["native", "gap-1", "rounded-full", "border-l", "px-2"]
    .every((name) => normalizedLogicalDirectionClasses.has(name));
const reactFiberKeys = api.reactFiberKeys({{
  "__reactFiber$test": {{}},
  "__reactProps$test": {{}},
  ordinary: {{}},
}});
const semanticModelMenuRow = {{ ariaLabel: "模型 5.6 Sol" }};
document.querySelectorAll = (selector) => selector.includes('[aria-label^="模型 "]')
  ? [semanticModelMenuRow]
  : [];
const semanticModelMenuRowFound = api.serviceTierMenuModelCandidates().includes(semanticModelMenuRow);
document.querySelectorAll = () => [];
const svgNode = (pathData) => {{
  const attributes = new Map([["viewBox", "0 0 20 20"]]);
  const pathAttributes = new Map([["d", pathData], ["fill", "currentColor"]]);
  const path = {{
    getAttribute: (name) => pathAttributes.get(name) ?? null,
    setAttribute: (name, value) => pathAttributes.set(name, String(value)),
  }};
  return {{
    dataset: {{}},
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    querySelector: (selector) => selector === "path" ? path : null,
    snapshot: () => ({{
      viewBox: attributes.get("viewBox"),
      marker: attributes.get("data-codex-service-tier-icon"),
      fill: pathAttributes.get("fill"),
      path: pathAttributes.get("d"),
    }}),
  }};
}};
const outlineFastSvg = svgNode("M9.80999 17.8302 outline-fast-icon");
const solidFastIconPatched = typeof api.patchNativeFastIcon === "function"
  ? api.patchNativeFastIcon(outlineFastSvg)
  : false;
const solidFastIconSnapshot = outlineFastSvg.snapshot();
const solidFastIcon = {{
  patched: solidFastIconPatched,
  viewBox: solidFastIconSnapshot.viewBox,
  marker: solidFastIconSnapshot.marker,
  fill: solidFastIconSnapshot.fill,
  solidPath: solidFastIconSnapshot.path?.startsWith("M11.9125 21.4125") || false,
}};
const unrelatedFastIconPatched = typeof api.patchNativeFastIcon === "function"
  ? api.patchNativeFastIcon(svgNode("M0 0 unrelated-icon"))
  : false;
api.setServiceTierState({{ serviceTier: "priority", fastTierValue: "priority" }});
api.setServiceTierState({{ status: "ok", serviceTier: "priority", fastTierValue: "priority" }});
api.setModelCatalog({{ status: "ok", model: "gpt-5.4", default_model: "gpt-5.4", models: ["gpt-5.4", "gpt-5.5"] }});

const inheritUnsetStatus = api.statusSummary({{
  controlMode: "inherit",
  threadMode: "inherit",
  defaultMode: "inherit",
  effectiveMode: "standard",
  effectiveServiceTier: null,
}});
const inheritFastStatus = api.statusSummary({{
  controlMode: "inherit",
  threadMode: "inherit",
  defaultMode: "inherit",
  effectiveMode: "fast",
  effectiveServiceTier: "priority",
}});
const inheritStandardStatus = api.statusSummary({{
  controlMode: "inherit",
  threadMode: "inherit",
  defaultMode: "inherit",
  effectiveMode: "standard",
  effectiveServiceTier: "standard",
}});
const inheritConfigTomlFastStatus = api.statusSummary({{
  controlMode: "inherit",
  threadMode: "inherit",
  defaultMode: "inherit",
  effectiveMode: "fast",
  effectiveServiceTier: "fast",
  serviceTierSource: "config-toml",
}});

api.setThreadState({{ mode: "global-fast", defaultMode: "fast", entries: {{}} }});
const supportedFast = api.applyServiceTierOverride("turn/start", {{
  threadId: "thread-12345678",
  model: "gpt-5.4",
  service_tier: null,
}}, "conv-should-not-be-model");

const unsupportedModel = api.applyServiceTierOverride("turn/start", {{
  threadId: "thread-12345678",
  model: "gpt-4.1",
  service_tier: "priority",
}}, "conv-should-not-be-model");

const turnWithoutModel = api.applyServiceTierOverride("turn/start", {{
  threadId: "thread-12345678",
  service_tier: null,
}}, "conversation-should-not-be-model");
const turnWithoutModelDiagnosticModel = api.diagnostics().at(-1)?.detail?.model;

api.setModelCatalog({{ status: "ok", model: "gpt-4.1", default_model: "gpt-4.1", models: ["gpt-4.1"] }});
api.setThreadState({{ mode: "custom", defaultMode: "inherit", entries: {{}}, draft: {{ mode: "inherit", at: Date.now() }} }});
api.setServiceTierState({{ serviceTier: "priority" }});
const customInheritUnsupported = api.applyServiceTierOverride("turn/start", {{
  threadId: "thread-12345678",
  service_tier: "priority",
}}, "");

api.setModelCatalog({{ status: "ok", model: "gpt-5.5", default_model: "gpt-5.5", models: ["gpt-5.5"] }});
api.setThreadState({{ mode: "global-fast", defaultMode: "fast", entries: {{}} }});
const startConversation = api.requestOverride({{
  type: "start-conversation",
  threadId: "thread-12345678",
  model: "gpt-5.5",
}});
const fetchStartConversationEnvelope = api.requestOverride({{
  type: "fetch",
  url: "vscode://codex/start-conversation",
  body: JSON.stringify({{
    threadId: "thread-12345678",
    model: "gpt-5.5",
    serviceTier: null,
  }}),
}});
const fetchStartConversation = JSON.parse(fetchStartConversationEnvelope.body);
const fetchSendCliRequestEnvelope = api.requestOverride({{
  type: "fetch",
  url: "vscode://codex/send-cli-request-for-host",
  body: {{
    hostId: "local",
    method: "thread/start",
    params: {{
      threadId: "thread-12345678",
      model: "gpt-5.5",
      service_tier: null,
    }},
  }},
}});
const fetchSendCliRequest = fetchSendCliRequestEnvelope.body;

api.setModelCatalog({{
  status: "ok",
  model: "gpt-5.6-sol",
  default_model: "gpt-5.6-sol",
  models: ["gpt-5.6-sol"],
  modelMetadata: {{
    "gpt-5.6-sol": {{
      displayName: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({{ reasoningEffort }})),
      additionalSpeedTiers: ["fast"],
      serviceTiers: [{{ id: "priority", name: "Fast" }}],
    }},
  }},
}});
const solFastAvailability = api.fastAvailability("gpt-5.6-sol");
const solFastDescriptor = api.modelDescriptor("gpt-5.6-sol");
const existingSolDescriptor = {{ model: "gpt-5.6-sol", serviceTiers: [] }};
api.applyModelMetadata(existingSolDescriptor, "gpt-5.6-sol");
const modelListResult = api.patchAppServerResult("model/list", {{
  data: [{{ model: "gpt-5.6-sol", serviceTiers: [] }}],
}});
api.setModelCatalog({{
  status: "ok",
  model: "gpt-5.6-sol",
  default_model: "gpt-5.6-sol",
  models: ["gpt-5.6-sol"],
  modelMetadata: {{
    "gpt-5.6-sol": {{
      displayName: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({{ reasoningEffort }})),
    }},
  }},
}});
const solDescriptor = api.modelDescriptor("gpt-5.6-sol");
const singletonDispatcher = {{ dispatchMessage() {{}}, subscribe() {{}} }};
const dispatcherFromSingleton = api.dispatcherFromModule({{ current: singletonDispatcher }}) === singletonDispatcher;
const currentSingletonDispatcher = {{ dispatchMessage() {{}}, subscribe() {{}} }};
const dispatcherFromCurrentSingleton = api.dispatcherFromModule({{
  decoy: singletonDispatcher,
  idt: currentSingletonDispatcher,
}}) === currentSingletonDispatcher;
class DispatcherClass {{
  static instance = new DispatcherClass();
  static getInstance() {{ return this.instance; }}
  dispatchMessage() {{}}
}}
const dispatcherFromClass = api.dispatcherFromModule({{ current: DispatcherClass }}) === DispatcherClass.instance;
let unrelatedDispatchCalls = 0;
const authState = {{ openAIAuth: "apikey", authMethod: "apikey", requiresAuth: false }};
let refreshedAuthState = authState;
const unrelatedDispatch = () => {{ unrelatedDispatchCalls += 1; }};
const authDispatch = (action) => {{
  refreshedAuthState = typeof action === "function" ? action(authState) : action;
}};
const nativeAuthRefreshDispatch = api.nativeAuthRefreshDispatch({{
  memoizedState: {{
    memoizedState: null,
    baseState: null,
    queue: {{ dispatch: unrelatedDispatch }},
    next: {{
      memoizedState: authState,
      baseState: authState,
      queue: {{ dispatch: authDispatch }},
      next: null,
    }},
  }},
  alternate: null,
}});
nativeAuthRefreshDispatch?.(api.nativeAuthRefreshAction);
const nativeAuthRefresh = {{
  selectedAuthDispatch: nativeAuthRefreshDispatch === authDispatch,
  unrelatedDispatchCalls,
  authMethod: refreshedAuthState.authMethod,
  sameReference: refreshedAuthState === authState,
}};
api.setThreadState({{ mode: "inherit", defaultMode: "inherit", entries: {{}} }});
api.syncNativeSelection("standard");
const nativeSelectionStandard = api.threadState();
const nativeSelectionStandardGuard = api.nativeSelectionGuard();
api.syncNativeSelection("fast");
const nativeSelectionFast = api.threadState();
const speedHeader = {{
  textContent: "速度",
  closest: () => null,
}};
const speedWrapper = {{
  textContent: "速度标准默认速度快速1.5 倍速度，用量更多",
  closest: () => null,
}};
const speedMenu = {{
  children: [speedWrapper],
  querySelectorAll: () => [speedWrapper, speedHeader],
}};
const nativeMenuItem = (label) => ({{
  textContent: label,
  getAttribute: (name) => name === "aria-label" ? label : "",
  querySelectorAll: () => [],
  closest: (selector) => selector === '[role="menu"]' ? speedMenu : null,
}});
const nestedNativeMenuStandard = api.nativeModeFromMenuItem(nativeMenuItem("标准默认速度"));
const nestedNativeMenuFast = api.nativeModeFromMenuItem(nativeMenuItem("快速1.5 倍速度，用量更多"));
const legacyGetSetting = async () => "legacy-get";
const legacySetSetting = async () => "legacy-set";
const legacySettingStorageValue = api.settingStorageFromModule({{
  n: legacyGetSetting,
  s: legacySetSetting,
}}, "setting-storage-");
const legacySettingStorage = legacySettingStorageValue.n === legacyGetSetting
  && legacySettingStorageValue.s === legacySetSetting;
const wrongCurrentGetSetting = async () => "wrong-current-get";
const wrongCurrentSetSetting = async () => "wrong-current-set";
const currentGetSetting = async (setting) => {{
  const marker = "get-setting";
  const params = {{ key: setting.key }};
  return marker && params && "current-get";
}};
const currentSetSetting = async (setting, value) => {{
  const marker = "set-setting";
  const params = {{ key: setting.key, value }};
  return marker && params && "current-set";
}};
const currentSettingStorageValue = api.settingStorageFromModule({{
  n: wrongCurrentGetSetting,
  s: wrongCurrentSetSetting,
  jut: currentGetSetting,
  Put: currentSetSetting,
}}, "app-initial-");
const currentSettingStorage = currentSettingStorageValue.n === currentGetSetting
  && currentSettingStorageValue.s === currentSetSetting;
const capabilitySettingStorageValue = api.settingStorageFromModule({{
  randomGetter: currentGetSetting,
  randomSetter: currentSetSetting,
}}, "app-initial-");
const capabilitySettingStorage = capabilitySettingStorageValue.n === currentGetSetting
  && capabilitySettingStorageValue.s === currentSetSetting;
const legacyStateCall = async () => "legacy-state";
const currentStateCall = async () => "current-state";
const legacyStateApi = api.stateApiFromModule({{
  n: legacyStateCall,
  qut: currentStateCall,
}}, "vscode-api-") === legacyStateCall;
const currentStateApi = api.stateApiFromModule({{
  n: legacyStateCall,
  qut: currentStateCall,
}}, "app-initial-") === currentStateCall;
const rect = (left, top, width, height) => ({{
  left,
  right: left + width,
  top,
  bottom: top + height,
  width,
  height,
}});
const openLocationButton = {{
  getAttribute: (name) => name === "aria-label" ? null : null,
  textContent: "打开位置",
}};
const currentHeader = {{
  getBoundingClientRect: () => rect(0, 0, 1792, 46),
  querySelectorAll: (selector) => selector === "button" ? [openLocationButton] : [],
}};
const panelHeader = {{
  getBoundingClientRect: () => rect(1476, 68, 300, 28),
  querySelectorAll: () => [],
}};
const headerRoot = {{
  querySelector: () => null,
  querySelectorAll: (selector) => selector === "header" ? [panelHeader, currentHeader] : [],
}};
const selectedHeader = api.findAppHeader(headerRoot);
const currentHeaderFound = selectedHeader === currentHeader;
const panelHeaderRejected = selectedHeader !== panelHeader;
const textOnlyOpenLocationRecognized = api.isOpenLocationButton(openLocationButton);
currentHeader.contains = () => false;
const floatingHeaderButton = {{
  getBoundingClientRect: () => rect(1428, 0, 72, 30),
}};
const floatingControlRoot = {{
  querySelectorAll: (selector) => selector === "button" ? [floatingHeaderButton] : [],
}};
const floatingMenuRightBoundary = api.floatingMenuRightBoundary(
  currentHeader,
  null,
  rect(1568, 9, 91, 28),
  floatingControlRoot,
);
const nativeMenuBar = {{
  getBoundingClientRect: () => rect(1280, 0, 379, 46),
  querySelectorAll: (selector) => selector === "button" ? [nativeOpenLocationButton] : [],
  closest: () => null,
}};
const nativeOpenLocationGroup = {{ parentElement: nativeMenuBar }};
const nativeOpenLocationButton = {{
  className: "native-text-button",
  textContent: "打开位置",
  parentElement: nativeOpenLocationGroup,
  getAttribute: () => null,
  getBoundingClientRect: () => rect(1568, 9, 91, 28),
  closest: (selector) => selector === ".inline-flex.self-start.items-stretch.overflow-hidden.rounded-lg"
    ? nativeOpenLocationGroup
    : null,
}};
const nativeHeader = {{
  contains: (candidate) => candidate === nativeMenuBar || candidate === nativeOpenLocationButton,
  querySelectorAll: (selector) => selector.includes("ms-auto")
    ? [nativeMenuBar]
    : selector === "button" ? [nativeOpenLocationButton] : [],
}};
const externalTodayButton = {{
  getBoundingClientRect: () => rect(1490, 8, 72, 30),
}};
document.querySelector = (selector) => selector.includes("ApplicationMenuTopBar") ? nativeHeader : null;
document.querySelectorAll = (selector) => selector === "button" ? [externalTodayButton] : [];
document.getElementById = () => null;
const nativeInsertionPoint = api.findNativeMenuInsertionPoint();
const nativeMenuInsertionWithExternalStatus = nativeInsertionPoint?.parent === nativeMenuBar
  && nativeInsertionPoint?.before === nativeOpenLocationGroup;
const homeTitleGrid = {{
  className: "grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4",
}};
const homeActionSlot = {{
  className: "flex items-center justify-end gap-1.5",
  parentElement: homeTitleGrid,
  firstChild: null,
}};
const homeIconButton = {{
  className: "native-icon-button aspect-square",
  closest: () => null,
}};
const homeIconMenuBar = {{
  getBoundingClientRect: () => rect(1730, 9, 28, 28),
  querySelectorAll: (selector) => selector === "button" ? [homeIconButton] : [],
  closest: () => null,
}};
const homeHeader = {{
  querySelectorAll: (selector) => selector.includes("ms-auto")
    ? [homeIconMenuBar]
    : selector === "div" ? [homeActionSlot] : [],
}};
document.querySelector = (selector) => selector.includes("ApplicationMenuTopBar") ? homeHeader : null;
const homeInsertionPoint = api.findNativeMenuInsertionPoint();
const homeHeaderInsertionUsesActionSlot = homeInsertionPoint?.parent === homeActionSlot
  && homeInsertionPoint?.before === null
  && !String(homeInsertionPoint?.nativeButtonClass || "").includes("aspect-square");
document.querySelector = (selector) => selector.includes("ApplicationMenuTopBar") ? nativeHeader : null;
const mountedCurrentHeader = {{
  nodeType: 1,
  closest: () => null,
  matches: (selector) => selector.split(", ").includes("header"),
  querySelector: () => null,
}};
const currentHeaderMountSchedulesScan = api.shouldScheduleScan([{{
  target: {{ nodeType: 3 }},
  addedNodes: [mountedCurrentHeader],
  removedNodes: [],
}}]);
const composerReasoningTrigger = {{
  nodeType: 1,
  closest: (selector) => selector.split(", ").includes('[data-codex-intelligence-trigger="true"]')
    ? composerReasoningTrigger
    : null,
  matches: () => false,
  querySelector: () => null,
}};
const composerFastIconReplacementSchedulesScan = api.shouldScheduleScan([{{
  target: composerReasoningTrigger,
  addedNodes: [],
  removedNodes: [],
}}]);
const statusUiNode = {{
  nodeType: 1,
  closest: (selector) => selector.includes('#codex-live-token-cost') ? statusUiNode : null,
  matches: () => true,
  querySelector: () => null,
}};
const statusUiMutationIgnored = !api.shouldScheduleScan([{{
  target: statusUiNode,
  addedNodes: [],
  removedNodes: [],
}}]);
api.scheduleScan([]);
const irrelevantMutationScanSucceeded = true;
const delayedNativeMenuRetryAvailable = typeof api.scheduleNativeMenuPlacementRetry === "function"
  && typeof api.nativeMenuPlacementRetryState === "function";
let delayedNativeMenuRetryScheduled = false;
let delayedNativeMenuHiddenWhileWaiting = false;
let delayedNativeMenuRetryUsesLowFrequencyDelay = false;
let delayedNativeMenuRetryPersists = false;
let delayedNativeMenuRetryMigrated = false;
let delayedNativeMenuRetryStopped = false;
let nativePlacementNotifiesStatusRender = false;
if (delayedNativeMenuRetryAvailable) {{
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const originalDocumentGetElementById = document.getElementById;
  const originalDocumentQuerySelector = document.querySelector;
  const originalDocumentQuerySelectorAll = document.querySelectorAll;
  const pendingTimers = [];
  const retryTrigger = {{
    className: "",
    dataset: {{ codexPlusTriggerInstalled: "5" }},
    querySelector: () => null,
    prepend() {{}},
  }};
  const retryMenu = {{
    id: "codex-plus-menu",
    className: "codex-plus-menu-floating",
    dataset: {{ codexPlusMenu: "true", codexPlusMenuVersion: "6" }},
    hidden: false,
    parentElement: document.documentElement,
    nextSibling: null,
    style: {{ removeProperty() {{}} }},
    querySelector: (selector) => selector === "button" ? retryTrigger : null,
    classList: {{
      contains: (name) => retryMenu.className.split(/\s+/).includes(name),
    }},
  }};
  let delayedHeaderMounted = false;
  let statusRenderCalls = 0;
  window.__codexLiveTokenCost = {{ render: () => {{ statusRenderCalls += 1; }} }};
  nativeMenuBar.insertBefore = (candidate) => {{
    candidate.parentElement = nativeMenuBar;
    candidate.className = "";
  }};
  window.setTimeout = (callback, delay) => {{
    const id = pendingTimers.length + 1;
    pendingTimers.push({{ id, callback, delay, cleared: false, fired: false }});
    return id;
  }};
  window.clearTimeout = (id) => {{
    const timer = pendingTimers.find((candidate) => candidate.id === id);
    if (timer) timer.cleared = true;
  }};
  document.getElementById = (id) => id === "codex-plus-menu" ? retryMenu : null;
  document.querySelector = (selector) => delayedHeaderMounted && selector.includes("ApplicationMenuTopBar")
    ? nativeHeader
    : null;
  document.querySelectorAll = (selector) => selector === "button" ? [externalTodayButton] : [];

  api.scheduleNativeMenuPlacementRetry();
  const nextPendingTimer = () => pendingTimers.find((timer) => !timer.cleared && !timer.fired);
  const firstRetryTimer = nextPendingTimer();
  delayedNativeMenuRetryScheduled = !!firstRetryTimer;
  delayedNativeMenuHiddenWhileWaiting = retryMenu.hidden === true;
  delayedNativeMenuRetryUsesLowFrequencyDelay = firstRetryTimer?.delay === 500;
  for (let index = 0; index < 8; index += 1) {{
    const timer = nextPendingTimer();
    if (!timer) break;
    timer.fired = true;
    timer.callback();
  }}
  delayedNativeMenuRetryPersists = api.nativeMenuPlacementRetryState().timerActive === true
    && !!nextPendingTimer();
  delayedHeaderMounted = true;
  const nativePlacementTimer = nextPendingTimer();
  if (nativePlacementTimer) {{
    nativePlacementTimer.fired = true;
    nativePlacementTimer.callback();
  }}
  const retryState = api.nativeMenuPlacementRetryState();
  delayedNativeMenuRetryMigrated = retryMenu.parentElement === nativeMenuBar
    && retryMenu.className === ""
    && retryMenu.hidden === false;
  delayedNativeMenuRetryStopped = retryState.timerActive === false
    && retryState.attempt === 0;
  nativePlacementNotifiesStatusRender = statusRenderCalls === 1;

  window.setTimeout = originalSetTimeout;
  window.clearTimeout = originalClearTimeout;
  document.getElementById = originalDocumentGetElementById;
  document.querySelector = originalDocumentQuerySelector;
  document.querySelectorAll = originalDocumentQuerySelectorAll;
  delete window.__codexLiveTokenCost;
}}
const conversationBounds = rect(300, 0, 1192, 900);
const conversationViewFirstOffset = api.conversationViewOffset(
  rect(400, 0, 800, 600),
  conversationBounds,
  896,
  0,
);
const conversationViewRepeatedOffset = api.conversationViewOffset(
  rect(496, 0, 800, 600),
  conversationBounds,
  896,
  conversationViewFirstOffset,
);
const conversationViewInitialFrameBudget = api.conversationViewFrameBudget("initial");
const conversationViewResizeFrameBudget = api.conversationViewFrameBudget("resize");
const conversationViewPollFrameBudget = api.conversationViewFrameBudget("poll");
const nativeAppServerParams = {{
  cwd: "C:/native/work",
  workspaceRoots: ["C:/native/work"],
  workspaceKind: "project",
  projectAssignment: {{ projectKind: "local", projectId: "C:/native/work" }},
}};
const appServerCalls = [];
const appServerClient = {{
  async sendRequest(method, params, options) {{
    appServerCalls.push({{ method, params, options }});
    return {{ ok: true }};
  }},
}};
api.patchAppServerClient(appServerClient);

appServerClient.sendRequest("start-conversation", nativeAppServerParams, {{ signal: "native" }}).then(async () => {{
api.setModelCatalog({{ status: "ok", model: "gpt-5.4", default_model: "gpt-5.4", models: ["gpt-5.4"], service_tier: "fast" }});
const resolvedConfigTomlTier = await api.resolveInheritedServiceTier();
api.setModelCatalog({{ status: "ok", model: "gpt-5.4", default_model: "gpt-5.4", models: ["gpt-5.4"] }});
const resolvedUnsetTier = await api.resolveInheritedServiceTier();
api.setModelCatalog({{ status: "ok", model: "gpt-4.1", default_model: "gpt-4.1", models: ["gpt-4.1"] }});
api.setThreadState({{ mode: "inherit", defaultMode: "inherit", entries: {{}} }});
api.setServiceTierState({{ status: "ok", serviceTier: null, configServiceTier: "fast", serviceTierSource: "config-toml" }});
const inheritedConfigFastBlocked = api.applyServiceTierOverride("turn/start", {{
  threadId: "thread-12345678",
  model: "gpt-4.1",
  service_tier: null,
}}, "");
const appServerParamsUnchanged = appServerCalls[0]?.params === nativeAppServerParams
  && appServerCalls[0]?.params?.workspaceKind === "project"
  && appServerCalls[0]?.params?.cwd === "C:/native/work"
  && appServerCalls[0]?.params?.projectAssignment?.projectId === "C:/native/work";
api.setBackendSettings({{
  relayProfilesEnabled: true,
  activeRelayId: "custom-relay",
  relayProfiles: [{{ id: "custom-relay", relayMode: "official", officialMixApiKey: true }}],
}});
api.setModelCatalog({{
  status: "ok",
  model: "gpt-5.6-sol",
  default_model: "gpt-5.6-sol",
  model_provider: "relay-ms0ihvx9",
  codex_model_provider: "vendor_alpha",
  models: ["gpt-5.6-sol"],
}});
localStorage.setItem("codexPlusSettings", JSON.stringify({{ serviceTierControls: false }}));
const providerFromMissing = api.applyProviderOverride("thread/start", {{ cwd: "C:/mobile" }});
const providerFromOpenAi = api.applyProviderOverride("thread/start", {{ cwd: "C:/mobile", modelProvider: "openai" }});
const explicitOtherProvider = {{ cwd: "C:/mobile", modelProvider: "other" }};
const providerFromOther = api.applyProviderOverride("thread/start", explicitOtherProvider);
const nonThreadParams = {{ cwd: "C:/mobile", modelProvider: "openai" }};
const nonThreadProviderUnchanged = api.applyProviderOverride("turn/start", nonThreadParams) === nonThreadParams;
const providerWithServiceTierControlsDisabled = api.requestOverride({{
  type: "start-conversation",
  cwd: "C:/mobile",
  modelProvider: "openai",
}});
await appServerClient.sendRequest("thread/start", {{ cwd: "C:/mobile", modelProvider: "openai" }}, {{ signal: "mobile" }});
const appServerProviderOverride = appServerCalls[1]?.params?.modelProvider;
const directThreadStartedId = api.remoteSessionStartedThreadId({{
  method: "thread/started",
  params: {{ thread: {{ id: "thread-mobile-direct" }} }},
}});
const nestedThreadStartedId = api.remoteSessionStartedThreadId({{
  type: "mcp-response",
  message: {{ method: "thread/started", params: {{ thread: {{ id: "thread-mobile-nested" }} }} }},
}});
const browserUseRouteThreadId = api.remoteSessionStartedThreadId({{
  type: "browser-use-session-route-capture",
  conversationId: "thread-mobile-browser-route",
}});
const inactiveBrowserUseUnscheduled = api.observeRemoteSessionNotification({{
  type: "browser-sidebar-browser-use-state",
  conversationId: "thread-mobile-browser-inactive",
  isActive: false,
}}) === false;
const remoteRecoveryCalls = [];
const remoteRecoveryDispatcherHandlers = new Map();
const remoteRecoveryDispatcher = {{
  subscribe(type, callback) {{
    remoteRecoveryDispatcherHandlers.set(type, callback);
    return () => remoteRecoveryDispatcherHandlers.delete(type);
  }},
}};
window.__CODEX_PLUS_TEST_REMOTE_RECOVERY__ = (payload, attempt) => {{
  remoteRecoveryCalls.push({{ payload, attempt }});
  return {{ status: "synced", message: "Remote Control session catalog recovery complete" }};
}};
const remoteRecoveryScheduled = api.observeRemoteSessionNotification({{
  response: {{ method: "thread/started", params: {{ thread: {{ id: "thread-mobile-notify" }} }} }},
}});
await new Promise((resolve) => setTimeout(resolve, 500));
const remoteRecoveryCallCountAfterSuccess = remoteRecoveryCalls.length;
const remoteRecoveryDispatcherCalls = [];
window.__CODEX_PLUS_TEST_REMOTE_RECOVERY__ = (payload, attempt) => {{
  remoteRecoveryDispatcherCalls.push({{ payload, attempt }});
  return {{ status: "synced", message: "Remote Control session catalog recovery complete" }};
}};
const remoteRecoveryDispatcherInstalled = api.installRemoteSessionDispatcherSubscription(remoteRecoveryDispatcher);
remoteRecoveryDispatcherHandlers.get("thread/started")?.({{ id: "thread-mobile-dispatcher" }});
await new Promise((resolve) => setTimeout(resolve, 500));
const remoteRecoveryDispatcherThreadId = remoteRecoveryDispatcherCalls[0]?.payload?.thread_id || "";
const remoteRecoveryBrowserUseDispatcherCalls = [];
window.__CODEX_PLUS_TEST_REMOTE_RECOVERY__ = (payload, attempt) => {{
  remoteRecoveryBrowserUseDispatcherCalls.push({{ payload, attempt }});
  return {{ status: "synced", message: "Remote Control session catalog recovery complete" }};
}};
remoteRecoveryDispatcherHandlers.get("browser-sidebar-browser-use-state")?.({{
  conversationId: "thread-mobile-browser-dispatcher",
  isActive: true,
}});
await new Promise((resolve) => setTimeout(resolve, 500));
const remoteRecoveryBrowserUseDispatcherThreadId = remoteRecoveryBrowserUseDispatcherCalls[0]?.payload?.thread_id || "";
const remoteRecoveryOutboundRouteCalls = [];
window.__CODEX_PLUS_TEST_REMOTE_RECOVERY__ = (payload, attempt) => {{
  remoteRecoveryOutboundRouteCalls.push({{ payload, attempt }});
  return {{ status: "synced", message: "Remote Control session catalog recovery complete" }};
}};
const outboundDispatcherMessages = [];
const outboundDispatcher = {{
  __codexServiceTierOriginalDispatchMessage(type, payload) {{
    outboundDispatcherMessages.push({{ type, payload }});
    return true;
  }},
}};
api.dispatchMessage(outboundDispatcher, "browser-use-session-route-capture", {{
  conversationId: "thread-mobile-browser-outbound",
}});
await new Promise((resolve) => setTimeout(resolve, 500));
const remoteRecoveryOutboundRouteThreadId = remoteRecoveryOutboundRouteCalls[0]?.payload?.thread_id || "";
const remoteRecoveryViewEventCalls = [];
window.__CODEX_PLUS_TEST_REMOTE_RECOVERY__ = (payload, attempt) => {{
  remoteRecoveryViewEventCalls.push({{ payload, attempt }});
  return {{ status: "synced", message: "Remote Control session catalog recovery complete" }};
}};
const remoteRecoveryListenerInstalled = api.installRemoteSessionRecoveryListener();
windowListeners.get("codex-message-from-view")?.({{
  detail: {{
    type: "browser-use-session-route-capture",
    conversationId: "thread-mobile-view-event",
  }},
}});
await new Promise((resolve) => setTimeout(resolve, 500));
const remoteRecoveryViewEventThreadId = remoteRecoveryViewEventCalls[0]?.payload?.thread_id || "";
const remoteRecoveryRetryCalls = [];
window.__CODEX_PLUS_TEST_REMOTE_RECOVERY__ = (payload, attempt) => {{
  remoteRecoveryRetryCalls.push({{ payload, attempt }});
  if (attempt === 0) {{
    return {{ status: "synced", message: "Remote Control session recovery already up to date" }};
  }}
  return {{ status: "synced", message: "Remote Control session recovery complete" }};
}};
const remoteRecoveryRetried = api.observeRemoteSessionNotification({{
  response: {{ method: "thread/started", params: {{ thread: {{ id: "thread-mobile-retry" }} }} }},
}});
await new Promise((resolve) => setTimeout(resolve, 500));
const remoteRecoveryRetryAttempts = remoteRecoveryRetryCalls.map((call) => call.attempt);
api.setBackendSettings({{
  relayProfilesEnabled: true,
  activeRelayId: "missing",
  relayProfiles: [{{ id: "eligible", relayMode: "official", officialMixApiKey: true }}],
}});
const missingActiveParams = {{ cwd: "C:/mobile", modelProvider: "openai" }};
const missingActiveProviderUnchanged = api.applyProviderOverride("thread/start", missingActiveParams) === missingActiveParams;
const missingActiveRecoveryUnscheduled = api.observeRemoteSessionNotification({{
  method: "thread/started",
  params: {{ thread: {{ id: "thread-mobile-missing-active" }} }},
}}) === false;
api.setBackendSettings({{
  relayProfilesEnabled: true,
  activeRelayId: "pure-api",
  relayProfiles: [{{ id: "pure-api", relayMode: "pureApi", officialMixApiKey: true }}],
}});
const pureApiParams = {{ cwd: "C:/mobile", modelProvider: "openai" }};
const pureApiProviderUnchanged = api.applyProviderOverride("thread/start", pureApiParams) === pureApiParams;
const pureApiRecoveryUnscheduled = api.observeRemoteSessionNotification({{
  method: "thread/started",
  params: {{ thread: {{ id: "thread-mobile-pure-api" }} }},
}}) === false;
api.setBackendSettings({{
  relayProfilesEnabled: true,
  activeRelayId: "official",
  relayProfiles: [{{ id: "official", relayMode: "official", officialMixApiKey: false }}],
}});
const pureOfficialParams = {{ cwd: "C:/mobile", modelProvider: "openai" }};
const pureOfficialProviderUnchanged = api.applyProviderOverride("thread/start", pureOfficialParams) === pureOfficialParams;
process.stdout.write(JSON.stringify({{
  supportedFast,
  unsupportedModel,
  turnWithoutModel,
  turnWithoutModelDiagnosticModel,
  customInheritUnsupported,
  inheritUnsetStatus,
  inheritFastStatus,
  inheritStandardStatus,
  inheritConfigTomlFastStatus,
  resolvedConfigTomlTier,
  resolvedUnsetTier,
  inheritedConfigFastBlocked,
  startConversation,
  fetchStartConversation,
  fetchSendCliRequest,
  solFastAvailability,
  solFastDescriptor,
  existingSolDescriptor,
  modelListResult,
  solDescriptor,
  dispatcherFromSingleton,
  dispatcherFromCurrentSingleton,
  dispatcherFromClass,
  nativeAuthRefresh,
  reactFiberKeys,
  semanticModelMenuRowFound,
  solidFastIcon,
  unrelatedFastIconPatched,
  nativeSelectionStandard,
  nativeSelectionStandardGuard,
  nativeSelectionFast,
  nestedNativeMenuStandard,
  nestedNativeMenuFast,
  legacySettingStorage,
  currentSettingStorage,
  capabilitySettingStorage,
  legacyStateApi,
  currentStateApi,
  currentHeaderFound,
  panelHeaderRejected,
  textOnlyOpenLocationRecognized,
  floatingMenuRightBoundary,
  nativeMenuInsertionWithExternalStatus,
  homeHeaderInsertionUsesActionSlot,
  logicalDirectionGroupClassesNormalized,
  currentHeaderMountSchedulesScan,
  composerFastIconReplacementSchedulesScan,
  statusUiMutationIgnored,
  irrelevantMutationScanSucceeded,
  delayedNativeMenuRetryAvailable,
  delayedNativeMenuRetryScheduled,
  delayedNativeMenuHiddenWhileWaiting,
  delayedNativeMenuRetryUsesLowFrequencyDelay,
  delayedNativeMenuRetryPersists,
  delayedNativeMenuRetryMigrated,
  delayedNativeMenuRetryStopped,
  nativePlacementNotifiesStatusRender,
  conversationViewFirstOffset,
  conversationViewRepeatedOffset,
  conversationViewInitialFrameBudget,
  conversationViewResizeFrameBudget,
  conversationViewPollFrameBudget,
  appServerParamsUnchanged,
  appServerSentCount: appServerCalls.length,
  providerFromMissing,
  providerFromOpenAi,
  providerFromOtherUnchanged: providerFromOther === explicitOtherProvider,
  nonThreadProviderUnchanged,
  providerWithServiceTierControlsDisabled,
  appServerProviderOverride,
  directThreadStartedId,
  nestedThreadStartedId,
  browserUseRouteThreadId,
  inactiveBrowserUseUnscheduled,
  remoteRecoveryScheduled,
  remoteRecoveryThreadId: remoteRecoveryCalls[0]?.payload?.thread_id || "",
  remoteRecoveryCallCountAfterSuccess,
  remoteRecoveryDispatcherInstalled,
  remoteRecoveryDispatcherThreadId,
  remoteRecoveryBrowserUseDispatcherThreadId,
  remoteRecoveryOutboundRouteThreadId,
  remoteRecoveryListenerInstalled,
  remoteRecoveryViewEventThreadId,
  remoteRecoveryRetried,
  remoteRecoveryRetryAttempts,
  missingActiveProviderUnchanged,
  missingActiveRecoveryUnscheduled,
  pureApiProviderUnchanged,
  pureApiRecoveryUnscheduled,
  pureOfficialProviderUnchanged,
}}));
}}).catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"#,
        script_path = serde_json::to_string(&script_path.to_string_lossy().to_string())
            .expect("script path should serialize")
    )
    .expect("harness should be written");
    drop(harness);

    let output = Command::new("node")
        .arg(&harness_path)
        .output()
        .expect("node should run service-tier harness");
    assert!(
        output.status.success(),
        "node harness failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("harness stdout should be JSON")
}

#[test]
fn injection_script_leaves_new_threads_to_the_codex_app() {
    let script = assets::injection_script(57321);

    assert!(!script.contains("installCodexProjectlessNewTaskButtons"));
    assert!(!script.contains("loadCodexAppModule(\"projectless-thread-\")"));
    assert!(!script.contains("projectless_thread_start_overridden"));
    assert!(!script.contains("projectless_app_server_start_overridden"));
    assert!(!script.contains("projectless_main_window_home_route_cleared"));
    assert!(!script.contains("hotkey-window-projectless-default-enabled"));
    assert!(script.contains("installCodexServiceTierDispatcherPatch"));
    assert!(script.contains("installAppServerModelRequestPatch"));
    assert!(script.contains("originalSendRequest(method, nextParams, options)"));
}

#[test]
fn injection_script_restores_thread_scroll_positions() {
    let script = assets::injection_script(57321);

    assert!(script.contains("threadScrollRestore"));
    assert!(script.contains("codexThreadScroll"));
    assert!(script.contains("installThreadScrollRouteHooks"));
    assert!(script.contains("scheduleThreadScrollSync"));
}

#[test]
fn injection_script_installs_upstream_branch_dropdown_adapter() {
    let script = assets::injection_script(57321);

    assert!(script.contains("installUpstreamBranchDropdownAdapter"));
    assert!(!script.contains("installUpstreamPendingWorktreeDispatcherPatch"));
    assert!(script.contains("data-codex-upstream-branch-option"));
    assert!(script.contains("codexUpstreamBranchSelection"));
    assert!(script.contains("/upstream-worktree/defaults"));
    assert!(script.contains("/upstream-worktree/prepare"));
    assert!(script.contains("injectUpstreamBranchOptions"));
    assert!(script.contains("Upstream"));
    assert!(script.contains("data-base-branch"));
    assert!(script.contains("data-project-id"));
    assert!(script.contains("MutationObserver"));
    assert!(script.contains("upstreamWorktreePayloadFromSelection"));
    assert!(script.contains("readUpstreamBranchSelection"));
    assert!(script.contains("writeUpstreamBranchSelection(null)"));
    assert!(script.contains("currentProjectRepoPathFromSelectedProjectButton"));
    assert!(script.contains("currentProjectContextFromStartButton"));
    assert!(script.contains("Start new chat in"));
    assert!(script.contains("codexUpstreamProjectContext"));
    assert!(script.contains("rememberStartNewChatProjectContext"));
    assert!(script.contains("currentProjectContextForBranchMenu"));
    assert!(script.contains("remoteProjectContextFromGlobalState"));
    assert!(script.contains("upstreamBranchDefaultsInflight = new Map()"));
    assert!(script.contains("upstreamRemoteBranchDefaultsCacheTtlMs"));
    assert!(script.contains("upstreamBranchDefaultsInflight.delete(cacheKey)"));
    assert!(script.contains("projectId:"));
    assert!(script.contains("data-codex-upstream-branch-selection-label"));
    assert!(script.contains("syncUpstreamBranchTriggerLabel"));
    assert!(script.contains("syncUpstreamBranchMenuSelection"));
    assert!(!script.contains("applyUpstreamPendingWorktreeOverride"));
    assert!(!script.contains("pending-worktree-create"));
    assert!(script.contains("qualifiedSourceRef"));
    assert!(script.contains("refs/remotes/${remote}/${baseBranch}"));
    assert!(!script.contains("startingState: { ...request.startingState, branchName: sourceRef }"));
    assert!(script.contains("data-codex-upstream-branch-check"));
    assert!(script.contains("data-codex-upstream-branch-icon"));
    assert!(script.contains("branchIconSvg"));
    assert!(script.contains("checkmarkSvg"));
    assert!(script.contains("aria-checked"));
    assert!(script.contains("check.removeAttribute(\"hidden\")"));
    assert!(script.contains("check.setAttribute(\"hidden\", \"\")"));
    assert!(script.contains("handleNativeBranchSelection"));
    assert!(script.contains("clearUpstreamBranchTriggerLabel"));
    assert!(!script.contains(r#"text.includes("/")"#));
    assert!(script.contains("newWorktreeModeActive"));
    assert!(script.contains("effectiveElementRect"));
    assert!(script.contains("removeUpstreamBranchOptions"));
    assert!(script.contains("cleanupInvalidUpstreamBranchOptions"));
    assert!(script.contains("branchMenuInNewWorktreeMode"));
    assert!(script.contains("branchMenuTriggerIsBranchControl"));
    assert!(script.contains("actual-upstream-refs-v17"));
    assert!(script.contains("create and checkout new branch"));
    assert!(script.contains("if (/^start in"));
    assert!(script.contains("if (!branchMenuInNewWorktreeMode(trigger))"));
    assert!(script.contains("window.__codexUpstreamBranchDropdownObserver?.disconnect?.()"));
    assert!(script.contains("record.addedNodes"));
    assert!(script.contains("addedNodeContainsBranchMenu"));
    assert!(!script.contains("new MutationObserver(schedule).observe"));
    assert!(script.contains(r#".composer-footer button, .composer-footer [role="button"]"#));
    assert!(!script.contains("return [...document.querySelectorAll('button')]"));
}

#[test]
fn injection_script_prevents_switching_to_branches_used_by_other_worktrees() {
    let script = assets::injection_script(57321);

    assert!(script.contains("data-codex-branch-worktree-path"));
    assert!(script.contains("annotateBranchMenuWorktreeUsage"));
    assert!(script.contains("branchWorktreePathFromMenuItem"));
    assert!(script.contains("该分支已在另一个 worktree 使用"));
    assert!(script.contains("event.stopImmediatePropagation?.()"));
}

#[test]
fn injection_script_rebuilds_upstream_options_for_each_project_branch_menu() {
    let script = assets::injection_script(57321);

    assert!(!script.contains("currentProjectRepoPathForBranchMenu"));
    assert!(!script.contains("repoPathFromProjectLabel"));
    assert!(script.contains("projectContextFromProjectLabel"));
    assert!(script.contains("upstreamBranchOptionsMatchRefs"));
    assert!(script.contains("upstreamBranchDefaultsCache = new Map()"));
    assert!(script.contains("actual-upstream-refs-v17"));
}

#[test]
fn manager_ui_exposes_pure_api_relay_mode_button() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("core crate should live under crates/codex-plus-core");
    let source = std::fs::read_to_string(repo.join("apps/codex-plus-manager/src/App.tsx")).unwrap();
    let commands =
        std::fs::read_to_string(repo.join("apps/codex-plus-manager/src-tauri/src/lib.rs")).unwrap();

    assert!(source.contains("官方混入 API Key"));
    assert!(source.contains("关闭官方低额度提示"));
    assert!(source.contains("hideOfficialUsageAlert"));
    assert!(source.contains("纯 API"));
    assert!(source.contains("apply_pure_api_injection"));
    assert!(commands.contains("commands::apply_pure_api_injection"));
}

#[test]
fn manager_ui_omits_plugin_auto_expand() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("core crate should live under crates/codex-plus-core");
    let source = std::fs::read_to_string(repo.join("apps/codex-plus-manager/src/App.tsx")).unwrap();

    assert!(!source.contains("codexAppPluginAutoExpand"));
    assert!(!source.contains("插件列表全量展示"));
}

#[test]
fn cdp_target_deserializes_websocket_field() {
    let target: CdpTarget = serde_json::from_value(json!({
        "id": "page-1",
        "type": "page",
        "title": "Codex",
        "url": "https://codex.test",
        "webSocketDebuggerUrl": "ws://debug",
    }))
    .expect("target should deserialize");

    assert_eq!(target.target_type, "page");
    assert_eq!(
        target.web_socket_debugger_url.as_deref(),
        Some("ws://debug")
    );
}

#[test]
fn runtime_evaluate_params_sets_expected_flags() {
    let params = bridge::runtime_evaluate_params("1 + 1");

    assert_eq!(params["expression"], "1 + 1");
    assert_eq!(params["awaitPromise"], false);
    assert_eq!(params["allowUnsafeEvalBlockedByCSP"], true);
}

#[test]
fn runtime_evaluate_params_can_await_promise_for_bridge_health_checks() {
    let params = bridge::runtime_evaluate_params_with_await_promise("Promise.resolve(true)", true);

    assert_eq!(params["expression"], "Promise.resolve(true)");
    assert_eq!(params["awaitPromise"], true);
    assert_eq!(params["allowUnsafeEvalBlockedByCSP"], true);
}

#[test]
fn bridge_health_check_script_uses_real_backend_round_trip() {
    let script = bridge::bridge_health_check_script();

    assert!(script.contains("__codexSessionDeleteBridge"));
    assert!(script.contains("/backend/status"));
    assert!(script.contains("Promise.race"));
    assert!(script.contains("setTimeout"));
}

#[test]
fn bridge_result_expressions_json_escape_inputs() {
    let resolve = bridge::resolve_bridge_expression("request\"1", &json!({"status": "ok"}))
        .expect("resolve expression should build");
    let reject = bridge::reject_bridge_expression("request\"1", "bad \"value\"")
        .expect("reject expression should build");

    assert_eq!(
        resolve,
        r#"window.__codexSessionDeleteResolve("request\"1", {"status":"ok"})"#
    );
    assert_eq!(
        reject,
        r#"window.__codexSessionDeleteReject("request\"1", "bad \"value\"")"#
    );
}

#[test]
fn pick_page_target_prefers_codex_title_or_url() {
    let targets = vec![
        target(
            "first",
            "page",
            "Other",
            "https://example.test",
            Some("ws://first"),
        ),
        target(
            "second",
            "page",
            "Codex",
            "https://example.test",
            Some("ws://second"),
        ),
        target(
            "third",
            "page",
            "Other",
            "https://codex.test",
            Some("ws://third"),
        ),
    ];

    let picked = pick_page_target(&targets).expect("target should be selected");

    assert_eq!(picked.id, "second");
}

#[test]
fn pick_page_target_leniently_falls_back_to_first_injectable_page() {
    let targets = vec![
        target(
            "browser",
            "browser",
            "Codex",
            "https://codex.test",
            Some("ws://browser"),
        ),
        target(
            "first",
            "page",
            "Other",
            "https://example.test",
            Some("ws://first"),
        ),
        target(
            "second",
            "page",
            "Other 2",
            "https://example.test/2",
            Some("ws://second"),
        ),
    ];

    let picked = pick_page_target(&targets).expect("target should be selected");

    assert_eq!(picked.id, "first");
}

#[test]
fn pick_page_target_rejects_non_pages_and_pages_without_websocket() {
    let targets = vec![
        target(
            "browser",
            "browser",
            "Codex",
            "https://codex.test",
            Some("ws://browser"),
        ),
        target("page-no-ws", "page", "Codex", "https://codex.test", None),
    ];

    let error = pick_page_target(&targets).expect_err("no injectable page should be selected");

    assert!(
        error
            .to_string()
            .contains("No injectable page target found")
    );
}

#[test]
fn pick_injectable_codex_page_target_rejects_non_codex_pages() {
    let targets = vec![
        target(
            "browser",
            "browser",
            "Codex",
            "https://codex.test",
            Some("ws://browser"),
        ),
        target(
            "other-page",
            "page",
            "Other App",
            "https://example.test",
            Some("ws://other"),
        ),
    ];

    let error = pick_injectable_codex_page_target(&targets)
        .expect_err("non-Codex page must not be selected for injection");

    assert!(
        error
            .to_string()
            .contains("No injectable Codex page target found")
    );
}

#[test]
fn pick_injectable_codex_page_target_ignores_embedded_browser_page_named_codex() {
    let targets = vec![
        target(
            "browser-pr",
            "page",
            "Fix Codex++ menu anchoring · Pull Request",
            "https://github.com/BigPizzaV3/CodexPlusPlus/pull/1743",
            Some("ws://browser-pr"),
        ),
        target(
            "main",
            "page",
            "Codex",
            "app://-/index.html",
            Some("ws://main"),
        ),
    ];

    let picked = pick_injectable_codex_page_target(&targets)
        .expect("Codex app page should win over embedded browser content");

    assert_eq!(picked.id, "main");
}

#[test]
fn pick_injectable_codex_page_target_rejects_embedded_browser_only_page() {
    let targets = vec![target(
        "browser-pr",
        "page",
        "Fix Codex++ menu anchoring · Pull Request",
        "https://github.com/BigPizzaV3/CodexPlusPlus/pull/1743",
        Some("ws://browser-pr"),
    )];

    let error = pick_injectable_codex_page_target(&targets)
        .expect_err("embedded browser content must not be selected for injection");

    assert!(
        error
            .to_string()
            .contains("No injectable Codex page target found")
    );
}

#[test]
fn pick_injectable_codex_page_target_accepts_chatgpt_desktop_page() {
    let targets = vec![target(
        "chatgpt",
        "page",
        "ChatGPT",
        "https://chatgpt.com/",
        Some("ws://chatgpt"),
    )];

    let picked = pick_injectable_codex_page_target(&targets)
        .expect("ChatGPT desktop page should be selected");

    assert_eq!(picked.id, "chatgpt");
}

#[test]
fn pick_injectable_codex_page_target_accepts_chatgpt_desktop_error_page() {
    let targets = vec![target(
        "chatgpt-error",
        "page",
        "ChatGPT",
        "data:text/html;charset=utf-8,%3Ctitle%3EChatGPT%3C/title%3E",
        Some("ws://chatgpt-error"),
    )];

    let picked = pick_injectable_codex_page_target(&targets)
        .expect("ChatGPT desktop error page should be selected");

    assert_eq!(picked.id, "chatgpt-error");
}

#[test]
fn avatar_overlay_target_detection_is_narrow() {
    let overlay = target(
        "avatar",
        "page",
        "ChatGPT Avatar Overlay",
        "app://-/index.html?initialRoute=%2Favatar-overlay",
        Some("ws://avatar"),
    );
    let main = target(
        "main",
        "page",
        "ChatGPT",
        "https://chatgpt.com/",
        Some("ws://main"),
    );

    assert!(is_avatar_overlay_page_target(&overlay));
    assert!(!is_primary_codex_page_target(&overlay));
    assert!(!is_avatar_overlay_page_target(&main));
    assert!(is_primary_codex_page_target(&main));
    assert!(!is_avatar_overlay_page_target(&target(
        "external",
        "page",
        "avatar-overlay",
        "https://example.test/avatar-overlay",
        Some("ws://external"),
    )));
}

#[test]
fn primary_target_selection_skips_v1_and_v2_overlay_candidates() {
    let targets = vec![
        target(
            "v1-overlay",
            "page",
            "Codex",
            "app://-/index.html?initialRoute=%2Favatar-overlay",
            Some("ws://v1"),
        ),
        target(
            "v2-overlay",
            "page",
            "Codex",
            "app://-/index.html?initialRoute=/avatar-overlay",
            Some("ws://v2"),
        ),
        target(
            "main",
            "page",
            "Codex",
            "app://-/index.html",
            Some("ws://main"),
        ),
    ];

    let selected = pick_injectable_codex_page_target(&targets).unwrap();

    assert_eq!(selected.id, "main");
}

#[test]
fn quick_chat_target_detection_is_narrow() {
    for url in [
        "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat",
        "app://-/index.html?initialRoute=/chatgpt/quick-chat",
        "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
        "app://-/index.html?initialRoute=/chatgpt/quick-chat-prewarm",
        "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2Fconversation-123",
        "app://-/index.html?initialRoute=/chatgpt/quick-chat/conversation-123",
    ] {
        let quick_chat = target("quick-chat", "page", "Codex", url, Some("ws://quick-chat"));

        assert!(is_quick_chat_page_target(&quick_chat));
        assert!(!is_primary_codex_page_target(&quick_chat));
    }

    assert!(!is_quick_chat_page_target(&target(
        "external",
        "page",
        "Codex",
        "https://example.test/chatgpt/quick-chat-prewarm",
        Some("ws://external"),
    )));
    assert!(!is_quick_chat_page_target(&target(
        "other-param",
        "page",
        "Codex",
        "app://-/index.html?next=initialRoute%3D%252Fchatgpt%252Fquick-chat-prewarm",
        Some("ws://other-param"),
    )));
    assert!(!is_quick_chat_page_target(&target(
        "similar-route",
        "page",
        "Codex",
        "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chatty",
        Some("ws://similar-route"),
    )));
}

#[test]
fn primary_target_selection_skips_quick_chat_candidate() {
    let targets = vec![
        target(
            "quick-chat",
            "page",
            "Codex",
            "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2Fconversation-123",
            Some("ws://quick-chat"),
        ),
        target(
            "quick-chat-prewarm",
            "page",
            "Codex",
            "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
            Some("ws://quick-chat-prewarm"),
        ),
        target(
            "main",
            "page",
            "Codex",
            "app://-/index.html",
            Some("ws://main"),
        ),
    ];

    let selected = pick_injectable_codex_page_target(&targets).unwrap();

    assert_eq!(selected.id, "main");
}

#[test]
fn quick_chat_only_target_is_not_injectable_as_codex_main_page() {
    let targets = vec![target(
        "quick-chat",
        "page",
        "Codex",
        "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
        Some("ws://quick-chat"),
    )];

    let error = pick_injectable_codex_page_target(&targets)
        .expect_err("Quick Chat helper renderer must not be selected for injection");

    assert!(
        error
            .to_string()
            .contains("No injectable Codex page target found")
    );
}

#[test]
fn pick_injectable_codex_page_target_requires_websocket() {
    let targets = vec![target("codex", "page", "Codex", "https://codex.test", None)];

    let error = pick_injectable_codex_page_target(&targets)
        .expect_err("Codex page without websocket must not be selected for injection");

    assert!(
        error
            .to_string()
            .contains("No injectable Codex page target found")
    );
}

#[tokio::test]
async fn list_targets_can_query_ipv6_loopback_cdp_endpoint() {
    let listener = TcpListener::bind("[::1]:0")
        .await
        .expect("IPv6 loopback listener should bind");
    let port = listener.local_addr().unwrap().port();
    let body = serde_json::to_vec(&json!([
        {
            "id": "page-1",
            "type": "page",
            "title": "Codex",
            "url": "app://-/index.html",
            "webSocketDebuggerUrl": format!("ws://[::1]:{port}/devtools/page/page-1"),
        }
    ]))
    .unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("request should arrive");
        let mut request = [0_u8; 1024];
        let _ = stream.readable().await;
        let _ = stream.try_read(&mut request);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream
            .try_write(response.as_bytes())
            .expect("response headers should write");
        stream.try_write(&body).expect("response body should write");
    });

    let targets = list_targets(port)
        .await
        .expect("CDP target query should fall back to IPv6 loopback");

    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].id, "page-1");
    server.await.expect("server task should complete");
}

#[tokio::test]
async fn install_bridge_routes_binding_while_waiting_for_command_response() {
    let temp = tempfile::tempdir().unwrap();
    let log_path = temp.path().join("codex-plus.log");
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(Some(log_path.clone()));
    let (url, request_rx) = spawn_cdp_server(|mut socket| async move {
        for expected_id in 1..=4 {
            let command = recv_json(&mut socket).await;
            assert_eq!(command["id"], expected_id);
            send_json(&mut socket, json!({ "id": expected_id, "result": {} })).await;
        }

        let evaluate = recv_json(&mut socket).await;
        assert_eq!(evaluate["id"], 5);
        assert_eq!(evaluate["method"], "Runtime.evaluate");
        send_json(
            &mut socket,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "request-1",
                        "path": "delete",
                        "payload": { "target": "session" },
                    })).unwrap(),
                },
            }),
        )
        .await;
        send_json(&mut socket, json!({ "id": 5, "result": {} })).await;

        let response = recv_json(&mut socket).await;
        assert_eq!(response["method"], "Runtime.evaluate");
        assert!(
            response["params"]["expression"]
                .as_str()
                .expect("expression should be string")
                .contains("__codexSessionDeleteResolve")
        );
        send_json(&mut socket, json!({ "id": response["id"], "result": {} })).await;
        close_socket(&mut socket).await;
    })
    .await;

    let handled = Arc::new(AtomicBool::new(false));
    let handler = {
        let handled = Arc::clone(&handled);
        Arc::new(move |path: String, payload: serde_json::Value| {
            let handled = Arc::clone(&handled);
            Box::pin(async move {
                assert_eq!(path, "delete");
                assert_eq!(payload["target"], "session");
                handled.store(true, Ordering::SeqCst);
                Ok(json!({ "status": "ok" }))
            })
                as Pin<Box<dyn Future<Output = anyhow::Result<serde_json::Value>> + Send>>
        })
    };

    tokio::time::timeout(
        Duration::from_secs(2),
        bridge::install_bridge(&url, BRIDGE_BINDING_NAME, handler, &[]),
    )
    .await
    .expect("bridge should not hang while processing interleaved binding call")
    .expect("bridge should keep processing interleaved binding call");
    request_rx
        .await
        .expect("server task should finish without panicking");
    assert!(handled.load(Ordering::SeqCst));
    let contents = std::fs::read_to_string(&log_path).unwrap();
    assert!(contents.contains("bridge.resolve_start"));
    assert!(contents.contains("bridge.resolve_ok"));
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(None);
}

type TestSocket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

async fn spawn_cdp_server<F, Fut>(handler: F) -> (String, oneshot::Receiver<()>)
where
    F: FnOnce(TestSocket) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let (done_tx, done_rx) = oneshot::channel();

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("client should connect");
        let socket = accept_async(stream)
            .await
            .expect("websocket should upgrade");
        handler(socket).await;
        let _ = done_tx.send(());
    });

    (websocket_url(address), done_rx)
}

fn websocket_url(address: SocketAddr) -> String {
    format!("ws://{address}")
}

async fn recv_json(socket: &mut TestSocket) -> serde_json::Value {
    let message = socket
        .next()
        .await
        .expect("client should send message")
        .expect("message should be readable");
    let Message::Text(text) = message else {
        panic!("expected text websocket message");
    };
    serde_json::from_str(&text).expect("message should be JSON")
}

async fn send_json(socket: &mut TestSocket, value: serde_json::Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .expect("message should send");
}

fn assert_expression_contains_request(command: &serde_json::Value, request_id: &str) {
    let expression = command["params"]["expression"]
        .as_str()
        .expect("expression should be string");
    assert!(
        expression.contains("__codexSessionDeleteResolve"),
        "{expression}"
    );
    assert!(expression.contains(request_id), "{expression}");
}

async fn close_socket(socket: &mut TestSocket) {
    socket.close(None).await.expect("websocket should close");
    let _ = tokio::time::timeout(Duration::from_millis(200), socket.next()).await;
}

fn noop_handler() -> bridge::BridgeHandler {
    Arc::new(|_, _| {
        Box::pin(async { Ok(json!({ "status": "ok" })) })
            as Pin<Box<dyn Future<Output = anyhow::Result<serde_json::Value>> + Send>>
    })
}
