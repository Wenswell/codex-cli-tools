# ccs pricing selection plan

## Goal

Keep the selected LiteLLM price snapshot in one local cache. Patterns and providers define the snapshot; cached models always satisfy both filters.

## Data Contract

`~/.config/codex-tools/model-prices.json` stores:

- `source`: LiteLLM directory URL.
- `fetchedAt`: timestamp of the last successful remote rebuild.
- `patterns`: normalized model-name patterns.
- `providers`: normalized LiteLLM `litellm_provider` names.
- `models`: exact model names mapped to their LiteLLM price records.

`patterns`, `providers`, and `models` are one selection state. `profiles.json.pricing` retains only manual price overrides. No selected-model configuration exists in `profiles.json`.

Remote selection first keeps model records with an exact `litellm_provider` in `providers`, then applies the pattern union. Entries without a string `litellm_provider`, including LiteLLM metadata, never enter the snapshot. An empty pattern set or provider set produces an empty model set.

## Command Contract

- `ccs pricing` prints cache state and the compact command list.
- `ccs pricing list` prints local snapshot models and price columns without a network request.
- `ccs pricing list --remote` fetches LiteLLM and prints only models from watched providers with the same price columns.
- `ccs pricing pattern` prints watched patterns and the local snapshot count matched by each pattern.
- `ccs pricing pattern watch PATTERN...` adds normalized patterns, fetches LiteLLM, previews the filtered remote model table, then writes the rebuilt cache after exact `yes`.
- `ccs pricing pattern unwatch PATTERN...` removes existing patterns, fetches LiteLLM, previews the filtered remote model table, then writes the rebuilt cache after exact `yes`.
- `ccs pricing provider` prints watched providers from the local cache without a network request.
- `ccs pricing provider add PROVIDER...` updates only local providers after exact `yes`.
- `ccs pricing provider remove PROVIDER...` updates only local providers after exact `yes`, then removes local models whose stored provider is no longer watched or whose name no longer matches a watched pattern.
- `ccs pricing refresh` fetches LiteLLM, rebuilds the complete provider-and-pattern snapshot, previews it, then writes after exact `yes`.

All model lists use `model`, `status`, `input/M`, `cache/M`, and `output/M` columns. Every write command prints its complete preview and states that no changes are written until `yes` is entered.

## Plan

1. Move selection state from `profiles.json.pricing.models` to `model-prices.json`.
2. Validate LiteLLM model records and expose provider-filtered catalog helpers.
3. Rebuild, rather than merge, the selected model snapshot after remote pattern operations and refreshes.
4. Add local provider commands and prune stale local model records on provider removal.
5. Replace the CLI help, tests, README, cost specification, built files, and package version.

## Acceptance

- The cache contains only models matching both watched patterns and watched providers.
- Remote lists and pattern operations exclude untracked providers and non-model catalog metadata.
- Pattern status and provider status are local-only reads.
- Provider add/remove remains local-only; removal preserves the cache invariant.
- Refresh, pattern watch, and pattern unwatch remove models absent from the newly selected remote catalog.
- Each changing command requires exact `yes` before it writes.

## Completion Notes

- Moved patterns, providers, and selected model prices into `model-prices.json`.
- Added structured LiteLLM catalog filtering on exact `litellm_provider` values and excluded non-model metadata.
- Replaced top-level watch and unwatch commands with pattern and provider command groups.
- Rebuilt model snapshots on pattern changes and refreshes; provider removal prunes local records without a remote request.
- Updated command help, README, cost specification, focused data-contract tests, built files, and package version.
