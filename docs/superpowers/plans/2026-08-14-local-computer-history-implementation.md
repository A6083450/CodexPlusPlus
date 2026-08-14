# Local Computer History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** 让当前 macOS Codex 桌面客户端在未登录 ChatGPT 时完整使用计算机历史记录，同时只在本机持久化记录/摘要，并让 Chronicle 摘要复用 `~/.codex/config.toml` 当前生效的 Responses API 模型与供应商。

**Architecture:** 保留上游 Chronicle 服务、设置页、插件和本地存储格式。启动器通过 CDP 在内存中精确改写当前版本的 Chronicle 设置页 chunk，删除 Memories 查询/写入门槛；同时把 Codex++ launcher 暴露为透明 `CODEX_CLI_PATH` 包装器，只对完整匹配的 `openai-memgen` 摘要命令生成最小 provider 覆盖。当前 bundled Codex 已用本机假上游确认会发送 `/v1/responses`、`store:false`，且不发送 `previous_response_id` 或 Memgen 头，因此不增加额外 HTTP 转发层。

**Tech Stack:** Rust 2024、Tokio、tokio-tungstenite/CDP、toml_edit、serde_json、sha2、base64、React 19 + TypeScript、现有 Node test harness。

## Global Constraints

- 功能保持 opt-in，设置键统一为 `codexAppLocalComputerHistory` / `codex_app_local_computer_history`，默认 `false`。
- 首版只在 macOS 启动链路生效；其他平台即使设置文件出现该值也不注入、不包装 CLI。
- 不修改 `/Applications/ChatGPT.app`、`app.asar`、Chronicle 数据目录或 ChatGPT 账号状态；页面改写只存在于当前 renderer 的 CDP 响应中。
- 只支持已审计的 Codex App `26.810.41047` Chronicle chunk：`chronicle-settings-page-_yHh3b2I.js`，SHA-256 `52c8ead5eb63b551495b51a361828b858cf9954515c02ab1ff47194e0f71787c`。URL、hash 或目标片段任一不匹配都继续原响应并显示兼容性错误。
- 不读取 `auth.json`，不回退 ChatGPT 登录或 `openai-memgen`。配置无效时摘要失败，但 Chronicle 本地采集继续。
- 不把 bearer token、直接 HTTP header 值、活动正文、摘要正文或完整请求体写入 argv、诊断日志或测试输出。
- 保留 Chronicle 原有 `--ignore-user-config`、`--ephemeral`、只读 sandbox 和 feature-disable 参数；后台摘要不加载无关用户指令、技能、插件或工具。
- 当前工作树已有用户改动，且 `App.tsx`、`renderer-inject.js`、`bridge.rs`、`launcher.rs`、`main.rs`、`cdp_bridge.rs` 与本功能重叠。每次修改前先读当前文件；提交时只暂存本功能新增文件和已核对的具体 hunks，绝不整文件覆盖或带入无关 diff。
- 不修改 `Cargo.toml`、`package.json`、lockfile 或依赖版本；现有依赖已包含 `sha2`、`base64`、`tokio-tungstenite`、`reqwest` 和 `toml_edit`。

---

### Task 1: Add The Opt-In Setting Contract

**Files:**

- Modify: `crates/codex-plus-core/src/settings.rs:354`
- Test: `crates/codex-plus-core/src/settings.rs:1617`
- Test: `crates/codex-plus-core/src/settings.rs:2230`

**Step 1: Write failing default and merge tests**

Extend the existing settings tests before the struct:

```rust
assert!(!settings.codex_app_local_computer_history);
```

In the update/merge fixture, send:

```json
{"codexAppLocalComputerHistory": true}
```

and assert the loaded value is `true`. Also deserialize `{}` and assert the field stays `false`.

**Step 2: Run the focused tests and confirm RED**

Run:

```bash
cargo test -p codex-plus-core settings_default_matches_expected_behavior
cargo test -p codex-plus-core update_settings
```

