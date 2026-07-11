# engineering preferences

This document records reusable project preferences that come from implementation reviews. Detailed command contracts stay in the command-specific specs.

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

## Cost And Pricing

- Cost reports should calculate the known priced portion and expose missing model prices as structured status. A missing price for one model should not fail unrelated rows, central status, or central reports.
- Pricing lookup reads the shared local cache, built-in supplemental prices, and explicit config overrides. Missing models remain in `missingPricingModels` and terminal pricing status. Remote cache writes belong to explicit `ccs pricing` commands.
- Model inventory commands that list available models should show whether each model has pricing with `ok`, `partial`, or `missing` status.

## Test Value

- Prefer tests that protect behavior, data contracts, safety/privacy boundaries, parser behavior, retention limits, and calculations.
- Exact terminal-output assertions should name the user-facing display contract they protect.
- Cross-cutting testing rules live in [testing guidelines](./TESTING_GUIDELINES.md).

## Documentation

- Update root-level summaries and detailed docs together when CLI behavior or runtime records change.
- Keep README content compact. Put durable contracts, plans, and review notes under `docs/`.
- Convert repeated review feedback into reusable rules rather than single-incident notes.
- Document the current contract separately from future schema and behavior plans.

## Configuration And Runtime Views

- File-changing previews should retain the exact source and target content. Apply verifies that the source remains current, writes the previewed target, and reads it back before reporting success.
- Multi-attempt runtime records should project one compact attribution entry per owned attempt at request completion. Aggregate views require complete facts for each displayed component and preserve missing or invalid states explicitly.
- Multi-view terminal tables should keep shared identity columns stable, derive every view from the same normalized records, and load local pricing or other frame dependencies once per rendered frame.
