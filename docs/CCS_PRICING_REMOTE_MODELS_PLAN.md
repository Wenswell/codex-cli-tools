# ccs pricing model selection plan

## Goal

Keep selected model names, price records, and update patterns in separate roles.

## Data Contract

- `pricing.models` in `~/.config/codex-tools/profiles.json` stores exact selected model names.
- `~/.cache/codex-tools/model-prices.json.models` stores exact model-name to LiteLLM price-record mappings.
- `MODEL_PATTERN...` is a command input for remote updates. It is expanded for `watch` and for `refresh` calls with model-pattern arguments.

## Command Contract

- `ccs pricing list` reads and prints local cached model prices without a network request.
- `ccs pricing list --remote` reads and prints the full remote LiteLLM model directory with the same price columns.
- `ccs pricing watch MODEL_PATTERN...` resolves remote matches, previews `pattern`, `model`, and price columns, then writes selected exact model names and their price records after exact `yes` confirmation.
- `ccs pricing unwatch MODEL...` previews local price rows and removes exact model names from `pricing.models` after exact `yes` confirmation. Cached prices remain available for local reports.
- `ccs pricing refresh` updates exact model names from `pricing.models`.
- `ccs pricing refresh MODEL_PATTERN...` expands the given remote patterns and updates their local price records.

## Plan

1. Split remote catalog retrieval from local cache update-plan construction.
2. Restore `pricing.models` as the exact selected-model configuration and remove persisted pattern handling.
3. Render all model rows with the common status, input, cache, and output price columns.
4. Change local and remote list modes to `list` and `list --remote`.
5. Build watch updates from one remote catalog request, then write both selected models and prices after confirmation.
6. Update tests, README, pricing specification, built files, and patch version.

## Acceptance

- Local lists run without a network request and show local price records.
- Remote lists show every remote model and normalized price columns.
- Watch previews include prices and no action column.
- A confirmed watch writes exact model names and matching remote price records.
- Remote request failures produce `unavailable` output for remote list and watch.

## Completion Notes

- Split `pricing.models`, cached price records, and temporary update patterns into separate roles.
- Added local and remote list modes with shared price columns.
- Added one-request watch plans that write exact selected models and prices together after confirmation.
- Added local unwatch previews and retained cache records for cost reporting.
- Added focused local, remote, unavailable-network, and confirmed-watch tests.
