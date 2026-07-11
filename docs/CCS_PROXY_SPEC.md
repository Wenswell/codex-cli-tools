# ccs proxy spec

`ccs proxy` reports proxy runtime state and HTTP request state from `~/.cache/codex-tools/proxy/proxy.json`.

## Storage files

Proxy state lives under `~/.cache/codex-tools/proxy`:

- `proxy.json`: lightweight runtime state snapshot, counters, active model API requests, and the newest completed model API request snapshot.
- `proxy-requests.jsonl`: bounded completed model API request history up to 64M, one normalized request record per line in completion order.
- `proxy.log`: bounded guard, unsupported-path, upstream-error, and local proxy error events as JSONL up to 16M.
- `proxy-runtime.log`: bounded background process stdout and stderr up to 16M.
- `proxy.pid`: background process id.

## Route boundary

The proxy HTTP server separates local control traffic from model API forwarding.

Local control endpoints:

- `GET /__codex_proxy/health`

Health responses include `status`, `pid`, `version`, `protocol`, and `mode`. Health checks are handled before metrics and never enter request history.

Only these model API paths enter upstream forwarding and request metrics:

- `/responses`
- `/v1/responses`
- `/chat/completions`
- `/v1/chat/completions`

Unsupported paths return local `404` JSON with `code: "unsupported_proxy_path"`, write one `ccs_proxy_unsupported_path` event to `proxy.log`, and do not update `active_requests`, `recent_requests`, `proxy-requests.jsonl`, status counters, latency counters, reasoning counters, or upstream hit counters.

Proxy startup validates the health `protocol` from `/__codex_proxy/health`. A protocol mismatch records `ccs_proxy_protocol_restart` with `server_protocol`, `client_protocol`, and `pid`, stops that proxy process, and starts the current proxy. A remaining mismatch after restart is a startup error with a restart message.

## Request lifecycle

- A supported model API request enters `metrics.active_requests` after the proxy accepts the request.
- Active records use the same request record schema as history records. Pending-only fields use `null` or `0` until completion.
- Proxy process startup clears any persisted `metrics.active_requests` entries before accepting new requests.
- A request moves to `metrics.recent_requests` when the upstream response is fully written, the request fails, or the response stream ends.
- History records are the completed form of the same request record and include completion time, mode, status code, request kind, reasoning token count metadata, reasoning text observation metadata, upstream, proxy-internal attempts, client request attempt, latency, request bytes, response bytes, session short id, model metadata, guard actions, failure summary, and error text.
- `proxy-requests.jsonl` records include JSONL-only `attempt_records` with complete upstream attempt facts. `proxy.json.metrics.recent_requests` keeps compact records without `attempt_records`.
- Compact state history is written before the complete JSONL record append. JSONL append failures after client response completion are recorded in `proxy.log`, and the proxy keeps serving.
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
- `upstream_hit_counts`: status-event-basis upstream hit counts inside `recent_requests`, keyed by selected upstream name.
- `latency_ms`: completed request latency inside `recent_requests` with `last`, `count`, `sum`, `min`, and `max`.

Request records include:

