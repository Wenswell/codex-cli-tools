# ccs proxy spec

`ccs proxy` reports proxy runtime state and HTTP request state from `~/.config/codex-tools/proxy.json`.

## Storage files

Proxy state lives under `~/.config/codex-tools`:

- `proxy.json`: lightweight runtime state snapshot, counters, active model API requests, and the newest completed model API request snapshot.
- `proxy-requests.jsonl`: complete completed model API request history, one normalized request record per line in completion order.
- `proxy.log`: guard, unsupported-path, upstream-error, and local proxy error events as JSONL.
- `proxy-runtime.log`: background process stdout and stderr.
- `proxy.pid`: background process id.

## Route boundary

The proxy HTTP server separates local control traffic from model API forwarding.

Local control endpoints:

- `GET /__codex_proxy/health`

Health responses include `status`, `pid`, `version`, and `protocol`. Health checks are handled before metrics and never enter request history.

Only these model API paths enter upstream forwarding and request metrics:

- `/responses`
- `/v1/responses`
- `/chat/completions`
- `/v1/chat/completions`

Unsupported paths return local `404` JSON with `code: "unsupported_proxy_path"`, write one `ccs_proxy_unsupported_path` event to `proxy.log`, and do not update `active_requests`, `recent_requests`, `proxy-requests.jsonl`, status counters, latency counters, reasoning counters, or upstream hit counters.

Status and watch commands validate the health `protocol` from `/__codex_proxy/health`. A protocol mismatch fails with a restart message.

## Request lifecycle

- A supported model API request enters `metrics.active_requests` after the proxy accepts the request.
- Active records use the same request record schema as history records. Pending-only fields use `null` or `0` until completion.
- Proxy process startup clears any persisted `metrics.active_requests` entries before accepting new requests.
- A request moves to `metrics.recent_requests` when the upstream response is fully written, the request fails, or the response stream ends.
- History records are the completed form of the same request record and include completion time, status code, request kind, reasoning token count metadata, reasoning text observation metadata, upstream, attempts, latency, request bytes, response bytes, session short id, model metadata, guard actions, and error text.
- `proxy-requests.jsonl` records include JSONL-only `attempt_records` with complete upstream attempt facts. `proxy.json.metrics.recent_requests` keeps compact records without `attempt_records`.
- SSE responses stay active while the proxy buffers upstream chunks before client response headers and while the accepted response body is written to the client.
- Client-aborted response streams are completed as failed history with status `499`.
- Proxy state writes are serialized in the proxy process so concurrent requests update one metrics snapshot in order.

## Metrics schema

`metrics` keeps compact operational counters for the state-file window:

- `total_requests`: completed model API request count inside `recent_requests`.
- `active_requests`: currently processed model API requests.
- `recent_requests`: newest completed model API request snapshot, capped at 100 records and ordered newest first.
- `status_counts`: observed model API status-code event counts inside `recent_requests`, keyed by exact HTTP status code string, such as `200`, `499`, and `502`.
- `reasoning_token_counts`: observed reasoning-token event counts inside `recent_requests`, keyed by `reasoning_tokens` value string, such as `42`, `516`, and `1552`.
- `upstream_hit_counts`: completed request counts per selected upstream inside `recent_requests`.
- `latency_ms`: completed request latency inside `recent_requests` with `last`, `count`, `sum`, `min`, and `max`.

Request records include:

- `id`: local request id.
- `started_at`: request start timestamp.
- `completed_at`: completion timestamp for history records; `null` for active records.
- `method`: HTTP method.
- `path`: request pathname.
- `status`: observed upstream or local response status.
- `upstream`: selected profile name.
- `attempts`: upstream fetch attempt count.
- `latency_ms`: completed request latency.
- `request_bytes`: request body byte count.
- `response_bytes`: completed response body byte count.
- `session`: short Codex session id when present.
- `request_kind`: `normal` or `context_compaction`.
- `request_model`: model string from the request body.
- `upstream_model`: model string from the accepted upstream payload.
- `upstream_model_source`: source path for `upstream_model`.
- `reasoning_tokens`: latest explicit upstream reasoning token count.
- `reasoning_tokens_source`: source path for `reasoning_tokens`.
- `reasoning_text_observed`: true when a supported reasoning text field is present and non-empty.
- `reasoning_text_source`: source path for the first observed reasoning text field.
- `guard_actions`: ordered local proxy action records.
- `error`: local proxy error text.

`guard_actions` entries include:

