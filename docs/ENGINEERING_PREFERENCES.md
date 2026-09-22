# engineering preferences

This document owns reusable project conventions. Detailed command contracts stay
in the command-specific specifications.

## CLI Design

- Keep command surfaces small. Prefer one obvious command and remove replaced
  behavior instead of retaining aliases or compatibility modes.
- New public tools expose useful no-argument behavior, dedicated `help`, `-h`,
  and `--help` output, plus `version` and `-v` backed by `package.json`.
- Status output prints active configuration values and results before a compact
  command footer. Root footers distinguish direct commands from namespaces;
  namespace footers list only immediate primary commands and end with `--help`.
- Help prints one command per line with a short comment. Invalid arguments fail
  with a short explicit error.
- File-changing commands print the complete preview, state that no changes are
  written without confirmation, and require typing exact `yes`. Do not add
  automatic-confirmation or separate dry-run flags.
- Apply rechecks the preview source, writes only the previewed target, verifies
  the result, and reports backups and verification.

## Runtime Logging

- Treat user-provided examples as indicators of a class of issues. If a request mentions `clvm-raw`, review all `clvm` runtime files and then scan other modules with the same logging pattern.
- Runtime records store normalized operational facts by default. High-sensitivity payloads such as connection snapshots, prompts, responses, API keys, environment values, domains, IPs, process names, rules, and node routes require an explicit raw debug surface.
- Raw debug surfaces use opt-in configuration, private file permissions, content-addressed files, redaction, payload-size limits, file-count limits, and total-byte limits.
- State files keep the latest inspectable snapshot and use atomic writes. History files use bounded JSONL and append records only when they add new runtime information.
- Long-running monitors avoid periodic history growth for unchanged samples. An idle empty sample is useful once; repeated identical samples belong in the live view, not in history.
- Long-running status servers publish primary health and status endpoints before auxiliary derived-data refreshes. Auxiliary refresh failures should be logged without blocking the primary status surface.
- Runtime records separate client-level repeated requests from tool-owned internal retries. Terminal status can show both, using distinct stored fields and distinct visible prefixes.
- Upstream usage metadata preserves explicit non-negative token counts at both request and internal-attempt scope. Missing or invalid fields remain `null`, so downstream reports can distinguish unknown values from explicit zeroes.
- Managed background processes with a health protocol treat protocol mismatch as a runtime replacement event: record a normalized event, stop the mismatched runtime, start the current entrypoint, and report a startup error when the current protocol remains unavailable.
- Shared helpers own JSONL append, bounded retention, atomic state writes, and raw archive behavior. New runtime logs should reuse those helpers.
- Status and watch renderers read compact state first. Larger history reads should be explicit and should use tail-oriented readers.
- High-frequency transport progress stays in memory. Persist exact terminal values without periodically rewriting the full state file while an operation is active.

## CLI Output

- Nested command status pages limit their compact `commands:` summary to the current command family.
- Keep labeled output compact and aligned where practical. Command footer rows
  stay on one line and are not width-dependent.

## Terminal Monitor Output

- Monitor headers use a compact command label plus a bare `HH:mm:ss` clock.
- Field separators are single spaces. Alignment belongs inside tables, not between unrelated header fields.
- Color sets stay small and semantic. Status-like values should use red, yellow, and green unless a fourth state has a clear meaning.
- Repeated short grouping identifiers should use a stable small bright palette so related rows are easy to scan without adding columns or legend text.
- Dense operational tables keep stable columns. Text-heavy details should live in the final column and use the shared ANSI-aware, wide-character-aware truncation rules.
- Dense operational tables should assign explicit shrink priority when columns have different diagnostic value. Lower-value status labels and endpoints can compress before dense numeric values, routing chains, and final detail fields.
- Terminal display values can enrich compact diagnostics from related normalized facts. Tests should cover both the stored fact and the rendered display value.
- Numeric display uses compact units for terminal output and keeps raw numeric values in JSON.
- Runtime retention and visible terminal row counts are separate display concerns. Non-TTY output keeps fixed row counts, while TTY output can use terminal height to reveal more retained rows.
- Watch-mode repaint cadence is a display concern. State writes and history appends happen only when runtime facts change.
- Raw TTY monitors handle `Ctrl-C` as the ETX input byte and route it through the same cleanup path as command-specific exit keys, restoring raw mode, cursor visibility, screen state, and input listeners.

## Test Value

- Prefer tests that protect behavior, data contracts, safety/privacy boundaries, parser behavior, retention limits, and calculations.
- Exact terminal-output assertions should name the user-facing display contract they protect.
- Cross-cutting testing rules live in [testing guidelines](./TESTING_GUIDELINES.md).
- Export source symbols only for a current cross-module or test consumer. Package
  binaries are the public surface; internal helpers stay module-local.

## Documentation

- Keep `README.md` focused on user setup and command behavior. Put reusable
  contributor rules and detailed data contracts under `docs/`.
- Update the README, owning specification, tests, and built `dist` output together
  when CLI behavior changes.
- Keep current contracts, not completed implementation plans, audits, or review
  logs. Git history owns historical implementation detail.
- Convert repeated review feedback into a reusable rule in the owning document.

## Configuration And Runtime Views

- Store configuration under `~/.config/codex-tools` unless the data is runtime
  state. Secrets belong in environment variables or that config directory, not
  in package files.
- File-changing previews should retain the exact source and target content. Apply verifies that the source remains current, writes the previewed target, and reads it back before reporting success.
- Multi-attempt runtime records should project one compact attribution entry per owned attempt at request completion. Aggregate views require complete facts for each displayed component and preserve missing or invalid states explicitly.
- Multi-view terminal tables should keep shared identity columns stable, derive every view from the same normalized records, and load local pricing or other frame dependencies once per rendered frame.

## Release

- Increment the shared `package.json` version in every commit. Use a patch
  increment unless the release explicitly requires another semantic-version level.
- Rebuild `dist` whenever source behavior or public help changes.
