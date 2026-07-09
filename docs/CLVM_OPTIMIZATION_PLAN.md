# clvm optimization plan

This plan tracks the current `clvm` cleanup.

## Goals

- Split `src/commands/clvm.ts` into focused modules while preserving the public command contract.
- Keep `rawArchive=true` debug payloads out of state and history records. Raw HTTP response bodies belong in `clvm-raw` and are referenced through `raw_ref`.
- Fit monitor success and failure headers to the active terminal width.

## Boundaries

- Automatic close history remains limited to connections successfully closed by `clvm monitor`.
- No new command aliases or compatibility flags.
- No migration layer for older state/history records.
- CLI behavior changes must update README, tests, built `dist`, and package patch version.

## Verification

- Runtime records keep error summaries in state/history and raw bodies only in raw archive files.
- `clvm monitor` headers fit terminal width in success and failure output.
- Existing config, setup, sync, sampling, auto-close, and monitor tests continue to pass.
