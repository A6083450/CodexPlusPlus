# DS Style Cost 性能优先重写设计

## 背景

`assets/user_scripts/market-codex-ds-style-cost.js` 当前约 49.7 万字节、10337 行。它同时承担流量捕获、事件解析、会话状态、费用计算、历史存储、Profile 解锁、分析聚合和界面渲染，并在 Codex Renderer 中运行。

当前实现包含多个全页面 `MutationObserver`，会改写 `Array.prototype.filter`、`RegExp.prototype.test`、`fetch`、XHR、WebSocket、React context 和 `electronBridge`，还会克隆响应、递归检查消息、运行周期定时器并触发强制重排。这些路径会进入 Codex 自身的高频渲染和消息循环，已经实测可让 `Codex (Renderer)` 持续占用 100% CPU。现有观察器限频补丁只能降低部分触发频率，不能消除全局热路径。

本次重写以性能为第一优先级。保留当前可见界面，但允许删除旧数据、跨重启历史、持续动画和官方 React 内部破解。实现目标不是修补旧脚本，而是把它替换为原生状态服务和极薄 Renderer 视图。

## 目标

- 保持 HUD、设置、价格、分析、日期选择和 Profile 页面的静态视觉与交互入口一致。
- Codex++ 空闲时，成本界面在 Renderer 中不运行轮询、周期定时器、全页面观察器或持续动画。
- 把事件归一化、Token 与费用计算、任务状态机和运行期聚合移出 Renderer。
- 运行中的界面更新最多每 500ms 一次，只在状态发生变化时推送。
- 删除所有全局原型、网络 API、React context 和 Electron bridge 改写。
- 不读取或迁移旧 localStorage、IndexedDB 和旧 ledger。
- 不保留跨 Codex++ 重启的 Token、费用或历史统计。
- 用真实 Codex App 的关闭/开启 A/B 数据证明 CPU 问题得到解决。

## 非目标

- 不保留旧脚本回退路径。
- 不兼容旧版价格覆盖、显示开关、Profile 资料或历史统计。
- 不实现 SQLite 历史数据库、跨设备同步或云端同步。
- 不要求保留数字滚动、周期闪光等持续动画。
- 不继续解锁或伪造官方 React Profile feature gate、auth context 或查询缓存。
- 不保证在原生采集和白名单补充事件都不可用时推测出缺失数据。
- 本设计不包含推送、发布、替换 `/Applications` 中的应用或创建上游 PR。

## 方案比较

### 方案一：原生运行态服务与极薄视图（采用）

Rust 负责采集后的归一化、状态机、费用计算和运行期聚合；现有 bridge 增加受控的原生到页面推送；userscript 只负责静态 DOM、样式和用户操作。该方案能让 Renderer 空闲时接近未加载脚本，也是唯一满足性能第一目标的方案。

### 方案二：原生采集并复用旧 UI 主体

下沉数据采集，但保留大部分旧脚本。视觉改动风险较低，但旧脚本的模块耦合、启动解析成本和渲染路径仍然存在，后续容易重新引入热循环。

### 方案三：纯 userscript 重写

不改 Rust，只在 Renderer 内改为事件驱动。改动范围较小，但流量接触、计算、聚合和状态仍占用 Renderer，性能上限低于方案一。

## 总体架构

系统由四个边界清晰的单元组成。

### TokenCostService

Rust 原生运行态服务，负责：

- 接收规范化的任务、模型、usage、工具调用和完成事件。
- 按 session 和 turn 维护运行期状态机。
- 计算 Token、费用、缓存命中率、首 Token、输出速度以及 LLM/工具耗时。
- 维护有限数量的最近轮次和 O(1) 日/模型聚合。
- 处理价格、显示开关和本地 Profile 配置。
- 在状态实际变化时递增 revision，并通知 bridge 推送器。

服务不使用 SQLite，不逐 delta 写磁盘，不读取 Renderer 历史。Codex++ 退出后运行期状态全部丢弃。

### UsageInput

数据输入分为两个受控来源：

1. **协议代理输入**：在 `protocol_proxy.rs` 已经解析 Responses 或 Chat 流事件的位置直接提取 usage、模型和生命周期信息，不重复解析完整响应。
2. **Renderer 白名单输入**：对于未经过协议代理的 Codex 原生流量，在 `renderer-inject.js` 已有消息边界上只识别明确的事件类型，并提取少量标量字段后调用原生 bridge。