Expected: compilation fails because `codex_app_local_computer_history` does not exist.

**Step 3: Add the backend setting**

Add beside the other Codex App enhancement flags:

```rust
#[serde(rename = "codexAppLocalComputerHistory", default)]
pub codex_app_local_computer_history: bool,
```

Set it to `false` in `Default`, and add:

```rust
merge_bool_setting(target, source, "codexAppLocalComputerHistory");
```

to `merge_backend_settings`.

**Step 4: Run focused tests and confirm GREEN**

Run the two commands from Step 2.

Expected: both pass.

**Step 5: Commit only the clean settings file**

```bash
git add crates/codex-plus-core/src/settings.rs
git diff --cached --check
git commit -m "feat: add local computer history setting"
```

---

### Task 2: Implement A Pure, Fail-Closed Chronicle Page Rewrite

**Files:**

- Create: `crates/codex-plus-core/src/chronicle_page.rs`
- Modify: `crates/codex-plus-core/src/lib.rs:1`
- Test: `crates/codex-plus-core/src/chronicle_page.rs`

**Step 1: Write failing pure rewrite tests**

Define a test-only `ChronicleChunkSpec` with a short fixture containing both exact target fragments. Cover:

Add tests named `supported_chunk_removes_memory_queries_and_memory_writes`,
`wrong_hash_is_rejected_without_returning_partial_output`, and
`missing_or_duplicate_target_fragment_is_rejected`. The first uses a test spec whose expected
hash is computed from the complete fixture, unwraps `Patched`, and asserts both replacements plus
the marker. The latter two assert `Unsupported` and compare the original fixture before/after to
prove no partial buffer mutation escaped.

The success assertion must prove the rewritten source:

- contains `O=!0,k=!0,A=!1,j=!0`;
- contains `enableMemories:()=>Promise.resolve()`;
- no longer contains calls to `ne(er,n)`, `ne(tr,n)`, `ne(ie,n)`, `ne(nr,n)`;
- no longer calls `Zn(` from the enable path;
- prepends `globalThis.__codexPlusLocalComputerHistoryPatch="26.810.41047";`.

**Step 2: Run the new tests and confirm RED**

```bash
cargo test -p codex-plus-core chronicle_page
```

Expected: module/functions are missing.

**Step 3: Implement exact source validation and rewrite**

Create these public boundaries:

```rust
pub const SUPPORTED_CHRONICLE_CHUNK_SUFFIX: &str =
    "/assets/chronicle-settings-page-_yHh3b2I.js";

pub enum ChronicleChunkRewrite {
    Patched(Vec<u8>),
    Unsupported { reason: &'static str },
}

pub fn rewrite_chronicle_chunk(url: &str, body: &[u8]) -> ChronicleChunkRewrite;
```

Implementation rules:

1. Require the exact URL suffix.
2. Compute SHA-256 and require the audited hash.
3. Decode UTF-8.
4. Replace exactly once:

```text
O=ne(er,n),k=ne(tr,n),{isLoading:A}=ne(ie,n),j=ne(nr,n)
```

with:

```text
O=!0,k=!0,A=!1,j=!0
```

5. Replace exactly once the complete audited `enableMemories` closure in `Cr` with `enableMemories:()=>Promise.resolve()`; anchor the replacement between `enableMemories:` and `,getChronicleState:()=>_.getState()` so no other `Zn` call can be touched.
6. Prepend the compatibility marker.
7. Return `Unsupported` on any count/hash/UTF-8 mismatch. Never return half-patched source.

Expose `mod chronicle_page` from `lib.rs`.

**Step 4: Run tests and prove the installed asset matches**

```bash
cargo test -p codex-plus-core chronicle_page
shasum -a 256 /tmp/codex-plus-chronicle-inspect/chronicle-settings-page-_yHh3b2I.js
```

Expected: Rust tests pass; installed asset hash equals the constant above.

**Step 5: Commit the isolated module**

