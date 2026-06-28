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

`ccs proxy` and `ccs proxy --once` print the same fields:

- Title line: `ccs proxy`, current time, runtime, pid, and refresh interval.
- Path lines: proxy URL, state path, log path, and config path.
- Summary line: `status total=... active=... 2xx=... 3xx=... 4xx=... 5xx=... upstreams=...`.
- Latency line: `latency last=... avg=... min=... max=...`.
- `active`: up to 5 current requests.
- `history`: up to 5 completed requests.

Request tables use fixed columns:

```text
time code up ms size session method path
```

Active rows show `...` for code, elapsed time for `ms`, and known request bytes for `size`. History rows show completed response bytes for `size`. Attempts greater than one are shown as `xN` after the upstream name.