Renderer 白名单输入不得克隆响应体、递归遍历任意对象或监听所有 `window.message`。它不得通过改写 `fetch`、XHR、WebSocket 或 `electronBridge` 获得数据。

协议代理产生的最终 usage 优先于 Renderer 补充事件。服务使用 session、turn、事件序号和稳定指纹去重，重复终止事件不得重复累计。

### TokenCostBridge

复用现有 CDP `Runtime.addBinding` bridge，增加成本功能的窄接口：

- `bootstrap`：注册页面实例并返回默认配置和初始空快照。
- `event`：接收 Renderer 白名单输入。
- `action`：处理价格、显示开关、Profile 配置和手动 CC Switch 同步。
- `lazy-asset`：只在用户打开相应界面时提供设置、Profile、分析或日期组件资源。

bridge 消息泵增加有界的原生到页面推送队列。`TokenCostService` 只在 revision 变化时发布快照，推送器把同一 500ms 窗口内的多次变化合并成最后一次，通过 CDP 调用页面预先注册的固定入口。所有推送路径统一受每 500ms 最多发送一次的限制；任务结束、页面切换和显式用户操作只提高待发送快照的优先级，不绕过限速。只有存在待发送快照时才允许使用一次性延迟任务，空闲时没有推送、轮询或定时检查。

推送只包含当前页面需要的标量数据，目标大小不超过 8KB。页面重新加载后旧注册失效，新实例重新 bootstrap；原生侧不得向已销毁页面继续推送。

### userscript 视图

`market-codex-ds-style-cost.js` 改为约 30 至 60KB 的 bootstrap：

- 注册快照入口。
- 注入 HUD 必需的最小 CSS 和固定 DOM 骨架。
- 使用字段级文本更新，不重建完整根节点。
- 在根节点上使用事件委托处理操作。
- 根据 `renderer-inject.js` 发出的页面生命周期事件挂载或卸载。
- 首次打开设置、Profile、分析或日期选择时才请求并解析对应资源。

userscript 不保存历史数组、不计算分析报表、不打开 IndexedDB，也不安装全页面 MutationObserver。页面没有合适挂载点时保持未挂载，等待下一次明确的页面生命周期事件，不轮询 DOM。

## 运行态数据模型

原生服务只维护当前 Codex++ 进程生命周期中的数据：

- `RuntimeSession`：session 标识、当前模型、推理强度、Fast 状态和活动 turn。
- `RuntimeTurn`：开始/结束时间、状态、usage、费用以及性能指标。
- `RecentTurns`：有上限的最近完成轮次，用于当前运行期分析。
- `RuntimeRollups`：按日期和模型维护的 O(1) 聚合，避免打开分析页时全量扫描。
- `UiConfig`：价格表、可见性开关、Profile 文本和头像引用。

最近轮次达到上限后，旧轮次只保留在聚合值中。中间输出 delta 不进入历史列表，只更新活动 turn 的计数器。队列过载时可以合并或丢弃中间 delta，但任务开始、任务结束和最终 usage 必须保留。

`UiConfig` 是唯一需要跨重启保存的数据，只有用户主动修改时才通过原子写写入 `~/.config/Codex++/` 下的独立小型配置文件。配置不得包含凭据、请求正文或完整响应。

## 旧数据策略

- 新实现永远不读取旧 localStorage、IndexedDB、Profile ledger 或分析 rollup。
- 不提供迁移接口、兼容解析器、迁移标记或旧数据去重逻辑。
- 首次运行直接使用默认价格、默认显示状态和默认 Profile 配置。
- 旧浏览器数据不自动删除。它们保持惰性，不影响 CPU；自动删除没有性能收益且会增加破坏性操作。
- 新版 userscript 通过正常的内置脚本版本升级替换旧文件，不提供旧脚本恢复入口。

## 事件与快照流程

1. Codex 页面加载，轻量 userscript 注册固定快照入口并调用 `bootstrap`。
2. 协议代理或 Renderer 白名单输入产生规范化事件。
3. `TokenCostService` 在 Rust 中合并事件、更新活动 turn 和运行期 rollup。
4. 如果可见快照发生变化，服务递增 revision，并把最新状态放入有界推送队列。
5. 距上次推送已满 500ms 时立即发送；否则只创建一个一次性延迟任务，并在可发送时输出最新快照。
6. userscript 对比 revision，并只更新发生变化的文本、属性或可见状态。
7. 任务结束事件立即完成原生状态，并把最终快照标为最高优先级；页面切换和显式用户操作采用相同规则，只替换待发送快照，不绕过 500ms 限速。
8. 空闲且状态未变化时，Rust 和 Renderer 都不产生成本界面的周期工作。