```bash
git add crates/codex-plus-core/src/chronicle_page.rs crates/codex-plus-core/src/lib.rs
git diff --cached --check
git commit -m "feat: add fail-closed Chronicle page rewrite"
```

---

### Task 3: Serve The Patched Chunk Through A Persistent CDP Fetch Session

**Files:**

- Modify: `crates/codex-plus-core/src/bridge.rs:1`
- Modify: `crates/codex-plus-core/src/launcher.rs:2561`
- Test: `crates/codex-plus-core/tests/cdp_bridge.rs:4062`

**Step 1: Add a mock-CDP failing test**

Extend the existing local WebSocket test harness with:

Add async tests named `chronicle_fetch_rewriter_fulfills_only_the_supported_chunk` and
`chronicle_fetch_rewriter_continues_unknown_chunk_unchanged`. Both use the existing local
WebSocket harness; the server side asserts each CDP method and returns the exact command response
needed to advance the client pump.

The fake CDP server must observe this sequence:

1. `Fetch.enable` with response-stage pattern `*chronicle-settings-page-*.js`.
2. `Fetch.getResponseBody` for the paused response.
3. On success, `Fetch.fulfillRequest` with base64-encoded patched JavaScript and original response status/headers, excluding stale `content-length` and `content-encoding`.
4. On unsupported input, `Fetch.continueRequest`.

Also assert a second installation replaces the previous pump rather than leaving two sessions enabled.

**Step 2: Run the focused tests and confirm RED**

```bash
cargo test -p codex-plus-core --test cdp_bridge chronicle_fetch_rewriter
```

Expected: `install_chronicle_fetch_rewriter` is missing.

**Step 3: Add the persistent rewriter to `bridge.rs`**

Add:

```rust
pub async fn install_chronicle_fetch_rewriter(
    websocket_url: &str,
) -> anyhow::Result<()>;
```

Use a `OnceLock<tokio::sync::Mutex<HashMap<String, FetchPump>>>`, matching the existing bridge pump lifecycle. The task must:

- validate the loopback CDP URL through `connect_cdp_websocket`;
- enable Fetch only for the Chronicle chunk at response stage;
- retrieve and decode the body;
- call `crate::chronicle_page::rewrite_chronicle_chunk`;
- fulfill or continue every paused request even after an internal error;
- log only safe reason codes, URL basename, and expected/actual compatibility status, never source/body content;
- close the WebSocket when replaced or shut down.

**Step 4: Install it only for the enabled macOS setting**

In `try_inject`, after the normal bridge/new-document scripts are registered:

```rust
if cfg!(target_os = "macos") && settings.codex_app_local_computer_history {
    crate::bridge::install_chronicle_fetch_rewriter(websocket_url).await?;
}
```

After installation, use `Runtime.evaluate` to check whether a matching Chronicle resource was already loaded. If so, call `Page.reload` once; the persistent Fetch session and existing `Page.addScriptToEvaluateOnNewDocument` registrations then apply on the fresh document. Guard the reload with a renderer global so reinjection/watchdog passes cannot loop.

**Step 5: Run focused and launcher regression tests**

```bash
cargo test -p codex-plus-core --test cdp_bridge chronicle_fetch_rewriter
cargo test -p codex-plus-core --test launcher
```

Expected: new tests and existing launcher tests pass.

**Step 6: Stage only reviewed hunks**

Because both files already contain unrelated user changes, inspect `git diff` and stage only the new Fetch-pump and opt-in call hunks. Then:

```bash
git diff --cached --check
git commit -m "feat: patch Chronicle page in memory"
```

---

### Task 4: Surface Compatibility State In The Existing Renderer Injection

**Files:**

- Modify: `assets/inject/renderer-inject.js:1401`
- Modify: `assets/inject/renderer-inject.js:1405`
- Modify: `assets/inject/renderer-inject.js:1441`
- Test: `crates/codex-plus-core/tests/cdp_bridge.rs:1103`
- Test: `crates/codex-plus-core/tests/cdp_bridge.rs:2209`

