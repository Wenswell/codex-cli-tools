# CLI runtime records

Status and monitor commands that sample external runtime state should keep both a live state file and a bounded history file.

## Scope

Use this pattern when a command reads changing external state, such as HTTP runtime state, network connections, usage counters, costs, or process status.

The command surface should stay small. Prefer existing status or monitor commands over adding separate log commands unless users need a focused reader.

When a logging issue is found in one file or command, review the surrounding command family and other modules that use the same runtime-record pattern. File-specific examples often identify a broader logging class.

## Files

- Config lives under `~/.config/codex-tools`.
- Runtime state and history live under `${XDG_CACHE_HOME:-~/.cache}/codex-tools`.
- The live state file uses JSON and stores the latest complete snapshot.
- The history file uses bounded JSONL and appends one normalized record per successful sample or completed request.
- File names should identify the tool and purpose, such as `clvm-state.json`, `clvm-history.jsonl`, `ccs-top-state.json`, or `proxy-requests.jsonl`.

## Record Shape

Each runtime record should include:

- `version`: schema version.
- `recorded_at`: write timestamp.
- `source`: command or runtime source, such as `status`, `monitor`, or `proxy`.
- `config`: active non-secret configuration summary.
- `summary`: compact counters and totals used by status output.
- `result`: normalized records used by the terminal renderer or JSON output. Keep detailed results in state when history can accumulate sensitive runtime facts.
- `raw`: original external input, event, or response only when the module's documented privacy boundary and command mode allow it.
- `raw_ref`: reference to a raw archive file when an explicit debug mode stores the complete raw payload outside the history line.

Runtime records store normalized facts by default. Modules that handle prompts, responses, API keys, environment files, local network connection snapshots, domains, IPs, process names, rules, node routes, or other sensitive payloads should document the raw boundary and keep those payloads in explicit debug surfaces.

Large raw payloads should use content-addressed archives:

- Keep state and history compact unless a raw debug mode is enabled.
- Keep JSONL history bounded enough for long-running monitors.
- Coalesce unchanged monitor samples so idle heartbeats do not grow history or rewrite state every interval.
- Treat watch refresh cadence as display behavior. State writes and history appends happen when observed runtime facts change.
- Store raw payload files under the same runtime cache root, `${XDG_CACHE_HOME:-~/.cache}/codex-tools`.
- Reference raw payloads by SHA-256, byte count, and path.
- Store identical raw payloads once and let multiple history records point to the same archive file.
- Enforce payload-size, file-count, and total-byte limits for raw archive directories.
- Redact secret-like headers and metadata before writing enabled raw records.

## Counters

Status summaries should be computed from the state-file window rather than an unbounded hidden counter when the state file is the visible source of truth.

For bounded state windows:

- Store the newest records first when humans inspect the JSON directly.
- Recompute counters from the retained window after each write.
- Keep bounded history in JSONL when users may need older facts.
- If the command reads more history than the state window, read from the JSONL tail rather than scanning the whole file.

## Terminal Output

Runtime commands should print active file paths when useful:

- Config path.
- State path.
- History path.
- Event or runtime log paths when they exist.

Status output should put state and results before command/help text. Help text remains a compact footer.

Monitor and watch output should keep display rules predictable:

- Headers use compact command labels and bare `HH:mm:ss` clocks.
- Header fields use single spaces.
- Tables keep stable columns and let the final detail column absorb remaining terminal width.
- Tables with mixed diagnostic value can assign shrink priority so compact labels and endpoints compress before dense counters, rates, routes, and final details.
- TTY output can adapt row counts to terminal height.
- Non-TTY output should stay deterministic.
- Watch and live monitor modes should recompute layout after terminal resize.
- Runtime retention windows and visible terminal row counts should be separate values. Taller terminals can reveal more retained facts without changing non-TTY output.
- Color sets should stay small and semantic, such as red, yellow, and green for status-like values.

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
- Append history records as JSON lines and compact them through the shared bounded helper for long-running or high-volume commands.
- Use shared runtime-log helpers for JSONL appends, atomic JSON state writes, and content-addressed raw archives.
- Write referenced raw payloads before writing state and history records when raw debug mode is enabled.
- Preserve completion or sample order in JSONL.
- Keep table columns stable and let the final detail column absorb remaining terminal width.
- Reuse shared formatters and table rendering helpers when available.