- `schema_version`: request record schema version. Current value is `4`.
- `id`: local request id.
- `started_at`: request start timestamp.
- `completed_at`: completion timestamp for history records; `null` for active records.
- `mode`: proxy mode used for this request: `recovery`, `intercept`, or `passthrough`.
- `method`: HTTP method.
- `path`: request pathname.
- `status`: observed upstream or local response status.
- `upstream_status`: last observed upstream HTTP status.
- `client_status`: status returned to the local Codex client.
- `final_action`: canonical completed outcome such as `passed`, `upstream_error`, `blocked`, `upstream_fetch_failed`, `gateway_error`, or `client_aborted`.
- `failure_summary`: structured failure details with `type`, `code`, and `message`.
- `upstream`: selected profile name.
- `attempts`: upstream fetch attempt count.
- `latency_ms`: completed request latency.
- `upstream_wait_ms`: time from upstream fetch start to upstream headers for the final attempt.
- `time_to_first_chunk_ms`: streaming time from upstream fetch start to first upstream chunk for the final attempt.
- `stream_duration_ms`: streaming time from first upstream chunk to final upstream chunk for the final attempt.
- `request_bytes`: request body byte count.
- `response_bytes`: completed response body byte count.
- `session`: short Codex session id when present.
- `client_turn_id`: Codex turn id parsed from `x-codex-turn-metadata`.
- `client_request_attempt`: repeated local client request count for the same `client_turn_id` and `request_body_sha256` inside the compact state window. The first request is `1`.
- `request_kind`: `normal` or `context_compaction`.
- `request_model`: model string from the request body.
- `request_reasoning_effort`: reasoning effort string from the request body when present.
- `request_body_sha256`: SHA-256 hash of the incoming request body.
- `upstream_model`: model string from the accepted upstream payload.
- `upstream_model_source`: source path for `upstream_model`.
- `stream_model`: model string observed from SSE payloads when present.
- `final_response_model`: model string on the accepted or final response payload.
- `system_fingerprint`: upstream self-reported system fingerprint when present.
- `service_tier`: upstream self-reported service tier when present. Request and top-level config tiers are captured separately for per-attempt pricing attribution.
- `input_tokens`: explicit upstream input token count.
- `cached_input_tokens`: explicit cached input token count from Responses `input_tokens_details.cached_tokens` or Chat Completions `prompt_tokens_details.cached_tokens`.
- `reasoning_tokens`: latest explicit upstream reasoning token count.
- `reasoning_tokens_source`: source path for `reasoning_tokens`.
- `output_tokens`: explicit upstream output token count.
- `total_tokens`: explicit upstream total token count.
- `usage_attempts`: one compact usage and pricing-attribution entry for every proxy-owned upstream attempt.
- `reasoning_text_observed`: true when a supported reasoning text field is present and non-empty.
- `reasoning_text_source`: source path for the first observed reasoning text field.
- `has_commentary`: true when the upstream payload contains commentary output.
- `has_final_answer`: true when the upstream payload contains final-answer output.
- `final_answer_only`: true when the upstream payload contains only final-answer output.
- `has_tool_call`: true when the upstream payload contains a tool call.
- `has_reasoning_item`: true when the upstream payload contains a reasoning item.
- `guard_actions`: ordered local proxy action records.
- `retry_summary`: retry counters by `reasoning_guard`, `upstream_capacity`, and `transport`.
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

`attempt_records` entries include `attempt`, `started_at`, `headers_at`, `completed_at`, `duration_ms`, `upstream`, `upstream_status`, timing fields, upstream model fields, upstream metadata, `input_tokens`, `cached_input_tokens`, `output_tokens`, `total_tokens`, reasoning metadata, response shape fields, per-attempt `final_action`, `failure_summary`, and `remaining_retries`.

Each compact `usage_attempts` entry stores `attempt`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `pricing_model`, `pricing_model_source`, `pricing_tier`, and `pricing_tier_source`. Every detailed attempt projects exactly once, including attempts without usage and passthrough responses that expose usage. Pricing model uses upstream model first and request model second. Pricing tier uses response `service_tier`, request `service_tier`, then the top-level config value captured when the request starts.

`proxy-requests.jsonl` stores JSONL-only `request_headers` with whitelisted sanitized request headers. Secret-bearing headers, prompt text, and response text stay outside request records.

Request schema version `4` and health protocol version `4` are the sole supported contracts.

## Upstream forwarding

The proxy resolves one active upstream from `profiles.current` for each client request. `ccs toggle` owns profile switching by changing `profiles.current`; the proxy reads that current value when forwarding a new request.

The proxy owns upstream authentication in proxy mode. It removes incoming `Authorization`, `api-key`, and `x-api-key` headers, then sets `Authorization: Bearer <current profile apiKey>` before the upstream request. This keeps already-running Codex CLI processes on the local proxy URL while new requests use the API key from the latest `profiles.current`. A current profile without `apiKey` is a configuration error and the proxy fails the request before contacting upstream.

`ccs proxy install` requires absent proxy state and an explicit `model_provider` with an existing `base_url`. Its preview captures the source config, provider, current URL, proxy URL, and backup path. Apply rejects source changes after preview, backs up the config, starts and health-checks the proxy in `passthrough` mode, changes only the routed provider's `base_url`, and verifies the exact target content. Intervention begins only after an explicit `ccs proxy mode recovery` or `ccs proxy mode intercept` command.

