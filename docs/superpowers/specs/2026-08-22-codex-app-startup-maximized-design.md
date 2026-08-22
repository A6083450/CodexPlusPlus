# 官方 Codex App 启动后铺满当前屏幕设计

## 目标

通过 Codex++ 启动官方 Codex App 时，可选择让窗口在每次启动后铺满当前显示器的可用桌面区域。窗口保留 macOS 菜单栏和 Dock，不进入 macOS 独立全屏空间。

本功能不依赖 Chromium/Electron 的 `--start-maximized` 参数。该参数会被 Codex App 自身的窗口恢复逻辑覆盖，不能可靠满足重开后的窗口状态要求。

## 范围

- 只接管通过 Codex++ 启动链打开的官方 Codex App。
- 只在 macOS 生效；Windows 和 Linux 保持现有行为。
- 新增 opt-in 设置，默认关闭，不改变现有用户的启动行为。
- 每次启动只执行一次最大化，之后允许用户手动移动或缩放窗口。
- 不接管用户直接从 Dock 或 Finder 启动、且未经过 Codex++ 启动链的实例。
- 不改变 Codex++ Manager 自身的窗口行为。

## 用户设置

在 `BackendSettings` 中新增布尔字段 `codex_app_start_maximized`，序列化为 `codexAppStartMaximized`，默认值为 `false`。

Codex++ Manager 的设置页新增“启动时铺满当前屏幕”开关。开关说明明确指出：

- 保留菜单栏和 Dock；
- 不进入系统全屏；
- 仅对通过 Codex++ 启动的官方 Codex App 生效。

不再把 `--start-maximized` 写入或解释为该功能的入口。

## 启动流程

1. Codex++ 按现有流程启动官方 Codex App，并保留现有 CDP 调试端口参数。
2. 当设置关闭或平台不是 macOS 时，窗口步骤直接返回，不做任何额外操作。
3. 当设置开启时，启动流程以有限重试等待官方 Codex App 的主页面 CDP target 可用。
4. 通过浏览器级 CDP WebSocket 调用 `Browser.getWindowForTarget`，用主页面 `targetId` 获取所属 `windowId`。
5. 调用 `Browser.setWindowBounds`，传入该 `windowId` 和 `bounds.windowState = "maximized"`。
6. 最大化步骤完成后继续现有注入、watchdog 和状态写入流程，不持续监听或重复覆盖用户后续的窗口操作。

窗口状态步骤位于进程创建之后、页面 target 可识别之后，因此它发生在 Electron 已开始恢复窗口状态之后，而不是仅依赖进程启动参数。

## 代码边界

- `crates/codex-plus-core/src/settings.rs`
  - 定义、默认化、反序列化和持久化新设置字段。
- `apps/codex-plus-manager/src/App.tsx`
  - 映射设置字段并提供开关。
- `apps/codex-plus-manager/src/i18n-en.ts`
  - 补充开关及说明的英文文本。
- `crates/codex-plus-core/src/cdp.rs`
  - 发现 browser WebSocket 和官方 Codex 主页面 target，向调用方提供经过现有回环地址校验的标识。
- `crates/codex-plus-core/src/bridge.rs`
  - 复用现有 CDP WebSocket 会话，封装 `Browser.getWindowForTarget` 与 `Browser.setWindowBounds`，不把 CDP JSON 拼装散落到启动流程。
- `crates/codex-plus-core/src/launcher.rs`
  - 根据平台和设置决定是否执行一次启动后最大化。

实现需保留这些文件中当前未提交的其他工作，不重排或重写无关代码。

## 错误处理

窗口最大化是增强行为，不应阻断 Codex App 启动。

- CDP 端点或主页面 target 在限定时间内不可用：记录诊断日志并继续启动。
- `Browser.getWindowForTarget` 或 `Browser.setWindowBounds` 返回错误：记录方法、调试端口和错误信息，不记录敏感配置。
- 设置关闭、非 macOS 或窗口已最大化：按成功的无操作处理。

不使用 AppleScript、辅助功能权限或系统级常驻进程作为回退，避免引入额外权限和不可控的窗口切换。

## 测试

### 自动化测试

- 设置默认值为 `false`。
- JSON 中的 `codexAppStartMaximized: true` 能正确反序列化并持久化，同时保留未知字段。
- 平台或设置不满足时不执行窗口命令。
- 使用本地假 CDP WebSocket 验证命令顺序：
  - `Browser.getWindowForTarget` 携带主页面 `targetId`；
  - 从返回值读取 `windowId`；
  - `Browser.setWindowBounds` 携带同一 `windowId` 和 `windowState: "maximized"`。
- CDP 失败时启动流程继续，并产生非致命诊断结果。
- 前端类型、默认设置和开关值映射保持一致。

### 运行时验收

在 macOS 上开启设置后完成两轮独立验收：

1. 退出官方 Codex App。
2. 通过 Codex++ 重新启动。
3. 确认窗口宽高等于当前显示器的可用区域。
4. 确认窗口 `AXFullScreen = false`。
5. 再次退出并重开，重复相同检查。
6. 启动后手动缩小窗口，确认 Codex++ 不会再次强制放大。

验收时同时确认进程参数不需要 `--start-maximized`。
