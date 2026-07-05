# runtime logging security plan

## Scope

Audit and reduce security and performance risk in runtime logging surfaces.

## Order

1. `clvm` and `clvm-raw`.
2. `ccs top` history.
3. `ccs proxy` runtime files.
4. Remaining modules with runtime records.

## Findings

- `clvm-state.json` stored the latest full raw `/connections` response in the previous design.
- `clvm-history.jsonl` accumulated normalized connection details, including endpoints, process names, rules, node chains, and matched domains.
- `clvm monitor` wrote an unchanged runtime record on every interval, including idle empty samples.
- `clvm-raw` uses content-addressed files but has no size or count boundary.
- `clvm-raw` checks existing archive files by reading the whole file.
- `clvm` raw HTTP headers have no secret-header redaction.
- `ccs top` rewrote the retained history window on every sample in the previous design.
- `ccs top`, `ccs proxy` request history, `ccs proxy` event logs, and `ccs proxy` runtime logs need explicit size boundaries.
- `/ccs/top/history` accepted arbitrarily long windows.
- `ccs s server` listens on `0.0.0.0`; deployment docs need a trusted-network boundary.
- `ccs proxy` request history uses a tail reader and excludes request/response bodies. Its runtime files previously defaulted to the config root.

## Plan

- Keep `clvm` state compact with latest normalized details and `raw_ref: null` by default.
- Keep `clvm-history.jsonl` as summary/error JSONL capped at 16M, without per-connection endpoint, process, rule, node, or matched-domain details.
- Coalesce unchanged `clvm monitor` samples, including repeated idle empty samples.
- Make `clvm-raw` an explicit debug layer through `rawArchive: true` or `--raw-archive on`.
- Keep enabled `clvm-raw` bounded with payload-size, file-count, and total-byte limits.
- Check `clvm-raw` archive existence through metadata, not full file reads.
- Redact secret-like HTTP response headers before writing enabled `clvm` raw records.
- Add shared runtime-log helpers for bounded JSONL append, atomic JSON state, and content-addressed raw archives.
- Append `ccs top` snapshots to bounded 64M JSONL and read the needed recent window from the tail.
- Reject `/ccs/top/history` windows longer than 24h30m.
- Keep `ccs proxy` request history bounded at 64M, event logs bounded at 16M, and runtime logs bounded at 16M.
- Document `ccs s server` as a trusted-network service.
- Move default `ccs proxy` runtime state and logs to the cache root.
- Update tests, README, runtime logging docs, and built `dist` files.

## Verification

- `pnpm test`
- Targeted assertions for default `clvm` raw omission, idle monitor coalescing, history detail omission, enabled raw references, retention, and header redaction.
- Targeted assertions for `ccs top` bounded history reading.
- Targeted assertions for `/ccs/top/history` window rejection.
- Targeted assertions for `ccs proxy` request, event, and runtime log boundaries.
- Targeted assertions for shared bounded JSONL trimming.