**Step 1: Add failing settings-map and DOM-harness tests**

Assert the generated script maps:

```javascript
localComputerHistory: "codexAppLocalComputerHistory"
```

Add Node harness cases:

- setting off: no Chronicle banner/observer;
- setting on + marker present: show a restrained local-mode notice, no error;
- setting on + Chronicle route loaded + marker absent: show an incompatibility notice and leave upstream controls untouched;
- leaving `/settings/chronicle`: remove injected notice;
- repeated mutation/navigation: one notice only.

**Step 2: Run tests and confirm RED**

```bash
cargo test -p codex-plus-core --test cdp_bridge local_computer_history
```

Expected: settings map and harness cases fail.

**Step 3: Add the renderer setting and notice**

Extend all three settings/default maps with `localComputerHistory: false`. Add a route-scoped observer that reads only:

```javascript
window.__codexPlusLocalComputerHistoryPatch
```

When compatible, insert one unframed status line at the top of the Chronicle content:

```text
本地模式：记录和摘要文件只保存在本机；生成摘要时会把必要活动文本发送给当前 API 供应商，不使用 ChatGPT Memories。
```

When incompatible, insert:

```text
当前 Codex 版本尚未适配本地计算机历史记录；功能未解锁，也不会改写云端 Memories 流程。
```

Do not enable buttons from this script. Only the audited chunk patch changes behavior.

**Step 4: Run injection tests**

```bash
cargo test -p codex-plus-core --test cdp_bridge local_computer_history
cargo test -p codex-plus-core --test cdp_bridge injection_script
```

Expected: focused and existing injection contract tests pass.

**Step 5: Stage only the new injection/test hunks and commit**

```bash
git diff --cached --check
git commit -m "feat: show Chronicle local mode status"
```

---

### Task 5: Parse The Effective Provider Without Loading User Runtime Features

**Files:**

- Create: `crates/codex-plus-core/src/computer_history.rs`
- Modify: `crates/codex-plus-core/src/lib.rs:1`
- Test: `crates/codex-plus-core/src/computer_history.rs`

**Step 1: Write failing config-resolution tests**

Use `tempfile` and synthetic values only. Cover:

Add tests named:

- `resolves_model_and_provider_from_active_profile`;
- `converts_direct_bearer_token_to_child_only_env`;
- `converts_direct_http_headers_to_env_http_headers`;
- `preserves_existing_env_key_without_reading_auth_json`;
- `rejects_missing_model_provider_base_url_or_non_responses_wire_api`;
- `generated_overrides_never_contain_secret_values`.

Each fixture uses a unique synthetic secret. The security test flattens every generated argv value
and asserts that none of those synthetic values occur, while the private child environment contains
the expected value exactly once.

The active profile test must prove root values are overlaid by `[profiles.<active>]` values while provider tables still come from `[model_providers.<id>]`.

**Step 2: Run tests and confirm RED**

```bash
cargo test -p codex-plus-core computer_history::tests::resolves
```

Expected: the module/API is missing.

**Step 3: Implement the effective config boundary**

Create non-secret public output and secret-bearing private state:

```rust
pub struct ChronicleCliOverrides {
    pub args: Vec<std::ffi::OsString>,
    child_env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
}

pub fn load_chronicle_cli_overrides(
    codex_home: &Path,
    inherited_env: &HashMap<OsString, OsString>,
) -> anyhow::Result<ChronicleCliOverrides>;
```

Do not derive `Debug` or `Serialize` for secret-bearing types. Parse `config.toml` with `toml_edit::DocumentMut` and extract only:

- effective `model` and `model_provider`;
- provider `name`, `base_url`, `wire_api`, `env_key`, `env_http_headers`, `http_headers`;
- safe transport knobs already supported by Codex (`request_max_retries`, `stream_max_retries`, `stream_idle_timeout_ms`, `supports_websockets`).