`ccs proxy mode recovery` enables continuation recovery for eligible streaming Responses guard hits and uses ordinary guard retry when recovery is unavailable. `ccs proxy mode intercept` disables continuation recovery and uses ordinary guard retry. `ccs proxy stop` switches to `passthrough`, keeps the proxy URL active, and forwards original client request bodies and upstream responses without reasoning guard retries, continuation recovery, response body stripping, capacity retries, or transport retries.

`ccs proxy restore` resolves `profiles.current` while building its preview and targets that profile's `baseURL`. Apply rejects config or proxy-state changes after preview, backs up the current config, changes and verifies only `state.provider_name`'s `base_url`, then stops the proxy and removes state. Install and restore backups remain available. Every other TOML field, `profiles.json`, and authentication data remain unchanged.

Upstream HTTP responses are upstream facts. In `recovery` and `intercept` modes, the proxy returns the original upstream status and body when the local reasoning guard accepts the response, including `401`, `403`, `408`, `429`, and `5xx`. Upstream `4xx` and `5xx` responses record `final_action=upstream_error`, `failure_summary.type=upstream_error`, and `error=null`. JSON error bodies populate `failure_summary.code/message`; non-JSON error bodies use `upstream_http_<status>` and `upstream returned HTTP <status>`.

In `recovery` and `intercept` modes, upstream capacity errors are a narrow retryable HTTP-response case. When an upstream error response body contains `Selected model is at capacity. Please try a different model.`, or contains both `selected model is at capacity` and `try a different model` case-insensitively, the proxy records `internal_retry` with `error: upstream_capacity`, retries the same upstream, and uses the same retry budget as the reasoning guard. Ordinary `429`, `502`, and `5xx` responses without that text stay upstream facts and pass through unchanged. If every capacity retry is exhausted, the final upstream status and body pass through unchanged.

In `recovery` and `intercept` modes, transport-level `TypeError: fetch failed` is retried once for the same upstream. A repeated transport failure returns local status `502` with error type `upstream_error`, code `upstream_fetch_failed`, and a request `guard_actions` entry with action `upstream_error`. In `passthrough` mode, transport failure returns one local upstream error response without an internal retry.

`attempts` counts upstream fetch attempts inside one proxy-handled client request. It includes the initial fetch, the single transport retry when used, upstream capacity retries, and reasoning-guard retry fetches. `retry_summary` counts these proxy-internal retries. `client_request_attempt` counts repeated Codex client requests with the same turn id and request body hash inside the compact state window.

## Reasoning guard

The reasoning guard is active in `recovery` and `intercept` modes for supported JSON and SSE response payloads. `passthrough` forwards the original response without guard decisions, retries, blocking, or rewriting. A response clone is inspected after forwarding begins solely to record model, usage, reasoning, and response-shape metadata.

- `reasoning_equals`: `516`, `1034`, `1552`.
- `guard_retry_attempts`: `3`.
- Non-stream JSON and `application/*+json` responses are buffered, parsed, and checked before being forwarded.
- SSE responses are buffered before client response headers are written. SSE `data:` JSON frames are scanned for model metadata, explicit `reasoning_tokens`, and reasoning text observations; accepted SSE bytes are then forwarded unchanged.
- In `recovery` mode, streaming Responses requests with `request_kind=normal` automatically request `reasoning.encrypted_content` when the client request does not include it.
- In `recovery` mode, a guarded streaming Responses match with collected encrypted reasoning items records `continuation_recovery` and retries with a continuation request before ordinary guard retry.
- `intercept` mode and `context_compaction` requests use ordinary guard retry and skip continuation recovery.
- Standard guard retry and continuation recovery are exclusive handling branches for the same guarded hit. Standard guard retry sends the original request again. Continuation recovery sends a Responses continuation request built from encrypted reasoning state. Both branches consume the same guard retry budget and record one attempt action.
- Accepted SSE or JSON responses remove `encrypted_content` fields only in `recovery` mode when the proxy added `reasoning.encrypted_content` automatically.
- A guard match records `internal_retry` and retries the same upstream until the retry budget is used.
- The final guard match records `return_status_502` and returns local status `502` with code `reasoning_guard_triggered`.
- Transport errors record `upstream_error`.

