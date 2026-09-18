# Proxy Cancel Robustness Plan

## Scope

Enhance `ccs proxy cancel` to reliably stop waiting 429/503 retry loops, prevent client-side auto-reconnection loops from re-entering retry waits, allow cancelling all active retry waits at once, and actively detect dead downstream client sockets.

## Problem Analysis

1. **Premature `res.destroy()` on Cancel**:
   When `ccs proxy cancel` canceled a waiting request, the proxy called `res.destroy()` rather than returning an HTTP error. Downstream clients (e.g. `codex app-server`, `undici`, `fetch`) treat connection resets as transient network transport failures and immediately replay the exact same turn request.
2. **Missing Session-Level Tombstones**:
   Cancelling only a specific `request_id` allowed subsequent replayed requests for the same cancelled session to be accepted as fresh requests and enter new 503 retry loops.
3. **Missing `all` Support**:
   Users had to specify an exact request ID or session prefix; there was no one-command way to cancel all waiting retries.
4. **Passive Client Disconnect Detection**:
   In long retry loops, the proxy relied solely on `req.on("aborted")` or socket close events, but did not actively check `request.socket.destroyed` or `request.socket.closed` before dispatching subsequent upstream attempts.

## Implementation

1. **Respond with HTTP 499 on Cancel**:
   Instead of calling `res.destroy()`, write an explicit JSON response with HTTP 499:
   `{"error":{"message":"retry cancelled by ccs proxy"}}`.
2. **Session Tombstone Cache**:
   Track cancelled session IDs in a bounded TTL map (120s). Immediately reject any incoming requests for a cancelled session with HTTP 499 before contacting upstreams.
3. **Support `ccs proxy cancel all`**:
   Accept `all` or `--all` as a target in both CLI and control endpoints, selecting all currently waiting 429/503 requests.
4. **Active Client Socket Verification**:
   Inspect `request.socket.destroyed` and `request.socket.closed` before every upstream attempt and retry wait in passthrough and guarded modes.
5. **Update Tests & Specs**:
   Update `docs/CCS_PROXY_SPEC.md`, `README.md`, and test suites. Increment package version to `0.3.35`.
