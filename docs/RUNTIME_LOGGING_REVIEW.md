# runtime logging review

Runtime logs should preserve external facts, support quick status rendering, and keep long-running files practical to read and append.

## Principles

- Config lives under `~/.config/codex-tools`.
- Runtime state, history, derived caches, and enabled raw runtime archives live under `${XDG_CACHE_HOME:-~/.cache}/codex-tools`.
- State files keep the latest complete snapshot and use atomic writes.
- History files use bounded JSONL and append one normalized record per sample or completed request.
- Each module documents its raw-data boundary. Prompt, response, API key, env payloads, and high-sensitivity runtime payloads stay out of runtime logs by default.
- High-volume raw payloads use explicit debug switches, content-addressed archive files, and `raw_ref` fields.
- Terminal status reads compact state first and reads history only when the user asks for older rows.

## Module Review

| module | files | status | notes |
| --- | --- | --- | --- |
| `clvm` | `clvm-state.json`, `clvm-history.jsonl`, `clvm-raw/*.json` | updated | State keeps the latest normalized connection details. Monitor coalesces unchanged samples, so idle repeated samples do not write every interval. History keeps summary/error records only and is capped at 16M. `rawArchive` defaults to `false`; enabling it stores bounded raw HTTP response records once by SHA-256 with sensitive response headers redacted. |
| `ccs top` | `ccs-top-state.json`, `ccs-top-history.jsonl`, `ccs-top-status.txt` | updated | State and history live under cache. History appends bounded JSONL records up to 64M and readers filter the needed recent window from the file tail. The HTTP history endpoint rejects windows longer than 24h30m. |
| `ccs proxy` | `proxy/proxy.json`, `proxy/proxy-requests.jsonl`, `proxy/proxy.log`, `proxy/proxy-runtime.log`, `proxy/proxy.pid` | updated | Request history, event logs, and runtime logs have clear roles under cache. Request history is capped at 64M, event logs and runtime logs at 16M, and request/response bodies are intentionally excluded. |
| `ccs cost` | `ccs-cost/`, `ccs-cost-derived.json`, `model-prices.json` | aligned | Derived runtime data lives under cache. Local reports read Codex session JSONL as source data and avoid storing prompt or response text. |
| wrappers and config tools | none | aligned | `cx`, `cxx`, `cxxs`, `ccx`, `ccxs`, `senv`, and `codex-rename` have no recurring runtime log surface. |

## Follow-Up

- Add cross-process locking for `ccs proxy` state mutation if multiple serving processes share one state root.
- Move cost snapshot upload targets from source constants to user configuration.
- Keep package templates free of machine-specific secrets, domains, and local endpoint choices; user-specific values belong under `~/.config/codex-tools`.
