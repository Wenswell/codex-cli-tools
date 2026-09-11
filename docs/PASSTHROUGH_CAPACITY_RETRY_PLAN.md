# Passthrough Capacity Retry Fix

## Scope

Make `passthrough + retry` recognize the Codex overload responses observed in
the proxy captures. Codex reports overload as either an HTTP `503` JSON body
with `error.code` `server_is_overloaded` or `slow_down`, or an SSE
`response.failed` event with `response.error.code` set to either value.

## Implementation

- Parse bounded response bytes for the two structured overload paths.
- Keep the existing capacity-message recognition for compatibility with
  providers that return the user-facing text directly.
- Inspect stream responses through a cloned body before forwarding the original
  response, so ordinary SSE remains byte-preserving and overload SSE can retry.
- Add regression coverage for both overload codes in SSE and HTTP 503 JSON.
- Update the proxy specification, README, tests, built `dist`, and package patch
  version together.

## Acceptance

- A `200 text/event-stream` containing `response.failed` with either overload
  code retries within the configured passthrough status-retry window.
- A `503 application/json` containing either overload code retries as before.
- A normal stream is forwarded unchanged and is not retried.
- Targeted proxy tests and the full test suite pass.
