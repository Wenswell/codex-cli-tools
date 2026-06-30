# ccs proxy spec

`ccs proxy` reports proxy runtime state and HTTP request state from `~/.config/codex-tools/proxy.json`.

## Request lifecycle

- A proxied HTTP request enters `metrics.active_requests` after the proxy accepts the request.
- Active records use the same request record schema as history records. Pending-only fields use `null` or `0` until completion.
- Proxy process startup clears any persisted `metrics.active_requests` entries before accepting new requests.
- A request moves to `metrics.recent_requests` when the upstream response is fully written, the request fails, or the response stream ends.
- History records are the completed form of the same request record and include completion time, status code, reasoning tokens, upstream, attempts, latency, request bytes, response bytes, session short id, model metadata, guard actions, and error text.
- SSE responses stay active while the proxy buffers upstream chunks before client response headers and while the accepted response body is written to the client.
- Client-aborted response streams are completed as failed history with status `499`.
- Proxy state writes are serialized in the proxy process so concurrent requests update one metrics snapshot in order.

## Metrics schema

`metrics` keeps compact operational counters:

- `total_requests`: completed request count.
- `active_requests`: currently processed HTTP requests.
- `recent_requests`: completed history, newest first.
- `status_counts`: completed request counts keyed by exact HTTP status code string, such as `200`, `404`, and `502`.
- `reasoning_token_counts`: completed request counts keyed by observed `reasoning_tokens` value string, such as `42`, `516`, and `1552`.
- `upstream_hit_counts`: completed request counts per selected upstream.
- `latency_ms`: completed request latency with `last`, `count`, `sum`, `min`, and `max`.

Request records include `guard_actions`, an ordered array of local proxy action records with:

- `at`: action timestamp.
- `action`: `internal_retry`, `return_status_502`, or `upstream_error`.
- `upstream`: selected upstream profile name.
- `attempt`: upstream fetch attempt number for the client request.
- `status`: upstream HTTP status when an upstream response existed.
- `reasoning_tokens`: matched reasoning token count when present.
- `error`: local proxy error text when present.

Request records include `reasoning_tokens`, the latest observed upstream reasoning-token count for the client request. Accepted responses store their accepted value. Guarded responses store the matched guard value that caused the latest internal action or final `502`.

Old state files are normalized at read time. Missing model fields render through the current `-` status display. Missing `reasoning_tokens` fields normalize to `null`. Missing `guard_actions` fields normalize to `[]`.

## Upstream forwarding

The proxy resolves one active upstream from `profiles.current` for each client request. `ccs toggle` owns profile switching by changing `profiles.current`; the proxy reads that current value when forwarding a new request.

Upstream HTTP responses are upstream facts. The proxy returns the original upstream status and body when the local reasoning guard accepts the response, including `401`, `403`, `408`, `429`, and `5xx`.

Transport-level `TypeError: fetch failed` is retried once for the same upstream. A repeated transport failure returns local status `502` with error type `upstream_error`, code `upstream_fetch_failed`, and a request `guard_actions` entry with action `upstream_error`.

`attempts` counts upstream fetch attempts for the client request. It includes the initial fetch, the single transport retry when used, and reasoning-guard retry fetches.

## Reasoning guard

The reasoning guard is always active for supported JSON and SSE response payloads.

- `reasoning_equals`: `516`, `1034`, `1552`.
- `guard_retry_attempts`: `3`.
- Non-stream JSON responses are buffered, parsed, and checked before being forwarded.
- SSE responses are buffered before client response headers are written. SSE `data:` JSON frames are scanned for model metadata and `reasoning_tokens`; accepted SSE bytes are then forwarded unchanged.
- A guard match records `internal_retry` and retries the same upstream until the retry budget is used.
- The final guard match records `return_status_502` and returns local status `502` with code `reasoning_guard_triggered`.
- Transport errors record `upstream_error`.

The proxy also writes each guard action as one JSON line in `~/.config/codex-tools/proxy.log`.

## Status view

`ccs proxy` and `ccs proxy --once` print a full snapshot:

- Title line: `ccs proxy`, current time, runtime, pid, proxy URL, and trailing refresh interval.
- Path lines: state path, log path, and config path.
- Summary line: `status total=... active=... 200=... 404=... 502=... upstreams=...`.
- Reasoning line: `reasoning total=... max=... 0=... 516=... 1034=... 1552=... other=...`.
- Latency line: `latency last=... avg=... min=... max=...`.
- `active`: up to 5 current requests rendered by the shared request-row formatter.
- `history`: up to 5 completed requests rendered by the shared request-row formatter.

`ccs proxy watch` renders the same live status in the terminal alternate screen, repaints each frame from the home cursor position, clears rewritten lines and the remaining screen tail, hides the cursor while active, and restores the main screen on exit. The watch view keeps the proxy URL on the title line and omits the state, log, and config file path lines.

`status total` is the sum of all exact status-code counters. Status counters render as exact HTTP codes in ascending numeric order and omit codes with zero count. Failed request records such as client aborts still keep their exact status code values.

