# Fork 版本号

采用 `上游版本+fork修订号`，例如 `1.3.0+36`，发布标签为 `v1.3.0+36`。

- `1.3.0` 跟随已合入的上游版本，不占用上游补丁号。
- `36` 是 fork 的累计修订号，不是修复数量；升级上游时不归零。
- 后续示例：`1.3.0+37` → `1.3.1+38`。
- 版本声明同步更新 Cargo workspace、Cargo.lock、manager package 与 lock、Tauri 配置和版本测试。
- fork 发布使用 `myfork`（A6083450/CodexPlusPlus）；当前 `origin` 是上游 BigPizzaV3/CodexPlusPlus。

`+N` 是 SemVer 构建元数据，不参与标准版本优先级比较。现有应用更新器也忽略它，并默认查询上游；因此仅增加 `+N` 不会触发自动升级提示。fork 自动更新渠道及修订号比较需另行实现。