- `at`: action timestamp.
- `action`: `internal_retry`, `continuation_recovery`, `return_status_502`, or `upstream_error`.
- `upstream`: selected upstream profile name.
- `attempt`: upstream fetch attempt number for the client request.
- `status`: upstream HTTP status when an upstream response existed.
- `reasoning_tokens`: matched reasoning token count when present.
- `error`: local proxy error text when present.

`reasoning_tokens` stores only explicit non-negative integer token counts from upstream usage fields. Accepted responses store the latest accepted value. Guarded responses store the matched guard value that caused the latest internal action or final `502`.

`reasoning_text_observed` records reasoning text fields such as `delta.reasoning_content`, `message.reasoning_content`, and `delta.reasoning`. Text observations stay separate from token-count metrics and guard matching.

`attempt_records` entries include `attempt`, `started_at`, `headers_at`, `completed_at`, `duration_ms`, `upstream`, `upstream_status`, upstream model fields, reasoning metadata, per-attempt `final_action`, `failure_summary`, and `remaining_retries`.

Old state files are normalized at read time. Missing model fields render through the current `-` status display. Missing `request_kind` normalizes to `normal`. Missing `reasoning_tokens`, `reasoning_tokens_source`, and `reasoning_text_source` fields normalize to `null`. Missing `reasoning_text_observed` normalizes to `false`. Missing `guard_actions` fields normalize to `[]`.

## Upstream forwarding

The proxy resolves one active upstream from `profiles.current` for each client request. `ccs toggle` owns profile switching by changing `profiles.current`; the proxy reads that current value when forwarding a new request.

The proxy owns upstream authentication in proxy mode. It removes incoming `Authorization`, `api-key`, and `x-api-key` headers, then sets `Authorization: Bearer <current profile apiKey>` before the upstream request. This keeps already-running Codex CLI processes on the local proxy URL while new requests use the API key from the latest `profiles.current`. A current profile without `apiKey` is a configuration error and the proxy fails the request before contacting upstream.

Upstream HTTP responses are upstream facts. The proxy returns the original upstream status and body when the local reasoning guard accepts the response, including `401`, `403`, `408`, `429`, and `5xx`.

Upstream capacity errors are a narrow retryable HTTP-response case. When an upstream error response body contains `Selected model is at capacity. Please try a different model.`, or contains both `selected model is at capacity` and `try a different model` case-insensitively, the proxy records `internal_retry` with `error: upstream_capacity`, retries the same upstream, and uses the same retry budget as the reasoning guard. Ordinary `429`, `502`, and `5xx` responses without that text stay upstream facts and pass through unchanged. If every capacity retry is exhausted, the final upstream status and body pass through unchanged.

Transport-level `TypeError: fetch failed` is retried once for the same upstream. A repeated transport failure returns local status `502` with error type `upstream_error`, code `upstream_fetch_failed`, and a request `guard_actions` entry with action `upstream_error`.

`attempts` counts upstream fetch attempts for the client request. It includes the initial fetch, the single transport retry when used, upstream capacity retries, and reasoning-guard retry fetches.

## Reasoning guard

The reasoning guard is always active for supported JSON and SSE response payloads.

- `reasoning_equals`: `516`, `1034`, `1552`.
- `guard_retry_attempts`: `3`.
- Non-stream JSON and `application/*+json` responses are buffered, parsed, and checked before being forwarded.
- SSE responses are buffered before client response headers are written. SSE `data:` JSON frames are scanned for model metadata, explicit `reasoning_tokens`, and reasoning text observations; accepted SSE bytes are then forwarded unchanged.
- Streaming Responses requests with `request_kind=normal` automatically request `reasoning.encrypted_content` when the client request does not include it.
- A guarded streaming Responses match with collected encrypted reasoning items records `continuation_recovery` and retries with a continuation request before ordinary guard retry.
- `context_compaction` requests use ordinary guard retry and skip continuation recovery.
- Standard guard retry and continuation recovery are exclusive handling branches for the same guarded hit. Standard guard retry sends the original request again. Continuation recovery sends a Responses continuation request built from encrypted reasoning state. Both branches consume the same guard retry budget and record one attempt action.
- Accepted SSE or JSON responses remove `encrypted_content` fields only when the proxy added `reasoning.encrypted_content` automatically.
- A guard match records `internal_retry` and retries the same upstream until the retry budget is used.
- The final guard match records `return_status_502` and returns local status `502` with code `reasoning_guard_triggered`.
- Transport errors record `upstream_error`.

