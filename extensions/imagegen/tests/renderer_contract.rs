#[test]
fn injection_script_recovers_generated_images_runtime() {
    let script = assets::injection_script(57321);

    assert!(script.contains("/thread-generated-images"));
    assert!(script.contains("data-codex-generated-images"));
    assert!(script.contains("__codexPlusGeneratedImages"));
    assert!(script.contains("__codexPlusCurrentSessionRef"));
    assert!(script.contains("__codexPlusPostJson"));
}

#[test]
fn image_generation_reinjection_does_not_keep_obsolete_client_wrappers() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("node")
        .arg(root.join("extensions/imagegen/tests/client-reinjection.cjs"))
        .arg(root.join("assets/inject/renderer-inject.js"))
        .output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn image_generation_restores_native_requests_after_backend_exit() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extensions/imagegen");
    let output = Command::new("node")
        .arg(root.join("tests/lifecycle.cjs"))
        .arg(root.join("ui/renderer-runtime.js"))
        .output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[tokio::test]
async fn image_generation_shutdown_waits_for_native_restoration() {
    let (url, done) = spawn_cdp_server(|mut socket| async move {
        let request = recv_json(&mut socket).await;
        assert_eq!(request["method"], "Runtime.evaluate");
        assert_eq!(request["params"]["awaitPromise"], true);
        assert!(request["params"]["expression"].as_str().unwrap().contains("__codexPlusRestoreNativeImageGeneration"));
        send_json(&mut socket, json!({"id":request["id"],"result":{"result":{"type":"object","value":{"restored":1,"pending":0}}}})).await;
    }).await;
    let restored = codex_plus_core::imagegen_runtime::restore_native_image_generation(&url).await.unwrap();
    assert_eq!(restored, json!({"restored":1,"pending":0}));
    done.await.unwrap();
}

#[test]
fn image_generation_turn_reloads_existing_threads_into_the_proxy() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extensions/imagegen");
    let output = Command::new("node")
        .arg(root.join("tests/turn-preparation.cjs"))
        .arg(root.join("ui/renderer-runtime.js"))
        .output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn generated_image_fallback_survives_failed_native_image_loading() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extensions/imagegen");
    let output = Command::new("node")
        .arg(root.join("tests/generated-images-rendering.cjs"))
        .arg(root.join("ui/generated-images-inject.js"))
        .output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
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

