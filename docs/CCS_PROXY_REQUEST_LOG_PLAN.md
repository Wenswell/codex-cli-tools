# ccs proxy request log plan

## Goal

Upgrade `ccs proxy` request history from compact operational records to complete request samples for debugging and analysis.

The plan keeps one source of truth for completed model API requests:

- `proxy-requests.jsonl`: complete completed request stream.
- `proxy.json.metrics.recent_requests`: newest compact status window.
- `proxy.log`: event stream for guard actions, unsupported paths, upstream errors, and local proxy errors.

## Decisions

- Store request headers through an explicit whitelist and redact secret-bearing values.
- Store complete request samples only in `proxy-requests.jsonl`.
- Keep `proxy.json.metrics.recent_requests` as the lightweight live status view.
- Use `final_action` only for the final client-visible result.
- Store retry process details in `retry_summary`, `attempt_records`, and existing `guard_actions`.
- Store request body hash and size. Do not store request body text or prompt excerpts.

## Scope

Included:

- Request outcome classification.
- Upstream/client status separation.
- Structured failure summaries.
- Per-attempt facts for retries.
- Timing facts for upstream wait and streaming.
- Request body hash and sanitized header summary.
- Token usage facts when upstream returns explicit usage fields.
- Documentation and tests for the new request record schema.

Excluded:

- Install entrypoints.
- Interactive UI.
- Codex config parsing.
- Active probes.
- Experimental intercept rules such as `final_answer_only_high_xhigh`.
- Request body excerpt storage unless explicitly approved.

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
| `request_body_sha256` | `string \| null` | SHA-256 of the incoming request body. |
| `request_headers` | `object \| null` | Whitelisted and sanitized request headers. JSONL only. |
| `upstream_wait_ms` | `number \| null` | Time from upstream fetch start to upstream headers. |
| `time_to_first_chunk_ms` | `number \| null` | Streaming time from upstream fetch start to first chunk. |
| `stream_duration_ms` | `number \| null` | Streaming time from first chunk to final chunk. |
| `input_tokens` | `number \| null` | Explicit upstream input token count. |
| `output_tokens` | `number \| null` | Explicit upstream output token count. |
| `total_tokens` | `number \| null` | Explicit upstream total token count. |
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

`proxy-requests.jsonl` stores complete completed records:

- all display fields
- request kind
- new status and failure fields
- request body hash
- whitelisted request headers
- usage token fields
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
- Keep the full request record in `proxy-requests.jsonl`; terminal display still uses `error`.

## attempt_records

Use one entry per upstream fetch attempt:

```json
{
  "attempt": 1,
  "upstream": "input",
  "started_at": "2026-07-03T00:00:00.000Z",
  "headers_at": "2026-07-03T00:00:00.120Z",
  "upstream_status": 429,
  "reasoning_tokens": null,
  "reasoning_tokens_source": null,
  "reasoning_text_observed": false,
  "upstream_model": null,
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
- Do not store request body text.
- Do not store prompt excerpts.

This gives stable correlation without storing prompt content.

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

1. Update request record types and normalization.
   - Add schema version and new nullable fields.
   - Define complete JSONL records and compact state records.
   - Keep one direct normalizer path for each record shape.

2. Add request summary helpers.
   - `hashRequestBody(body)`.
   - `sanitizeWhitelistedRequestHeaders(headers)`.
   - `buildFailureSummary(error, upstreamPayload)`.
   - `createAttemptRecord(...)`.
   - `createRetrySummary(...)`.

3. Add lifecycle timestamps.
   - Request start.
   - Upstream fetch start per attempt.
   - Upstream headers observed.
   - First stream chunk.
   - Final stream chunk.
   - Completion.

4. Fill `final_action`.
   - Accepted response without retry: `passed`.
   - Accepted response after retry: `passed`.
   - Exhausted guard: `blocked`.
   - Repeated fetch failure: `upstream_fetch_failed`.
   - Client abort: `client_aborted`.
   - Local unclassified error: `gateway_error`.

5. Fill `retry_summary`.
   - Increment reasoning guard retry count when a guard match triggers retry.
   - Increment upstream capacity retry count when a capacity response triggers retry.
   - Increment transport retry count when fetch failed is retried.
   - Keep `total` equal to the sum of retry counters.

6. Fill `attempt_records`.
   - Append at attempt start.
   - Update on upstream response status.
   - Update on observed model and reasoning metadata.
   - Update on guard action or transport failure.
   - Persist only in `proxy-requests.jsonl`.

7. Keep display stable.
   - Existing status table continues using `status`, `error`, `guard_actions`, model fields, reasoning fields, bytes, and latency.
   - New fields are stored for analysis and JSON inspection.

8. Update docs.
   - Update `CCS_PROXY_SPEC.md` request record schema.
   - Update `README.md` proxy section.
   - Keep this plan with completion notes.

9. Add tests.
   - Accepted upstream response records `final_action=passed`.
   - Capacity retry then success records `final_action=passed` and `retry_summary.upstream_capacity > 0`.
   - Reasoning guard retry then success records `final_action=passed` and `retry_summary.reasoning_guard > 0`.
   - Exhausted reasoning guard records `final_action=blocked`.
   - Repeated transport failure records `final_action=upstream_fetch_failed`.
   - Client abort records `final_action=client_aborted`.
   - Plain upstream `429` passthrough records upstream/client status correctly.
   - Header sanitization redacts secrets and preserves useful headers.
   - Request body hash is stable and prompt text is absent.

## Acceptance Criteria

- `proxy-requests.jsonl` contains one complete request record per completed model API request.
- `proxy.json.metrics.recent_requests` stores compact request records without `attempt_records` or `request_headers`.
- Each completed record has `schema_version=2`.
- Each completed record has a non-pending `final_action`.
- `upstream_status` and `client_status` are explicit.
- Local failure records have `failure_summary`.
- Upstream JSON errors are preserved in `failure_summary`.
- Secret headers are redacted.
- Only whitelisted request headers are persisted.
- Request body text is absent from logs.
- `request_body_sha256` is present for completed records whose body was read.
- `retry_summary.total` equals the sum of retry counters.
- Complete attempt facts are available in JSONL records.
- Existing status rendering remains compact.

## Ready To Start

No confirmation blockers remain.

Implementation should begin with record type/schema changes and tests for the final-action and retry-summary contract.
