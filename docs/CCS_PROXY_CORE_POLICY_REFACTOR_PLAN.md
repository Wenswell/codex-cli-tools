# ccs proxy core policy refactor plan

## Core principle

- 第一性原理：代理只做三件事：识别可观测的上游事实、决定重试或转发、记录最终结果。
- 贝叶斯公式：`P(策略|证据) ∝ P(证据|策略)P(策略)`。只有证据充分才升级为拦截或重试；没有明确证据的普通响应不进入失败策略。
- 奥卡姆剃刀：一层策略决策、一个重试预算、一个 attempt 生命周期。不增加兼容层、备用路径或静默降级。
- 任何检查超限、响应控制权已经丢失或 deadline 已过的情况，按明确的 fail-closed 结果收口。

## Goal

把 `ccs proxy` 的核心路径整理为独立的失败策略、attempt 状态机、增量流式检查和规范化日志。除已确认的最小 `ccs proxy config` 外，保持现有 CLI 表面，不引入新的安装入口或交互界面。

上游依据：[PR #27](https://github.com/nonononull/codex-retry-gateway/pull/27)、[合并提交](https://github.com/nonononull/codex-retry-gateway/commit/ef7fc5a0f9da125b91431cd99bcf6fd9387a53b2)、[分层策略设计](https://github.com/nonononull/codex-retry-gateway/blob/ef7fc5a0f9da125b91431cd99bcf6fd9387a53b2/docs/plans/2026-07-14-layered-gateway-policies-design.md)。

## Scope

Included:

- Capacity、HTTP 429、reasoning、首个有效输出超时、总 deadline 的组合策略。
- 统一重试预算和可中止的 Retry-After 等待。
- 真实上游 attempt 的创建、关闭、重试和超时边界。
- 增量 SSE 检查、检查上限、转发前后拦截边界。
- 规范化请求/attempt 日志字段和策略事件。
- 针对上述行为的数据契约和边界测试。

除 `latency_guard` 及其最小配置命令外，不改变当前命令表面、配置解析、非核心监测和已有无关能力。

## Confirmed decisions

1. reasoning 匹配器先抽象，默认仍为 `[516, 1034, 1552]`，不直接采用上游的 `518*n-2` 扩展。见[当前常量](../src/commands/ccs-proxy.ts#L329)。
2. 统一 guard 重试预算先保持 `3`，只统一预算消耗范围；不直接改为上游默认 `5`。见[当前预算](../src/commands/ccs-proxy.ts#L331)。
3. Capacity 默认 `retry_then_pass_through`，HTTP 429 默认 `pass_through`，普通 5xx 不自动重试。
4. 策略优先级固定为：`timeout > capacity > http_429 > reasoning > pass_through`。
5. transport `fetch failed` 重试保持独立，不消耗 guard 预算。
6. 已发送客户端响应头后不得改写为 502 或发起新 attempt，只能中止上游并断开客户端连接。
7. 日志只保存规范化事实、哈希、允许的请求头和错误摘要；不保存 prompt、响应正文或请求正文摘录。
8. `latency_guard` 写入 proxy 状态，默认关闭；启用时至少一个阈值为正数。增加最小 `ccs proxy config` 查看/修改入口，不增加环境变量、兼容字段或备用配置来源。
9. `latency_guard.first_progress_action` 只允许 `return_502` 或 `retry_then_502`；毫秒阈值为不超过 Node timer 上限的非负整数，`0` 表示单独关闭该阈值。

## Target design

### 1. Policy decision

- Capacity 仅由明确的容量错误事实触发；HTTP 429 仅由状态码触发；普通 5xx 直接作为上游事实处理。
- 动作集合固定为 `pass_through`、`return_502`、`retry_then_pass_through`、`retry_then_502`。
- `Retry-After` 支持秒数和 HTTP 日期；合法值最多等待 60 秒，缺失/非法值使用有上限的随机退避；等待必须响应客户端 abort 和总 deadline。
- 每次策略结果写入 `policy_trigger`、`policy_action`、`retry_trigger`、`retry_delay_ms` 和剩余预算。

### 2. Attempt and deadline

- 每次真实 `fetch` 前创建 attempt，响应头、响应结束、失败或取消时只关闭一次。
- 使用 `pendingRetry` 表示尚未发出的下一次重试，不能提前计数或写入虚假 attempt。
- 总 deadline 从第一次真实上游 fetch 开始，跨越内部重试和等待；在发起 fetch、解析完成、写客户端响应头前都检查。
- 首个有效输出窗口按 attempt 计时；有效进度只包括非空文本、最终答案或工具调用。
- timeout 优先于后续策略：未发送客户端响应时返回带稳定 reason/code 的 502；已转发时执行 abort + disconnect。

### 3. Streaming interception

- 用增量字节扫描器替代“完整响应拼接后解析”。处理分片、LF/CR/CRLF、跨分片 BOM 和完整事件边界。
- 事件检查缓冲限制为 1 MiB；候选 SSE 超限时在响应头发送前返回 `response_inspection_limit_exceeded`，发送后断开。
- 完整事件无法识别为 SSE 时按明确的纯文本路径处理；不得把半截事件当作已解析结果。
- 扫描器与转发共用同一组 chunk，不再通过 `response.clone()` 做完整延迟读取。
- reasoning 规则关闭时允许直接转发；其他失败策略仍独立生效。

### 4. Request logs

每个 attempt 至少记录：

- `gateway_request_id`、`attempt_id`、`attempt_dispatched`。
- `upstream_fetch_started_at`、`upstream_headers_at`、`first_progress_at`、`time_to_first_progress_ms`。
- `policy_trigger`、`policy_action`、`retry_after_ms`、`retry_delay_ms`、`retry_budget_used`、`retry_budget_remaining`。
- `timeout_phase`、`timeout_limit_ms`、`timeout_response_control_lost`、`upstream_stream_terminated`。
- `final_action`、`upstream_http_status`、`client_http_status`、`failure_summary`。

请求历史继续使用有界 JSONL；策略触发和收口各写一个结构化事件。客户端响应完成后的持久化失败只能记录事件，不能改变已经发送的响应。

## Implementation slices

1. 增加内部 policy decision 类型和统一 retry budget；先覆盖 Capacity/429，再接入 reasoning 和 timeout。
2. 把请求执行改为真实 attempt 状态机，加入绝对总 deadline、可中止等待和转发边界检查。
3. 替换 SSE 检查为增量扫描器，保留原始字节，加入 1 MiB 超限收口和转发后 disconnect。
4. 扩展 request/attempt 规范化字段，确保每个真实 attempt 只完成一次。
5. 添加定向测试并更新本计划的实施结果；不扩展非核心功能。

## Acceptance

- 四种 Capacity/429 动作、策略优先级和 Retry-After 秒数/日期/超限行为可验证。
- guard、Capacity、429、首进度超时共享同一预算；transport retry 不计入该预算。
- 总 deadline 跨重试生效，过期后不产生新 attempt；转发前返回 502，转发后断开。
- SSE 分片、混合换行、BOM、纯文本回退和 1 MiB 超限均有确定结果，且转发字节不被改写。
- 日志每个 attempt 只收口一次，包含策略/超时事实，不包含 prompt、响应正文或密钥。

## Status

完成。

实施结果：

- 独立 policy 模块已实现四种动作、固定优先级、共享预算、Retry-After 解析、随机退避及可中止等待。
- 核心请求路径已改为真实 attempt 生命周期；总 deadline 为跨重试的绝对期限，首进度按 attempt 计时，转发前返回 502，转发后中止并断连。
- SSE 已改为增量扫描，覆盖任意分片、混合换行、跨分片 BOM、完整事件边界和 1 MiB 检查上限，接受的原始字节保持不变。
- `latency_guard` 已加入 proxy 状态和 `ccs proxy config`，默认关闭；`passthrough` 仅关闭 reasoning/recovery，其他策略独立运行。
- 请求契约已升级为 schema 6、健康协议升级为 5；每个真实 attempt 记录策略、预算、超时和收口事实，并输出规范化策略/完成事件。

已识别回归：上述 `passthrough` 行为违反原有透明转发契约。后续修复以 [ccs proxy passthrough and CLI display plan](./CCS_PROXY_PASSTHROUGH_CLI_DISPLAY_PLAN.md) 为准；本节保留为本次提交的历史实施记录。

验收：定向 policy 与 proxy 测试已通过；最终 `pnpm test` 通过 148 项测试。