## 界面复刻

实现前必须在替换旧脚本前保存基准截图和必要的 DOM/CSS 快照。以下内容保持一致：

- HUD 位置、尺寸、间距、颜色、字体、边框、圆角、图标和文字。
- 空闲、运行、空数据和错误等静态可见状态。
- 设置按钮、设置弹窗、价格编辑、分析、日期选择和 Profile 页面的结构。
- 鼠标悬停、键盘焦点、弹窗开关和表单操作等用户触发反馈。

以下差异属于明确接受的性能优化：

- 数值直接替换，不创建逐位数字滚动 DOM。
- 删除周期闪光、无限 CSS 动画和通过 `offsetWidth` 触发的强制重排。
- 设置、Profile、分析和日期组件关闭时不保留 DOM、事件或后台刷新。

Profile 保留原有入口和可见页面，但使用 Codex++ 自有本地视图，不再开启官方 feature gate，不改写 auth context、Statsig、查询缓存或 React Fiber。关闭或离开页面时完整销毁本地视图。

日期选择保留当前视觉。Flatpickr 源码与完整样式不进入启动 bootstrap，由原生 lazy asset 接口在首次打开日期选择器时提供，并在关闭界面后释放实例。

## 性能不变量

实现和测试必须持续满足以下限制：

- 不改写 `Array.prototype`、`Promise.prototype` 或 `RegExp.prototype`。
- 不改写 `window.fetch`、XHR、WebSocket、`electronBridge` 或 React context。
- 不在 `document.body` 或 `document.documentElement` 上保留全子树观察器。
- 不使用 `setInterval` 维持 HUD、分析、Profile、同步或挂载状态。
- 不在 Renderer 中克隆、全文读取或递归扫描网络响应。
- 不在 Renderer 中保存完整轮次历史或执行跨轮次聚合。
- 不通过布局读取重新启动 CSS 动画。
- 不因采集失败启用更宽泛、更高成本的兜底路径。

## 容量与背压

- 原生事件输入使用有界队列，容量在实现计划中固定并由压力测试验证。
- 同一 turn 的高频 delta 可以覆盖旧值，只保留最新累计状态。
- 最终 usage、完成和失败事件进入保留优先级，不得被普通 delta 挤出。
- Renderer 事件使用明确枚举和字段白名单，超出大小限制的事件在进入服务前拒绝。
- 运行期最近轮次设置固定上限；超限内容折叠进 rollup 后释放。
- 诊断日志按错误类别限频，不记录消息正文、请求体、凭据或完整响应。

## 错误与降级

- **原生服务不可用**：HUD 保持布局并显示占位值。bootstrap 只进行有限次数重试，之后休眠到页面生命周期事件或用户操作。
- **协议代理未覆盖**：使用 Renderer 白名单输入。白名单输入也不可用时允许数据缺失，不启用全局拦截。
- **事件过载**：合并中间 delta，优先保留生命周期和最终 usage。
- **事件无效或超限**：立即忽略并限频记录诊断，不把错误对象回传 Renderer。
- **CC Switch 不可用**：只让当前手动同步失败，不启动后台重试或轮询。
- **懒加载资源失败**：对应界面显示静态错误，关闭时清理；不循环重新加载。
- **视图模块异常**：只销毁该模块，HUD 主体继续工作；下次显式操作最多重试一次。
- **配置写入失败**：保留本次运行的内存值并提示，不高频重写。
- **页面重载或重复注入**：先清理旧根节点、入口和监听器，再安装新实例；所有安装与销毁操作幂等。

任何错误都不得导致旧脚本的全局 hook、全页面 observer 或轮询路径重新出现。

## 性能预算

所有 CPU 指标使用相同 Codex 版本、相同机器、相同页面和相同操作流程，在成本脚本关闭与开启之间做 A/B 对照。

- 启动 bootstrap 原始体积不超过 60KB；懒加载资源不计入启动解析。
- 空闲预热后，Renderer CPU 中位增量不超过 1 个百分点。
- 空闲时成本功能的周期推送、bridge 请求和 Renderer 定时唤醒次数为 0。
- 活跃对话期间，Renderer CPU 平均增量不超过 3 个百分点。
- 活跃对话期间不得连续 5 秒高于关闭脚本基线 10 个百分点。
- 包括最终状态和显式操作在内，成本快照推送最多每秒 2 次，单次目标不超过 8KB。
- HUD 单次更新 `p95 <= 4ms`，最大值小于 16ms。
- 不允许出现成本脚本引起的 50ms 以上 Long Task。
- Renderer 额外堆内存目标小于 5MB。
- 30 分钟运行后，Renderer 堆、原生队列、DOM 节点、监听器和计时器不得持续增长。
- 设置或 Profile 首次懒加载挂载小于 200ms，再次打开小于 100ms。