`reasoning total` is the sum of completed requests with observed `reasoning_tokens`. `max` is the largest observed `reasoning_tokens` value across completed requests and renders `-` when none have been observed. Reasoning counters render fixed groups: `0`, every guarded value from `REASONING_EQUALS`, and `other` for every remaining observed value. Guarded-value counts render red. The `0` count renders orange. `other` and non-guarded max values render green. Requests with no observed reasoning token do not increment `reasoning_token_counts`.

Request tables use the shared terminal table renderer. Fixed-width columns are right-aligned, and the final error column takes remaining width and is left-aligned. The visible data columns are:

```text
session time up code reas. lat. size req_model up_model path error
```

Active rows show elapsed time for `lat.`, known request bytes for `size`, and known upstream, status, reasoning token, and model fields as soon as the proxy observes them. Active rows show `-` for code while no status is known and `-` for missing `reasoning_tokens`. History rows show completed response bytes for `size`. Attempts greater than one are shown as `xN` after the upstream name; retry attempts use the same active upstream. Missing request and upstream model fields render as `-`; matching request/upstream models render as `[same]`; differing upstream models render as the upstream model name. `path` is fixed-width, and request error text renders in the final left-aligned `error` column without table-side truncation. Truncated table cells use the shared single-character ellipsis `…`. Time, latency, and size use compact 3-significant-digit units after the base unit, such as `56ms`, `2.34s`, `43.2s`, `3.12m`, `32.0K`, and `3.41M`.

## Implementation notes

- `metrics.active_requests` and `metrics.recent_requests` use the same request record type.
- Active records are normalized through the same request-record normalizer as history records.
- Status output builds active and history rows with one request-row formatter. The formatter derives pending or completed timing and byte display from `completed_at`.
- Persisted `active_requests` entries never survive a proxy restart. A new proxy process resets `active_requests` to `[]` before serving traffic.
- Current upstream display is derived from `profiles.current`; historical upstream hit counts remain visible through `upstream_hit_counts`.

Local file paths in terminal output render relative to `$HOME` with `~/`.

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

The proxy forwards request bodies at their original size. Runtime and upstream resources determine practical payload bounds.

The proxy does not set its own upstream response deadline. Client settings such as Codex `stream_idle_timeout_ms` own stream idle timeout behavior.

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
- SSE responses are fully buffered before client response headers, preserve accepted bytes, and scan SSE `data:` JSON frames for the first model value.
- Missing model fields are stored as `null`.

### Status view plan

The status table adds compact model visibility without expanding the command surface:

```text
session time up code reas. lat. size req_model up_model path error
```

Column behavior:

- `req_model`: `request_model`, truncated for terminal width, dim `-` when missing.
- `up_model`: dim `-` when missing, dim `[same]` when it equals `req_model`, and the red truncated upstream model name when different.
- `reas.`: observed `reasoning_tokens`, dim `-` when missing.
- `lat.`: elapsed time for active rows and completed latency for history rows.
- Active rows follow the shared `up_model` rendering rules; SSE streams update active rows after the first model frame is observed.
- History rows show status-normalized model fields.
- `path`: fixed-width request path.
- `error`: request error text, left-aligned in the final remaining-width column and not table-truncated.

### Tests

- Request JSON model is recorded for all four concrete paths.
- Non-stream JSON responses extract `upstream_model` for all four concrete paths when present.
- SSE responses extract `upstream_model` for all four concrete paths when present.
- SSE forwarding preserves the exact client-visible response bytes after strict guard buffering.
- The proxy selects only `profiles.current`; `profiles.toggle` entries are unused by proxy forwarding.
- Upstream `401`, `403`, `408`, `429`, and `5xx` responses are passed through with original status and body.
- Transport `fetch failed` is retried once and repeated failure returns `502 upstream_error/upstream_fetch_failed`.
- Non-stream JSON reasoning guard matches retry the same upstream and record `internal_retry`.
- SSE reasoning guard matches retry the same upstream after strict buffering and record `internal_retry`.
- Exhausted reasoning guard retry budget returns `502 reasoning_guard_triggered` and records `return_status_502`.
- Client aborts during strict SSE buffering complete history as `499`.
- Status tables display `code` and `reas.` as separate columns.
- Reasoning token counts are persisted in `metrics.reasoning_token_counts` and rendered as grouped `reasoning total=... max=... 0=... 516=... 1034=... 1552=... other=...`.
- Guard actions are persisted in request history and written to `proxy.log`.
- Missing request and upstream model fields render as `-`, equal upstream models render as `[same]`, and differing upstream models render as model names.
- Status tables right-align fixed columns, left-align the final `error` column without table-side truncation, and format time/size with compact 3-significant-digit units after the base unit.
- Existing active/history lifecycle, byte counts, session short id, status groups, and concurrent metrics tests continue to pass.

### Decisions

- Status table column names are `req_model` and `up_model`.
- Stream model extraction stops at the first valid model value.
