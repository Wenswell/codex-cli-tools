# ccs proxy request log plan

## Goal

Upgrade `ccs proxy` request history from compact operational records to complete request samples for debugging and analysis.

## Status

Confirmed implementation plan. Current runtime records remain compact operational records; bounded request history, event logging, runtime logging, and status rendering are implemented in the current CLI. This plan defines the next request-record contract.

Implementation starts with documentation and tests, then updates the runtime schema. The command surface stays unchanged.

The plan keeps one source of truth for completed model API requests:

- `proxy-requests.jsonl`: bounded completed request stream with complete request records.
- `proxy.json.metrics.recent_requests`: newest compact status window.
- `proxy.log`: event stream for guard actions, unsupported paths, upstream errors, and local proxy errors.

## Decisions

- Use one current schema for completed proxy request records.
- Preserve observable facts from the proxy boundary. Hidden client state belongs to a separate design.
- Store request headers through an explicit whitelist and redact secret-bearing values.
- Store complete request samples only in bounded `proxy-requests.jsonl`.
- Keep `proxy.json.metrics.recent_requests` as the lightweight live status view.
- Use `final_action` only for the final client-visible result.
- Store retry process details in `retry_summary`, `attempt_records`, and existing `guard_actions`.
- Store request body hash and size. Prompt text and response text stay absent from records.
- Store upstream self-reported metadata when it appears in JSON or SSE payloads.
- Store response-shape booleans as normalized facts for anomaly analysis.
- Defer local Codex config model fields to a separate design because proxy request handling currently observes request bodies, active profile, and upstream responses.

## Scope

Included:

- Request outcome classification.
- Upstream/client status separation.
- Structured failure summaries.
- Per-attempt facts for retries.
- Timing facts for upstream wait and streaming.
- Request body hash and sanitized header summary.
- Token usage facts when upstream returns explicit usage fields.
- Upstream self-reported model, fingerprint, and service-tier facts.
- Response structure facts for accepted, retried, and blocked responses.
- Documentation and tests for the new request record schema.

Excluded:

- Install entrypoints.
- Interactive UI.
- Codex config parsing.
- Active probes.
- Experimental intercept rules such as `final_answer_only_high_xhigh`.
- Request body excerpt storage unless explicitly approved.
- Local Codex config model inference such as `local_config_model` and `effective_local_model`.

## Current State

Current request records contain compact runtime facts:

- `id`
- `started_at`
- `completed_at`
- `method`
- `path`
- `status`
- `upstream`
- `attempts`
- `latency_ms`
- `request_bytes`
- `response_bytes`
- `session`
- `request_model`
- `upstream_model`
- `upstream_model_source`
- `reasoning_tokens`
- `reasoning_tokens_source`
- `reasoning_text_observed`
- `reasoning_text_source`
- `guard_actions`
- `error`

This is enough for terminal status and recent-history display. It is weaker for debugging because important facts must be inferred from `status`, `error`, and `guard_actions`.

## Target Schema

Add these request record fields:

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | `number` | Request record schema version. Start at `2`. |
| `final_action` | `string` | Canonical completed outcome. |
| `upstream_status` | `number \| null` | Last observed upstream HTTP status. |
| `client_status` | `number \| null` | Status returned to the local Codex client. |
| `failure_summary` | `object \| null` | Structured failure details. |
| `request_kind` | `string` | Request classification: `normal` or `context_compaction`. |
| `request_reasoning_effort` | `string \| null` | Reasoning effort requested in the incoming JSON body when present. |
| `request_body_sha256` | `string \| null` | SHA-256 of the incoming request body. |
| `request_headers` | `object \| null` | Whitelisted and sanitized request headers. JSONL only. |
| `stream_model` | `string \| null` | Upstream model observed from SSE payloads when present. |
| `final_response_model` | `string \| null` | Upstream model on the accepted or final response payload. |
| `system_fingerprint` | `string \| null` | Upstream self-reported system fingerprint when present. |
| `service_tier` | `string \| null` | Upstream self-reported service tier when present. |
| `upstream_wait_ms` | `number \| null` | Time from upstream fetch start to upstream headers. |
| `time_to_first_chunk_ms` | `number \| null` | Streaming time from upstream fetch start to first chunk. |
| `stream_duration_ms` | `number \| null` | Streaming time from first chunk to final chunk. |
| `input_tokens` | `number \| null` | Explicit upstream input token count. |
| `reasoning_tokens` | `number \| null` | Explicit upstream reasoning token count. Existing field retained. |
| `output_tokens` | `number \| null` | Explicit upstream output token count. |
| `total_tokens` | `number \| null` | Explicit upstream total token count. |
| `has_commentary` | `boolean` | Upstream payload contains commentary-phase output. |
| `has_final_answer` | `boolean` | Upstream payload contains final-answer output. |
| `final_answer_only` | `boolean` | Upstream payload contains only final-answer output. |
| `has_tool_call` | `boolean` | Upstream payload contains tool-call output. |
| `has_reasoning_item` | `boolean` | Upstream payload contains a reasoning item. |
| `retry_summary` | `object` | Retry counters by retry reason. |
| `attempt_records` | `array` | Ordered upstream attempt facts. JSONL only. |