The proxy writes each guard action as one JSON line in `~/.config/codex-tools/proxy.log`. Local proxy request errors also write JSONL events to the same event log.

## Status view

`ccs proxy` and `ccs proxy --once` print a full snapshot:

- Title line: `ccs proxy`, current time, runtime, pid, server version, protocol, proxy URL, and trailing refresh interval.
- Path lines: state, requests, events, runtime, and config paths.
- Summary line: `status total=... active=... 200=... 404=... 502=... upstreams=...`.
- Reasoning line: `reasoning total=... max=...` plus any non-zero `0=...`, `516=...`, `1034=...`, `1552=...`, and `other=...` groups. When continuation recovery activity exists, the line also renders `recovery=... recovered=... exhausted=...`.
- Latency line: `latency last=... avg=... min=... max=...`.
- `active`: up to 5 current requests rendered by the shared request-row formatter.
- `history`: completed requests rendered by the shared request-row formatter.

History row count follows these rules:

- TTY output computes the count from `process.stdout.rows` after title, path, summary, active, history header, and command footer lines are reserved.
- Tiny terminals can render zero history rows.
- Non-TTY output renders 5 history rows for deterministic piped output.
- `--history N` overrides adaptive sizing for `ccs proxy`, `ccs proxy --once`, and `ccs proxy watch`.
- `N` is a positive integer.
- Default rendering reads completed history from `proxy.json.metrics.recent_requests`.
- Explicit `--history N` reads `proxy.json.metrics.recent_requests` when the snapshot has enough rows.
- Explicit `--history N` reads the tail of `proxy-requests.jsonl` when `N` exceeds the snapshot length.

`ccs proxy watch` renders the same live status in the terminal alternate screen, repaints each frame from the home cursor position, clears rewritten lines and the remaining screen tail, hides the cursor while active, and restores the main screen on exit. The watch view keeps the proxy URL on the title line, omits path lines, and repaints immediately on terminal resize.

`status total` is the sum of exact status-code event counters from `proxy.json.metrics.recent_requests`. Each guard retry action contributes its observed upstream status, and each completed model API request contributes its final status unless the final local guard failure is already represented by a `return_status_502` action. Status counters render as exact HTTP codes in ascending numeric order and omit codes with zero count. Failed request records such as client aborts still keep their exact status code values. Unsupported paths are event-log facts and do not contribute status counters.

Continuation recovery counters use the same `proxy.json.metrics.recent_requests` window and the same `guard_actions` fact source. `recovery` counts `continuation_recovery` actions. `recovered` counts requests with at least one continuation recovery action that finish with an accepted status below `400`. `exhausted` counts requests with at least one continuation recovery action and a final `return_status_502` guard action.

`reasoning total` is the sum of explicit reasoning-token events from completed requests in `proxy.json.metrics.recent_requests`. Each guard action with `reasoning_tokens` contributes one event, and the final response `reasoning_tokens` contributes one event when present. A final local `502 reasoning_guard_triggered` records the last guarded value through its `return_status_502` action, so the matching request field does not add a second count for the same observation. `max` is the largest observed `reasoning_tokens` value and renders `-` when none have been observed. Reasoning counters render non-zero fixed groups: `0`, every guarded value from `REASONING_EQUALS`, and `other` for every remaining observed value. Guarded-value counts render red. The `0` count renders orange. `other` and non-guarded max values render green. Requests with reasoning text observations and absent explicit token counts do not increment `reasoning_token_counts`.

Request tables use the shared terminal table renderer. Fixed-width columns are right-aligned, and the final error column takes remaining width and is left-aligned. The visible data columns are:

```text
session time up reas./code lat. size model error
```

