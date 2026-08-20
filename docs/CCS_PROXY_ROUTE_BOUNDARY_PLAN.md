# ccs proxy route boundary plan

## Status

Implemented in package version `0.3.0`.

## Goal

Keep proxy policy limited to known model endpoints while transparently forwarding other upstream API paths, including `/v1/alpha/search`.

## Scope

1. Keep `/responses`, `/v1/responses`, `/chat/completions`, and `/v1/chat/completions` as policy-managed routes.
2. Transparently forward every other upstream API path with normal proxy authentication and request recording.
3. Reserve `/__codex_proxy/*` for local control. Reject unknown control paths with a message that identifies `ccs proxy` as the rejecting component.
4. Update focused tests, README, proxy specification, built output, and package version `0.3.0`.

## Acceptance

- Non-policy requests preserve the method, path, query, body, and upstream response.
- Non-policy requests reach the upstream once even when an inspection mode is active.
- Unknown `/__codex_proxy/*` paths return a local `404 unsupported_proxy_path` with an explicit `ccs proxy` interception message and never reach upstream.

## Result

- Route classification now distinguishes local control, policy-managed upstream, transparent upstream, and invalid local control traffic.
- `/v1/alpha/search` and future non-control API paths use one transparent upstream request in every proxy mode.
- Focused proxy tests pass. The complete suite passes all 173 tests when run serially; the default parallel run exposed an existing proxy-process shutdown race in two lifecycle tests.
