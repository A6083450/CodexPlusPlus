# DS Style Cost Performance-First Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Rust 原生运行态服务和极薄 Renderer 视图完整替换 `market-codex-ds-style-cost.js`，保持当前静态界面和交互入口一致，并用真实 Codex App A/B 证明成本功能不会再让 `Codex (Renderer)` 持续高 CPU。

**Architecture:** `TokenCostService` 在 Rust 中接收协议代理与 Renderer 白名单事件，完成去重、状态机、费用和运行期聚合；现有 CDP bridge 增加四条窄路由和受 500ms 限速的原生推送；启动 userscript 只保留 HUD、字段级 DOM 更新和事件委托，设置、分析、Profile 与 Flatpickr 通过静态内置资源按需执行。运行期历史不落盘，旧浏览器数据永不读取，唯一持久化内容是用户主动修改的小型 UI 配置。

**Tech Stack:** Rust 2024 workspace、Tokio、Serde/serde_json、Reqwest、现有 CDP WebSocket bridge、原生 JavaScript、Node `node:test`、现有 Cargo 与 Tauri 构建链。

## Global Constraints

- 不新增 crate 或 npm 依赖，不修改 `Cargo.toml`、`package.json`、`.gitignore`。
- 不读取、迁移或删除旧 localStorage、IndexedDB、Profile ledger、旧 analytics rollup。
- 不提供旧脚本回退路径；继续使用同一文件名 `market-codex-ds-style-cost.js`，通过正常内置版本升级覆盖旧版。
- 不改写 `Array.prototype`、`Promise.prototype`、`RegExp.prototype`、`fetch`、XHR、WebSocket、`electronBridge`、React context、Statsig 或 React Fiber。
- 成本功能不得添加 `document.body`/`document.documentElement` 全子树观察器、`setInterval`、响应克隆、任意对象递归扫描或强制布局读取。
- Profile 对 host DOM 的唯一写入是用户显式打开账号菜单后，对严格匹配的旧 Profile 菜单项做一次性属性/文字替换；只允许一次 `requestAnimationFrame`，关闭/销毁时恢复，不轮询、不观察 DOM、不修改官方状态。
- `EVENT_QUEUE_CAPACITY = 256`，`RECENT_TURN_LIMIT = 256`，`MAX_RENDERER_EVENT_BYTES = 4 * 1024`，`MAX_SNAPSHOT_BYTES = 8 * 1024`，`LAZY_PUSH_CAPACITY = 8`。
- `MAX_ID_BYTES = 160`，`MAX_MODEL_BYTES = 128`，`MAX_TOOL_NAME_BYTES = 128`，`MAX_EMAIL_BYTES = 320`，`MAX_PROFILE_TEXT_BYTES = 128`，`MAX_PROFILE_AVATAR_BYTES = 256 * 1024`。
- `MAX_SSE_FRAME_BYTES = 64 * 1024`，`MAX_CC_SWITCH_BODY_BYTES = 1024 * 1024`，每个 session 的 `DEDUPE_FINGERPRINT_LIMIT = 512`。
- 所有快照统一经过 `SNAPSHOT_MIN_INTERVAL = 500ms` 限速；最终状态和用户操作只能替换 pending 快照，不能绕过限速。
- 没有 pending 快照时不创建 sleep；Renderer 空闲时成本功能的周期 timer、bridge 请求、native push 均为 0。
- 采集默认关闭；只有成功 `/token-cost/bootstrap` 的当前 page instance 才能激活。userscript 禁用或 instance dispose 后，Renderer 不提取/发送事件、不安装账号菜单 click/keydown 边界，协议代理不创建 usage tap。
- 运行期 token、费用、turn 与分析在 Codex++ 退出后清零；只有 `UiConfig` 在用户主动保存时原子写入 `~/.config/Codex++/token-cost-ui.json`。
- 只创建独立本地测试构建；不发布、不推送、不替换 `/Applications` 中已安装的 Codex/Codex++。
- 每次只 stage 本任务列出的路径，不触碰 `.idea/` 或其他用户改动。

---

## File And Interface Map

### New Rust files

- `crates/codex-plus-core/src/token_cost/mod.rs`：公开服务 API、常量和子模块导出。
- `crates/codex-plus-core/src/token_cost/model.rs`：输入事件、usage、配置、快照、action、lazy asset 类型。
- `crates/codex-plus-core/src/token_cost/pricing.rs`：整数纳美元费用计算、Fast 倍率和默认价格。
- `crates/codex-plus-core/src/token_cost/config.rs`：`UiConfigStore` 加载与原子保存。
- `crates/codex-plus-core/src/token_cost/state.rs`：有界事件队列、session/turn 状态机、去重、recent turns、rollup。
- `crates/codex-plus-core/src/token_cost/input.rs`：Responses SSE、Chat SSE、非流 JSON 提取与规范化 Renderer 事件校验。
- `crates/codex-plus-core/src/token_cost/push.rs`：单槽最新快照、懒模块有界通道、纯状态限速器。
- `crates/codex-plus-core/src/token_cost/assets.rs`：懒资源 `include_str!` 与安全 `Runtime.evaluate` 表达式构造。
- `crates/codex-plus-core/tests/token_cost.rs`：服务、定价、配置、输入、背压的集成测试。

### New Renderer assets

- `assets/live_token_cost/settings.js`：设置壳、数据与显示、模型价格。
- `assets/live_token_cost/analytics.js`：运行期分析和日期范围交互。
- `assets/live_token_cost/profile.js`：账号菜单入口后打开的 Codex++ 自有本地 Profile 页面。
- `assets/live_token_cost/flatpickr.js`：Flatpickr 4.6.13 与中文 locale，仅首次打开日期选择器时执行。
- `assets/live_token_cost/flatpickr.css`：当前日期选择器视觉样式。

### Modified files

- `crates/codex-plus-core/src/lib.rs`：新增 `pub mod token_cost;`。
- `crates/codex-plus-core/src/paths.rs`：新增 `default_codex_plus_config_dir()`、`TOKEN_COST_UI_FILE` 与 `token_cost_ui_path()`；不改变现有 settings/status 路径。
- `crates/codex-plus-core/src/routes.rs`：`BridgeContext` 持有共享服务并增加四条严格反序列化路由。
- `crates/codex-plus-core/src/bridge.rs`：保留 `install_bridge`，新增带 push receiver 的兼容扩展。
- `crates/codex-plus-core/src/launcher.rs`：helper/protocol proxy 与默认注入共享同一个服务实例。
- `apps/codex-plus-launcher/src/main.rs`：带数据服务的 packaged launcher context 使用同一服务和 push receiver。
- `assets/inject/renderer-inject.js`：只在现有 app-server/导航边界增加成本白名单提取和生命周期事件。
- `assets/user_scripts/market-codex-ds-style-cost.js`：整文件替换为不超过 60KB 的 bootstrap。
- `apps/codex-plus-manager/src/live-token-cost.test.ts`：替换旧脚本内部算法测试为薄视图契约测试。
- `apps/codex-plus-manager/src/renderer-inject.test.ts`：增加白名单和生命周期测试。
- `crates/codex-plus-core/tests/cdp_bridge.rs`：增加推送合并、限速、idle 与 lazy source 测试。
- `crates/codex-plus-core/tests/bridge_routes.rs`：增加四条路由并更新内置脚本升级断言。
- `crates/codex-plus-core/tests/launcher.rs` 与 `apps/codex-plus-launcher/src/main.rs` 内联测试：验证共享服务接线。

### Public Rust contract