Rules:

- require `wire_api = "responses"` for this first macOS implementation;
- force `requires_openai_auth = false`;
- never read `auth.json`;
- keep an existing `env_key` by name and inherit its value;
- convert `experimental_bearer_token`/direct bearer fields to `CODEX_PLUS_CHRONICLE_API_KEY` in child env and emit only that env-var name in the `-c` override;
- convert direct `http_headers` values to `CODEX_PLUS_CHRONICLE_HEADER_<index>` child env values and emit an `env_http_headers` table containing only variable names;
- TOML-quote model/provider values and provider IDs; never build raw `key=value` strings by concatenating unescaped user values;
- do not log or expose `child_env`.

**Step 4: Run all config/security tests**

```bash
cargo test -p codex-plus-core computer_history::tests
```

Expected: all tests pass, including tests that search every generated argv string for synthetic secret values.

**Step 5: Commit the isolated module**

```bash
git add crates/codex-plus-core/src/computer_history.rs crates/codex-plus-core/src/lib.rs
git diff --cached --check
git commit -m "feat: resolve Chronicle summary provider locally"
```

---

### Task 6: Classify And Rewrite Only The Chronicle Memgen Invocation

**Files:**

- Modify: `crates/codex-plus-core/src/computer_history.rs`
- Test: `crates/codex-plus-core/src/computer_history.rs`

**Step 1: Write classifier/rewrite tests**

Use an argv fixture with all required traits:

```text
exec
--ignore-user-config
--ephemeral
--sandbox read-only
-c model_provider="openai-memgen"
-c model_providers.openai-memgen.http_headers={"X-OpenAI-Memgen-Request"="true"}
```

Test:

- all traits present -> Chronicle rewrite;
- remove any one trait -> byte-for-byte passthrough;
- non-UTF-8 Unix arg -> passthrough;
- rewritten args contain no `openai-memgen`, Memgen header, forced OpenAI URL/auth/WebSocket overrides or synthetic secret;
- rewritten args retain original prompt/stdin mode, `--ignore-user-config`, `--ephemeral`, sandbox and feature-disable args;
- rewritten args append current model/provider overrides after all retained args so they win;
- repeated invocation reloads `config.toml` and sees a provider/model change.

**Step 2: Run tests and confirm RED**

```bash
cargo test -p codex-plus-core computer_history::tests::classifies
cargo test -p codex-plus-core computer_history::tests::rewrites
```

Expected: classifier/rewrite APIs are missing.

**Step 3: Implement fail-closed invocation planning**

Add:

```rust
pub enum CodexCliInvocationPlan {
    Passthrough { args: Vec<OsString> },
    ChronicleSummary {
        args: Vec<OsString>,
        child_env: Vec<(OsString, OsString)>,
    },
}

pub fn plan_codex_cli_invocation(
    args: Vec<OsString>,
    codex_home: &Path,
    inherited_env: &HashMap<OsString, OsString>,
) -> anyhow::Result<CodexCliInvocationPlan>;
```

Classification is true only when all five traits above exist. For a matched invocation:

1. Remove each `-c` plus value pair whose value selects `openai-memgen`, starts with `model_providers.openai-memgen.`, or contains `X-OpenAI-Memgen-Request`.
2. Preserve every unrelated arg in order.
3. Load effective config at invocation time.
4. Append safe model/provider overrides.

If classification is uncertain, return `Passthrough`. If classification is certain but config is invalid, return an error and do not execute the original Memgen command.

**Step 4: Run all module tests**

```bash
cargo test -p codex-plus-core computer_history::tests
```

Expected: all classification, security and config tests pass.

**Step 5: Commit**

```bash
git add crates/codex-plus-core/src/computer_history.rs
git diff --cached --check
git commit -m "feat: rewrite Chronicle summary commands"
```

---

### Task 7: Wire The Transparent CLI Wrapper Into macOS Launch

**Files:**

