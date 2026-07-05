# testing guidelines

Tests should fail for product problems and durable contracts. They should stay focused enough that a failure points to a meaningful behavior change.

## High-Value Tests

- User-visible command behavior: argument handling, status output shape, write confirmation, exit codes, and error messages that define the command contract.
- Data contracts: JSON schemas, JSONL record shape, state files, history files, request records, and config migration results.
- Safety boundaries: secret masking, raw archive opt-in behavior, sensitive-field omission, redaction, private permissions, and retention limits.
- Runtime behavior: retry/backoff decisions, idle monitor coalescing, bounded log trimming, tail-oriented history reads, and atomic state writes.
- Parsers and formatters with real ambiguity: TOML/JSON parsing, ANSI-aware width, wide-character width, truncation, unit formatting, and duration formatting.
- Calculations: usage totals, costs, deltas, buckets, counters, latency summaries, and retry statistics.
- Regression cases where a prior bug would produce leaked data, malformed records, incorrect counters, unbounded growth, or broken command flow.

## Output Assertions

- Assert required fields, table shape, stable columns, meaningful labels, and machine-readable values.
- Assert exact text when the text is the contract, such as a required confirmation prompt, a documented error code, or a public command line.
- Assert exact color or spacing when that visual detail carries semantics.
- Prefer semantic assertions over full-output snapshots for monitor and table output.

## Terminal And Subprocess Helpers

- Use `test/helpers/terminal.js` for ANSI stripping, stdout property overrides, stdout capture, inline module scripts, and Node subprocess execution.
- Use command-specific wrappers only for fixed command paths and environment defaults; keep process execution behavior in the shared helper.
- Simulate TTY width, rows, color, and resize through shared helpers so tests restore stdout descriptors consistently.

## Low-Value Tests

- Incidental wording in decorative titles.
- Exact gaps between unrelated header fields.
- Cosmetic color choices without semantic meaning.
- Full snapshots of terminal output that mix many unrelated concerns.
- Tests that mirror the implementation line by line without protecting a user-visible result or stored data contract.

## Placement

- Put cross-cutting test rules in this document.
- Put command-specific acceptance criteria in the command spec or plan.
- Keep tests near the behavior they protect and name the contract being protected.
