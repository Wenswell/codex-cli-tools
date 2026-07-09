# engineering preferences

This document records reusable project preferences that come from implementation reviews. Detailed command contracts stay in the command-specific specs.

## Runtime Logging

- Treat user-provided examples as indicators of a class of issues. If a request mentions `clvm-raw`, review all `clvm` runtime files and then scan other modules with the same logging pattern.
- Runtime records store normalized operational facts by default. High-sensitivity payloads such as connection snapshots, prompts, responses, API keys, environment values, domains, IPs, process names, rules, and node routes require an explicit raw debug surface.
- Raw debug surfaces use opt-in configuration, private file permissions, content-addressed files, redaction, payload-size limits, file-count limits, and total-byte limits.
- State files keep the latest inspectable snapshot and use atomic writes. History files use bounded JSONL and append records only when they add new runtime information.
- Long-running monitors avoid periodic history growth for unchanged samples. An idle empty sample is useful once; repeated identical samples belong in the live view, not in history.
- Long-running status servers publish primary health and status endpoints before auxiliary derived-data refreshes. Auxiliary refresh failures should be logged without blocking the primary status surface.
- Managed background processes with a health protocol treat protocol mismatch as a runtime replacement event: record a normalized event, stop the mismatched runtime, start the current entrypoint, and report a startup error when the current protocol remains unavailable.
- Shared helpers own JSONL append, bounded retention, atomic state writes, and raw archive behavior. New runtime logs should reuse those helpers.
- Status and watch renderers read compact state first. Larger history reads should be explicit and should use tail-oriented readers.

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

## Test Value

- Prefer tests that protect behavior, data contracts, safety/privacy boundaries, parser behavior, retention limits, and calculations.
- Exact terminal-output assertions should name the user-facing display contract they protect.
- Cross-cutting testing rules live in [testing guidelines](./TESTING_GUIDELINES.md).

## Documentation

- Update root-level summaries and detailed docs together when CLI behavior or runtime records change.
- Keep README content compact. Put durable contracts, plans, and review notes under `docs/`.
- Convert repeated review feedback into reusable rules rather than single-incident notes.
- Document the current contract separately from future schema and behavior plans.
