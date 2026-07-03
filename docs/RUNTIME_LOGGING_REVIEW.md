# runtime logging review

Runtime logs should preserve external facts, support quick status rendering, and keep long-running files practical to read and append.

## Principles

- Config lives under `~/.config/codex-tools`.
- Runtime state, history, derived caches, and raw runtime archives live under `${XDG_CACHE_HOME:-~/.cache}/codex-tools`.
- State files keep the latest complete snapshot and use atomic writes.
- History files use JSONL and append one normalized record per sample or completed request.
- Each module documents its raw-data boundary. Prompt, response, API key, and env payloads stay out of runtime logs unless a command is explicitly designed to edit those files.
- High-volume raw payloads use content-addressed archive files and `raw_ref` fields in history.
- Terminal status reads compact state first and reads history only when the user asks for older rows.

## Module Review

| module | files | status | notes |
| --- | --- | --- | --- |
| `clvm` | `clvm-state.json`, `clvm-history.jsonl`, `clvm-raw/*.json` | updated | State keeps the latest raw HTTP response record. History keeps compact normalized records plus `raw_ref`. Raw response records are stored once by SHA-256. |
| `ccs top` | `ccs-top-state.json`, `ccs-top-history.jsonl`, `ccs-top-status.txt` | follow-up | State and history live under cache. History currently rewrites a retained window on each sample, which controls size while increasing per-sample work. |
| `ccs proxy` | `proxy.json`, `proxy-requests.jsonl`, `proxy.log`, `proxy-runtime.log`, `proxy.pid` | follow-up | Request history, event logs, and runtime logs have clear roles. Request and response bodies are intentionally excluded. The files currently live under the proxy state root, which defaults to config. A cache-root migration needs a dedicated change because running proxy processes and tests share that path. |
| `ccs cost` | `ccs-cost/`, `ccs-cost-derived.json`, `model-prices.json` | aligned | Derived runtime data lives under cache. Local reports read Codex session JSONL as source data and avoid storing prompt or response text. |
| wrappers and config tools | none | aligned | `cx`, `cxx`, `cxxs`, `ccx`, `ccxs`, `senv`, and `codex-rename` have no recurring runtime log surface. |

## Follow-Up

- Convert `ccs top` history writes to append-only JSONL and move retention filtering to readers.
- Move default `ccs proxy` runtime files to `~/.cache/codex-tools` while keeping config in `~/.config/codex-tools`.
- Add a small shared helper for JSONL append plus content-addressed raw payload archives when a second module needs raw references.
- Keep package templates free of machine-specific secrets, domains, and local endpoint choices; user-specific values belong under `~/.config/codex-tools`.
