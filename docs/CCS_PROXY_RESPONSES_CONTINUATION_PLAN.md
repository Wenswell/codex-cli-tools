# ccs proxy responses continuation plan

## Goal

Add the latest useful `ccs proxy` upstream behavior in a narrow scope:

- request kind detection
- complete per-attempt request facts
- Responses streaming continuation recovery

## Status

Implemented on 2026-07-05.

Recovery statistics follow-up implemented on 2026-07-05.

## Scope

Included:

- Detect `request_kind` as `normal` or `context_compaction`.
- Store `request_kind` on active, recent, and JSONL request records.
- Store ordered `attempt_records` in completed JSONL request records.
- Use the same request lifecycle to record upstream attempt start, headers, completion, status, model, reasoning, retry action, failure summary, and remaining retry budget.
- For `/responses` and `/v1/responses` streaming requests, request `reasoning.encrypted_content` when continuation recovery may be needed.
- Collect streamed reasoning items with `encrypted_content`.
- On a guarded stream match, construct the next Responses request from the original input plus collected reasoning items and a continuation marker.
- Exclude `context_compaction` requests from continuation recovery.
- Remove automatically requested `encrypted_content` fields from accepted client-visible SSE output.

Excluded:

- `final_answer_only_high_xhigh` intercept mode.
- New user-facing proxy configuration flags.
- Compatibility shims for old record shapes beyond the existing normalizers.
- Request body text storage.
- Guard matching formula changes.
- Changes to non-Responses continuation behavior.

## Implementation Plan

1. Extend record schema.
   - Add `request_kind` to `ProxyRequestRecord`.
   - Add JSONL-only `attempt_records`.
   - Keep `proxy.json.metrics.recent_requests` compact by omitting `attempt_records` from state writes.

2. Add request kind detection.
   - Inspect `x-codex-request-kind`, `x-codex-purpose`, and `x-codex-turn-metadata`.
   - Inspect request JSON `metadata`, `codex_request_kind`, `request_kind`, and `purpose`.
   - Match `remote_compaction` and `context_compaction` case-insensitively.

3. Add attempt tracking.
   - Create an attempt record at each upstream fetch start.
   - Fill headers time, upstream status, model, reasoning metadata, completion time, duration, retry action, failure summary, and remaining retries.
   - Preserve `guard_actions` for compact terminal display.

4. Add Responses continuation recovery.
   - Before forwarding eligible streaming Responses requests, add `reasoning.encrypted_content` to `include` when absent.
   - Collect streamed `reasoning` items containing `encrypted_content`.
   - On guarded stream match, retry with continuation request body before ordinary guard retry.
   - Use the existing guard retry budget.
   - Strip automatically added encrypted content from final accepted SSE output.

5. Update docs and tests.
   - Update `README.md` and `docs/CCS_PROXY_SPEC.md`.
   - Add tests for `request_kind`, JSONL `attempt_records`, continuation success, continuation exhaustion, context compaction exclusion, and encrypted content stripping.
   - Build `dist` and run the proxy test suite.

## Acceptance

- `proxy-requests.jsonl` contains `request_kind` and per-attempt `attempt_records`.
- `proxy.json.metrics.recent_requests` contains compact request records and omits `attempt_records`.
- Responses streaming guard matches try continuation recovery before ordinary retry when encrypted reasoning items are available.
- Context compaction requests use ordinary guard behavior and skip continuation recovery.
- Client-visible SSE output omits encrypted reasoning fields that the proxy added only for recovery.

## Recovery Statistics Follow-up

Goal:

- Make Responses continuation recovery visible in the same status surface as reasoning guard counters.

Decisions:

- Use `guard_actions` as the status-view source, matching existing reasoning and status counters.
- Count every `continuation_recovery` action as one recovery attempt.
- Count a request as recovered when it contains at least one `continuation_recovery` action and finishes with an accepted status below `400`.
- Count a request as exhausted when it contains at least one `continuation_recovery` action and records a final `return_status_502` guard action.
- Render recovery totals on the existing reasoning summary line to keep the status layout compact.

Completed plan:

1. Added recovery summary derivation from `proxy.json.metrics.recent_requests`.
2. Extended the reasoning summary line with `recovery=... recovered=... exhausted=...` when recovery activity exists.
3. Added tests for continuation success, exhausted recovery status output, event-basis counters, and `proxy.log` action records.
4. Updated README and proxy spec.
5. Built `dist`, ran tests, and bumped patch version.

Verified with:

```bash
pnpm test
```