The proxy writes each guard action as one JSON line in `~/.cache/codex-tools/proxy/proxy.log`. Local proxy request errors also write JSONL events to the same event log.

## Status view

`ccs proxy` and `ccs proxy --once` print a full snapshot:

- Title line: labeled `ccs proxy`, current `HH:mm:ss` time, runtime, mode, pid, server version, protocol, proxy URL, and trailing refresh interval.
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

`ccs proxy watch` renders the same live status in the terminal alternate screen, repaints each frame from the home cursor position, clears rewritten lines and the remaining screen tail, hides the cursor while active, and restores the main screen on exit. The watch view keeps the proxy URL on the title line, omits path lines, and repaints immediately on terminal resize. Its footer shows the current view and `v view  q/Ctrl-C exit`. `--view overview|tokens|cost` selects the initial view. In a TTY, `v` cycles `overview -> tokens -> cost -> overview`; `q` and `Ctrl-C` exit cleanly.

`status total` is the sum of exact status-code event counters from `proxy.json.metrics.recent_requests`. Each guard retry action contributes its observed upstream status, and each completed model API request contributes its final status unless the final local guard failure is already represented by a `return_status_502` action. Upstream hit counters use the same event basis and count the upstream attached to each counted guard action or final response when present. Status counters render as exact HTTP codes in ascending numeric order and omit codes with zero count. Failed request records such as client aborts still keep their exact status code values. Unsupported paths are event-log facts and do not contribute status counters.

Continuation recovery counters use the same `proxy.json.metrics.recent_requests` window and the same `guard_actions` fact source. `recovery` counts `continuation_recovery` actions. `recovered` counts requests with at least one continuation recovery action that finish with an accepted status below `400`. `exhausted` counts requests with at least one continuation recovery action and a final `return_status_502` guard action.

`reasoning total` is the sum of explicit reasoning-token events from completed requests in `proxy.json.metrics.recent_requests`. Each guard action with `reasoning_tokens` contributes one event, and the final response `reasoning_tokens` contributes one event when present. A final local `502 reasoning_guard_triggered` records the last guarded value through its `return_status_502` action, so the matching request field does not add a second count for the same observation. `max` is the largest observed `reasoning_tokens` value and renders `-` when none have been observed. Reasoning counters render non-zero fixed groups: `0`, every guarded value from `REASONING_EQUALS`, and `other` for every remaining observed value. Guarded-value counts render red. The `0` count and `recovery` count render yellow. `other` and non-guarded max values render green. Requests with reasoning text observations and absent explicit token counts do not increment `reasoning_token_counts`.

Request tables use the shared terminal table renderer. Fixed-width columns are right-aligned, and the final error column takes remaining width and is left-aligned. `overview` is the default. The three visible column sets are:

```text
overview  session time up model reas./code lat. size error
tokens    session time up model input output cached error
cost      session time up model input$ output$ cached$ total$ error
```

The model column is 10 cells wide and describes the current or final attempt. Missing request and upstream models render dim `-`. A request-only or upstream-only model renders normally. Equal raw values render the upstream model green; different raw values render the actual upstream model red. Comparison precedes `gpt-` to `o` abbreviation and truncation, so raw `gpt-5.6-sol` and `o5.6-sol` display the same abbreviated text in red.

Token and cost columns aggregate all `usage_attempts`; the model column remains attempt-local. `input` sums `input_tokens - cached_input_tokens` for every attempt, matching the `input$` pricing basis. `cached` sums cached input separately. A token column renders only when every attempt has the fields required by that calculation, then uses decimal `K` with at most one decimal place. Cached input above input tokens renders `input` as `invalid`. Missing attempt data renders dim `-`.

Cost lookup reads the local model price cache once per frame, applies `profiles.json` overrides, and performs no network refresh. Each attempt uses its stored exact pricing model and normalized tier: `default|standard` selects standard pricing and `fast|priority` selects fast pricing. Input cost subtracts cached input before applying input price; cached and output components use their own prices. Components sum unrounded attempt values and format once. Missing usage, unsupported tiers, or missing prices render the affected component and total as `-`. Cached input above input tokens renders input and total as `invalid`. USD values render as `$0`, `<$0.0001`, up to four decimals below `$0.01`, and two decimals from `$0.01`.