如果机器噪声使进程 CPU 指标不稳定，必须同时使用 CDP Performance trace 中的脚本归因、Long Task、渲染耗时和推送计数判断，不得只选取有利样本。

## 测试设计

### Rust 单元测试

- 不同来源事件归一化为相同的内部模型。
- 协议代理最终 usage 覆盖 Renderer 中间估算。
- 重复事件、乱序终止事件和重复最终 usage 不重复累计。
- 费用、Fast 倍率、缓存 Token 和性能指标计算保持正确。
- 活动 turn、最近轮次、rollup 和 revision 状态转换正确。
- 队列合并、容量上限和终止事件优先级在压力下成立。
- 配置只在用户操作时写入，并通过原子写保持完整。

### Bridge 契约测试

- `bootstrap`、`event`、`action` 和 `lazy-asset` 只接受预期字段。
- 超限、未知和无效事件在进入状态服务前被拒绝。
- 多个 revision 在 500ms 内只推送最后一个快照。
- 空闲状态不产生推送。
- 页面销毁后不再接收推送，重新 bootstrap 不重复注册。
- 其他现有 bridge route 不因成本推送队列而阻塞或改变结果。

### userscript 测试

- 启动只创建 HUD 所需节点和一个根级事件委托。
- 重复注入不会产生重复根节点、监听器或快照入口。
- 相同 revision 不写 DOM，变化快照只更新对应字段。
- 设置、Profile、分析和日历关闭后释放 DOM、实例和监听器。
- 页面生命周期事件能挂载和卸载，且没有全页面 observer 或 interval。
- 测试前后全局原型、网络 API、React context 和 Electron bridge 引用保持相同。
- 禁止 API 通过静态契约扫描与运行时断言双重检查。

### 视觉回归

- 保存旧版 HUD 空闲态、运行态、设置、价格、分析、日期和 Profile 基准图。
- 使用固定视口、主题、字体、数据和时间生成新版截图。
- 屏蔽动态数值后做像素对照，并对布局尺寸与关键 DOM 属性做结构断言。
- 允许差异仅限已明确删除的持续动画；静态帧、交互入口和文字必须一致。

### 压力与本机验收

- 合成高频 delta、工具调用、乱序完成、页面切换和重复注入。
- 运行 30 分钟 soak，记录队列深度、推送次数、DOM 节点、监听器、计时器和堆内存。
- 在真实 Codex App 中分别关闭和开启脚本，验证空闲、流式输出、工具调用、设置、Profile 和日期选择流程。
- 同时记录 `Codex (Renderer)` 进程 CPU、CDP Performance trace、Long Task、JS 堆和快照推送次数。
- 真实 App A/B 未通过性能预算时，不得以单元测试、源码检查或静态截图宣称问题解决。

## 验收标准

- 当前可见界面的静态视觉、文字、布局和交互入口与旧版一致。
- 旧数据不迁移，运行期统计在 Codex++ 重启后清零。
- 空闲时成本功能在 Renderer 中没有周期工作。
- 活跃时推送、渲染、CPU、Long Task 和内存均满足性能预算。
- 全局原型、网络 API、React context 和 Electron bridge 不被成本功能改写。
- Profile 使用自有本地视图，不依赖官方 React 内部破解。
- 采集失败时允许缺失数据，不启用高成本兜底。
- 真实 Codex App A/B 证明 `Codex (Renderer)` 不再因该功能持续高 CPU。

## 实施边界

- 只重写成本功能相关 Rust 服务、bridge route、协议代理事件接入、`renderer-inject.js` 白名单转发和 userscript 视图。
- 不做无关的 renderer-inject 重构或用户脚本管理器重构。
- 不修改 `Cargo.toml`、`package.json` 或依赖版本，除非实现阶段证明现有依赖无法满足需求并另行确认。
- 保留当前内置脚本缺失安装和版本升级机制，不改变用户脚本目录与启用状态模型。
- 实现和测试使用单独的本地测试构建；不发布、不替换已安装应用，除非用户另行授权。
