# ccs proxy upstream sync plan

## Core principle

无历史包袱，破而后立；只取最佳实践，拒绝兜底。

## Goal

Align `ccs proxy` with the latest core behavior from `codex-retry-gateway` while keeping this toolset's command surface small.

The proxy will use the manually selected current profile only. Profile switching remains owned by `ccs toggle`.

## Planned behavior

- Use one active upstream from `profiles.current`.
- Remove automatic upstream fallthrough from proxy request handling.
- Treat upstream HTTP responses as upstream facts. `401`, `403`, `408`, `429`, and `5xx` are returned to Codex with their original status and body when the local reasoning guard leaves the response unchanged.
- Retry transport-level `fetch failed` once inside the proxy. Return `502 upstream_error/upstream_fetch_failed` after repeated transport failure.
- Check non-stream JSON responses for `reasoning_tokens`.
- Check stream SSE responses for `reasoning_tokens` in strict mode by buffering upstream chunks before sending them to the client.
- Use `reasoning_equals = [516, 1034, 1552]`.
- Use `guard_retry_attempts = 3`.
- When a local reasoning guard matches, retry the same upstream request inside the proxy until the guard retry budget is exhausted.
- Return `502 reasoning_guard_triggered` only after the guard retry budget is exhausted.
- Record each guard match action in request history and process logs:
  - `internal_retry`
  - `return_status_502`
  - `upstream_error`
- Keep existing request lifecycle metrics: active requests, recent requests, exact status counts, upstream hit counts, latency, byte counts, session id, and model metadata.

## Implementation steps

1. Update `ccs proxy` upstream selection to resolve only `profiles.current`.
2. Replace automatic upstream fallthrough with single-upstream forwarding.
3. Add transport retry handling for `TypeError: fetch failed`.
4. Add shared reasoning-token extraction for non-stream JSON and SSE payloads.
5. Add guard retry state per client request.
6. Add strict SSE buffering before client response headers are written.
7. Persist guard action and upstream error text in request records.
8. Update `README.md`, `docs/CCS_PROXY_SPEC.md`, and built `dist` files with the final behavior.
9. Add tests for single-upstream behavior, HTTP status passthrough, transport retry, non-stream guard retry, stream guard retry, and exhausted guard retry.

## Discarded upstream core features

- Request body size limits and `413 request_body_limit_exceeded`. `ccs proxy` forwards request bodies at their original size.
- Runtime interception toggles for stream and non-stream modes. The reasoning guard is always active for supported response types.
- `stream_action=disconnect`. Strict SSE buffering is the only stream guard mode.
- Model-family consistency scoring, suspicious sample storage, fingerprint drift tracking, and rebuild suspicion metrics. `ccs proxy` keeps request-level model observation only.
- Incremental in-memory logs API. `ccs proxy` keeps compact request history in `proxy.json` and process output in `proxy.log`.
- Active probe behavior.

## Confirmation

The current request is sufficient for implementation.