- Modify: `apps/codex-plus-launcher/src/main.rs:48`
- Modify: `crates/codex-plus-core/src/computer_history.rs`
- Modify: `crates/codex-plus-core/src/launcher.rs:750`
- Test: `apps/codex-plus-launcher/src/main.rs`
- Test: `crates/codex-plus-core/tests/launcher.rs:454`

**Step 1: Write failing launch-command tests**

Add tests proving:

- setting off: `build_macos_open_command` remains byte-for-byte unchanged and contains no wrapper env;
- setting on: command includes exactly one `--env CODEX_CLI_PATH=<current launcher>` and one `--env CODEX_PLUS_CHRONICLE_REAL_CLI=<app>/Contents/Resources/codex` before `--args`;
- missing/non-executable real CLI returns an error before launch;
- the wrapper path and real CLI path cannot resolve to the same file;
- existing `launcher_does_not_override_codex_app_environment` still proves no global `.envs(codex_process_environment())`, packaged-app environment mutation or proxy environment mutation was reintroduced.

Add a Unix fake executable test proving passthrough argv/stdin/stdout/stderr and exit code are preserved.

**Step 2: Run focused tests and confirm RED**

```bash
cargo test -p codex-plus-core --test launcher local_computer_history
cargo test -p codex-plus-launcher cli_wrapper
```

Expected: wrapper environment helpers and entrypoint are missing.

**Step 3: Add the wrapper runner**

In `computer_history.rs`, add an async entrypoint returning `Option<i32>`:

```rust
pub async fn run_cli_wrapper_from_environment() -> anyhow::Result<Option<i32>>;
```

Behavior:

- absent `CODEX_PLUS_CHRONICLE_REAL_CLI` -> `Ok(None)` so normal launcher startup is untouched;
- otherwise read raw `args_os`, plan the invocation, and spawn the real CLI with inherited stdio;
- set child `CODEX_CLI_PATH` to the real CLI and remove the wrapper sentinel to prevent recursion;
- add secret child env only for a Chronicle summary plan;
- return the real child exit code; map signal termination to `1`;
- log only `passthrough`/`chronicle_summary`, success/failure class and exit code, never args/env values.

At the very start of `launcher_main`, before option parsing and the single-instance guard:

```rust
if let Some(exit_code) = codex_plus_core::computer_history::run_cli_wrapper_from_environment().await? {
    std::process::exit(exit_code);
}
```

**Step 4: Add macOS `open --env` arguments**

Resolve:

```rust
let wrapper = std::env::current_exe()?;
let real_cli = app_dir.join("Contents/Resources/codex");
```

When and only when macOS + setting enabled, insert the two `--env` pairs before `--args`. Do not use `Command::envs` for the desktop app; `open --env` is the explicit LaunchServices path supported by the current macOS `open` command.

If the Codex app is already running, emit a safe diagnostic that a full quit/relaunch is required; do not force-quit or launch a duplicate instance.

**Step 5: Run launcher tests**

```bash
cargo test -p codex-plus-core --test launcher
cargo test -p codex-plus-launcher
```

Expected: all pass; default launch commands remain unchanged.

**Step 6: Stage only reviewed hunks and commit**

```bash
git diff --cached --check
git commit -m "feat: route Chronicle summaries through active provider"
```

---

### Task 8: Add The Manager Toggle And Explicit Data-Boundary Copy

**Files:**

- Modify: `apps/codex-plus-manager/src/App.tsx:123`
- Modify: `apps/codex-plus-manager/src/App.tsx:210`
- Modify: `apps/codex-plus-manager/src/App.tsx:791`
- Modify: `apps/codex-plus-manager/src/App.tsx:3652`

**Step 1: Add the field first and confirm TypeScript RED**

Add `codexAppLocalComputerHistory: boolean` to `BackendSettings`, then reference it in the UI before adding its default.

Run:

```bash
npm run check
```

from `apps/codex-plus-manager/`.