Keep existing fields that serve terminal display:

- `status`
- `error`
- `guard_actions`
- `latency_ms`
- `reasoning_tokens`
- `reasoning_text_observed`
- model fields
- byte fields

## Record Shapes

`proxy-requests.jsonl` stores bounded completed records with complete request fields:

- all display fields
- request kind
- new status and failure fields
- request body hash
- whitelisted request headers
- usage token fields
- upstream self-reported metadata fields
- response shape fields
- timing fields
- retry summary
- attempt records

`proxy.json.metrics.recent_requests` stores lightweight completed records for live status:

- all display fields
- `request_kind`
- `schema_version`
- `final_action`
- `upstream_status`
- `client_status`
- `failure_summary`
- `request_body_sha256`
- upstream self-reported metadata fields
- response shape fields
- timing fields
- usage token fields
- `retry_summary`

`attempt_records` and `request_headers` stay out of `proxy.json` to keep watch-mode state writes and reads small.

## final_action Values

Use one canonical value per completed request:

| Value | Meaning |
|---|---|
| `passed` | Upstream response accepted and returned to the client. |
| `blocked` | Guard retry budget exhausted and proxy returned local guard failure. |
| `upstream_fetch_failed` | Transport fetch failed after retry. |
| `request_rejected` | Local proxy rejected the request before upstream fetch. |
| `gateway_error` | Local proxy error outside known categories. |
| `client_aborted` | Client closed the response before completion. |

`final_action` is the primary machine field. `error` remains a display string.

Retry history does not change `final_action`. A capacity retry followed by a successful upstream response has `final_action=passed` and `retry_summary.upstream_capacity > 0`. A reasoning guard retry followed by a successful upstream response has `final_action=passed` and `retry_summary.reasoning_guard > 0`.

## retry_summary

Use retry counters on every completed record:

```json
{
  "total": 3,
  "reasoning_guard": 0,
  "upstream_capacity": 3,
  "transport": 0
}
```

Rules:

- `total` is the sum of retry attempts after the first upstream attempt.
- `reasoning_guard` counts local reasoning guard retries.
- `upstream_capacity` counts upstream capacity error retries.
- `transport` counts transport retries after `fetch failed`.
- Exhausted guard retries use `final_action=blocked`.
- Exhausted transport retries use `final_action=upstream_fetch_failed`.
- Capacity retries that exhaust and then pass through the final upstream response use `final_action=passed`; the final upstream status remains visible through `upstream_status` and `client_status`.

## failure_summary

Use a structured object:

```json
{
  "type": "upstream_error",
  "code": "upstream_fetch_failed",
  "message": "fetch failed"
}
```

Extraction rules:

- If upstream JSON contains `error.type`, `error.code`, or `error.message`, copy those values.
- If local code creates the failure, write local `type`, `code`, and `message`.
- Keep `message` concise.
- Keep the full request record in bounded `proxy-requests.jsonl`; terminal display still uses `error`.

## Upstream Metadata

Record self-reported upstream metadata from JSON responses and SSE `data:` JSON payloads:

- `upstream_model`: current display model field, kept for status rendering.
- `stream_model`: first model observed from SSE stream payloads.
- `final_response_model`: model on the accepted or final response payload.
- `system_fingerprint`: string from `system_fingerprint`.
- `service_tier`: string from `service_tier`.

For Responses payloads, model extraction keeps the existing priority: `response.model`, then top-level `model`. For chat completion payloads, model extraction reads top-level `model`.

## Usage Tokens

Store explicit non-negative integer token fields only:

- `input_tokens`
- `reasoning_tokens`
- `output_tokens`
- `total_tokens`

