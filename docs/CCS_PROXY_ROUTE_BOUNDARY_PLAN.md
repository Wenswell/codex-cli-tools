# ccs proxy route boundary plan

## Core principle

无历史包袱，破而后立；只取最佳实践，拒绝兜底。

## Context

Remote proxy history showed completed rows with `session` rendered as `-`. The raw records were `GET /` requests with `request_bytes=0`, `response_bytes≈104K`, `request_model=null`, `upstream_model=null`, and `reasoning_tokens=null`.

These rows are valid HTTP proxy records under the current broad routing behavior, but they are invalid for the request-history purpose. `proxy-requests.jsonl` and `metrics.recent_requests` should represent model API traffic only.

## Status

Implemented in package version `0.1.12`.

## Root cause

`ccs proxy serve` accepts every non-health path as an upstream proxy request. The service has one HTTP server that handles local control endpoints and upstream model forwarding, but the forwarding path lacks an explicit model API allowlist.

This lets local control clients, stale watch clients, browser visits, curl checks, and unrelated root-path probes enter the model request lifecycle:

- `metrics.active_requests`
- `metrics.recent_requests`
- `proxy-requests.jsonl`
- status counters
- latency counters
- upstream hit counters
- history table rendering

The `session` field is only extracted from JSON request body field `session_id`. `GET /` has no request body, so it records `session=null` and renders as `-`.

## Goal

Separate HTTP traffic by purpose:

- control endpoints stay local to the proxy process
- supported model API paths enter upstream forwarding and request history
- unsupported paths return local client errors and write event logs only

Request history becomes a clean model-request history.

## Final behavior

### Control endpoints

Local control endpoints are handled before any request metric is created.

Supported control endpoint:

- `GET /__codex_proxy/health`

The health response includes:

- `status`
- `pid`
- `version`
- `protocol`

Health checks do not update `active_requests`, `recent_requests`, `proxy-requests.jsonl`, status counters, latency counters, or upstream hit counters.

### Model API endpoints

Only these paths enter upstream forwarding and request history:

- `/responses`
- `/v1/responses`
- `/chat/completions`
- `/v1/chat/completions`

These requests keep the current lifecycle:

- active request record
- request body read
- session/model extraction
- upstream forwarding
- reasoning guard
- final history append
- state metrics update

### Unsupported paths

Unsupported paths return local `404` with compact JSON:

```json
{"error":{"code":"unsupported_proxy_path","message":"unsupported proxy path"}}
```

Unsupported paths write one JSONL event to `proxy.log` with:

- `event: "ccs_proxy_unsupported_path"`
- `method`
- `path`
- `status: 404`

Unsupported paths do not update request history or request metrics.

## Implementation plan

1. [x] Introduce a route classifier.

   ```text
   control   -> local endpoint
   model_api -> upstream forwarding
   invalid   -> local 404 event
   ```

2. [x] Move route classification to the top of `serveProxy`, before `activeRecord` creation.

3. [x] Keep `proxyEndpointClass(pathname)` as the model API classifier or replace it with a stronger `classifyProxyRoute` function.

4. [x] Return health locally and include `version` plus protocol.

5. [x] Return unsupported paths locally with `404` and `unsupported_proxy_path`.

6. [x] Keep model API forwarding behavior unchanged after classification.

7. [x] Add client/server protocol validation for managed proxy startup:

   - Managed startup reads server protocol from `/__codex_proxy/health`.
   - A protocol mismatch records a runtime event, stops that proxy process, and starts the current proxy.
   - A remaining mismatch after restart exits with a clear restart message.

8. [x] Update process/runtime display:

   - show server `version`
   - show server `protocol`
   - keep `pid` and proxy URL

9. [x] Update docs:

   - `README.md`
   - `docs/CCS_PROXY_SPEC.md`
   - this plan file after implementation

10. [x] Update built `dist` files in the same change.

11. [x] Increment `package.json` patch version in the implementation commit.

## Test plan

- [x] `GET /__codex_proxy/health` returns local health JSON and does not enter `active_requests`, `recent_requests`, or `proxy-requests.jsonl`.
- [x] `GET /` returns local `404 unsupported_proxy_path` and does not enter request metrics or request history.
- [x] `GET /anything` returns local `404 unsupported_proxy_path` and writes one `proxy.log` event.
- [x] `POST /responses` keeps current forwarding, session extraction, model extraction, reasoning metadata, and history append behavior.
- [x] `POST /v1/responses` keeps current behavior.
- [x] `POST /chat/completions` keeps current behavior.
- [x] `POST /v1/chat/completions` keeps current behavior.
- [x] `ccs proxy watch` does not generate request history rows.
- [x] Status counters exclude unsupported paths.
- [x] Latency counters exclude unsupported paths.
- [x] Upstream hit counters exclude unsupported paths.
- [x] Protocol mismatch restarts the managed proxy; a remaining mismatch fails with an explicit restart message.

## Acceptance

- [x] `proxy-requests.jsonl` stores model API requests only.
- [x] `metrics.recent_requests` stores model API requests only.
- [x] `proxy.log` stores unsupported-path events, guard events, upstream errors, and local proxy errors.
- [x] `ccs proxy watch` status refresh produces no model-history noise.
- [x] Stale or unsupported clients cannot pollute history.
- [x] Existing reasoning guard behavior stays unchanged for supported model API paths.
- [x] `pnpm build && node --test test/ccs-proxy.test.js` passes.
- [x] `pnpm test` passes.

## Confirmation

No implementation confirmation blocker remains.

The plan intentionally removes broad-path forwarding. Any client that depends on proxying arbitrary paths through `ccs proxy` must move to supported model API paths.
