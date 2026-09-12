# Independent imagegen extension

独立维护源：`../CodexPlusPlus-imagegen`，独立 Git 仓库，不是上游 fork，不配置远程仓库。
CodexPlusPlus 的 `extensions/imagegen` 仅是构建快照；**后续修改请在独立维护源进行**。
初始行为基线为用户验证可用的 CodexPlusPlus 1.3.0+46。保留原项目 LICENSE 以及 skill 自带许可。

## 内容与边界

- `ui/renderer-runtime.js`：生图工具冲突修正、保存/恢复、原生消息缓存更新。
- `ui/generated-images-inject.js`：消息匹配、图片预览、自动持久化触发。
- `rust/generated_images.rs`：图片落盘、原生消息修复、历史索引重建。
- `rust/imagegen_skill.rs`、`skill/`：本地 imagegen 增强版本、覆盖安装和覆盖状态检查。
- `rust/relay_compatibility.rs`、`rust/config_read.rs`：图片模型配置兼容与有效开关读取。
- `tests/`：图片数据和 skill 安装回归测试，由宿主 cargo test 执行。

这里是独立版本管理的扩展源码包，不是独立运行的 Codex 插件。Rust 通过宿主薄门面编译，复用宿主的数据类型、数据库定位和原子文件写入；renderer 通过一个固定插槽装配，复用宿主桥接和原生会话管理器。宿主的通用 HTTP/模型选择/协议代理仍由宿主管理，不复制整套应用。

## 同步与合并上游

在独立源中修改后：

```sh
python3 ../CodexPlusPlus-imagegen/sync.py --sync --target .
python3 ../CodexPlusPlus-imagegen/sync.py --check --target .
NO_PROXY=127.0.0.1,localhost cargo test -p codex-plus-core --test cdp_bridge --test imagegen_skill --test relay_config
cargo test -p codex-plus-data --test generated_images
```

以上命令从 CodexPlusPlus 根目录运行。同步只写扩展快照；宿主中已有未同步改动会被拒绝覆盖，不自动删除文件，也不覆盖整份上游源文件。

合并上游前后执行独立源的 `--check`。`integration/hooks.tsv` 列出必须保留的宿主接入点：renderer 插槽/请求钩子、Rust 门面、路由、配置兼容、本地 skill 安装入口、构建/打包检查。缺失时检查明确失败，应恢复对应的薄接入点并运行回归测试，不能直接用旧文件覆盖新版上游。

普通 cargo 构建通过 core/build.rs 自动检查接入点；macOS 打包额外检查快照摘要。独立源保存 SHA-256 清单，能发现扩展文件被静默修改。上游若重写原生会话 API，仍需适配并测试；模块隔离不能保证第三方 API 永远兼容。宿主构建不依赖同级目录或网络，干净 checkout 只需随仓库提交扩展快照即可。
