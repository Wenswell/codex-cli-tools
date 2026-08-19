# cimg CLI 方案

## 目标

新增单用途命令 `cimg`：输入一段文本提示词，通过活动 `ccs` profile 的 OpenAI-compatible Images API 生成一张 PNG。

参考 [PixAI](https://github.com/fengxinzi-mulan/PixAI) 的 `src/shared/image-options.ts`，只复用 `gpt-image-2` 文生图所需的比例、尺寸和质量预设。Electron、图生图、批量、流式、重试、会话、SQLite 和提示词辅助不在范围内。

## 命令契约

```text
cimg
cimg -p TEXT [--ratio RATIO] [--size WIDTHxHEIGHT] [--quality QUALITY] [-o FILE]
cimg version | -v
cimg help | -h | --help
```

- 无参数输出活动 profile、API 地址、固定模型、默认参数、输出目录和日志路径。
- `-p` / `--prompt` 是唯一必填输入。
- 默认参数为 `1:1`、`1024x1024`、`auto`。
- `--ratio` 接受 `1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`21:9`、`9:21`。
- `--size` 必须属于所选比例的固定尺寸表；未传时使用该比例的标准尺寸。
- `--quality` 接受 `auto`、`low`、`medium`、`high`。
- 默认输出到当前目录的时间戳 PNG；`-o` / `--out` 可指定新文件，已有文件不覆盖。
- 生成前打印 profile、端点、模型、参数和输出路径；只有输入精确 `yes` 后才请求并写文件。

## 请求与响应

请求固定发送到 `{baseURL}/v1/images/generations`：

```json
{
  "prompt": "...",
  "model": "gpt-image-2",
  "size": "1024x1024",
  "quality": "auto",
  "n": 1,
  "output_format": "png"
}
```

认证读取 `~/.config/codex-tools/profiles.json` 的活动 profile。响应必须包含 `data[0].b64_json`；解码后校验 PNG 签名与 IHDR，以独占创建方式写入文件。单次请求最长等待 300 秒，不重试。完成结果记录并显示 PNG 实际宽高；供应商返回尺寸与请求尺寸不同时明确警告，不执行隐式缩放。

## 请求记录

每个 API 请求使用同一个 `request_id` 写两条 schema v1 生命周期事件到 `${XDG_CACHE_HOME:-~/.cache}/codex-tools/cimg/requests.jsonl`，并限制文件大小：

- HTTP 请求前追加 `started`，记录时间、请求 ID、活动非密配置、prompt SHA-256 和字符数。
- 请求结束后追加 `succeeded` 或 `failed`，补充完成时间、HTTP 状态、耗时、输出路径、字节数、PNG 实际宽高或规范化错误。

两条事件构成一次请求的可追溯更新；进程异常退出时仍保留未完成的 `started`。API key、prompt 原文、供应商错误消息、响应原文和图片 base64 不写入日志；错误记录只保留 code、HTTP 状态和通用消息。文件权限为 `0600`。

## 实施步骤

1. 新增 `src/commands/cimg.ts` 和 `src/bin/cimg.ts`，复用 profiles、路径、确认、输出和运行记录工具。
2. 在 `package.json` 注册 `cimg`，同步构建产物并增加 patch 版本。
3. 添加参数映射、请求体、确认边界、成功/失败日志和文件写入测试。
4. 更新 README 的安装命令、工具列表和使用说明。

## 验收标准

- `cimg`、帮助和版本输出符合仓库 CLI 约定。
- 非法比例、比例与尺寸不匹配、非法质量、缺少 prompt 或活动密钥时在请求前失败。
- 未输入 `yes` 时不发请求、不写图片、不写请求日志。
- 确认后只发送一次固定模型的 generations 请求，并保存一张 PNG。
- 请求前写 `started`，成功或失败后写同一请求 ID 的终态事件，日志不含敏感原文。
- 定向测试、TypeScript 检查、构建和全仓测试通过。