Active rows show elapsed time for `lat.`, known request bytes for `size`, and known upstream, status, reasoning metadata, and model fields as soon as the proxy observes them. `reas./code` renders `reasoning_tokens/status` when an explicit token count is present, `text/status` when reasoning text is observed with absent explicit token count, and `-/status` when reasoning metadata is absent. Examples include `516/200`, `text/200`, and `-/-`. A new retry attempt clears attempt-scoped status, reasoning metadata, and upstream model until that attempt observes fresh values. History rows show completed response bytes for `size`. Attempts greater than one are shown as a yellow number after the upstream name, such as `input3`; retry attempts use the same active upstream. `model` renders `request_model/upstream_model`. Missing request and upstream model fields render as `-`; matching request/upstream models render as `[same]`; differing upstream models render as the upstream model name. Examples include `gpt-5.5/-`, `gpt-5.5/[same]`, and `gpt-5.5/gpt-5.5-mini`. The `error` column starts with a bracketed local-action prefix when guard actions exist, then the request error text. Prefix entries render as `guard:<value>` for standard reasoning guard retry, `cap:<value>` for capacity retry, `rec:<value>` for Responses continuation recovery, `block:<value>` for final local guard failure, and `err:<value>` for upstream transport errors. The value is `reasoning_tokens` when present, HTTP status when present, or `-`; HTTP status entries are yellow and reasoning-token entries are red, such as `[guard:516 guard:516 block:516] reasoning_guard_triggered ...` and `[rec:1552]`. Request error text renders in the final left-aligned `error` column as one current-width line; request records keep the full text, and wider terminals show more visible content on the next render. Truncated table cells use the shared single-character ellipsis `…`. Time, latency, and size use compact 3-significant-digit units after the base unit, such as `56ms`, `2.34s`, `43.2s`, `3.12m`, `32.0K`, and `3.41M`.

## Implementation notes

- `metrics.active_requests` and `metrics.recent_requests` use the same request record type.
- Active records are normalized through the same request-record normalizer as history records.
- Status output builds active and history rows with one request-row formatter. The formatter derives pending or completed timing and byte display from `completed_at`.
- Persisted `active_requests` entries never survive a proxy restart. A new proxy process resets `active_requests` to `[]` before serving traffic.
- Current upstream display is derived from `profiles.current`; recent upstream hit counts remain visible through `upstream_hit_counts`.
- Completed model API requests append to `proxy-requests.jsonl` inside the serialized proxy metrics mutation queue, preserving completion order with the state snapshot update.
- State-file counters are recomputed from `metrics.recent_requests` after every completed request and when old state files are read.
- Status rendering reads JSONL through a reverse block tail reader only for explicit history counts that exceed the compact snapshot.

Local file paths in terminal output render relative to `$HOME` with `~/`.

## Model and reasoning metadata

Metadata extraction covers four concrete OpenAI-style paths:

- `/v1/chat/completions`
- `/v1/responses`
- `/chat/completions`
- `/responses`

The four paths map to two endpoint classes: `chat/completions` and `responses`.

### Field semantics

- `request_model`: model string read from the incoming request JSON body.
- `upstream_model`: model string read from the upstream response payload.
- `upstream_model_source`: extraction source for `upstream_model`, such as `json.model`, `json.response.model`, or `sse.data.model`.
- `reasoning_tokens`: latest explicit upstream reasoning token count.
- `reasoning_tokens_source`: JSON Pointer or SSE JSON Pointer that produced `reasoning_tokens`.
- `reasoning_text_observed`: boolean marker for observed reasoning text.
- `reasoning_text_source`: JSON Pointer or SSE JSON Pointer that produced the first observed reasoning text field.

The proxy forwards requests directly. Model fields are observational metadata only.

The proxy forwards request bodies at their original size. Runtime and upstream resources determine practical payload bounds.

The proxy does not set its own upstream response deadline. Client settings such as Codex `stream_idle_timeout_ms` own stream idle timeout behavior.

### Model extraction

| Path | Endpoint class | `request_model` | Non-stream `upstream_model` | Stream `upstream_model` |
| --- | --- | --- | --- | --- |
| `/v1/chat/completions` | `chat/completions` | request JSON `model` | response JSON `model` | SSE `model` |
| `/chat/completions` | `chat/completions` | request JSON `model` | response JSON `model` | SSE `model` |
| `/v1/responses` | `responses` | request JSON `model` | response JSON `response.model`, then response JSON `model` | SSE `response.model`, then SSE `model` |
| `/responses` | `responses` | request JSON `model` | response JSON `response.model`, then response JSON `model` | SSE `response.model`, then SSE `model` |

### Reasoning extraction

Explicit token count paths:

- `/usage/output_tokens_details/reasoning_tokens`
- `/usage/completion_tokens_details/reasoning_tokens`
- `/response/usage/output_tokens_details/reasoning_tokens`
- `/response/usage/completion_tokens_details/reasoning_tokens`

Reasoning text observation paths:

- `/choices/0/delta/reasoning_content`
- `/choices/0/message/reasoning_content`
- `/choices/0/delta/reasoning`
- `/choices/0/message/reasoning`
- `/delta/reasoning_content`
- `/message/reasoning_content`
- `/delta/reasoning`
- `/message/reasoning`
- `/output/0/content/0/reasoning`
- `/response/output/0/content/0/reasoning`