`model.rs` 使用以下固定形状；字符串在反序列化后统一检查长度，不把请求正文或 delta 文本存入状态：

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    ProtocolProxy,
    Renderer,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventMeta {
    pub source: UsageSource,
    pub session_id: String,
    pub turn_id: String,
    pub event_id: String,
    pub correlation_id: String,
    pub occurred_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenUsage {
    pub input: u64,
    pub cached_input: u64,
    pub cache_write: u64,
    pub output: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TokenCostEvent {
    TurnStarted { meta: EventMeta, model: String, fast: bool },
    OutputDelta { meta: EventMeta, estimated_output_tokens: u64 },
    ToolStarted { meta: EventMeta, call_id: String, name: String },
    ToolCompleted { meta: EventMeta, call_id: String },
    Usage { meta: EventMeta, usage: TokenUsage, exact: bool },
    TurnCompleted { meta: EventMeta, usage: Option<TokenUsage> },
    TurnFailed { meta: EventMeta },
}
```

价格统一存为 USD/百万 token 的纳美元整数，计算使用 `u128` 中间值，避免新 decimal 依赖和浮点累计误差：

```rust
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelPrice {
    pub input_nanos_per_million: u64,
    pub cached_input_nanos_per_million: Option<u64>,
    pub cache_write_nanos_per_million: Option<u64>,
    pub output_nanos_per_million: u64,
}

pub fn usage_cost_nanos(usage: TokenUsage, price: ModelPrice, fast_multiplier_millis: u32) -> u64;
```

持久化配置只包含以下字段，默认值为 `hub_visible=true`、`output_rate_visible=true`、`profile_visible=true`、空价格覆盖和本地 Profile 默认值：

```rust
#[derive(Clone, Debug)]
pub struct UiConfigStore {
    path: Option<PathBuf>,
}

impl UiConfigStore {
    pub fn new(path: PathBuf) -> Self;
    pub fn in_memory() -> Self;
    pub fn load(&self) -> UiConfig;
    pub fn save(&self, config: &UiConfig) -> anyhow::Result<()>;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct UiConfig {
    pub schema_version: u8,
    pub hub_visible: bool,
    pub output_rate_visible: bool,
    pub profile_visible: bool,
    pub price_overrides: BTreeMap<String, ModelPrice>,
    pub profile: ProfileConfig,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileConfig {
    pub display_name: String,
    pub username: String,
    pub email: String,
    pub plan_type: String,
    pub plan_label: String,
    pub workspace_name: String,
    pub avatar_data_url: Option<String>,
}
```

`ProfileConfig::default()` 固定为 `display_name="Local Usage"`、`username="codex-local-usage"`、`email="sama@openai.com"`、`plan_type="pro_20x"`、`plan_label="Pro 20x"`、空 `workspace_name` 和无头像，与旧版首次可见状态一致，但不读取旧值。`display_name`、`plan_type`、`plan_label`、`workspace_name` 最多 128 bytes；`username` 必须是 3–20 个 ASCII 字符且只含字母、数字、`.`、`_`、`-`；电子邮件最多 320 bytes；头像必须是总长不超过 256KB 的 `data:image/png|jpeg|webp;base64,...`。

bridge action 采用 tag enum，不接收自由形状对象：

```rust
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TokenCostAction {
    SetVisibility { instance_id: String, hub_visible: bool, output_rate_visible: bool, profile_visible: bool },
    SavePrice { instance_id: String, model: String, price: ModelPrice },
    DeletePrice { instance_id: String, model: String },
    ResetPrice { instance_id: String, model: String },
    SaveProfile { instance_id: String, profile: ProfileConfig },
    QueryAnalytics { instance_id: String, range: AnalyticsRange, model: Option<String> },
    SyncCcSwitch { instance_id: String },
    QueryDiagnostics { instance_id: String },
    DisposeInstance { instance_id: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AnalyticsRange {
    Today,
    LastSevenDays,
    LastThirtyDays,
    Custom { from_day: String, to_day: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LazyAsset {
    Settings,
    Analytics,
    Profile,
    Flatpickr,
}
```

action 返回值和分析形状固定为：

```rust
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TokenCostActionResponse {
    Updated { config: UiConfig, snapshot: TokenCostSnapshot },
    Analytics { analytics: AnalyticsSnapshot },
    Synced { imported_turns: u32, analytics: AnalyticsSnapshot },
    Diagnostics { diagnostics: TokenCostDiagnostics },
    Disposed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsSnapshot {
    pub from_day: String,
    pub to_day: String,
    pub totals: AnalyticsTotals,
    pub days: Vec<AnalyticsDay>,
    pub models: Vec<AnalyticsModel>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsTotals {
    pub turns: u32,
    pub steps: u32,
    pub input: u64,
    pub cached_input: u64,
    pub cache_write: u64,
    pub output: u64,
    pub cost_nanos: u64,
    pub llm_ms: u64,
    pub tool_ms: u64,
    pub first_token_total_ms: u64,
    pub first_token_samples: u32,
    pub generation_ms: u64,
    pub generation_output_tokens: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsDay {
    pub day: String,
    pub totals: AnalyticsTotals,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsModel {
    pub model: String,
    pub totals: AnalyticsTotals,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct TokenCostDiagnostics {
    pub events_ingested: u64,
    pub events_coalesced: u64,
    pub events_rejected: u64,
    pub queue_depth: u64,
    pub queue_high_water: u64,
    pub recent_turns: u64,
    pub dedupe_fingerprints: u64,
    pub snapshots_published: u64,
    pub snapshots_sent: u64,
    pub lazy_commands_sent: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SnapshotPush {
    Snapshot {
        instance_id: String,
        snapshot: TokenCostSnapshot,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LazyAssetPush {
    pub instance_id: String,
    pub asset: LazyAsset,
}
```

`days` 最多 31 条，`models` 最多 20 条；输出速率由 `generation_output_tokens / generation_ms` 派生。上述结构不包含请求或响应正文。

`TokenCostDiagnostics` 只包含计数器：`events_ingested`、`events_coalesced`、`events_rejected`、`queue_depth`、`queue_high_water`、`recent_turns`、`dedupe_fingerprints`、`snapshots_published`、`snapshots_sent`、`lazy_commands_sent`。`QueryDiagnostics` 只在性能测量开始和结束时调用，不产生持久化或后台采样。

bootstrap、HUD snapshot 和 ingest 结果固定为：

```rust
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TokenCostBootstrap {
    pub instance_id: String,
    pub config: UiConfig,
    pub snapshot: TokenCostSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TokenCostSnapshot {
    pub revision: u64,
    pub running: bool,
    pub model: String,
    pub fast: bool,
    pub turns: u32,
    pub steps: u32,
    pub llm_ms: u64,
    pub tool_ms: u64,
    pub first_token_average_ms: Option<u64>,
    pub output_rate_milli_tokens_per_second: u64,
    pub input: u64,
    pub cached_input: u64,
    pub output: u64,
    pub cost_nanos: u64,
    pub hub_visible: bool,
    pub output_rate_visible: bool,
    pub profile_visible: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IngestOutcome {
    Applied { revision: u64 },
    NoChange { revision: u64 },
    Coalesced { revision: u64 },
    Rejected { reason: &'static str },
}
```

服务接口固定为：

```rust
pub struct TokenCostService {
    inner: std::sync::Mutex<ServiceInner>,
    store: UiConfigStore,
    snapshot_tx: tokio::sync::watch::Sender<Option<SnapshotPush>>,
    lazy_tx: tokio::sync::broadcast::Sender<LazyAssetPush>,
    push_metrics: Arc<PushMetrics>,
    active_instance: Arc<ActiveInstance>,
    cc_switch_in_flight: std::sync::atomic::AtomicBool,
}

struct ServiceInner {
    state: RuntimeState,
    queue: BoundedEventQueue,
    config: UiConfig,
}

pub struct TokenCostPushReceiver {
    pub(crate) snapshots: tokio::sync::watch::Receiver<Option<SnapshotPush>>,
    pub(crate) lazy: tokio::sync::broadcast::Receiver<LazyAssetPush>,
    pub(crate) metrics: Arc<PushMetrics>,
    pub(crate) active_instance: Arc<ActiveInstance>,
}

pub(crate) struct PushMetrics {
    snapshots_sent: std::sync::atomic::AtomicU64,
    lazy_commands_sent: std::sync::atomic::AtomicU64,
}

pub(crate) struct ActiveInstance {
    current: std::sync::RwLock<Option<String>>,
}

impl ActiveInstance {
    pub(crate) fn replace(&self, instance_id: String);
    pub(crate) fn clear_if(&self, instance_id: &str) -> bool;
    pub(crate) fn matches(&self, instance_id: &str) -> bool;
    pub(crate) fn is_active(&self) -> bool;
}

impl TokenCostService {
    pub fn with_store(store: UiConfigStore) -> Arc<Self>;
    pub fn in_memory() -> Arc<Self>;
    pub fn ingest(&self, event: TokenCostEvent) -> IngestOutcome;
    pub fn bootstrap(&self, instance_id: &str) -> anyhow::Result<TokenCostBootstrap>;
    pub async fn apply_action(&self, action: TokenCostAction) -> anyhow::Result<TokenCostActionResponse>;
    pub fn request_lazy_asset(&self, instance_id: &str, asset: LazyAsset) -> anyhow::Result<()>;
    pub fn subscribe(&self) -> TokenCostPushReceiver;
    pub fn capture_enabled(&self) -> bool;
}
```

`output_rate_milli_tokens_per_second` 以千分之一 tok/s 为单位，避免 snapshot 中出现浮点。分析数据只由 `QueryAnalytics` 返回，不能进入每 500ms 的快照。

### Bridge and JavaScript contract

四条 route 固定为：

```text
/token-cost/bootstrap
/token-cost/event
/token-cost/action
/token-cost/lazy-asset
```

页面固定入口是 `window.__codexLiveTokenCostV1`：

```javascript
{
  instanceId,
  acceptNativePush(push),
  registerModule(name, factory),
  emitAction(action),
  diagnostics(),
  destroy(),
}
```

Rust 只执行两个固定表达式形状。snapshot 通过完整 JSON 序列化，不拼接字段：

```rust
pub fn snapshot_expression(push: &SnapshotPush) -> anyhow::Result<String> {
    let payload = serde_json::to_string(push)?;
    Ok(format!(
        "window.__codexLiveTokenCostV1?.acceptNativePush({payload})"
    ))
}
```

以及由 Rust 构造、包含静态 `include_str!` 源码的实例校验包装器：

```rust
pub fn lazy_asset_expression(instance_id: &str, asset: LazyAsset) -> anyhow::Result<String> {
    let instance_id = serde_json::to_string(instance_id)?;
    let source = lazy_asset_source(asset);
    Ok(format!(
        "(() => {{ const api = window.__codexLiveTokenCostV1; \
         if (!api || api.instanceId !== {instance_id}) return false; \
         {source}\nreturn true; }})()"
    ))
}

fn lazy_asset_source(asset: LazyAsset) -> String {
    match asset {
        LazyAsset::Settings => include_str!("../../../../assets/live_token_cost/settings.js").to_owned(),
        LazyAsset::Analytics => include_str!("../../../../assets/live_token_cost/analytics.js").to_owned(),
        LazyAsset::Profile => include_str!("../../../../assets/live_token_cost/profile.js").to_owned(),
        LazyAsset::Flatpickr => format!(
            "const __codexLiveTokenCostFlatpickrCss = {};\n{}",
            serde_json::to_string(include_str!("../../../../assets/live_token_cost/flatpickr.css"))
                .expect("static CSS must serialize"),
            include_str!("../../../../assets/live_token_cost/flatpickr.js"),
        ),
    }
}
```

不得使用 `eval`、`new Function`、动态 script URL 或运行时网络加载模块。

---

### Task 1: Freeze The Old Visual Contract Before Replacement

**Files:**
- Create: `docs/superpowers/evidence/ds-style-cost-baseline/manifest.md`
- Create: `docs/superpowers/evidence/ds-style-cost-baseline/hud-idle.png`
- Create: `docs/superpowers/evidence/ds-style-cost-baseline/hud-running.png`
- Create: `docs/superpowers/evidence/ds-style-cost-baseline/settings-general.png`
- Create: `docs/superpowers/evidence/ds-style-cost-baseline/settings-profile.png`
- Create: `docs/superpowers/evidence/ds-style-cost-baseline/settings-usage.png`
- Create: `docs/superpowers/evidence/ds-style-cost-baseline/settings-pricing.png`
- Create: `docs/superpowers/evidence/ds-style-cost-baseline/settings-calendar.png`
- Create: `docs/superpowers/evidence/ds-style-cost-baseline/profile-page.png`
- Create: `apps/codex-plus-manager/src/live-token-cost-visual-contract.test.ts`

**Interfaces:** Add a characterization test that executes the checked-in old script in the VM DOM harness and locks its rendered labels, HUD field order, settings navigation, element IDs, computed CSS variables and accepted animation differences. Source-text matching is not behavior evidence; the test must drive the real script and assert observable DOM/style/interaction results.

- [ ] **Step 1: Add the visual characterization test against the existing script**

  Execute version `0.8.3` against controlled composer, settings and account-menu fixtures. Assert the exact rendered HUD sequence `轮 · 步`, `LLM · 工具调用`, `首 token 平均 · tok/s`, `缓存命中`, `输入 tok · 输出 tok`; panel order `个人资料/数据与显示/使用统计/模型价格`; IDs `codex-live-token-cost` and `codex-live-token-cost-settings`; account trigger labels `打开个人资料菜单/Open profile menu/Open profile menu and settings`; and computed `--cltc-*` color/spacing/radius values. Drive click/keyboard behavior and lock the old enabled Profile menu row's role, disabled attributes, class, identity label/avatar geometry and behavior as the entry contract; do not lock its React implementation or grep the source for these strings.

- [ ] **Step 2: Run the characterization test**

  Run: `cd apps/codex-plus-manager && node --test src/live-token-cost-visual-contract.test.ts`

  Expected: PASS against version `0.8.3`. A failure means the fixture assumptions do not match the checked-in old source and must be corrected before replacement.

- [ ] **Step 3: Capture fixed-state baseline images from a separate local test instance**

  Run: `cargo build -p codex-plus-launcher --release`

  Run: `test ! -e target/ds-style-cost-baseline-20260815 && mkdir -p target/ds-style-cost-baseline-20260815/config && cp target/release/codex-plus-plus target/ds-style-cost-baseline-20260815/codex-plus-plus`

  Use viewport `1440x900`, device scale factor `1`, light theme, fixed time `2026-08-15T10:00:00+08:00`, fixed font loading, and fixture values `12轮/34步/LLM 1m 08s/工具调用 24s/首 token 1.2s/52 tok/s/缓存命中 72%/输入 128K/输出 18K`.

  Launch the copied binary as `XDG_CONFIG_HOME=target/ds-style-cost-baseline-20260815/config target/ds-style-cost-baseline-20260815/codex-plus-plus --debug-port 9338`. This empty isolated config forces installation of the checked-in old bundled source without reading or overwriting the user's real user-script file. Use the existing CDP screenshot capability to save the eight named PNGs, and keep the old script enabled only long enough to capture them. Do not run the DMG packager, replace an installed app, or leave the old instance running after capture.

  Run: `shasum -a 256 assets/user_scripts/market-codex-ds-style-cost.js target/ds-style-cost-baseline-20260815/config/Codex++/user_scripts/market-codex-ds-style-cost.js`

  Expected: both hashes are identical before accepting screenshots.

- [ ] **Step 4: Record exact evidence metadata**

  In `manifest.md`, record viewport, theme, fixed fixture, each PNG pixel size, SHA-256, the source commit, selectors for measured HUD/modal/profile bounds, and the only accepted visual differences: removed rolling digits, shimmer, and other continuous animations.

  Run: `sips -g pixelWidth -g pixelHeight docs/superpowers/evidence/ds-style-cost-baseline/*.png`

  Run: `shasum -a 256 docs/superpowers/evidence/ds-style-cost-baseline/*.png`

- [ ] **Step 5: Commit the baseline contract**

  ```bash
  git add apps/codex-plus-manager/src/live-token-cost-visual-contract.test.ts
  git add -f docs/superpowers/evidence/ds-style-cost-baseline
  git commit -m "test: freeze ds style cost visual contract"
  ```

### Task 2: Add Core Models, Integer Pricing, And UI Config Persistence

**Files:**
- Create: `crates/codex-plus-core/src/token_cost/mod.rs`
- Create: `crates/codex-plus-core/src/token_cost/model.rs`
- Create: `crates/codex-plus-core/src/token_cost/pricing.rs`
- Create: `crates/codex-plus-core/src/token_cost/config.rs`
- Create: `crates/codex-plus-core/tests/token_cost.rs`
- Modify: `crates/codex-plus-core/src/lib.rs`
- Modify: `crates/codex-plus-core/src/paths.rs`

**Interfaces:** Implement the public model, pricing, config and constants defined above; the full `TokenCostService` is created in Task 3. `UiConfigStore::in_memory()` must never touch disk; `UiConfigStore::new(path)` must load only its exact JSON path.

- [ ] **Step 1: Write failing model, pricing, and config tests**

  Cover exact serde tags, unknown-field rejection, the exact Profile defaults and field/username/email/avatar validation above, malformed config fallback with one rate-limited diagnostic, `u128` cost math, cached input fallback to input price, absent cache-write price, Fast multipliers `gpt-5.6=2.0x`, `gpt-5.5=2.5x`, `gpt-5.4=2.0x`, and atomic replacement without leftover temp files.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Expected: compile failure because `codex_plus_core::token_cost` and `token_cost_ui_path()` do not exist.

- [ ] **Step 3: Implement models and integer pricing**

  `usage_cost_nanos` must first compute `uncached_input = input.saturating_sub(cached_input)`，再按以下函数计算未缓存输入、缓存输入、缓存写入和输出四项：

  ```rust
  fn component_cost(tokens: u64, nanos_per_million: u64) -> u128 {
      u128::from(tokens) * u128::from(nanos_per_million) / 1_000_000
  }
  ```

  `cached_input_nanos_per_million=None` 与 `cache_write_nanos_per_million=None` 都回退到 input price。四项求和后乘 `fast_multiplier_millis / 1000`，最后 clamp 到 `u64::MAX`。不得用 `f64` 累计金额。

  Port the current fallback USD/1M table exactly, then convert once to nanodollars: `gpt-5.6-sol 5/0.5/6.25/30`，`gpt-5.6-terra 2.5/0.25/3.125/15`，`gpt-5.6-luna 1/0.1/1.25/6`，`gpt-5.3-codex 1.75/0.175/none/14`，`gpt-5.4 2.5/0.25/none/15`，`gpt-5.4-mini 0.75/0.075/none/4.5`，`gpt-5.4-nano 0.2/0.02/none/1.25`，`gpt-5.4-pro 30/none/none/180`，`gpt-5.5 5/0.5/none/30`，`gpt-5.5-pro 30/none/none/180`。字段顺序是 input/cached input/cache write/output。新实现不读取旧页面全局价格对象。

- [ ] **Step 4: Implement isolated config persistence**

  Add `default_codex_plus_config_dir()` with the same platform rules already used by the packaged launcher user-script manager: Windows `APPDATA/Codex++`，其他平台优先 `XDG_CONFIG_HOME/Codex++`，再回退 `~/.config/Codex++`。Add `TOKEN_COST_UI_FILE: &str = "token-cost-ui.json"` and `token_cost_ui_path()` under that directory; do not change `.codex-session-delete` settings/status paths. Save only from mutating actions using `crate::settings::atomic_write`; load `schema_version=1`; reject strings above the model/profile limits defined in `model.rs`; avatar data URL 限制为 256KB；never inspect browser storage.

- [ ] **Step 5: Run focused and library tests**

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Run: `cargo test -p codex-plus-core paths:: -- --nocapture`

  Run: `cargo test -p codex-plus-core settings::tests::atomic_write_replaces_existing_file_and_removes_temp_file -- --nocapture`

  Expected: PASS.

- [ ] **Step 6: Commit core types**

  ```bash
  git add crates/codex-plus-core/src/lib.rs crates/codex-plus-core/src/paths.rs crates/codex-plus-core/src/token_cost crates/codex-plus-core/tests/token_cost.rs
  git commit -m "feat: add native token cost models and config"
  ```

### Task 3: Implement The Bounded Runtime State Machine

**Files:**
- Create: `crates/codex-plus-core/src/token_cost/state.rs`
- Modify: `crates/codex-plus-core/src/token_cost/mod.rs`
- Modify: `crates/codex-plus-core/src/token_cost/model.rs`
- Create: `crates/codex-plus-core/src/token_cost/push.rs`
- Modify: `crates/codex-plus-core/tests/token_cost.rs`

**Interfaces:** `BoundedEventQueue::new(256)` coalesces `OutputDelta` by `(session_id, turn_id)`，保留较大的累计 `estimated_output_tokens`，evicts the oldest delta to admit lifecycle/final events, and never lets an ordinary delta evict a critical event. `RuntimeState::apply` is deterministic and has no clock reads; timestamps come from events/tests.

- [ ] **Step 1: Write failing transition and pressure tests**

  Cover capture disabled by default, bootstrap activation, matching dispose deactivation, stale dispose ignored, turn start, lazy start on usage, first-token timestamp, overlapping tool intervals as interval union, output rate, exact usage replacing estimates, protocol exact usage outranking Renderer exact usage, duplicate event IDs, repeated final usage, completion before usage, failure, 257th recent turn folding into O(1) rollups, revision unchanged for semantic no-op, and 10,000 deltas with queue length never above 256.

- [ ] **Step 2: Run state tests and verify RED**

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Expected: failure because runtime state and queue behavior are not implemented.

- [ ] **Step 3: Implement queue priority and deterministic state transitions**

  Store at most 512 dedupe fingerprints in a FIFO set per active session. A fingerprint is `(source, event_id)`; final usage also uses `(correlation_id, input, cached_input, cache_write, output)` so an exact protocol event can replace, but not add to, an equivalent Renderer estimate.

  Use these critical variants: `TurnStarted`, `ToolStarted`, `ToolCompleted`, `Usage(exact=true)`, `TurnCompleted`, `TurnFailed`. Only `OutputDelta` and `Usage(exact=false)` are coalescible. 如果队列已被 256 个 critical event 占满，`TokenCostService::ingest` 先同步 apply 最旧 critical event，再接纳新 critical event；critical event 永不因普通 delta 或容量压力被丢弃。

  Count one turn on the first accepted `TurnStarted` or lazy-start event. Count the first LLM step at turn start; after the active tool interval closes, the next reasoning/agent `OutputDelta` starts at most one new step. A distinct exact usage correlation may also establish a missing step, but may not increment a step already seen from Renderer. First-token latency is measured once per step from that step start to its first output event. Tool time is the union of overlapping tool intervals; LLM time is completed turn wall time minus that union. Output rate uses exact output tokens when available, otherwise cumulative estimated output tokens, divided by measured generation time.

- [ ] **Step 4: Implement bounded recent turns and incremental rollups**

  Keep exactly 256 completed turn summaries in `VecDeque`. On eviction, no scan or re-aggregation occurs because daily/model counters were updated at completion time. `QueryAnalytics` reads the counters and at most 256 recent summaries.

- [ ] **Step 5: Publish snapshots only on visible semantic changes**

  `TokenCostService::ingest` locks the queue/state once, enqueues, drains deterministically, compares the compact visible snapshot, increments revision only when it differs, then sends the latest snapshot to the watch channel. It must not spawn an event worker or an idle task.

- [ ] **Step 6: Run all token-cost tests**

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Expected: PASS, including the 10,000-event pressure case.

- [ ] **Step 7: Commit the state machine**

  ```bash
  git add crates/codex-plus-core/src/token_cost crates/codex-plus-core/tests/token_cost.rs
  git commit -m "feat: add bounded token cost runtime state"
  ```

### Task 4: Add Narrow Protocol And Renderer Input Extractors

**Files:**
- Create: `crates/codex-plus-core/src/token_cost/input.rs`
- Modify: `crates/codex-plus-core/src/token_cost/mod.rs`
- Modify: `crates/codex-plus-core/tests/token_cost.rs`

**Interfaces:**

```rust
pub struct ResponsesUsageTap {
    state: UsageTapState,
}

pub struct ChatUsageTap {
    state: UsageTapState,
}

struct UsageTapState {
    request_id: u64,
    session_id: String,
    turn_id: String,
    correlation_id: String,
    model: String,
    sequence: u64,
    tail: Vec<u8>,
    terminal_seen: bool,
}

impl ResponsesUsageTap {
    pub fn from_request(request_id: u64, body: &[u8], now_ms: u64) -> (Self, Vec<TokenCostEvent>);
    pub fn push_bytes(&mut self, bytes: &[u8], now_ms: u64) -> Vec<TokenCostEvent>;
    pub fn finish(&mut self, now_ms: u64) -> Vec<TokenCostEvent>;
}

impl ChatUsageTap {
    pub fn from_request(request_id: u64, body: &[u8], now_ms: u64) -> (Self, Vec<TokenCostEvent>);
    pub fn push_bytes(&mut self, bytes: &[u8], now_ms: u64) -> Vec<TokenCostEvent>;
    pub fn finish(&mut self, now_ms: u64) -> Vec<TokenCostEvent>;
}

pub fn validate_renderer_event(event: TokenCostEvent) -> anyhow::Result<TokenCostEvent>;
```

- [ ] **Step 1: Write failing extractor tests with fixture bytes**

  Cover split SSE frames, multiple frames per chunk, `[DONE]`, Responses output/reasoning deltas and `response.completed`, Chat content/reasoning deltas and `usage`, non-stream JSON, malformed frames, 64KB per-frame cap and direct fields only.

  Assert nested lookalike fields are ignored；Renderer events with a non-Renderer source, strings over limits, invalid cumulative token values, or serialized size over 4KB are rejected by `validate_renderer_event`.

- [ ] **Step 2: Run input tests and verify RED**

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Expected: failure because taps and allowlist extractor are missing.

- [ ] **Step 3: Implement incremental SSE parsing**

  Buffer only the incomplete frame tail, cap it at 64KB, parse only `data:` JSON records, and immediately discard processed bytes. Maintain only a cumulative output UTF-8 byte count and emit cumulative `OutputDelta`; never retain delta text. Extract only documented direct paths such as `response.usage`, top-level `usage`, `model`, `service_tier` (`priority` means Fast), `metadata.thread_id`, `metadata.turn_id`, `conversation`, and `prompt_cache_key`; do not walk arbitrary descendants.

- [ ] **Step 4: Implement correlation rules**

  Prefer explicit thread/turn IDs, then `correlation_id`, then a connection-local `proxy-{request_id}` identity. The service may attach an ID-less exact proxy usage to the sole active turn; when zero or multiple turns are active it remains connection-local rather than guessing.

- [ ] **Step 5: Run input and protocol proxy regression tests**

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Run: `cargo test -p codex-plus-core --test protocol_proxy -- --nocapture`

  Expected: PASS; existing response conversion bytes remain unchanged.

- [ ] **Step 6: Commit extractors**

  ```bash
  git add crates/codex-plus-core/src/token_cost crates/codex-plus-core/tests/token_cost.rs
  git commit -m "feat: add bounded token usage extractors"
  ```

### Task 5: Add Strict Token-Cost Bridge Routes

**Files:**
- Modify: `crates/codex-plus-core/src/routes.rs`
- Modify: `crates/codex-plus-core/tests/bridge_routes.rs`
- Modify: `crates/codex-plus-core/src/token_cost/model.rs`
- Modify: `crates/codex-plus-core/src/token_cost/mod.rs`

**Interfaces:** Preserve every existing `BridgeContext` constructor. Existing constructors attach `TokenCostService::in_memory()`; add `pub fn with_token_cost(self, service: Arc<TokenCostService>) -> Self`. The four routes deserialize dedicated request structs with `deny_unknown_fields` and return the existing bridge status envelope style.

- [ ] **Step 1: Write failing bridge contract tests**

  Add the four paths to `bridge_routes_cover_all_current_paths`. Test valid bootstrap/event/action/lazy requests, unknown fields, wrong types, missing instance ID, 129-character IDs, 4KB Renderer event cap, stale instance, and that `/backend/status` still completes normally.

- [ ] **Step 2: Run bridge route tests and verify RED**

  Run: `cargo test -p codex-plus-core --test bridge_routes token_cost -- --nocapture`

  Expected: missing route/context failures.

- [ ] **Step 3: Implement context attachment and route handlers**

  `bootstrap` replaces the shared active page instance, activates capture and returns `{status:"ok", config, snapshot}`. Matching `DisposeInstance` deactivates capture, sends `None` through the snapshot watch and invalidates queued lazy commands through the shared instance check; a stale instance cannot dispose the current one. `event` validates byte size before deserialization, rejects any `meta.source` other than `renderer`, then calls `ingest`; protocol events never enter through the page binding. `action` performs one typed action. `lazy-asset` publishes one typed command. Error responses contain a short category/message but never echo payloads.

- [ ] **Step 4: Implement manual-only CC Switch sync**

  `SyncCcSwitch` first claims `cc_switch_in_flight` with `compare_exchange`; a small scope copies the required state and releases `ServiceInner` before any `await`. It performs one bounded Reqwest request to `http://127.0.0.1:17888/cc-switch/turns?refresh=1`, with 500ms connect timeout、2s total timeout、1MB body cap and no retry/background task, then briefly reacquires the mutex to merge validated values. An RAII guard clears the atomic flag on success, parse failure, timeout or cancellation. Parse only aggregate/turn fields needed for the current runtime and do not persist imported history.

- [ ] **Step 5: Run all bridge route tests**

  Run: `cargo test -p codex-plus-core --test bridge_routes -- --nocapture`

  Expected: PASS, including all existing non-cost routes.

- [ ] **Step 6: Commit routes**

  ```bash
  git add crates/codex-plus-core/src/routes.rs crates/codex-plus-core/src/token_cost crates/codex-plus-core/tests/bridge_routes.rs
  git commit -m "feat: expose strict token cost bridge routes"
  ```

### Task 6: Add Coalesced Native-To-Renderer Pushes And Lazy Assets

**Files:**
- Create: `crates/codex-plus-core/src/token_cost/assets.rs`
- Create: `assets/live_token_cost/settings.js`
- Create: `assets/live_token_cost/analytics.js`
- Create: `assets/live_token_cost/profile.js`
- Create: `assets/live_token_cost/flatpickr.js`
- Create: `assets/live_token_cost/flatpickr.css`
- Modify: `crates/codex-plus-core/src/token_cost/push.rs`
- Modify: `crates/codex-plus-core/src/token_cost/mod.rs`
- Modify: `crates/codex-plus-core/src/bridge.rs`
- Modify: `crates/codex-plus-core/tests/cdp_bridge.rs`
- Modify: `crates/codex-plus-core/tests/token_cost.rs`

**Interfaces:** Keep `install_bridge(...)` unchanged as a wrapper. Add:

```rust
pub async fn install_bridge_with_pushes(
    websocket_url: &str,
    binding_name: &str,
    handler: BridgeHandler,
    new_document_scripts: &[String],
    pushes: Option<TokenCostPushReceiver>,
) -> anyhow::Result<()>;

pub struct SnapshotCoalescer {
    last_sent_at: Option<std::time::Instant>,
    pending: Option<SnapshotPush>,
}

pub enum SnapshotOffer {
    SendNow(SnapshotPush),
    ArmAt(std::time::Instant),
    ReplacedPending,
}

impl SnapshotCoalescer {
    pub fn offer(&mut self, now: std::time::Instant, push: SnapshotPush) -> SnapshotOffer;
    pub fn deadline(&self) -> Option<std::time::Instant>;
    pub fn take_due(&mut self, now: std::time::Instant) -> Option<SnapshotPush>;
    pub fn clear(&mut self);
}
```

- [ ] **Step 1: Write failing pure coalescer tests**

  With explicit `std::time::Instant` values passed to the pure coalescer, assert first dirty snapshot sends immediately, revisions inside 500ms replace pending, exactly the newest sends at 500ms, final snapshot does not bypass the gate, no pending snapshot means no deadline, stale instance pushes are discarded, and serialized snapshots over 8KB are rejected. Do not require Tokio's `test-util` feature.

- [ ] **Step 2: Write failing CDP WebSocket pump tests**

  Extend the fake CDP server to record `Runtime.evaluate`. Assert incoming binding calls still resolve while outbound snapshots arrive, no idle evaluate occurs during a real 650ms observation window, three updates inside 500ms produce one expression, lazy modules use static source wrappers, dispose changes the watch value to `None` and clears pending, queued snapshot/lazy commands for a nonmatching instance never evaluate, and replacing an active pump closes its old receiver.

- [ ] **Step 3: Run focused tests and verify RED**

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Run: `cargo test -p codex-plus-core --test cdp_bridge token_cost_push -- --nocapture`

  Expected: failures because push-aware installation and asset expressions do not exist.

- [ ] **Step 4: Implement single-slot snapshot and bounded command channels**

  Use `tokio::sync::watch` for the latest snapshot and `tokio::sync::broadcast` capacity 8 for one-shot lazy commands. Receivers share atomic `snapshots_sent`/`lazy_commands_sent` counters used only by explicit diagnostics. Lagged lazy commands return a visible one-shot error for the requested panel; they never trigger a retry loop.

- [ ] **Step 5: Implement one-shot bridge scheduling**

  `offer`/`take_due` update `last_sent_at` only when returning a snapshot to send; replacing pending does not move the deadline. The message pump selects among CDP socket input, snapshot changes, lazy commands, shutdown, and an optional pinned `Sleep`. A watch value of `None` clears the coalescer and sleep. Immediately before every snapshot or lazy evaluate, require `pushes.active_instance.matches(instance_id)`; otherwise drop it without incrementing sent counters. Create the sleep only after receiving a dirty snapshot before its deadline; clear it after sending. Send `Runtime.evaluate` with `send_command_without_wait` so bridge request handling is not blocked by evaluate responses.

- [ ] **Step 6: Add inert module registration stubs first**

  Each new JS asset must only call `api.registerModule("name", factory)` and perform no work until its factory is mounted by a user action. `flatpickr.js` contains the existing licensed 4.6.13 source and locale, while `flatpickr.css` is serialized into the static wrapper; neither appears in startup source.

- [ ] **Step 7: Run bridge and token-cost tests**

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Run: `cargo test -p codex-plus-core --test cdp_bridge -- --nocapture`

  Expected: PASS.

- [ ] **Step 8: Commit push infrastructure**

  ```bash
  git add crates/codex-plus-core/src/bridge.rs crates/codex-plus-core/src/token_cost crates/codex-plus-core/tests/cdp_bridge.rs crates/codex-plus-core/tests/token_cost.rs assets/live_token_cost
  git commit -m "feat: add coalesced token cost bridge pushes"
  ```

### Task 7: Wire One Shared Service Through Helper, Proxy, And Launchers

**Files:**
- Modify: `crates/codex-plus-core/src/launcher.rs`
- Modify: `crates/codex-plus-core/tests/launcher.rs`
- Modify: `apps/codex-plus-launcher/src/main.rs`

**Interfaces:** `DefaultLaunchHooks` gets a manually implemented `Default`, owns one `Arc<TokenCostService>`, and exposes `pub fn token_cost_service(&self) -> Arc<TokenCostService>`. Every helper connection and bridge context receives that exact Arc.

- [ ] **Step 1: Write failing shared-instance launcher tests**

  Test that `DefaultLaunchHooks::token_cost_service()` returns pointer-equal Arcs, helper ingestion becomes visible to bootstrap, packaged `watchdog_bridge_context` retains the same service, and bridge reinjection subscribes without constructing a second service.

- [ ] **Step 2: Run launcher tests and verify RED**

  Run: `cargo test -p codex-plus-core --test launcher token_cost -- --nocapture`

  Run: `cargo test -p codex-plus-launcher token_cost -- --nocapture`

  Expected: missing service wiring failures.

- [ ] **Step 3: Thread the service into helper connections**

  Change `handle_helper_connection(stream, remote_addr)` to also receive `Arc<TokenCostService>`. Create a request ID from an `AtomicU64`. Check `capture_enabled()` once when the request begins; when false, preserve the current zero-tap forwarding path. When true, direct Responses streams feed raw upstream chunks to `ResponsesUsageTap` before writing; Chat-to-Responses feeds converted Responses bytes; direct Chat streams feed raw chunks to `ChatUsageTap`; non-stream JSON parses the already-buffered body once. Do not clone response bodies only for cost tracking.

- [ ] **Step 4: Attach the same service to bridge contexts**

  In core `try_inject` and packaged `try_inject_with_context`, call `install_bridge_with_pushes(..., Some(service.subscribe()))`. Keep existing `install_bridge` callers and tests working through the wrapper.

- [ ] **Step 5: Run launcher and protocol tests**

  Run: `cargo test -p codex-plus-core --test launcher -- --nocapture`

  Run: `cargo test -p codex-plus-core --test protocol_proxy -- --nocapture`

  Run: `cargo test -p codex-plus-launcher -- --nocapture`

  Expected: PASS.

- [ ] **Step 6: Commit launcher wiring**

  ```bash
  git add crates/codex-plus-core/src/launcher.rs crates/codex-plus-core/tests/launcher.rs apps/codex-plus-launcher/src/main.rs
  git commit -m "feat: connect token cost service to launch runtime"
  ```

### Task 8: Add The Renderer Allowlist Tap And Explicit Lifecycle Events

**Files:**
- Modify: `assets/inject/renderer-inject.js`
- Modify: `apps/codex-plus-manager/src/renderer-inject.test.ts`

**Interfaces:** Add `tokenCostEventFromAppServer(method, params)` beside the existing dispatcher handling. Before calling it, the existing boundary checks `window.__codexLiveTokenCostCaptureV1?.enabled === true`; disabled mode performs no extraction or bridge request. The extractor may read only direct scalar fields and must emit already-normalized events through `postJson("/token-cost/event", event)`. One document listener each for `codex-plus:token-cost-activate` and `codex-plus:token-cost-deactivate` verifies the capture object's matching instance. Activate emits the first `codex-plus:token-cost-lifecycle` and installs the account-menu boundary; deactivate removes that boundary and its pending frame. Later lifecycle events come only from existing route/app-server boundaries and the explicit account-menu boundary described below.

- [ ] **Step 1: Write failing renderer allowlist tests**

  Export the extractor only through the existing test API. Cover capture-off early return before extraction, every allowed method, direct ID/model/usage/tool fields, per-turn delta sequence IDs, unknown methods, nested lookalikes, oversize data, no text body forwarding, and no recursive helper.

- [ ] **Step 2: Write failing lifecycle and Profile-entry tests**

  Assert capture-off activation emits nothing and installs no account listeners; after setting a valid capture object, one `codex-plus:token-cost-activate` emits exactly one initial lifecycle event, installs one account click/keydown pair, and each real route change emits one more; repeated activation or same route/reason is coalesced synchronously. A stale deactivate does nothing; a matching deactivate removes the pair and cancels the one pending frame.

  Add one idempotent capture-phase click/keydown pair. On unrelated events it performs only an exact `closest` selector check and returns. On `button[aria-label='打开个人资料菜单']`, `button[aria-label='Open profile menu']`, or `button[aria-label='Open profile menu and settings']`, schedule exactly one `requestAnimationFrame`; require non-empty button/menu IDs within `MAX_ID_BYTES`, resolve the menu with `getElementById` rather than selector interpolation, then verify `role='menu'`, exact `aria-labelledby`, one disabled identity row, and a separate enabled Settings row before emitting lifecycle detail `{reason:'profile_menu', profile:false, profileMenuId}`. On a marked `[data-codex-plus-token-cost-profile-entry]`, prevent the host action and emit `{reason:'profile_entry', profile:true}`. Cover mouse, Enter and Space, malformed/oversize menu IDs, CSS-special characters, lookalike menus, repeated clicks before the frame, stale capture, teardown and same-event coalescing. Assert the cost block does not instantiate `MutationObserver`, call `setInterval`, retry a missing menu, or patch global APIs.

- [ ] **Step 3: Run renderer tests and verify RED**

  Run: `cd apps/codex-plus-manager && node --test src/renderer-inject.test.ts`

  Expected: missing extractor and lifecycle assertions fail.

- [ ] **Step 4: Implement the narrow tap at existing boundaries**

  Reuse the dispatcher/subscription already located by `renderer-inject.js`; do not add a second asset scan or dispatcher patch. A small per-active-turn byte/sequence counter is allowed and is cleared on turn completion. 每次文本 delta 只累加 UTF-8 byte length，发送 `estimated_output_tokens = max(1, ceil(cumulative_utf8_bytes / 4))`，随后立即丢弃文本；原生队列覆盖旧 delta 时不会丢失累计估算。

- [ ] **Step 5: Emit lifecycle and the bounded account-menu boundary without polling**

  Dispatch `{route, reason, profile, profileMenuId}` in response to `codex-plus:token-cost-activate`, existing navigation synchronization, `turn/started`, `turn/completed`, and the explicit account-menu boundary. The userscript sets `{enabled:true, instanceId}` only after successful bootstrap, then dispatches the activation event and mounts from the resulting lifecycle event; destroy dispatches matching `codex-plus:token-cost-deactivate` immediately after clearing capture and before its best-effort native dispose. Account-menu handling does not exist while capture is off, owns at most one pending animation frame while active, cancels it during teardown, and never retries a missing/mismatched menu. If any host anchor is absent, wait for another explicit lifecycle/user event; do not schedule a DOM polling fallback.

- [ ] **Step 6: Run renderer regression tests**

  Run: `cd apps/codex-plus-manager && node --test src/renderer-inject.test.ts`

  Run: `cd apps/codex-plus-manager && npm test`

  Expected: PASS.

- [ ] **Step 7: Commit renderer input**

  ```bash
  git add assets/inject/renderer-inject.js apps/codex-plus-manager/src/renderer-inject.test.ts
  git commit -m "feat: forward allowlisted token cost events"
  ```

### Task 9: Replace The Old Userscript With A Thin HUD Bootstrap

**Files:**
- Replace: `assets/user_scripts/market-codex-ds-style-cost.js`
- Replace: `apps/codex-plus-manager/src/live-token-cost.test.ts`
- Modify: `apps/codex-plus-manager/src/live-token-cost-visual-contract.test.ts`
- Create: `apps/codex-plus-manager/src/live-token-cost-performance.test.ts`

**Interfaces:** Version becomes `1.0.0`. Startup creates only style, settings button, HUD root, one root click/change delegation pair, one lifecycle listener, one bridge bootstrap request, `window.__codexLiveTokenCostCaptureV1` and the fixed `window.__codexLiveTokenCostV1` entry. The lifecycle listener also performs the bounded Profile menu-row projection when `reason === 'profile_menu'`; it adds no document listener of its own. Capture remains false until bootstrap succeeds.

- [ ] **Step 1: Rewrite tests first for the thin-view contract**

  Build a VM DOM harness that counts listeners, writes, timers, observers, bridge calls, and global references. Test idempotent install, stale-version destroy, one HUD root, one settings button, one delegated listener set, one lifecycle listener, explicit `diagnostics()` with no background sampler, bootstrap retry delays exactly `[0, 250, 1000]` only after failure, then sleep until lifecycle/user action.

  Test snapshot behavior: lower/same revision ignored, changed revision updates only changed text nodes/attributes, no `innerHTML` replacement after skeleton creation, direct numeric replacement without rolling-digit nodes, bootstrap success sets `{enabled:true, instanceId}` and dispatches one activation event, destroy clears capture, dispatches one matching deactivate, and sends one best-effort matching `DisposeInstance`; destroy removes nodes/listeners/entry, and stale instance native pushes are ignored.

  Test Profile entry projection separately: `profile_visible=false` restores/skips the projection; otherwise only the exact lifecycle-supplied menu ID may be queried. The menu must match `role=menu`, `aria-labelledby`, disabled identity row and enabled Settings sibling; save original class/text/disabled/tabindex/avatar state on that DOM node before marking it with `data-codex-plus-token-cost-profile-entry`; render configured `display_name`/avatar with the baseline geometry; update only after config changes or another explicit menu lifecycle. Before each projection and on destroy/repeat injection, query and restore connected marked nodes; never retain menu nodes in a long-lived Set/Map, so detached menus are collectible. No timer, observer or account/auth mutation is allowed.

- [ ] **Step 2: Add a separate static performance policy gate**

  In `live-token-cost-performance.test.ts`, add a clearly named defense-in-depth policy gate asserting startup source is `<= 61_440` bytes and does not contain `localStorage`, `indexedDB`, `MutationObserver`, `setInterval`, `.clone(`, `offsetWidth`, `Array.prototype`, `Promise.prototype`, `RegExp.prototype`, `window.fetch =`, `XMLHttpRequest`, `WebSocket`, `electronBridge =`, `Statsig`, `__reactFiber`, `eval(`, or `new Function`. Keep this separate from behavior tests: it enforces the agreed performance denylist but is not evidence that the UI works or that CPU budgets pass.

- [ ] **Step 3: Run userscript tests and verify RED**

  Run: `cd apps/codex-plus-manager && node --test src/live-token-cost.test.ts src/live-token-cost-visual-contract.test.ts`

  Run: `cd apps/codex-plus-manager && node --test src/live-token-cost-performance.test.ts`

  Expected: old 496KB script fails size, forbidden API, and thin lifecycle assertions.

- [ ] **Step 4: Replace the script completely**

  Preserve the old HUD static skeleton, IDs, classes, labels, CSS metrics, hover/focus states and visibility attributes. Preserve the visible account-menu Profile row by projecting local text/avatar only at the explicit lifecycle boundary above; this bounded DOM projection is not an official Profile unlock. Remove all old parsing, persistence, aggregation, rolling digit, shimmer, Profile gate/auth/query-cache/sidebar observer and helper code. Format values from native scalar snapshot only; formatting functions must be pure and bounded.

- [ ] **Step 5: Implement bounded bootstrap failure behavior**

  The initial bootstrap may perform at most three one-shot retries at 0/250/1000ms. After the third failure, keep placeholder HUD and do nothing until a lifecycle event or explicit settings click resets the retry budget. Successful bootstrap clears all retry handles.

- [ ] **Step 6: Run userscript and full manager tests**

  Run: `cd apps/codex-plus-manager && node --test src/live-token-cost.test.ts src/live-token-cost-visual-contract.test.ts`

  Run: `cd apps/codex-plus-manager && node --test src/live-token-cost-performance.test.ts`

  Run: `cd apps/codex-plus-manager && npm test`

  Run: `wc -c assets/user_scripts/market-codex-ds-style-cost.js`

  Expected: all tests PASS and byte count is at most 61,440.

- [ ] **Step 7: Commit the bootstrap replacement**

  ```bash
  git add assets/user_scripts/market-codex-ds-style-cost.js apps/codex-plus-manager/src/live-token-cost.test.ts apps/codex-plus-manager/src/live-token-cost-visual-contract.test.ts apps/codex-plus-manager/src/live-token-cost-performance.test.ts
  git commit -m "feat: replace ds style cost with thin hud bootstrap"
  ```

### Task 10: Implement Lazy Settings And Pricing

**Files:**
- Modify: `assets/live_token_cost/settings.js`
- Modify: `assets/user_scripts/market-codex-ds-style-cost.js`
- Modify: `apps/codex-plus-manager/src/live-token-cost.test.ts`
- Modify: `crates/codex-plus-core/tests/token_cost.rs`

**Interfaces:** First settings click records one bounded `pendingOpen` intent and sends one `/token-cost/lazy-asset` request for `settings`; when the static native push registers the module, it consumes that still-current intent and opens the modal from the same user action. A failed/stale registration clears the intent and cannot open later by itself. Closing destroys modal DOM and module listeners but retains the parsed factory for a one-click warm open.

- [ ] **Step 1: Write failing lazy settings tests**

  Cover one cold request, no duplicate request while pending, under-200ms fixture mount, warm reopen under 100ms, panel navigation, focus return, Escape/overlay close, root delegation only, complete cleanup, and static visual strings/order.

- [ ] **Step 2: Write failing typed action tests**

  Cover visibility save, price add/edit/delete/reset, validation errors, config write exactly once per successful user action, no write for analytics/diagnostics/open/close, and a failed write retaining in-memory value with one visible error.

- [ ] **Step 3: Run focused tests and verify RED**

  Run: `cd apps/codex-plus-manager && node --test --test-name-pattern="settings|pricing|lazy" src/live-token-cost.test.ts`

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Expected: inert settings module and missing action rendering fail.

- [ ] **Step 4: Port only settings/pricing markup and static CSS**

  Reuse the baseline classes, visible labels/descriptions, helper status row/link and values from old CSS so the static panel remains identical. Omit only animation loops and background helper polling/sync. The existing `个人资料` settings navigation remains a direct local-config entry; `启用本地 Profile 解锁` controls both the bounded account-menu projection and Codex++ local Profile view rather than official React internals; `立即同步` remains a manual command with its result status.

- [ ] **Step 5: Bind all changes through typed native actions**

  The module sends decimal price input as validated nanodollar integers; it never saves browser state. Native responses refresh the relevant config snapshot. Inputs remain stable while focused; unrelated HUD pushes cannot reconstruct modal contents.

- [ ] **Step 6: Run focused and full tests**

  Run: `cd apps/codex-plus-manager && npm test`

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Expected: PASS.

- [ ] **Step 7: Commit settings and pricing**

  ```bash
  git add assets/live_token_cost/settings.js assets/user_scripts/market-codex-ds-style-cost.js apps/codex-plus-manager/src/live-token-cost.test.ts crates/codex-plus-core/tests/token_cost.rs
  git commit -m "feat: add lazy token cost settings and pricing"
  ```

### Task 11: Implement Lazy Analytics, Calendar, And Local Profile

**Files:**
- Modify: `assets/live_token_cost/analytics.js`
- Modify: `assets/live_token_cost/profile.js`
- Modify: `assets/live_token_cost/flatpickr.js`
- Modify: `assets/live_token_cost/flatpickr.css`
- Modify: `assets/user_scripts/market-codex-ds-style-cost.js`
- Modify: `apps/codex-plus-manager/src/live-token-cost.test.ts`
- Modify: `crates/codex-plus-core/tests/token_cost.rs`

**Interfaces:** Analytics receives bounded `AnalyticsSnapshot` from `QueryAnalytics`. The original account-menu Profile row remains the full-view entry, while the settings modal retains its existing `个人资料` config entry. Clicking the marked account row is intercepted by the Renderer boundary and emits lifecycle detail `reason='profile_entry', profile=true`; the userscript then requests `Profile` once and mounts a Codex++-owned full-page local surface. It never navigates to or mutates the official Profile route, auth or feature state. Flatpickr is requested only on the first date trigger click.

- [ ] **Step 1: Write failing analytics tests**

  Cover today/7-day/30-day/custom ranges, model filter, empty runtime, bounded chart rows, no client-side full-history aggregation, one query per explicit range/filter change, cleanup on panel close, and manual CC Switch result without retry timer.

- [ ] **Step 2: Write failing calendar tests**

  Assert opening settings or analytics does not load Flatpickr; first calendar click requests it once; close calls `destroy`; reopen reuses registered source; CSS has no infinite animation; failed load shows a static error and permits at most one retry on the next explicit click.

- [ ] **Step 3: Write failing local Profile tests**

  Cover account-menu row projection from Task 9, click/keyboard opening through `profile_entry`, lifecycle mount/unmount, one local full-page root, the baseline Profile page labels/layout, configured `display_name`/`username`/email/plan/avatar, edit/save through `SaveProfile`, run-lifetime activity data, explicit close and route-exit cleanup, repeat injection cleanup, and unchanged references for React context, Statsig, auth objects, `Array.prototype.filter`, `RegExp.prototype.test`, `fetch`, XHR, WebSocket, and `electronBridge`.

- [ ] **Step 4: Run focused tests and verify RED**

  Run: `cd apps/codex-plus-manager && node --test --test-name-pattern="analytics|calendar|profile" src/live-token-cost.test.ts`

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Expected: inert modules fail behavior assertions.

- [ ] **Step 5: Implement bounded analytics rendering**

  Render at most 31 daily columns and 20 model rows per response. Generate chart nodes once per query response and never refresh them from HUD pushes. All range timestamps come from the explicit query action.

- [ ] **Step 6: Port Flatpickr and visual CSS into the lazy asset**

  Keep the license header and current Chinese locale. The factory owns the Flatpickr instance and style node; `destroy` removes the instance and panel-specific style. No Flatpickr bytes may appear in the startup userscript.

- [ ] **Step 7: Implement the local Profile view**

  Use a single module-owned full-page root mounted after the explicit `profile_entry` lifecycle event. Reproduce the captured Profile page structure, typography, spacing, avatar/editor and runtime activity panels inside that root; expose an explicit close action and destroy it on any later lifecycle event with `profile=false`. The only host DOM projection is the strictly matched account-menu row implemented in Task 9; do not open the official route, enable its feature gate, rewrite sidebar identity outside that menu-open event, or patch auth/React internals. If the owned mount anchor is absent, do nothing until another explicit user/lifecycle event.

- [ ] **Step 8: Run manager and native tests**

  Run: `cd apps/codex-plus-manager && npm test`

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Expected: PASS.

- [ ] **Step 9: Commit lazy views**

  ```bash
  git add assets/live_token_cost assets/user_scripts/market-codex-ds-style-cost.js apps/codex-plus-manager/src/live-token-cost.test.ts crates/codex-plus-core/tests/token_cost.rs
  git commit -m "feat: add lazy token cost analytics and profile views"
  ```

### Task 12: Lock Normal Built-In Script Upgrade Behavior

**Files:**
- Modify: `crates/codex-plus-core/src/user_scripts.rs`
- Modify: `crates/codex-plus-core/tests/bridge_routes.rs`

**Interfaces:** Keep the exact bundled filename and existing missing/newer-version semantics. Startup upgrades an older bundled `0.8.3` source to `1.0.0` while preserving disabled state; an unversioned user override remains untouched; explicit manager reinstall overwrites and enables as it does today.

- [ ] **Step 1: Update tests first**

  Add assertions for `@version      1.0.0`, bootstrap size, absence of legacy storage identifiers, disabled-state preservation during version upgrade, unversioned override preservation, and explicit reinstall behavior.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `cargo test -p codex-plus-core --test bridge_routes user_script_manager_ -- --nocapture`

  Expected: the old version assertions or built-in metadata fail until updated.

- [ ] **Step 3: Make the smallest installer adjustment required**

  Do not change user script directory, state JSON, startup missing-only behavior, or manager route. Only adjust built-in version comparison expectations/code if the new semantic version exposes a real parser gap.

- [ ] **Step 4: Run all user-script manager tests**

  Run: `cargo test -p codex-plus-core --test bridge_routes user_script -- --nocapture`

  Expected: PASS.

- [ ] **Step 5: Commit installer contract**

  ```bash
  git add crates/codex-plus-core/src/user_scripts.rs crates/codex-plus-core/tests/bridge_routes.rs
  git commit -m "test: lock ds style cost upgrade behavior"
  ```

### Task 13: Add Static And Synthetic Performance Gates

**Files:**
- Modify: `apps/codex-plus-manager/src/live-token-cost-performance.test.ts`
- Create: `scripts/measure-ds-style-cost-performance.mjs`
- Modify: `apps/codex-plus-manager/src/live-token-cost.test.ts`
- Modify: `crates/codex-plus-core/tests/token_cost.rs`
- Modify: `crates/codex-plus-core/tests/cdp_bridge.rs`

**Interfaces:** `window.__codexLiveTokenCostV1.diagnostics()` reports DOM writes, listener count, outstanding one-shot timers, observer count, bridge calls, snapshot count, update durations, mounted modules and owned node count, plus one native `QueryDiagnostics` result. It performs work only when explicitly called. `scripts/measure-ds-style-cost-performance.mjs` accepts required `--debug-port`、`--duration-seconds`、`--label`、`--output` and optional `--trace-output`, uses the exact port to locate one Codex browser process and recursively discovers its `--type=renderer` descendants, samples per-renderer/aggregate process and CDP metrics once per second, and writes one bounded JSON result. Raw CDP trace is produced only when the optional argument is present.

- [ ] **Step 1: Write the synthetic 30-minute-equivalent pressure test**

  Under fake time, apply 100,000 deltas, 2,000 tool events, 1,000 route events, 200 repeat injections, 100 settings/Profile/calendar open-close cycles, and 256 completed turns. Assert bounded queue/recent/dedupe sizes, at most 2 snapshot pushes per simulated second, zero idle timers after settling, stable owned node/listener counts, and no full-root reconstruction.

- [ ] **Step 2: Extend the separate static performance policy gate**

  Extend the defense-in-depth gate from Task 9 to scan the startup script and the marked `TOKEN_COST_BEGIN`/`TOKEN_COST_END` block in `renderer-inject.js`, not unrelated existing renderer features. Fail on all forbidden APIs from Global Constraints and on recursive helpers that enumerate arbitrary object keys/values. Keep behavior, DOM lifecycle, synthetic load and real-App CPU evidence in their executable tests; this source gate only enforces the explicit denylist.

- [ ] **Step 3: Add payload and update-duration assertions**

  Assert every serialized snapshot is at most 8KB, every Renderer event at most 4KB, startup at most 60KB, HUD fixture update p95 at most 4ms and max below 16ms in the Node harness. Treat Node timing as a regression gate, not proof of real App CPU behavior.

- [ ] **Step 4: Implement the explicit real-App measurement runner**

  Use only Node built-ins and the Node 22 global `fetch`/`WebSocket`. Resolve the primary page from the URL formed as ``http://127.0.0.1:${debugPort}/json/list``. Parse `ps -axo pid=,ppid=,command=` to find exactly one Codex browser command containing the formed string ``--remote-debugging-port=${debugPort}``, recursively find its renderer descendants, and reject zero browser or zero renderer matches. Sample every renderer with the argument vector `ps -p rendererPid -o %cpu=,rss=` and record both per-process and summed CPU/RSS, plus CDP `Performance.getMetrics` and `Runtime.getHeapUsage`, once per second. Install a measurement-only `PerformanceObserver` for `longtask` at start and disconnect it at end. Only when `--trace-output` is present, start CDP `Tracing` with `devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.cpu_profiler` and save all `Tracing.dataCollected` events there. Call page/native diagnostics once before and once after the sample window, capture counter deltas, and never poll the cost bridge.

  The output JSON contains label, timestamps, app/CDP identity, browser PID, renderer PID set, every raw per-process/aggregate sample, aggregate CPU median/average/max, RSS/heap start/end/max, Long Tasks, page diagnostic deltas and native diagnostic deltas. When the script is disabled, cost diagnostics are explicitly `null`; this is expected and distinct from a CDP/sample failure. Abort rather than silently dropping invalid samples.

- [ ] **Step 5: Run focused pressure gates**

  Run: `cd apps/codex-plus-manager && node --test src/live-token-cost-performance.test.ts`

  Run: `cargo test -p codex-plus-core --test token_cost -- --nocapture`

  Run: `cargo test -p codex-plus-core --test cdp_bridge token_cost_push -- --nocapture`

  Expected: PASS.

- [ ] **Step 6: Run repository-level focused suites**

  Run: `cargo test -p codex-plus-core --test token_cost --test cdp_bridge --test bridge_routes --test protocol_proxy --test launcher -- --nocapture`

  Run: `cargo test -p codex-plus-launcher -- --nocapture`

  Run: `cd apps/codex-plus-manager && npm test && npm run check`

  Expected: PASS.

- [ ] **Step 7: Commit performance gates**

  ```bash
  git add apps/codex-plus-manager/src/live-token-cost-performance.test.ts apps/codex-plus-manager/src/live-token-cost.test.ts scripts/measure-ds-style-cost-performance.mjs crates/codex-plus-core/tests/token_cost.rs crates/codex-plus-core/tests/cdp_bridge.rs
  git commit -m "test: enforce token cost performance budgets"
  ```

### Task 14: Prove Visual Parity And Real Codex App Performance

**Files:**
- Create: `docs/superpowers/evidence/ds-style-cost-acceptance/manifest.md`
- Create: `docs/superpowers/evidence/ds-style-cost-acceptance/*.png`
- Create: `docs/superpowers/evidence/ds-style-cost-acceptance/performance.md`
- Create: `docs/superpowers/evidence/ds-style-cost-acceptance/trace-summary.json`

**Interfaces:** This task is a release gate for the local implementation only. It does not publish, install over `/Applications`, push, tag, or create a PR.

- [ ] **Step 1: Build a separate local test artifact**

  Run: `cargo build -p codex-plus-launcher --release`

  Run: `test ! -e target/ds-style-cost-test-20260815 && mkdir -p target/ds-style-cost-test-20260815/config/Codex++ && cp target/release/codex-plus-plus target/ds-style-cost-test-20260815/codex-plus-plus`

  Run: `shasum -a 256 target/ds-style-cost-test-20260815/codex-plus-plus`

  Record the exact binary path and SHA-256 in `manifest.md`. Launch this copied binary with `XDG_CONFIG_HOME=target/ds-style-cost-test-20260815/config` so user scripts and `token-cost-ui.json` stay isolated from the user's real config. Do not run `scripts/installer/macos/package-dmg.sh` because it clears `dist/macos`, and do not copy anything into `/Applications`.

- [ ] **Step 2: Capture new screenshots with the exact baseline fixture**

  Use the same viewport, scale, theme, time, font and values from Task 1. Capture the same eight states into `ds-style-cost-acceptance`.

- [ ] **Step 3: Compare static visuals**

  Mask only the listed dynamic numeric rectangles, then pixel-compare old/new images. Record mismatch percentage plus exact HUD/modal/profile bounding boxes. Any layout, text, color, spacing, border, icon, hover/focus or entry-point difference is a failure; removed continuous animation frames are the only accepted difference.

- [ ] **Step 4: Run disabled/enabled real App A/B**

  First inspect existing Codex/Codex++ processes read-only. If the user's active Codex must be closed or restarted to make the A/B valid, stop and obtain explicit permission; the plan does not authorize process termination. Verify TCP port 9339 is free, then launch `XDG_CONFIG_HOME=target/ds-style-cost-test-20260815/config target/ds-style-cost-test-20260815/codex-plus-plus --debug-port 9339` in a persistent TTY.

  Before the disabled launch, use `apply_patch` to create `target/ds-style-cost-test-20260815/config/Codex++/user_scripts.json` with exactly `{"enabled":true,"scripts":{"user:market-codex-ds-style-cost.js":false}}`; startup installs the checked-in bundled files while preserving this disabled state. Verify effective state through `/user-scripts/list`. Before the enabled launch, use `apply_patch` to change only that boolean to `true` and verify again. The isolated config contains no user-owned scripts, and the user's real config remains untouched. Run all disabled measurements in one fresh app launch, then all enabled measurements in a second fresh launch; each launch gets its own five-minute warm-up. Restart only after the explicit process-control permission above.

  Run: `mkdir -p target/ds-style-cost-perf-20260815`

  Use the same Codex App version, machine, conversation fixture and five-minute warm-up. For each arm record:

  1. 10 minutes idle on the same thread.
  2. 10 minutes streaming output with the same fixture workload.
  3. A tool-call sequence.
  4. Settings, pricing, analytics, calendar and Profile open/close flows.
  5. A 30-minute mixed soak.

  Collect `Codex (Renderer)` CPU samples once per second, CDP Performance trace, Long Tasks, JS heap, DOM node/listener/timer counters, bridge request count, native push count and queue high-water marks.

  Use these exact measurement commands while performing the named workload:

  ```bash
  node scripts/measure-ds-style-cost-performance.mjs --debug-port 9339 --duration-seconds 600 --label disabled-idle --output target/ds-style-cost-perf-20260815/disabled-idle.json
  node scripts/measure-ds-style-cost-performance.mjs --debug-port 9339 --duration-seconds 600 --label disabled-active --output target/ds-style-cost-perf-20260815/disabled-active.json
  node scripts/measure-ds-style-cost-performance.mjs --debug-port 9339 --duration-seconds 1800 --label disabled-soak --output target/ds-style-cost-perf-20260815/disabled-soak.json
  node scripts/measure-ds-style-cost-performance.mjs --debug-port 9339 --duration-seconds 120 --label disabled-active-trace --output target/ds-style-cost-perf-20260815/disabled-active-trace-metrics.json --trace-output target/ds-style-cost-perf-20260815/disabled-active-trace.json
  node scripts/measure-ds-style-cost-performance.mjs --debug-port 9339 --duration-seconds 600 --label enabled-idle --output target/ds-style-cost-perf-20260815/enabled-idle.json
  node scripts/measure-ds-style-cost-performance.mjs --debug-port 9339 --duration-seconds 600 --label enabled-active --output target/ds-style-cost-perf-20260815/enabled-active.json
  node scripts/measure-ds-style-cost-performance.mjs --debug-port 9339 --duration-seconds 1800 --label enabled-soak --output target/ds-style-cost-perf-20260815/enabled-soak.json
  node scripts/measure-ds-style-cost-performance.mjs --debug-port 9339 --duration-seconds 120 --label enabled-active-trace --output target/ds-style-cost-perf-20260815/enabled-active-trace-metrics.json --trace-output target/ds-style-cost-perf-20260815/enabled-active-trace.json
  ```

  Each idle command runs after the five-minute warm-up with no user interaction. Each active command uses the same saved prompt/output fixture and tool sequence. Each soak repeats the same ten-minute mixed workload three times. Run each 120-second trace command in its matching disabled/enabled launch with the same active fixture. CPU/heap budget calculations use only the six non-trace files; trace runs are attribution evidence because tracing itself adds overhead. Raw traces stay under `target/`; only aggregate evidence and trace attribution enter `docs/superpowers/evidence`.

- [ ] **Step 5: Enforce the hard budgets**

  Acceptance requires all of:

  - idle Renderer CPU median delta `<= 1` percentage point;
  - idle periodic cost pushes/bridge requests/Renderer timer wakeups `= 0`;
  - active Renderer CPU average delta `<= 3` percentage points;
  - no continuous 5-second interval above disabled baseline `+10` points;
  - pushes `<= 2/s`, snapshot `<= 8KB`;
  - HUD update p95 `<= 4ms`, max `<16ms`;
  - no cost-attributed Long Task `>=50ms`;
  - Renderer heap overhead `<5MB` and no 30-minute growth trend;
  - settings/Profile cold mount `<200ms`, warm mount `<100ms`;
  - no sustained growth in native queue, recent turns, dedupe, DOM nodes, listeners or timers.

- [ ] **Step 6: Investigate any failed budget before claiming completion**

  Attribute the trace to exact functions. Fix the implementation and repeat the full affected A/B arm; do not average a failed run away and do not use source inspection or Node timing as a substitute.

- [ ] **Step 7: Run the final clean verification matrix**

  Run: `cargo test -p codex-plus-core --test token_cost --test cdp_bridge --test bridge_routes --test protocol_proxy --test launcher -- --nocapture`

  Run: `cargo test -p codex-plus-launcher -- --nocapture`

  Run: `cd apps/codex-plus-manager && npm test && npm run check`

  Run: `git diff --check`

  Expected: all commands PASS after the final A/B run.

- [ ] **Step 8: Commit acceptance evidence**

  ```bash
  git add -f docs/superpowers/evidence/ds-style-cost-acceptance
  git commit -m "test: document ds style cost performance acceptance"
  ```

---

## Completion Gate

Implementation is complete only when Tasks 1-14 are checked, all focused and regression suites pass, static visual comparison passes, and the real Codex App enabled/disabled A/B meets every hard budget. A passing Rust/Node suite without the real App A/B is an incomplete implementation. The final handoff must report the exact local test artifact, commits, test outputs, A/B sample durations, CPU deltas, push counts, Long Tasks, heap delta and any residual limitation; it must also state explicitly that no app was installed or published.
