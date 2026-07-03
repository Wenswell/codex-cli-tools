# CLI runtime records

Status and monitor commands that sample external runtime state should keep both a live state file and an append-only history file.

## Scope

Use this pattern when a command reads changing external state, such as HTTP runtime state, network connections, usage counters, costs, or process status.

The command surface should stay small. Prefer existing status or monitor commands over adding separate log commands unless users need a focused reader.

## Files

- Config lives under `~/.config/codex-tools`.
- Runtime state and history live under `${XDG_CACHE_HOME:-~/.cache}/codex-tools`.
- The live state file uses JSON and stores the latest complete snapshot.
- The history file uses JSONL and appends one normalized record per successful sample or completed request.
- File names should identify the tool and purpose, such as `clvm-state.json`, `clvm-history.jsonl`, `ccs-top-state.json`, or `proxy-requests.jsonl`.

## Record Shape

Each runtime record should include:

- `version`: schema version.
- `recorded_at`: write timestamp.
- `source`: command or runtime source, such as `status`, `monitor`, or `proxy`.
- `config`: active non-secret configuration summary.
- `summary`: compact counters and totals used by status output.
- `result`: normalized records used by the terminal renderer or JSON output.
- `raw`: original external input, event, or response when the module's privacy boundary allows it.
- `raw_ref`: reference to a raw archive file when the complete raw payload is stored outside the history line.

Secrets must not be written to runtime records. Modules that handle prompts, responses, API keys, environment files, or other private payloads should store normalized facts and document the raw boundary. Modules that handle operational state, such as local network connection snapshots, can store raw external responses when those facts are needed for debugging.

Large raw payloads should use content-addressed archives:

- Keep the latest state file complete for direct inspection.
- Keep append-only history compact enough for long-running monitors.
- Store raw payload files under the same runtime cache root, `${XDG_CACHE_HOME:-~/.cache}/codex-tools`.
- Reference raw payloads by SHA-256, byte count, and path.
- Store identical raw payloads once and let multiple history records point to the same archive file.

## Counters

Status summaries should be computed from the state-file window rather than an unbounded hidden counter when the state file is the visible source of truth.

For bounded state windows:

- Store the newest records first when humans inspect the JSON directly.
- Recompute counters from the retained window after each write.
- Keep complete history in JSONL when users may need older facts.
- If the command reads more history than the state window, read from the JSONL tail rather than scanning the whole file.

## Terminal Output

Runtime commands should print active file paths when useful:

- Config path.
- State path.
- History path.
- Event or runtime log paths when they exist.

Status output should put state and results before command/help text. Help text remains a compact footer.

## Numeric Format

Terminal numbers for bytes, speeds, durations, and compact counters should use three significant digits after the base unit:

- `160K`
- `43.2M`
- `160K/s`
- `43.2M/s`
- `56ms`
- `2.34s`
- `3.12m`

Use short unit names in dense status tables, such as `K`, `M`, `G`, `K/s`, and `M/s`. Keep raw numeric values in JSON records.

## Implementation Notes

- Write the live JSON state atomically.
- Append history records as JSON lines.
- Write referenced raw payloads before writing state and history records.
- Preserve completion or sample order in JSONL.
- Keep table columns stable and let the final detail column absorb remaining terminal width.
- Reuse shared formatters and table rendering helpers when available.