### Lifecycle integration

- Active request records include `request_model` after the request body is read.
- History request records include model metadata and reasoning metadata.
- Non-stream JSON responses are already buffered for inspection, so metadata extraction runs before response forwarding.
- SSE responses are fully buffered before client response headers, preserve accepted bytes, and scan SSE `data:` JSON frames for the first model value, latest explicit reasoning token count, and first reasoning text observation.
- Missing model fields are stored as `null`.

### Status view

The status table adds compact model visibility and preserves the command surface:

```text
session time up reas./code lat. size model error
```

- `model`: `request_model/upstream_model`, with each side truncated for terminal width. Missing values render dim `-`, matching upstream model renders dim `[same]`, and differing upstream model renders red.
- `reas./code`: explicit `reasoning_tokens`, `text` for observed reasoning text with absent token count, and HTTP status code. Missing reasoning metadata renders dim `-`; HTTP status keeps the existing status color.
- `lat.`: elapsed time for active rows and completed latency for history rows.
- Active rows follow the shared `model` rendering rules; SSE streams update active rows after the first model frame is observed.
- Retry attempts clear active-row `reas./code` and upstream model before the new attempt observes response metadata.
- History rows show status-normalized model fields.
- `up`: upstream name plus yellow attempt count when attempts are greater than one.
- `error`: optional bracketed local-action prefix from `guard_actions`, then request error text, left-aligned in the final remaining-width column and rendered as one current-width line.

### Tests

- Request JSON model is recorded for all four concrete paths.
- Non-stream JSON responses extract `upstream_model` for all four concrete paths when present.
- SSE responses extract `upstream_model` for all four concrete paths when present.
- Non-stream JSON and `application/*+json` responses extract explicit `reasoning_tokens` and `reasoning_tokens_source`.
- SSE responses keep the latest explicit `reasoning_tokens` value.
- GLM-style reasoning text fields render as `text/status` and leave token counters unchanged.
- SSE forwarding preserves the exact client-visible response bytes after strict guard buffering.
- Streaming Responses guard matches can recover through continuation when encrypted reasoning items are available.
- Continuation recovery uses the guard retry budget and returns `502 reasoning_guard_triggered` when the budget is exhausted.
- Context compaction requests are recorded with `request_kind=context_compaction` and use ordinary guard retry.
- Completed JSONL request records include `attempt_records`; compact state history omits them.
- The proxy selects only `profiles.current`; `profiles.toggle` entries are unused by proxy forwarding.
- Upstream `401`, `403`, `408`, `429`, and `5xx` responses are passed through with original status and body.
- Upstream capacity error bodies matching `Selected model is at capacity. Please try a different model.` retry the same upstream within the guard retry budget; ordinary `429` responses continue to pass through.
- Transport `fetch failed` is retried once and repeated failure returns `502 upstream_error/upstream_fetch_failed`.
- Non-stream JSON reasoning guard matches retry the same upstream and record `internal_retry`.
- SSE reasoning guard matches retry the same upstream after strict buffering and record `internal_retry`.
- Exhausted reasoning guard retry budget returns `502 reasoning_guard_triggered` and records `return_status_502`.
- Client aborts during strict SSE buffering complete history as `499`.
- Status tables display `reas./code` as one combined column.
- Reasoning token counts are persisted in `metrics.reasoning_token_counts` on the event basis and rendered as `reasoning total=... max=...` plus non-zero grouped counts.
- Guard actions are persisted in request history and written to `proxy.log`.
- Completed model API requests are appended to `proxy-requests.jsonl`; `metrics.recent_requests` remains capped at 100.
- Background stdout/stderr are written to `proxy-runtime.log`.
- Status history count follows TTY rows, non-TTY fixed 5, and explicit `--history N`.
- Watch repaints on terminal resize.
- Guard action prefixes render in the status table `error` column.
- Missing request and upstream model fields render as `-`, equal upstream models render as `[same]`, and differing upstream models render as model names.
- Status tables right-align fixed columns, left-align the final `error` column as one current-width line, and format time/size with compact 3-significant-digit units after the base unit.
- Existing active/history lifecycle, byte counts, session short id, status groups, and concurrent metrics tests continue to pass.

### Decisions

- Status table model column name is `model`.
- Stream model extraction stops at the first valid model value.
- Stream reasoning token extraction stores the latest explicit count.
- Reasoning text observations stay separate from token-count metrics.