Expected: TypeScript reports the missing default/object field.

**Step 2: Add platform detection, default and toggle**

Add next to the Windows detection:

```typescript
const isMacPlatform = /\bMacintosh\b|\bMac OS X\b/i.test(navigator.userAgent);
```

Set the default to `false`. In “界面与启动”, add:

```tsx
<FeatureToggle
  title={t("本地计算机历史记录")}
  detail={t("默认关闭；记录和摘要文件只保存在本机，不使用 ChatGPT Memories。生成摘要时会把必要活动文本发送给 ~/.codex/config.toml 当前供应商。仅支持当前 macOS 客户端，需重启 Codex 生效。")}
  checked={form.codexAppLocalComputerHistory}
  disabled={!masterEnabled || !isMacPlatform}
  onChange={(value) => setEnhanceFlag("codexAppLocalComputerHistory", value)}
/>
```

Normalize a missing backend field back to `false`, matching the opt-in contract.

**Step 3: Run frontend checks**

```bash
npm run check
npm test
npm run vite:build
```

Expected: typecheck, Node tests and Vite build pass without modifying package metadata.

**Step 4: Stage only the reviewed `App.tsx` hunks and commit**

```bash
git diff --cached --check
git commit -m "feat: expose local computer history toggle"
```

---

### Task 9: Lock The Current Responses API Contract With A Fake Upstream

**Files:**

- Create: `crates/codex-plus-core/tests/computer_history.rs`

**Step 1: Add an ignored macOS installed-CLI contract test**

The test must:

- require `/Applications/ChatGPT.app/Contents/Resources/codex`;
- create a temporary empty `CODEX_HOME`;
- start a one-shot `127.0.0.1:0` HTTP server;
- invoke bundled Codex with synthetic model/provider/key, `--ignore-user-config`, `--ephemeral`, read-only sandbox and zero retry overrides;
- return a synthetic 400 after recording only selected non-sensitive fields.

Assert:

```rust
assert_eq!(request.path, "/v1/responses");
assert_eq!(request.body["model"], "chronicle-test-model");
assert_eq!(request.body["store"], false);
assert!(request.body.get("previous_response_id").is_none());
assert!(!request.headers.contains_key("x-openai-memgen-request"));
assert!(request.headers.contains_key("authorization"));
```

Mark it ignored because CI machines do not ship the desktop bundle:

```rust
#[ignore = "requires the installed macOS Codex desktop CLI"]
```

**Step 2: Run it explicitly on this Mac**

```bash
cargo test -p codex-plus-core --test computer_history installed_codex_responses_request_is_stateless -- --ignored --nocapture
```

Expected: pass. Test output must not print the Authorization value or full request body.

**Step 3: Add a wrapper-to-fake-CLI integration test**

Use a temporary executable that records argv keys with values redacted. Assert normal invocations are unchanged and Chronicle invocations use the active synthetic provider without any Memgen override or secret in argv.

**Step 4: Run and commit**

```bash
cargo test -p codex-plus-core --test computer_history
cargo test -p codex-plus-core --test computer_history installed_codex_responses_request_is_stateless -- --ignored
git add crates/codex-plus-core/tests/computer_history.rs
git diff --cached --check
git commit -m "test: lock Chronicle Responses request contract"
```

---

### Task 10: Full Verification And Logged-Out macOS Acceptance

**Files:**

- Verify only; do not edit Chronicle history files manually.

**Step 1: Run formatting and focused suites**

```bash
cargo fmt --check
cargo test -p codex-plus-core computer_history
cargo test -p codex-plus-core chronicle_page
cargo test -p codex-plus-core --test cdp_bridge local_computer_history
cargo test -p codex-plus-core --test cdp_bridge chronicle_fetch_rewriter
cargo test -p codex-plus-core --test launcher
cargo test -p codex-plus-launcher
```

Expected: all pass.

**Step 2: Run broader repo checks**