Active overview rows show elapsed time for `lat.`, known request bytes for `size`, and observed attempt facts. `session` uses a stable small bright palette. `reas./code` renders `reasoning_tokens/status`, `text/status`, or `-/status`. History overview rows show completed response bytes. Proxy-internal attempts greater than one append a yellow count to the upstream name. The `error` column retains client and guard prefixes plus full stored error details, truncated only for the current terminal width. Time, latency, and size retain compact three-significant-digit units.

## Implementation notes

- `metrics.active_requests` and `metrics.recent_requests` use the same request record type.
- Active records are normalized through the same request-record normalizer as history records.
- Status output builds active and history rows with one request-row formatter. The formatter derives pending or completed timing and byte display from `completed_at`.
- Persisted `active_requests` entries never survive a proxy restart. A new proxy process resets `active_requests` to `[]` before serving traffic.
- Current upstream display is derived from `profiles.current`; recent upstream hit counts remain visible through `upstream_hit_counts`.
- Completed model API requests append to bounded `proxy-requests.jsonl` inside the serialized proxy metrics mutation queue, preserving completion order with the state snapshot update.
- State-file counters are recomputed from `metrics.recent_requests` after every completed request and when state files are read.
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
- `request_reasoning_effort`: reasoning effort string read from `reasoning.effort` or `reasoning_effort` in the incoming request JSON body.
- `upstream_model`: model string read from the upstream response payload.
- `upstream_model_source`: extraction source for `upstream_model`, such as `json.model`, `json.response.model`, or `sse.data.model`.
- `stream_model`: model string first observed from SSE payloads.
- `final_response_model`: model string on the accepted or final response payload.
- `system_fingerprint`: upstream self-reported `system_fingerprint`.
- `service_tier`: upstream self-reported `service_tier`.
- `input_tokens`, `cached_input_tokens`, `output_tokens`, and `total_tokens`: explicit upstream usage token fields. Cached input remains `null` when the upstream omits or reports an invalid value.
- `reasoning_tokens`: latest explicit upstream reasoning token count.
- `reasoning_tokens_source`: JSON Pointer or SSE JSON Pointer that produced `reasoning_tokens`.
- `reasoning_text_observed`: boolean marker for observed reasoning text.
- `reasoning_text_source`: JSON Pointer or SSE JSON Pointer that produced the first observed reasoning text field.
- `has_commentary`, `has_final_answer`, `final_answer_only`, `has_tool_call`, and `has_reasoning_item`: response shape booleans stored for anomaly analysis.

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

- `/usage/input_tokens`
- `/usage/prompt_tokens`
- `/usage/input_tokens_details/cached_tokens`
- `/usage/prompt_tokens_details/cached_tokens`
- `/usage/output_tokens`
- `/usage/completion_tokens`
- `/usage/total_tokens`
- `/usage/output_tokens_details/reasoning_tokens`
- `/usage/completion_tokens_details/reasoning_tokens`
- `/response/usage/input_tokens`
- `/response/usage/prompt_tokens`
- `/response/usage/input_tokens_details/cached_tokens`
- `/response/usage/prompt_tokens_details/cached_tokens`
- `/response/usage/output_tokens`
- `/response/usage/completion_tokens`
- `/response/usage/total_tokens`
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
- History request records include model metadata, usage metadata, and reasoning metadata.
- Non-stream JSON responses are already buffered for inspection, so metadata extraction runs before response forwarding.
- SSE responses are fully buffered before client response headers, preserve accepted bytes, and scan SSE `data:` JSON frames for the first model value, latest explicit usage token counts, latest explicit reasoning token count, and first reasoning text observation.
- Compact request state and completed JSONL request records preserve one `usage_attempts` projection for every detailed attempt. JSONL-only `attempt_records` retain the complete per-attempt facts.
- Missing model fields are stored as `null`.

### Status view

The status command provides three request-table views:

