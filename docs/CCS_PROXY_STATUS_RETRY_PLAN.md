# ccs proxy status retry plan

## Goal

新增轻量 `retry` 模式，只依据上游响应状态处理 HTTP 429 和 503。普通响应在收到响应头后直接转发，不读取、缓冲或检查正文。

## Decisions

- `passthrough` 保持单次透明转发。
- `retry` 只拦截 429/503，不启用 capacity、reasoning、continuation、SSE inspection、latency guard 或 transport retry。
- 重试从首次上游请求开始计算总窗口，默认 60 分钟；窗口到期后向客户端返回最后一次 429/503。
- 优先采用合法 `Retry-After`，否则使用 full-jitter 指数退避。
- 默认退避为基础 1 秒、上限 30 秒；总窗口、基础退避、退避上限均保存在 `proxy.json`，通过 `ccs proxy config retry` 查看和修改。
- 写配置继续采用 preview、精确输入 `yes`、写入后校验的现有命令契约。
- 重试等待响应客户端中止，总窗口禁止发起越界 attempt。
- 429/503 使用独立的时长上限，不占用 reasoning guard 的三次预算。

## Implementation

1. 增加 `retry` 模式与 `status_retry` 状态配置，升级 state schema、health protocol 和 request record schema。
2. 增加轻量状态重试循环：只调用 `fetch`、检查 `response.status`、取消待重试响应正文并等待。
3. 扩展 attempt、retry summary、事件和状态显示，区分 429 与 503 重试。
4. 增加 `ccs proxy config retry WINDOW BASE MAX`，参数单位为毫秒。
5. 更新 README、proxy spec、构建产物和定向测试。

## Acceptance

- `retry` 模式下，429/503 后可以恢复到 200，并向客户端只返回最终 200。
- 持续 429/503 到达窗口上限后返回最后一次上游状态与原始正文。
- 200、其他 4xx/5xx 和流式响应只产生一次上游 attempt，响应字节保持不变。
- `Retry-After`、指数退避、最大退避、客户端中止和总窗口边界均有测试。
- 状态页和 JSON/JSONL 记录显示真实配置、attempt 数及 429/503 重试计数。
- 定向测试、类型检查和全仓测试通过。

## Status

完成。

实施结果：

- 新增 `retry` 模式，只检查响应状态并持续重试 HTTP 429/503；其他状态和最终响应正文直接转发。
- 默认总窗口 60 分钟、基础退避 1 秒、退避上限 30 秒；`ccs proxy config retry WINDOW BASE MAX` 可配置并要求精确输入 `yes`。
- `Retry-After`、客户端中止、窗口耗尽、429/503 独立计数、attempt 事件和 request schema 7 已接入。
- `watch` 按模式收缩摘要，并把释放的行数用于历史表格。
- state schema 升级到 2，health protocol 升级到 6；后台代理信号关闭和版本切换的健康检查竞态已修正。
- `pnpm test` 通过 160 项测试。