Supported source shapes include OpenAI-compatible `usage` fields for Responses and chat completions:

- `usage.input_tokens`
- `usage.prompt_tokens`
- `usage.output_tokens`
- `usage.completion_tokens`
- `usage.total_tokens`
- `usage.output_tokens_details.reasoning_tokens`
- `usage.completion_tokens_details.reasoning_tokens`
- the same fields under `response.usage`

Status reasoning counters continue to use explicit `reasoning_tokens` events only.

## Response Shape

Store response shape booleans for accepted, retried, and blocked attempts:

- `has_commentary`
- `has_final_answer`
- `final_answer_only`
- `has_tool_call`
- `has_reasoning_item`

Shape extraction reads structured output items, chat messages, tool call arrays, and Responses event payloads. It stores booleans only. Response text and prompt text stay absent from logs.

## attempt_records

Use one entry per upstream fetch attempt:

```json
{
  "attempt": 1,
  "upstream": "input",
  "started_at": "2026-07-03T00:00:00.000Z",
  "headers_at": "2026-07-03T00:00:00.120Z",
  "upstream_status": 429,
  "upstream_wait_ms": 120,
  "time_to_first_chunk_ms": null,
  "stream_duration_ms": null,
  "input_tokens": null,
  "reasoning_tokens": null,
  "output_tokens": null,
  "total_tokens": null,
  "reasoning_tokens_source": null,
  "reasoning_text_observed": false,
  "upstream_model": null,
  "system_fingerprint": null,
  "service_tier": null,
  "has_commentary": false,
  "has_final_answer": false,
  "final_answer_only": false,
  "has_tool_call": false,
  "has_reasoning_item": false,
  "guard_action": "internal_retry",
  "failure_summary": {
    "type": "upstream_error",
    "code": "model_at_capacity",
    "message": "Selected model is at capacity. Please try a different model."
  }
}
```

`guard_actions` stays as the compact display/event list. `attempt_records` stores complete attempt facts for analysis.

Attempt `final_action` values include `passed`, `internal_retry`, `continuation_recovery`, `upstream_capacity_internal_retry`, `transport_retry`, `blocked`, `upstream_fetch_failed`, `upstream_error`, `client_aborted`, and `gateway_error`.

Attempt records store the same upstream metadata, usage token, response shape, and timing fields as the request record when those facts are observed during that attempt.

## Header Sanitization

Persist whitelisted sanitized request headers in `request_headers`.

Allowed headers:

- `content-type`
- `accept`
- `user-agent`
- `x-codex-request-kind`
- `x-codex-purpose`
- `x-codex-turn-metadata`
- `x-codex-beta-features`
- `openai-organization`
- `openai-project`

Always redact if present:

- `authorization`
- `api-key`
- `x-api-key`
- `cookie`
- `set-cookie`
- `proxy-authorization`

Do not persist arbitrary request headers. Add new headers to the whitelist only when they have debugging value and no secret risk.

## Request Body Storage

Default plan:

- Store `request_body_sha256`.
- Store `request_bytes`.
- Continue extracting `session` and `request_model`.
- Request body text stays outside records.
- Prompt excerpts stay outside records.

This gives stable correlation while prompt content stays outside records.

## Timing Facts

Record:

- `latency_ms`: existing full request duration.
- `upstream_wait_ms`: upstream header wait time.
- `time_to_first_chunk_ms`: streaming first-chunk wait time.
- `stream_duration_ms`: stream body duration.

These fields help distinguish:

- upstream connection delay
- upstream generation delay
- local write/client abort behavior
- guard buffering time

## Implementation Plan

1. Update docs for the confirmed schema.
   - Mark this plan as active.
   - Update `CCS_PROXY_SPEC.md`.
   - Update `README.md`.

2. Add tests for the v2 record contract.
   - Request record fixture fields.
   - Attempt record fixture fields.
   - Compact state record excludes JSONL-only fields.
   - Prompt and response text stay absent.

3. Update request record types and normalization.
   - Add schema version and new nullable fields.
   - Define complete JSONL records and compact state records.
   - Keep one direct normalizer path for each record shape.

4. Add request summary helpers.
   - `hashRequestBody(body)`.
   - `sanitizeWhitelistedRequestHeaders(headers)`.
   - `buildFailureSummary(error, upstreamPayload)`.
   - `createAttemptRecord(...)`.
   - `createRetrySummary(...)`.

