# ccs proxy passthrough and CLI display plan

## Status

Ready for implementation.

## Goal

恢复 `passthrough` 的透明转发语义，并同步收紧 `ccs proxy` 命令表面和现有状态视图。保持现有 policy、日志、状态结构和三个 watch 视图，不增加新的运行时能力。

## Decision basis

- 第一性原理：`passthrough` 的唯一产品承诺是代理路由存在，但代理不干预上游结果。
- 有界贝叶斯：只有 `intercept` 和 `recovery` 明确授权策略介入；mode 为 `passthrough` 时，不根据响应或失败证据升级为重试、拦截或 deadline。
- 奥卡姆剃刀：复用现有透明转发能力和已有 compact metrics；删除重复入口，不增加兼容别名、配置项、view 或 schema 字段。

## Confirmed contract

### Modes

| Mode | Contract |
| --- | --- |
| `passthrough` | 单次上游 fetch；不执行 proxy policy、重试、等待、deadline、正文拦截或改写 |
| `intercept` | 保持现有 Capacity、transport、latency、reasoning guard 行为 |
| `recovery` | 保持 `intercept` 行为，并启用 continuation recovery |

`passthrough` 继续执行代理的必要职责：解析当前 profile、设置上游认证、限制受支持路径、转发客户端 abort，并记录不改变响应的状态码、耗时和字节事实。

在 `passthrough` 中：

- 一个客户端请求最多产生一个真实上游 attempt。
- Capacity、HTTP 429、reasoning、first-progress timeout、total deadline 和 inspection limit 均不触发策略动作。
- Transport failure 不重试；没有可转发的 HTTP 响应时返回现有稳定的本地 upstream failure。
- 已启用的 `latency_guard` 保留在 state 中，但仅在切换到 `intercept` 或 `recovery` 后生效。
- 被动观测不得延迟响应头、缓存完整正文、限制 SSE event 大小、中止上游或改变响应字节。

### Command surface

本次涉及的业务命令为：

```text
ccs proxy [--view overview|tokens|cost] [--history N]
ccs proxy watch [--view overview|tokens|cost] [--history N]
ccs proxy mode [passthrough|recovery|intercept]
ccs proxy config
ccs proxy config latency off
ccs proxy config latency FIRST_MS TOTAL_MS [return_502|retry_then_502]
ccs proxy install
ccs proxy restore
ccs proxy serve
```

现有 `help`、`-h`、`--help` 以及公共 `ccs version|-v` 契约保持不变。

- `ccs proxy mode passthrough` 替代 `ccs proxy stop`。
- 删除 `ccs proxy stop`，不保留 alias 或兼容提示。
- 无参数 `ccs proxy` 已是单次输出，因此删除 `--once`，不保留 alias。
- 三种 mode 写入都先打印当前值与目标值，要求输入精确的 `yes`。
- `help`、无参数状态底部和顶层 `ccs` compact help 使用同一份当前命令契约。

### Status and watch

保留 `overview`、`tokens`、`cost` 三个 view 及其字段来源，只调整必要语义：

```text
overview  session time up model reas./code dur. size result
tokens    session time up model input output cached result
cost      session time up model input$ output$ cached$ total$ result
```

- `dur.` 替代 `lat.`：active 行表示已运行时长，history 行表示总请求时长。
- `result` 替代 `error`：该列同时承载成功的策略动作前缀和失败摘要。
- 标题使用 `deadline: off`；启用时显示 first/total 的紧凑值和完整 action，例如 `deadline: 30.0s/10.0m retry_then_502`。
- `status total=...` 改为 `status events=...`，明确其统计状态事件而非客户端请求数。
- 增加一行紧凑 policy 摘要：`policy retries=... capacity=... 429=... reasoning=... timeout=... transport=...`。
- policy 摘要固定聚合 `proxy.json.metrics.recent_requests` 全窗口，不受当前渲染行数或 `--history` 影响；不读取 JSONL，不增加 state 字段。
- `retries` 精确等于 `upstream_capacity + http_429 + reasoning_guard + timeout + transport`。没有重试时仍显示零值，便于稳定扫描。

## Implementation slices

1. **恢复透明转发**
   - mode 为 `passthrough` 时走单次直连路径，跳过统一 policy、retry budget、deadline 和 response inspection。
   - 保持认证、路由、abort 和不干预响应的基础记录。
   - `intercept` 与 `recovery` 行为保持不变。
2. **收紧命令契约**
   - `mode` 接受三种值；删除 `stop` 和 `--once` 分支。
   - 同步 help、README 和 proxy spec；旧核心计划保留历史实施事实，但在 Status 中标记错误的 passthrough 语义已由本计划取代。
3. **校正现有展示**
   - 更新 deadline 标题、status/policy 摘要和两个列标题。
   - 复用 `retry_summary` 聚合与现有 formatter；更新 built `dist` 和 package patch version。

## Acceptance

- `passthrough` 面对 Capacity 文本、HTTP 429、reasoning guard 值和已启用的 latency guard 时只产生一个上游 attempt，并原样转发上游 HTTP 响应。
- `passthrough` 遇到 transport failure 时不重试；`intercept` 和 `recovery` 仍按现有契约重试。
- `passthrough` 流响应不因 SSE inspection limit、首进度或总 deadline 被缓存、改写或中止。
- `ccs proxy mode passthrough` 按预览和精确 `yes` 修改 mode；`stop` 与 `--once` 作为未知参数失败。
- 所有公开 help 只列确认后的命令表面。
- 三个 view 仅发生确认的标题变化，沿用现有列宽、截断和 overflow 行为。
- deadline 显示全部活动配置，status 使用 `events`，policy 摘要与现有 `retry_summary` 聚合一致。
- 当前 README、proxy spec 和计划状态均不得把“passthrough 仍执行其他策略”描述为现行契约。

## Focused verification

- 一个 passthrough 端到端测试覆盖单 attempt、响应字节保持和 policy/deadline 不介入；transport 使用一个独立定向断言。
- 一个命令测试覆盖 `mode passthrough` 确认写入及已删除入口。
- 一个 renderer 测试覆盖列集合、deadline、status events 和 policy 聚合；不增加完整输出 snapshot。
- 定向测试通过后，提交前执行一次 `pnpm test`。

## Non-goals

- 不新增 watch view、快捷键、表格列或详情页。
- 不修改 policy 优先级、重试次数、Retry-After、reasoning 匹配值或 continuation 算法。
- 不新增配置、环境变量、日志文件、状态字段、schema 或 health protocol。
- 不重写 SSE scanner、attempt state machine、metrics 存储或定价逻辑。
- 不保留 `stop`、`--once` 或旧展示名称的兼容路径。
