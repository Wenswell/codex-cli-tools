# ccs sync and proxy refinement plan

Status: completed

## Goal Input

```text
Implement docs/CCS_SYNC_PROXY_REFINEMENT_PLAN.md end to end. Follow its confirmed contracts, scope, and acceptance criteria. Update tests, user and developer documentation, CLI help, built dist files, package version, and commit the completed implementation.
```

## Goal And Scope

1. Add selective field replacement to `ccs sync` while keeping additive sync as the default.
2. Make proxy install and restore change only the routed provider's `base_url` in `config.toml`.
3. Add overview, token, and cost request-table views with totals across every upstream attempt.

Before this change, `ccs sync` added only missing TOML fields, proxy restore copied the complete install-time backup, and the request table used `session time up reas./code lat. size model error` with a 21-cell `request/upstream` model. Detailed `attempt_records` contained the required per-attempt facts while compact records omitted them.

## ccs sync

```text
ccs sync
ccs sync --replace TOML_PATH [--replace TOML_PATH ...]
ccs sync --replace all
```

- Plain `ccs sync` retains additive behavior.
- `--replace` accepts repeatable exact dotted leaf paths from `config/codex-config.toml`.
- `--replace all` selects every template leaf except `model_providers.*.base_url`; combining `all` with explicit paths is invalid.
- Duplicate explicit paths normalize to one selection.
- Selected fields receive the template value. Missing template fields remain additive in every form.
- Unselected existing values and local-only fields remain unchanged.
- Explicit `base_url` replacement, unknown paths, and non-leaf paths fail before preview.
- While proxy state exists, a replacement that changes `model_provider` fails before preview so local proxy routing stays active.
- `profiles.json` and `AGENTS.md` keep their current sync rules.
- Reuse the current line-based TOML helpers. General TOML parsing, formatting, comment handling, and parser replacement are deferred.

Preview prints the existing masked diff after these summaries:

```text
different: 5  model, service_tier, features.goals, features.fast_mode, features.new_field
update:    3  model, features.goals, features.new_field
```

- `different` lists template fields whose semantic values differ or are missing locally.
- `update` lists fields changed by this invocation.
- Both lines include counts and complete dotted-key lists; empty sets show `0`.
- Preview, exact `yes` confirmation, backup, application of the previewed result, and read-back verification follow the existing CCS write workflow.

## Proxy Routing

- Install reads the explicit `model_provider`, its existing `base_url`, and the current profile; proxy state must be absent.
- Install previews current/local URLs and backup path, requires exact `yes`, backs up config, starts and health-checks the proxy, then writes and verifies the local `base_url`.
- Restore resolves `profiles.current` when its preview is built and uses that profile's `baseURL`.
- Restore previews actual/target URLs and backup path, requires exact `yes`, backs up config, writes and verifies `state.provider_name`'s `base_url`, then stops the proxy and removes state.
- Backups remain available as manual recovery records.

Install and restore preserve every other `config.toml` field and leave `profiles.json` and authentication data unchanged. They reuse the current TOML helpers; broader TOML processing stays outside this work.

## Request Table Views

```text
ccs proxy [--once] [--history N] [--view overview|tokens|cost]
ccs proxy watch [--history N] [--view overview|tokens|cost]
```

- `overview` is the default. `--view` selects the initial view.
- TTY watch uses `v` to cycle `overview -> tokens -> cost -> overview`; `q` and `Ctrl-C` exit cleanly.
- Shared columns begin `session time up model` and end with the flexible `error` column.

```text
overview  session time up model reas./code lat. size error
tokens    session time up model input output cached error
cost      session time up model input$ output$ cached$ total$ error
```

The model column is 10 cells wide. Rendering compares original values before abbreviation and truncation:

| Request | Upstream | Display | Color |
| --- | --- | --- | --- |
| missing | missing | `-` | dim |
| present | missing | request model | normal |
| missing | present | upstream model | normal |
| equal | equal | upstream model | green |
| different | different | actual upstream model | red |

