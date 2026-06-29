# ccs proxy spec

`ccs proxy` reports proxy runtime state and HTTP request state from `~/.config/codex-tools/proxy.json`.

## Request lifecycle

- A proxied HTTP request enters `metrics.active_requests` after the proxy accepts the request.
- Active records include request id, start time, method, path, session short id, and request byte size.
- A request moves to `metrics.recent_requests` when the upstream response is fully written, the request fails, or the response stream ends.
- History records include completion time, status code, upstream, attempts, latency, request bytes, response bytes, session short id, and error text.
- Streaming responses stay active while the response body is being written to the client.
- Client-aborted response streams are completed as failed history with status `499`.
- Proxy state writes are serialized in the proxy process so concurrent requests update one metrics snapshot in order.

## Metrics schema

`metrics` keeps compact operational counters:

- `total_requests`: completed request count.
- `active_requests`: currently processed HTTP requests.
- `recent_requests`: completed history, newest first.
- `status_counts`: completed request groups keyed as `2xx`, `3xx`, `4xx`, and `5xx`.
- `upstream_hit_counts`: completed request counts per selected upstream.
- `latency_ms`: completed request latency with `last`, `count`, `sum`, `min`, and `max`.

Old state files are normalized at read time. Missing fields are rendered as empty values.

## Status view

`ccs proxy`, `ccs proxy --once`, and each `ccs proxy watch` refresh print the same fields:

- Title line: `ccs proxy`, current time, runtime, pid, and refresh interval.
- Path lines: proxy URL, state path, log path, and config path.
- Summary line: `status total=... active=... 2xx=... 3xx=... 4xx=... 5xx=... upstreams=...`.
- Latency line: `latency last=... avg=... min=... max=...`.
- `active`: up to 5 current requests.
- `history`: up to 5 completed requests.

Request tables use the shared terminal table renderer. The row number is an explicit aligned column, and the visible data columns are:

```text
time code up ms size session req_model up_model method path
```

Active rows show `...` for code, elapsed time for `ms`, and known request bytes for `size`. History rows show completed response bytes for `size`. Attempts greater than one are shown as `xN` after the upstream name.

## Model field plan

First version scope covers four concrete OpenAI-style paths:

- `/v1/chat/completions`
- `/v1/responses`
- `/chat/completions`
- `/responses`

The four paths map to two endpoint classes: `chat/completions` and `responses`.

### Field semantics

- `request_model`: model string read from the incoming request JSON body.
- `upstream_model`: model string read from the upstream response payload.
- `upstream_model_source`: extraction source for `upstream_model`, such as `json.model`, `json.response.model`, or `sse.data.model`.

The proxy forwards requests directly. Model fields are observational metadata only.

### Extraction plan

| Path | Endpoint class | `request_model` | Non-stream `upstream_model` | Stream `upstream_model` |
| --- | --- | --- | --- | --- |
| `/v1/chat/completions` | `chat/completions` | request JSON `model` | response JSON `model` | SSE `model` |
| `/chat/completions` | `chat/completions` | request JSON `model` | response JSON `model` | SSE `model` |
| `/v1/responses` | `responses` | request JSON `model` | response JSON `response.model`, then response JSON `model` | SSE `response.model`, then SSE `model` |
| `/responses` | `responses` | request JSON `model` | response JSON `response.model`, then response JSON `model` | SSE `response.model`, then SSE `model` |

### Lifecycle integration

- Active request records include `request_model` after the request body is read.
- History request records include `request_model`, `upstream_model`, and `upstream_model_source`.
- Non-stream JSON responses are already buffered for inspection, so model extraction runs before response forwarding.
- Stream responses are forwarded through a transform that preserves bytes and scans SSE `data:` JSON frames for the first model value.
- Missing model fields are stored as `null`.

### Status view plan

The status table adds compact model visibility without expanding the command surface:

```text
time code up ms size session req_model up_model method path
```

Column behavior:

- `req_model`: `request_model`, truncated for terminal width.
- `up_model`: `upstream_model`, truncated for terminal width.
- Active rows show `up_model` as empty.
- History rows show both model fields when available.

### Tests

- Request JSON model is recorded for all four concrete paths.
- Non-stream JSON responses extract `upstream_model` for all four concrete paths when present.
- SSE responses extract `upstream_model` for all four concrete paths when present.
- SSE forwarding preserves the exact client-visible response bytes.
- Missing model fields render as empty values.
- Existing active/history lifecycle, byte counts, session short id, status groups, and concurrent metrics tests continue to pass.

### Decisions

- Status table column names are `req_model` and `up_model`.
- Stream model extraction stops at the first valid model value.
