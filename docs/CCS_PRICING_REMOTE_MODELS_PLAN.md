# ccs pricing remote models plan

## Goal

Make watched pricing entries describe model-name patterns and show the LiteLLM remote models selected by each pattern.

## Scope

- Rename `profiles.json` configuration from `pricing.models` to `pricing.patterns`.
- Keep `~/.cache/codex-tools/model-prices.json.models` as the cached model-price mapping.
- Add a `remote` column to `ccs pricing list` with the remote model name selected by each pattern.
- Show remote model matches in `ccs pricing watch` and `ccs pricing unwatch` previews.
- Render remote request failures as `unavailable` and continue `list`, `watch`, and `unwatch` output.
- Keep `ccs pricing refresh` strict because it prepares a cache write plan.

## Plan

1. Add a shared LiteLLM remote catalog reader with a bounded request and normalized result states.
2. Reuse the reader for price refresh, list rendering, and watch previews.
3. Expand `*` patterns against remote model keys for list and watch output.
4. Rename the persisted watched configuration field to `pricing.patterns`.
5. Add focused tests for remote matches, unavailable remote results, configuration writes, and strict refresh failures.
6. Update the pricing specification, README, built files, and patch version.

## Acceptance

- `pricing.patterns` is the only watched-pattern field read and written by `ccs`.
- `ccs pricing list` shows each selected remote model in a `remote` column and retains local cache pricing columns.
- `ccs pricing watch` and `ccs pricing unwatch` previews show remote matches for every changed pattern.
- Remote network, HTTP, and response-format failures render `unavailable` and return successful list or watch output.
- `ccs pricing refresh` reports its remote retrieval error before a write plan is available.

## Completion Notes

- Added `pricing.patterns` as the persisted watched-pattern field.
- Added a shared five-second LiteLLM catalog reader with normalized `timeout`, `fetch failed`, `http STATUS`, and `invalid response` states.
- Added pattern-to-remote rows for pricing lists and watch previews.
- Kept refresh retrieval strict before generating a cache write plan.
- Added focused catalog, command, and unavailable-network tests.