```bash
cargo test -p codex-plus-core
cargo test -p codex-plus-launcher
npm run check
npm test
npm run vite:build
```

Run the npm commands from `apps/codex-plus-manager/`. Record any unrelated pre-existing failures separately; do not weaken tests.

**Step 3: Review security invariants**

```bash
rg -n "openai-memgen|X-OpenAI-Memgen-Request|experimental_bearer_token|Authorization" crates/codex-plus-core/src/computer_history.rs crates/codex-plus-core/src/chronicle_page.rs apps/codex-plus-launcher/src/main.rs
git diff --check
git status --short
```

Expected:

- Memgen strings occur only in classifier/removal constants and tests;
- no real token/provider URL/history text is present;
- no package/lockfile change was introduced by this feature;
- unrelated user changes remain present and unstaged.

**Step 4: Build and inspect the manager UI**

Run the existing manager dev workflow, open “Codex增强 -> 界面与启动”, and verify at desktop and narrow window widths:

- toggle copy wraps without overlap;
- toggle is available on macOS and default off;
- data-boundary copy explicitly says local persistence plus remote provider processing;
- changing the toggle persists `codexAppLocalComputerHistory` and does not change other fields.

**Step 5: Perform real logged-out Codex acceptance**

After the user has fully quit the existing Codex app, launch through the newly built Codex++ launcher with the toggle enabled. Do not force-quit an active app.

Verify in the real UI:

1. Open `/settings/chronicle` while logged out.
2. Confirm the local-mode notice is present and no compatibility error appears.
3. Turn on, grant/customize permissions, pause, resume and clear history.
4. Confirm the official page controls and state updates work.
5. Confirm Chronicle-managed local files appear/update under its existing local storage and `~/.codex/memories/extensions/skysight/`; inspect only filenames, sizes and timestamps, not sensitive content.
6. Trigger a synthetic/controlled summary and confirm the wrapper diagnostic reports `chronicle_summary` without logging args/body.
7. Confirm no request uses `openai-memgen` or `X-OpenAI-Memgen-Request` and no ChatGPT Memories query/mutation is issued by the patched page.
8. Temporarily make the synthetic fake provider unavailable and confirm local capture remains active while summary generation fails without OpenAI fallback.
9. Restore the current provider and confirm a later summary succeeds and remains local.

**Step 6: Capture final diff and commit boundary**

Review every staged hunk against this plan. Do not push, tag, publish a release or create a PR.

```bash
git diff --cached --check
git status --short
```

Expected: only intended feature hunks/new tests are staged or committed; all pre-existing unrelated work remains untouched.

## Self-Review Checklist

- [ ] Every design goal from `docs/superpowers/specs/2026-08-14-computer-history-local-memories-design.md` maps to an implementation task and an acceptance check.
- [ ] The page patch removes both Memories availability queries and Memories enable/write calls, not merely the disabled button.
- [ ] The CDP rewriter is installed only when opted in, handles cached/early-loaded chunks, and always continues unsupported requests.
- [ ] Normal `codex exec` calls are byte-for-byte passthrough and preserve exit/stdin/stdout/stderr behavior.
- [ ] Chronicle recognition requires all signature traits; uncertain input is never rewritten.
- [ ] `--ignore-user-config`, `--ephemeral`, read-only sandbox and Chronicle feature isolation remain present.
- [ ] The active model/provider is re-read for every summary invocation.
- [ ] Secrets are child-only environment values and cannot appear in argv/Debug/serde/log output.
- [ ] The real CLI contract test proves `/v1/responses`, `store:false`, no `previous_response_id`, and no Memgen header.
- [ ] API failure cannot disable local capture or invoke an OpenAI fallback.
- [ ] Unknown client hash fails closed with a visible compatibility message.
- [ ] No test or log prints real history content, API credentials, provider URL or Authorization values.
- [ ] Existing dirty-worktree changes remain intact and excluded from feature commits.
- [ ] No unfinished implementation marker, package metadata change, push, release or PR is included.