5. Add lifecycle timestamps.
   - Request start.
   - Upstream fetch start per attempt.
   - Upstream headers observed.
   - First stream chunk.
   - Final stream chunk.
   - Completion.

6. Add upstream metadata extraction.
   - Model facts.
   - `system_fingerprint`.
   - `service_tier`.

7. Add usage token extraction.
   - Responses usage shape.
   - Chat completions usage shape.
   - SSE `data:` usage shape.

8. Add response shape extraction.
   - Commentary output.
   - Final-answer output.
   - Tool calls.
   - Reasoning items.

9. Fill `final_action`.
   - Accepted response without retry: `passed`.
   - Accepted response after retry: `passed`.
   - Exhausted guard: `blocked`.
   - Repeated fetch failure: `upstream_fetch_failed`.
   - Client abort: `client_aborted`.
   - Local unclassified error: `gateway_error`.

10. Fill `retry_summary`.
   - Increment reasoning guard retry count when a guard match triggers retry.
   - Increment upstream capacity retry count when a capacity response triggers retry.
   - Increment transport retry count when fetch failed is retried.
   - Keep `total` equal to the sum of retry counters.

11. Fill `attempt_records`.
   - Append at attempt start.
   - Update on upstream response status.
   - Update on observed model and reasoning metadata.
   - Update on observed usage tokens, upstream metadata, response shape, and timing.
   - Update on guard action or transport failure.
   - Persist only in bounded `proxy-requests.jsonl`.

12. Keep display stable.
   - Existing status table continues using `status`, `error`, `guard_actions`, model fields, reasoning fields, bytes, and latency.
   - New fields are stored for analysis and JSON inspection.

13. Add behavior tests.
   - Accepted upstream response records `final_action=passed`.
   - Capacity retry then success records `final_action=passed` and `retry_summary.upstream_capacity > 0`.
   - Reasoning guard retry then success records `final_action=passed` and `retry_summary.reasoning_guard > 0`.
   - Exhausted reasoning guard records `final_action=blocked`.
   - Repeated transport failure records `final_action=upstream_fetch_failed`.
   - Client abort records `final_action=client_aborted`.
   - Plain upstream `429` passthrough records upstream/client status correctly.
   - Header sanitization redacts secrets and preserves useful headers.
   - Request body hash is stable and prompt text is absent.
   - Usage token fields parse from JSON and SSE usage payloads.
   - Response shape booleans parse from Responses and chat completion payloads.
   - Timing fields are present with numeric values when observable.

14. Build and verify.
   - `pnpm build`
   - `pnpm test`
   - Inspect representative `proxy-requests.jsonl` fixture output through tests.

## Acceptance Criteria

- `proxy-requests.jsonl` contains complete request records for recent completed model API requests.
- `proxy.json.metrics.recent_requests` stores compact request records without `attempt_records` or `request_headers`.
- Each completed record has `schema_version=2`.
- Each completed record has a non-pending `final_action`.
- `upstream_status` and `client_status` are explicit.
- Upstream self-reported `system_fingerprint` and `service_tier` are stored when present.
- Usage token fields are stored when upstream returns explicit usage values.
- Response shape booleans are present on completed request records and attempt records.
- Timing fields are present on completed request records and attempt records.
- Local failure records have `failure_summary`.
- Upstream JSON errors are preserved in `failure_summary`.
- Secret headers are redacted.
- Only whitelisted request headers are persisted.
- Request body text is absent from logs.
- `request_body_sha256` is present for completed records whose body was read.
- `retry_summary.total` equals the sum of retry counters.
- Complete attempt facts are available in JSONL records.
- Existing status rendering remains compact.

## Confirmation Points

- Blocking confirmation: none.
- Local config model fields stay out of v2.
- Raw request or response payload archives stay out of v2.
- Terminal output remains compact; new fields are stored for JSON inspection.

## Ready To Start

Implementation should begin with record type/schema changes and tests for the final-action and retry-summary contract.

## Kickoff Record

Confirmed on 2026-07-05 after comparing the reference application evidence fields with current `ccs proxy` behavior.

## Completion Record

Implemented on 2026-07-05.

- Added request record schema v2 fields for final action, upstream/client status, failure summary, retry summary, request body hash, sanitized JSONL-only request headers, upstream metadata, usage tokens, response shape, and timing.
- Kept terminal status rendering compact and unchanged.
- Kept prompt text and response text out of runtime records.
- Added tests for v2 JSONL/state record boundaries, usage tokens, response shape, upstream metadata, timing, and header sanitization.
