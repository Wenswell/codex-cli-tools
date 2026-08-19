# senv automatic source discovery

## Goal

Make `senv` work without arguments when the current directory contains one
environment template such as `runtime.env.example`.

## Command contract

- With no `--source` or `--target`, inspect the current directory for files whose
  names end with `.env.example`.
- When exactly one source exists, use it and derive the target by removing the
  final `.example` suffix. For example, `runtime.env.example` targets
  `runtime.env`, and `.env.example` targets `.env`.
- When no source exists or multiple sources exist, stop with an actionable error.
  The multiple-source error lists the candidates and directs the user to
  `--source` and `--target`.
- When either path option is present, retain the explicit command contract:
  unspecified paths use `.env.example` and `.env`.
- Preview, confirmation, backup, merge, and redaction behavior do not change.

## Implementation

1. Parse whether source and target options were supplied instead of assigning
   defaults during argument parsing.
2. Resolve default paths before reading files.
3. Document the no-argument discovery behavior in help and README.
4. Add CLI tests for unique discovery and ambiguous discovery.

## Acceptance

- In a directory containing `runtime.env.example`, `senv` previews changes for
  `runtime.env` and reaches the confirmation prompt.
- In a directory containing both `.env.example` and `runtime.env.example`, `senv`
  exits without writing and explains how to choose paths explicitly.
- Existing explicit path commands retain their current behavior.
