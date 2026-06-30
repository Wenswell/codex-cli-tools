# ccs proxy history plan

## Core principle

无历史包袱，破而后立；只取最佳实践，拒绝兜底。

## Goal

Scale `ccs proxy` request history while keeping live refresh stable.

The proxy will separate four responsibilities:

- `proxy.json`: lightweight runtime state snapshot.
- `proxy-requests.jsonl`: complete completed-request history.
- `proxy.log`: guard and error event JSONL.
- `proxy-runtime.log`: background process stdout and stderr.

## Status

Planned on 2026-06-30.

The current request is sufficient for implementation. No confirmation blockers remain.

## Final behavior

- `ccs proxy` and `ccs proxy --once` render an adaptive history count in TTY output.
- `ccs proxy watch` renders an adaptive history count and recomputes it when terminal height changes.
- Non-TTY output uses a fixed history count of 5 for deterministic piped output.
- `--history N` overrides the adaptive count.
- Supported forms:
  - `ccs proxy --history N`
  - `ccs proxy --once --history N`
  - `ccs proxy watch --history N`
- `N` must be a positive integer.
- Default rendering reads completed history from `proxy.json`.
- Explicit `--history N` reads `proxy-requests.jsonl` only when `N` exceeds `metrics.recent_requests.length`.
- `proxy.json.metrics.recent_requests` remains a small newest-first snapshot.
- `proxy-requests.jsonl` stores every completed request as one JSON line.
- `proxy.log` stores guard and error events only.
- Background process output moves to `proxy-runtime.log`.

## Storage model

`proxy.json` remains the status snapshot:

- runtime install state
- proxy URL and provider metadata
- active requests
- exact status counters
- reasoning-token counters
- upstream hit counters
- latency summary
- recent completed requests

`proxy-requests.jsonl` is the complete completed-request source:

- path: `~/.config/codex-tools/proxy-requests.jsonl`
- format: one normalized `ProxyRequestRecord` JSON object per line
- order: append in completion order
- fields: all request table, metric, model, guard action, byte, latency, session, status, and error fields

`proxy.log` is the event log:

- guard actions
- upstream errors
- local proxy errors with request context

`proxy-runtime.log` is the process log:

- foreground startup output for background processes
- uncaught stdout and stderr from the background process

## Rendering model

Adaptive history count uses the current terminal height:

- Count fixed lines for title, summaries, section headings, table headers, active rows, and command footer.
- Use remaining visible rows for history rows.
- Tiny terminals may show zero history rows so the live view stays within the screen.
- A user-provided `--history N` has priority over adaptive sizing.
- Watch mode listens for terminal resize and repaints immediately.

History source selection:

- Default status and watch use `metrics.recent_requests`.
- `--history N` uses `metrics.recent_requests` when it already contains enough rows.
- `--history N` reads the tail of `proxy-requests.jsonl` when it needs more rows.
- Tail reads use file-size-based reverse block reading and parse only the needed trailing JSONL records.

## Implementation checklist

- [ ] Add `historyCount?: number` to proxy status options.
- [ ] Parse `--history N` for once and watch status commands.
- [ ] Reject missing, non-integer, zero, and negative `--history` values.
- [ ] Add `proxyRequestsPath(stateRoot)` and `proxyRuntimeLogPath(stateRoot)`.
- [ ] Move background stdout and stderr from `proxy.log` to `proxy-runtime.log`.
- [ ] Append completed request records to `proxy-requests.jsonl`.
- [ ] Keep `metrics.recent_requests` limited to the existing compact snapshot size.
- [ ] Add a JSONL tail reader for newest completed request records.
- [ ] Build history rows from `proxy.json` by default.
- [ ] Use the JSONL tail reader only for explicit history counts beyond the snapshot size.
- [ ] Compute adaptive history count from terminal rows.
- [ ] Repaint watch on terminal resize.
- [ ] Update status path output to include `requests`, `events`, and `runtime` paths outside watch mode.
- [ ] Update `README.md`, `docs/CCS_PROXY_SPEC.md`, and built `dist` files.

## Tests

- `ccs proxy --history N` renders N history rows when enough completed requests exist.
- `ccs proxy watch --history N` passes the explicit history count into watch rendering.
- Invalid `--history` values fail with a clear CLI error.
- TTY rendering computes history count from `process.stdout.rows`.
- Non-TTY rendering uses 5 history rows.
- Watch refresh reacts to terminal resize.
- Completed requests append to `proxy-requests.jsonl`.
- `proxy.json.metrics.recent_requests` stays capped at the compact snapshot size.
- `--history N` uses `proxy-requests.jsonl` when N exceeds snapshot history length.
- Default watch rendering works from `proxy.json` without reading `proxy-requests.jsonl`.
- Background process output writes to `proxy-runtime.log`.
- Guard and error event JSONL writes to `proxy.log`.

## Acceptance

Implementation is complete when:

- `pnpm test` passes.
- `ccs proxy` keeps current compact output and adaptive TTY history.
- `ccs proxy watch` stays stable during normal refresh and resize.
- Large history requests do not scan the full JSONL file during every watch refresh.
- `proxy.json`, `proxy-requests.jsonl`, `proxy.log`, and `proxy-runtime.log` each have one clear responsibility.
