# ccs proxy mode plan

## Goal

Add explicit `ccs proxy` intervention modes.

## Status

Implemented on 2026-07-07.

## Mode Semantics

- `recovery`: inspect supported model responses, use continuation recovery for eligible streaming Responses guard hits, then use ordinary guard retry when recovery is unavailable.
- `intercept`: inspect supported model responses and use ordinary guard retry. Streaming Responses continuation recovery is disabled.
- `passthrough`: forward the original client request body to the active upstream and stream the upstream response back without reasoning guard retries, continuation recovery, response body stripping, capacity retries, or transport retries.

`ccs proxy install` starts in `recovery`, matching the current strongest protection behavior.

## Command Surface

- `ccs proxy mode`: print the active mode.
- `ccs proxy mode recovery`: switch to recovery mode.
- `ccs proxy mode intercept`: switch to intercept mode.
- `ccs proxy stop`: switch to passthrough mode and keep the proxy process usable for clients still pointed at the proxy URL.
- `ccs proxy restore`: restore `~/.codex/config.toml`, stop the proxy process, and remove proxy state.

Commands that write `proxy.json` print the planned change and require typing exact `yes`.

## Implementation Plan

1. [x] Add `mode` to proxy state and status output.
2. [x] Add mode switching helpers and CLI parsing.
3. [x] Read current mode for each proxied request so mode changes affect the running background proxy.
4. [x] Split request forwarding into guarded and passthrough paths.
5. [x] Update tests, README, proxy spec, built `dist`, and package patch version.

## Acceptance

- `ccs proxy mode recovery` enables continuation recovery for eligible streaming Responses requests.
- `ccs proxy mode intercept` keeps guard retries and blocks exhausted guarded responses without continuation recovery.
- `ccs proxy stop` forwards guarded responses as upstream responses and keeps the proxy endpoint reachable.
- Status output shows the active mode.
- `ccs proxy restore` remains the command for exiting proxy routing.

## Verification

```bash
pnpm build && node --test test/ccs-proxy.test.js
```
