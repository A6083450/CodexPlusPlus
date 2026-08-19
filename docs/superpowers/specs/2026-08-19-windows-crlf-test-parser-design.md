# Windows CRLF 测试源码解析兼容设计

## 背景

GitHub Windows job `32221931037` 的 frontend tests 在 `market-ds-style-cost-performance.test.ts` 中有 12 个失败。本机 macOS 同一命令通过。失败用例都经过 `functionBody`，而该 helper 用 LF 空行定位下一个函数；Windows checkout 读取 CRLF 脚本时，边界匹配失败，导致测试源码契约无法提取函数体。

这不是 renderer bridge watchdog 或生产注入逻辑的运行时失败。现有 bridge backoff 改动保持不变。

## 目标

- 让测试源码契约解析同时支持 LF 和 CRLF 输入。
- 用一个回归用例明确覆盖 CRLF 输入。
- 保持现有测试断言、生产脚本、`.gitattributes` 和 GitHub workflow 不变。

## 方案

在 `apps/codex-plus-manager/src/market-ds-style-cost-performance.test.ts` 的 `functionBody` helper 内，将 `CRLF` 规范化为 `LF` 后再执行现有边界查找和切片。这样所有调用方共享同一兼容行为，避免为每个断言单独处理换行。

新增测试把已读取的脚本转换为 CRLF，再调用 `functionBody` 并断言能提取 `ensureStyle` 函数。该测试在修复前必须失败，修复后与完整 manager 测试一起通过。

## 非目标

- 不改变 `assets/user_scripts/market-codex-ds-style-cost.js` 的内容或换行策略。
- 不回退或重写 renderer bridge timeout/backoff 实现。
- 不修改 workflow、依赖、版本号或打包脚本。

## 验证

1. 运行新增 CRLF 回归测试并先确认修复前失败。
2. 运行 `npm test`，确认 86 个 manager tests 全部通过。
3. 运行 `npm run check`，确认 TypeScript 检查通过。
4. 检查 `git diff --check`，并确认 `.idea/` 等用户文件未被纳入改动。