```text
overview  session time up model reas./code lat. size error
tokens    session time up model input output cached error
cost      session time up model input$ output$ cached$ total$ error
```

- `model`: current/final actual model in 10 cells; equal request/upstream values are green, differing actual upstream values are red, and missing values are dim.
- `reas./code`: explicit `reasoning_tokens`, `text` for observed reasoning text with absent token count, and HTTP status code. Missing reasoning metadata renders dim `-`; HTTP status keeps the existing status color.
- `lat.`: elapsed time for active rows and completed latency for history rows.
- Token columns require the field from every attempt and sum all attempt values.
- Cost columns calculate each attempt with its own model and tier, sum full-precision values, and format once.
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
- JSON and SSE responses extract cached input from the four supported usage paths and keep the latest valid SSE value.
- Missing and invalid cached input values normalize to `null`; zero remains a valid explicit token count.
- Compact state, completed JSONL records, and per-attempt JSONL records preserve cached input values.
- GLM-style reasoning text fields render as `text/status` and leave token counters unchanged.
- SSE forwarding preserves the exact client-visible response bytes after strict guard buffering.
- Repeated transport `fetch failed` keeps `guard_actions[].status` as `null` and renders the terminal prefix with the final local request status, such as `[err:502 err:502]`.
- Streaming Responses guard matches can recover through continuation when encrypted reasoning items are available.
- Continuation recovery uses the guard retry budget and returns `502 reasoning_guard_triggered` when the budget is exhausted.
- `intercept` mode disables continuation recovery and uses ordinary guard retry.
- `ccs proxy stop` switches to `passthrough` and forwards guarded upstream responses without guard actions.
- Context compaction requests are recorded with `request_kind=context_compaction` and use ordinary guard retry.
- Completed JSONL request records include `attempt_records`; compact state history omits them.
- Compact state history is updated before appending the complete JSONL request record.
- The proxy selects only `profiles.current`; `profiles.toggle` entries are unused by proxy forwarding.
- Upstream `401`, `403`, `408`, `429`, and `5xx` responses are passed through with original status and body and recorded as `upstream_error` failures.
- Upstream capacity error bodies matching `Selected model is at capacity. Please try a different model.` retry the same upstream within the guard retry budget; ordinary `429` responses continue to pass through.
- Transport `fetch failed` is retried once and repeated failure returns `502 upstream_error/upstream_fetch_failed`.
- Non-stream JSON reasoning guard matches retry the same upstream and record `internal_retry`.
- SSE reasoning guard matches retry the same upstream after strict buffering and record `internal_retry`.
- Exhausted reasoning guard retry budget returns `502 reasoning_guard_triggered` and records `return_status_502`.
- Client aborts during strict SSE buffering complete history as `499`.
- Status tables display `reas./code` as one combined column.
- Reasoning token counts are persisted in `metrics.reasoning_token_counts` on the event basis and rendered as `reasoning total=... max=...` plus non-zero grouped counts.
- Guard actions are persisted in request history and written to `proxy.log`.
- Completed model API requests are appended to bounded `proxy-requests.jsonl`; `metrics.recent_requests` remains capped at 100.
- Background stdout/stderr are written to `proxy-runtime.log`.
- Status history count follows TTY rows, non-TTY fixed 5, and explicit `--history N`.
- Watch repaints on terminal resize.
- Guard action prefixes render in the status table `error` column.
- Model rendering covers missing, request-only, upstream-only, equal, different, raw comparison before abbreviation, width, and ANSI color semantics.
- Token rendering covers missing attempt data, zero, decimal `K` boundaries, and the confirmed `999.9K` maximum.
- Cost rendering covers per-attempt model and tier selection, cached subtraction, missing facts and prices, invalid cached counts, standard and fast prices, full-precision sums, and adaptive USD output.
- Status tables right-align fixed columns, left-align the final `error` column as one current-width line, and format time/size with compact 3-significant-digit units after the base unit.
- Existing active/history lifecycle, byte counts, session short id, status groups, and concurrent metrics tests continue to pass.

### Decisions

- Status table model column name is `model`.
- Stream model extraction stops at the first valid model value.
- Stream reasoning token extraction stores the latest explicit count.
- Reasoning text observations stay separate from token-count metrics.
