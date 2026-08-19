# 公共 CLI 表面回归方案

## 目标

统一 `package.json.bin` 中所有公开入口的基础契约和自动化回归测试，避免新增工具遗漏 help、version 或构建入口验证。

## 公共契约

每个公开入口都必须支持：

```text
TOOL version
TOOL -v
TOOL help
TOOL -h
TOOL --help
```

- 两个版本入口读取共享 `package.json` 版本并输出 `TOOL VERSION`。
- 三个帮助入口是工具自身的专用帮助，不转发给下游命令。
- 帮助以 `Usage:` 开始，包含当前工具名；每个命令行带简短注释。
- 帮助和版本入口不读取业务配置、不发网络请求、不修改文件。

无参数行为按工具职责保留：

- 状态型工具输出实际状态和简洁命令栏。
- 自动发现型工具执行其默认发现流程。
- 转发型 wrapper 启动下游 CLI。
- 必填位置参数工具输出用法并报告缺失参数。

不为追求形式一致而改变既有无参数业务语义。

## 实施

1. 为 `ccx`、`ccxs` 增加自身 help，保留无参数和普通参数的 Claude 转发行为。
2. 修正 `codex-rename help`，使三种 help 入口一致。
3. 新增 `test/cli-surface.test.js`，动态读取 `package.json.bin` 并验证全部入口的版本与帮助契约。
4. 保留各工具现有测试，继续覆盖无参数状态、自动发现和转发等工具特定行为。
5. 更新 README、构建产物和 patch 版本。

## 验收

- 当前 10 个公开入口全部通过两种版本和三种帮助入口测试。
- 新增 bin 会自动进入公共测试，不维护手写工具列表。
- `ccx help` 和 `ccxs help` 不启动 Claude。
- `codex-rename help` 正常退出，不要求路径参数。
- 定向测试、TypeScript 检查、构建和全仓测试通过。
