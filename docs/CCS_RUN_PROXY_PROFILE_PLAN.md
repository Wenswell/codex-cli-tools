# ccs run proxy profile plan

## Goal

Keep `ccs run PROFILE [CODEX_ARGS...]` as an explicit one-process profile selection when `ccs proxy` is installed, while retaining proxy policy and observability.

## Root cause

`ccs run` currently routes the child process to the local proxy whenever proxy state exists. The proxy resolves every request from `profiles.current`, so the requested `PROFILE` only changes the child API key and does not select the upstream.

## Design

- `ccs run PROFILE` adds a temporary `model_providers.<provider>.http_headers.x-ccs-profile` Codex config override.
- The local proxy resolves that header before reading `profiles.current`.
- Requests without the header continue to use `profiles.current`.
- The selected profile must exist and contain both `baseURL` and `apiKey`; invalid selections fail explicitly.
- The internal routing header is removed before forwarding upstream and is excluded from request logs.
- `ccs run` keeps using the local proxy URL, so configured proxy modes still apply.
- No profile, Codex config, auth, or proxy state file is modified.

Codex supports provider `http_headers`; a dotted CLI override updates only the routing header leaf for the launched process.

## Scope

1. Add the temporary routing header to `ccs run` when proxy state is active.
2. Resolve proxy upstreams from the optional routing header.
3. Strip the internal header from upstream requests.
4. Update README, proxy spec, tests, built files, and package version.

## Acceptance

- With proxy state active, `ccs run input` passes the local proxy URL and the `input` routing header to Codex.
- A request with the routing header reaches that profile even when `profiles.current` names another profile.
- A request without the routing header still reaches `profiles.current`.
- The selected provider does not receive the internal header.
- Unknown or incomplete selected profiles return an explicit proxy error.
- Targeted tests and the full test suite pass.

## Status

Implemented in package version `0.2.52`.

## Result

- `ccs run` adds the temporary provider header only when proxy state is active.
- Proxy routing gives the explicit profile priority and preserves `profiles.current` as the default.
- Invalid explicit profiles return `400` with `invalid_proxy_profile` in normalized failure records.
- Upstream requests omit the internal routing header and use the selected profile API key.
- README, proxy spec, built `dist`, and package version are synchronized.
- `pnpm test` passes all 154 tests.
