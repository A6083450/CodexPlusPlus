# Imagegen 功能包

本仓库的 `extensions/imagegen/` 是生图增强的唯一维护目录，源码和专属测试直接在这里修改，与宿主一起提交到同一个 Git 仓库。
这里只隔离模块边界，不使用独立仓库、子模块或外部源码同步。
初始行为基线为用户验证可用的 CodexPlusPlus 1.3.0+46。保留原项目 LICENSE 以及 skill 自带许可。

## 内容与边界

功能包版本见 `VERSION`，当前为 `1.1.0`。本次生图增强的实现和专属回归测试均在本包维护：

- `ui/renderer-runtime.js`：生图工具冲突修正、保存/恢复、原生消息缓存更新。
- `ui/generated-images-inject.js`：消息匹配、图片预览、自动持久化触发。
- `ui/model-routes.ts`：管理器对图片模型、供应商协议和生图代理开关的判断。
- `rust/generated_images.rs`：图片落盘、原生消息修复、历史索引重建。
- `rust/image_delivery.rs`：Responses JSON/SSE 图片交付、真实文件引用、历史消息 ID 兼容。
- `rust/models.rs`、`rust/profile.rs`：图片数据结构和供应商生图能力判断。
- `rust/assets.rs`、`rust/runtime.rs`：renderer 装配和退出时的原生生图恢复。
- `rust/imagegen_skill.rs`、`skill/`：本地 imagegen 增强版本、覆盖安装和覆盖状态检查。
- `rust/relay_compatibility.rs`、`rust/config_read.rs`：图片模型配置兼容与有效开关读取。
- `rust/protocol_tools.rs`：图片模型使用托管生图，清理顶层及 Code Mode `additional_tools` 中冲突的同名函数。
- `tests/`：图片数据和 skill 安装回归测试，由宿主 cargo test 执行。

宿主仅保留协议转发调用、桥接路由、配置字段、设置界面和 `include!` / TypeScript import 门面。
会话最后使用模型的通用恢复、原生 Fast 解锁及共享 AppScope/RPC 查找仍由宿主管理；图片浮层对模型恢复的保护和图片请求接管条件属于本包。
原有 `codex_plus_core::image_delivery`、`models::GeneratedImage` 等调用路径保持兼容。

| 宿主接入位置 | 本包维护源 |
| --- | --- |
| core `image_delivery.rs` 及对应测试 | `rust/image_delivery.rs`、`tests/image_delivery.rs` |
| core `models.rs`、`settings.rs` | `rust/models.rs`、`rust/profile.rs` |
| core `assets.rs` | `rust/assets.rs`、`tests/assets.rs` |
| core `launcher.rs` 的图片交付调用与测试 | `rust/image_delivery.rs`、`tests/launcher.rs` |
| core `cdp_bridge.rs` 的生图专属测试 | `tests/renderer_contract.rs` |
| manager `model-routes.ts` 及图片测试入口 | `ui/model-routes.ts`、`tests/*.test.ts` |

图片模型会话优先使用 Responses 托管生图。关闭供应商配置管理时，仅在会话配置中临时接入代理，上游地址、有效 API 凭据与自定义头来自当前 Codex 配置，不改写全局配置或登录文件；切回文字模型时恢复会话配置。官方原生登录、命令认证和带额外查询参数的配置保留原生路径。

图片是否已交付以本地文件内容和原生图片加载结果为准。缺失文件从生成结果恢复，损坏文件保留并另存恢复副本；保存成功后仍保留兜底预览，直到原生图片确实加载成功。
流式图片预览跟随最终回复移动；回复中编造的失效本地图片路径会就地替换为真实生成文件，已有参考图和远程图片链接保留，已补入的同一图片不会重复显示。

原生 `image_gen.imagegen` 始终保留。后端确认可用时才临时覆盖会话中的原生生图开关；退出前恢复空闲会话，忙碌会话在下次发送前恢复。意外断连也会触发恢复，不再往全局配置写入 `image_generation=false`。

图片编辑器等页面未暴露原生 manager 时，发送前通过当前 AppScope 的本地 RPC 卸载并恢复空闲会话，沿用原生设置和流归属管理；忙碌或恢复失败时不放行发送。

原始 `image_generation_call` 未进入原生图库时，兜底缩略图复用原生 `ImagePreviewOverlay` 浮层和消息的 React 上下文，默认覆盖聊天区域；“在侧面板中打开”由用户显式选择。原生标注、评论和编辑提交保持在当前会话，切换会话时关闭浮层；浮层打开期间暂停图片持久化，避免原缩略图被浮层中的图片替换。

这是同仓库内的功能模块。Rust 通过宿主薄门面编译，复用宿主的数据类型、数据库定位和原子文件写入；renderer 通过一个固定插槽装配，复用宿主桥接和原生会话管理器。宿主的通用 HTTP/模型选择/协议代理仍由宿主管理，不复制整套应用。

## 维护与合并上游

直接修改 `extensions/imagegen/` 中的代码，审查差异后更新完整性清单，再运行检查和测试。以下命令均从 CodexPlusPlus 根目录运行：

```sh
python3 extensions/imagegen/check.py --update-manifest --target .
python3 extensions/imagegen/check.py --check --target .
NO_PROXY=127.0.0.1,localhost cargo test -p codex-plus-core --test cdp_bridge --test imagegen_skill --test relay_config
cargo test -p codex-plus-core --test imagegen_extension --test image_delivery
cargo test -p codex-plus-data --test generated_images
```

`--update-manifest` 只更新本目录的 `MANIFEST.json`，不复制、替换或删除任何源码，也不访问其他仓库。
`--check` 检查文件清单、SHA-256、宿主门面和接入点；新增、删除或修改包内文件均需审查后显式更新清单。缺失或被改写的宿主接入点不能通过刷新清单来放行。

合并上游前后执行 `--check`，合并后先检查功能包差异，不要直接刷新清单掩盖上游改动。`integration/hooks.tsv` 列出必须保留的宿主接入点：renderer 插槽/请求钩子、Rust 门面、路由、配置兼容、本地 skill 安装入口、构建/打包检查。缺失时检查明确失败，应恢复对应的薄接入点并运行回归测试，不能直接用旧文件覆盖新版上游。

`integration/facades.tsv` 记录专用宿主门面的完整内容，防止在门面里重新混入实现；`hooks.tsv` 对关键调用还校验出现次数，避免保留一处调用就掩盖其他路径被删的问题。
普通 cargo 构建通过 core/build.rs 检查门面与接入点；macOS / Windows 的 PR 和发布工作流均检查功能包的完整性清单及 SHA-256，macOS 打包还会再次检查。
上游若重写原生会话 API，仍需适配并测试；模块隔离不能保证第三方 API 永远兼容。干净 checkout 直接构建本仓库即可，不依赖同级目录或网络获取生图源码。