let nativePreviewClicks = 0;
let nativeOverlayOpens = 0;
const nativeImageButton = element("button");
nativeImageButton.querySelectorAll = () => [];
nativeImageButton.__reactFiber$preview = {{ memoizedProps: {{ image: {{ src: "/generated_images/image-1.png" }} }} }};
nativeImageButton.addEventListener("click", () => {{ nativePreviewClicks++; }});
const targets = [responseTarget("msg-last")];
globalThis.window = globalThis;
window.innerWidth = 1800;
window.innerHeight = 1130;
globalThis.document = {{
  body: element("body"), documentElement: element("html"),
  createElement: (tagName) => element(tagName),
  querySelectorAll(selector) {{
    if (selector === '[data-testid="generated-image-preview"]') return [nativeImageButton];
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
window.__codexPlusOpenGeneratedImagePreview = async (image, session, sourceImage) => {{
  if (image.id !== "image-1" || session.session_id !== "thread-1"
      || sourceImage.getAttribute("data-codex-generated-image-id") !== image.id) throw new Error("preview binding mismatch");
  nativeOverlayOpens++;
  return true;
}};
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
  renderedImage?.parentElement?.click();
  const nativePreview = {{
    containerInMarkdown: renderedContainer?.parentElement === exactTarget.markdown,
    targetChildren: exactTarget.children.length,
    imageParentTag: renderedImage?.parentElement?.tagName || "",
    imageClass: renderedImage?.className || "",
    imageStyle: renderedImage?.style?.cssText || "",
    nativeClicks: nativePreviewClicks,
    overlayOpens: nativeOverlayOpens,
    customDialogs: descendants(document.body).filter(child => child.tagName === "dialog").length,
  }};

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
        json!({ "first": 0, "middle": 0, "last": 0 })
    );
    assert_eq!(result["nativePreview"]["containerInMarkdown"], true);
    assert_eq!(result["nativePreview"]["targetChildren"], 2);
    assert_eq!(result["nativePreview"]["imageParentTag"], "button");
    assert_eq!(result["nativePreview"]["nativeClicks"], 0);
    assert_eq!(result["nativePreview"]["overlayOpens"], 1);
    assert_eq!(result["nativePreview"]["customDialogs"], 0);
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
fn desktop_image_feature_defaults_respect_direct_image_profile() {
    let script = assets::injection_script(57321);
    let start = script.find("  function patchCodexImageGenerationManager(");
    assert!(start.is_some(), "desktop feature defaults must respect the direct image profile");
    let start = start.unwrap();
    let end = script[start..].find("  function patchCodexContextUsageManager(").unwrap() + start;
    let harness = format!(r#"
const assert = require('node:assert/strict');
let profile = {{ relayMode: 'pureApi', protocol: 'responses', imageGenerationProxy: false }};
const codexRemoteSessionActiveProfile = () => profile;
const codexPlusBackendSettings = {{}};
const codexServiceTierCurrentModelName = () => 'gpt-6';
const window = {{ __codexPlusImageGenerationRuntime: {{ active: true, threads: new Map() }} }};
const codexImageGenerationRuntimeActive = () => window.__codexPlusImageGenerationRuntime.active;
const defaults = {{ image_generation: true, other_feature: true }};
const manager = {{ requestClient: {{ hostId: 'local' }}, settings: {{ readDefaultFeatureOverrides: () => defaults }} }};
{}
patchCodexImageGenerationManager(manager);
const reader = manager.settings.readDefaultFeatureOverrides;
assert.equal(reader(), defaults, 'explicit proxy opt-out preserves native defaults');
codexPlusBackendSettings.imageGenerationProxy = {{ provider: 'custom', baseUrl: 'http://localhost:57321/v1' }};
assert.deepEqual(reader(), {{ image_generation: false, other_feature: true }});
assert.equal(defaults.image_generation, true);
const resume = {{ threadId: 'image-thread', config: {{ 'features.image_generation': true,
  'features.other': true, features: {{ image_generation: true, retained: true }} }} }};
const patched = applyCodexImageGenerationRequestOverride('thread/resume', resume);
assert.equal(patched.config['features.image_generation'], false);
assert.equal(patched.config.features.image_generation, false);
assert.equal(patched.config.features.retained, true);
assert.equal(patched.config['features.other'], true);
assert.equal(resume.config['features.image_generation'], true);
window.__codexPlusImageGenerationRuntime.active = false;
assert.equal(reader(), defaults);
assert.equal(applyCodexImageGenerationRequestOverride('thread/resume', resume), resume);
const remote = {{ requestClient: {{ hostId: 'remote' }}, settings: {{ readDefaultFeatureOverrides: () => defaults }} }};
patchCodexImageGenerationManager(remote);
assert.equal(remote.settings.readDefaultFeatureOverrides(), defaults);
"#, &script[start..end]);
    let output = std::process::Command::new("node").args(["-e", &harness]).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn image_persistence_restores_native_thread_even_when_repair_fails() {
    let source = assets::renderer_script();
    let start = source.find("  window.__codexPlusImagePersistenceJobs =").unwrap();
    let end = source[start..].find("  function patchCodexImageGenerationManager").unwrap() + start;
    let harness = r#"
const assert = require('node:assert/strict');
global.window = {};
let calls = [], busy = false, fail = false, navigations = 0, resumedModel = null;
let streamOwned = true;
const conversation = { latestModel: "test", resumeState: "resumed",
  turns: [{ items: [{ type: 'agentMessage', id: 'msg-image', text: 'old text' }] }],
  turnHistory: { kind: 'canonical', history: { entitiesByKey: { turn: { items: [{ type: 'agentMessage', id: 'msg-image', text: 'old text' }] } } } }
};
const manager = {
  requestClient: { hostId: 'local', async sendRequest(method, params) {
    calls.push(method);
    if (method === 'thread/archive') manager.notificationContext.handleThreadArchived('image-thread');
    if (method === 'thread/unarchive') manager.notificationContext.handleThreadUnarchived('image-thread');
    return { thread: { status: { type: busy ? 'active' : 'idle' }, cwd: '/tmp', turns: params?.includeTurns ? [{ items: [{ type: 'agentMessage', id: 'msg-image', text: '![image](/generated_images/new.png)' }] }] : [] } };
  } },
  streamState: { stopFollowingConversationState() { streamOwned = false; } },
  notificationContext: { handleThreadArchived() { navigations++; }, handleThreadUnarchived() { navigations++; } },
  getConversation: () => conversation, getConversationCwd: () => '/tmp',
  updateConversationState(id, update) { update(conversation); },
  async resumeConversation(options) { resumedModel = options.model; assert.equal(streamOwned, false, 'stale stream ownership would skip native resume'); assert.equal(conversation.resumeState, 'needs_resume'); calls.push('resume'); return { status: 'ready' }; }
};
global.collectCodexReactRuntimeCandidates = () => ({ conversationManagers: [manager] });
global.postJson = async () => { calls.push('persist'); if (fail) throw Error('disk full'); return 1; };
global.sendCodexPlusDiagnostic = () => {};
(async () => {
  const session = { session_id: 'image-thread' };
  const first = window.__codexPlusPersistGeneratedImages(session);
  assert.equal(first, window.__codexPlusPersistGeneratedImages(session));
  assert.equal(await first, true);
  assert.deepEqual(calls, ['thread/read', 'thread/archive', 'persist', 'thread/unarchive', 'resume', 'thread/read']);
  assert.equal(window.__codexPlusImagePersistenceJobs.size, 0);
  assert.equal(navigations, 0);
  assert.equal(conversation.turns[0].items[0].text, '![image](/generated_images/new.png)');
  assert.equal(conversation.turnHistory.history.entitiesByKey.turn.items[0].text, conversation.turns[0].items[0].text);
  manager.notificationContext.handleThreadArchived('user-archived-thread');
  assert.equal(navigations, 1);
  calls = []; fail = true;
  assert.equal(await window.__codexPlusPersistGeneratedImages(session), false);
  assert.deepEqual(calls, ['thread/read', 'thread/archive', 'persist', 'thread/unarchive', 'resume', 'thread/read']);
  calls = []; busy = true;
  assert.equal(await window.__codexPlusPersistGeneratedImages(session), 'busy');
  assert.deepEqual(calls, ['thread/read']);
  busy = false;
  assert.equal(await window.__codexPlusPersistGeneratedImages({ ...session, model: 'gpt-image-2.5-flare' }, true), true);
  assert.equal(resumedModel, 'gpt-image-2.5-flare');
})().catch(error => { console.error(error); process.exitCode = 1; });
"#;
    let output = Command::new("node").arg("-e").arg(format!("{harness_prefix}\n{}\n{harness_suffix}", &source[start..end], harness_prefix = harness.split("(async () =>").next().unwrap(), harness_suffix = format!("(async () =>{}", harness.split_once("(async () =>").unwrap().1))).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}