Display then abbreviates `gpt-` to `o` and truncates to 10 cells. Raw `gpt-5.6-sol` versus `o5.6-sol` therefore displays `o5.6-sol` in red.

## Usage And Cost

Compact request records add one `usage_attempts` entry for every proxy-owned upstream attempt in every mode, including attempts without usage and passthrough responses that expose usage. Each entry stores `attempt`, the three token fields, `pricing_model`, `pricing_model_source`, `pricing_tier`, and `pricing_tier_source`.

- Active and completed records project each detailed attempt exactly once; request schema and proxy health protocol versions increase.
- `pricing_model` is `upstream_model` when present, then `request_model`. Stored names are used for exact price lookup.
- Tier uses the first present source: response `service_tier`, request `service_tier`, then top-level config `service_tier` captured at request start.
- `default|standard` maps to `standard`; `fast|priority` maps to `fast`; unsupported selected values make that attempt's cost unavailable.
- Token columns sum all attempts only when every attempt has that token field; otherwise the column shows dim `-`.
- Token values use decimal `K` with at most one decimal place, from `0` through the confirmed maximum `999.9K`.
- The model column describes the current/final attempt; token and cost columns describe all attempts.

Cost uses existing `readModelPriceCache()` and `modelPriceParts()` rules with `profiles.json` pricing overrides. Price fields are USD per token. Calculate each attempt with its own model and tier, sum unrounded values, then format once:

```text
input$  = (input_tokens - cached_input_tokens) * input_price
cached$ = cached_input_tokens * cache_read_price
output$ = output_tokens * output_price
total$  = input$ + cached$ + output$
```

- Missing required usage or price renders that component and the total as `-`.
- `cached_input_tokens > input_tokens` renders input and total as `invalid`.
- Cost view reads the local price cache once per frame and performs no network refresh.
- USD format is `$0`, `<$0.0001`, up to four decimals below `$0.01`, and two decimals from `$0.01`.

## Implementation Plan

1. [x] Add sync argument parsing, selected-value replacement, field summaries, preview application, and focused tests.
2. [x] Change proxy install/restore planning and writes to the confirmed `base_url` behavior.
3. [x] Capture request tier and per-attempt usage/pricing attribution in compact records; increase request and health protocol versions.
4. [x] Add view parsing, three column sets, model rendering, token/cost aggregation, and `v`/`q` watch controls.
5. [x] Update CLI help, README, `docs/CCS_PROXY_SPEC.md`, and this document's status; build `dist` and increment the package patch version.
6. [x] Run focused and full tests, type checking, diff checks, manual CLI verification, and commit.

## Acceptance Criteria

- Sync default stays additive; one, repeated, and `all` replacements change exactly the planned template fields.
- Sync preserves local-only fields and runtime `base_url`; invalid selections fail before confirmation.
- Sync preview reports accurate `different` and `update` lists and applies the same previewed result after exact `yes`.
- Install and restore change only the selected `base_url`; restore uses `profiles.current` at restore time and preserves unrelated config edits.
- Restore verifies direct routing, stops the proxy, removes state, and retains backups.
- All three views use the confirmed columns; `--view`, `v`, and `q` work in their documented forms.
- Model tests cover missing, request-only, upstream-only, equal, different, abbreviation-before-display, width, and ANSI colors.
- Internal retry, transport retry, and passthrough fixtures record every upstream attempt exactly once.
- Token tests cover missing attempt data and `0`, `999`, `1K`, `1.2K`, `312.4K`, and `999.9K`.
- Cost tests cover per-attempt model/tier selection, cached subtraction, missing data/prices, invalid cached counts, shared standard/fast pricing, full-precision sums, and adaptive USD output.

## Verification

```bash
pnpm check
pnpm test
git diff --check
```

Manual verification covers sync default/selected/all, proxy install, all three one-shot/watch views, `v`/`q`, a profile switch while installed, and restore preserving unrelated TOML fields.

## Excluded

- General TOML parser, formatting, comment, multiline-value, and duplicate-key work.
- Compatibility or migration for previous proxy state/request schemas, and changes to shared pricing selection, remote refresh, or existing `ccs cost` formatting.
