# ccs sync and proxy refinement plan

Status: confirmed plan, implementation pending

Confirmed: 2026-07-11

## Goal Input

The following text can be used directly as a Goal input:

```text
Implement docs/CCS_SYNC_PROXY_REFINEMENT_PLAN.md end to end. Treat its confirmed command contracts, data contracts, failure behavior, acceptance criteria, and scope boundaries as authoritative. Deliver ccs sync selective replacement, ccs proxy base_url-only install/restore behavior, overview/tokens/cost proxy views, all-attempt token and cost attribution, tests, README and detailed spec updates, built dist files, a package patch version, full verification, and one final commit.
```

## Goal

Deliver three related improvements:

1. Let `ccs sync` replace selected template-owned `config.toml` fields while retaining its additive default.
2. Make proxy install and restore update one `base_url` value, with restore targeting the profile selected at restore time.
3. Add compact proxy overview, token, and cost views with request-level totals across all proxy-owned upstream attempts.

The implementation keeps one source of truth for each field:

- `config/codex-config.toml` owns fields selected by `ccs sync --replace`.
- Profile switching owns the direct route URL from `profiles.current` to its profile `baseURL`.
- Proxy state `provider_name` identifies the materialized TOML route field, and `proxy_base_url` owns its installed value.
- `config.toml` materializes the current route through template-owned `model_provider` and runtime-owned active-provider `base_url` fields.
- Captured request, response, and request-start config facts own model comparison, token totals, and pricing attribution.
- `~/.config/codex-tools/model-prices.json` and documented pricing overrides own prices.

## Current Behavior

- `ccs sync` adds missing TOML keys and sections while preserving existing values.
- Profile sync already updates template profile `baseURL` values, preserves local API keys and local profiles, and preserves existing `current`, `toggle`, and `top` values.
- `~/.codex/AGENTS.md` already receives the complete packaged template.
- Proxy install updates the active provider `base_url` to the local proxy URL.
- Proxy restore copies the complete install-time backup over `config.toml`.
- Proxy request tables use `session time up reas./code lat. size model error`.
- Request records already preserve request model, upstream model, service tier, and input, output, and cached input token facts.

## Confirmed Contracts

### 1. ccs sync selective replacement

Command surface:

```text
ccs sync
ccs sync --replace TOML_PATH
ccs sync --replace TOML_PATH --replace TOML_PATH
ccs sync --replace all
```

Examples:

```bash
ccs sync --replace model
ccs sync --replace model --replace features.goals
ccs sync --replace all
```

Rules:

- Plain `ccs sync` keeps the current additive behavior.
- `--replace` is repeatable and accepts exact TOML dotted leaf paths.
- `all` selects every template-owned leaf field except the planned active provider `base_url`.
- `all` and explicit paths are separate forms. Combining them is an argument error.
- Duplicate explicit paths normalize to one selection.
- A missing option value, unknown path, section path, or path absent from the template fails before preview and confirmation.
- Selected fields use the complete physical assignment line from `config/codex-config.toml`, including indentation, spacing, quote style, and inline comment.
- Missing template fields continue to be added in every sync form.
- Existing template fields outside the selection preserve their local assignment.
- Keys and sections present only in the local file remain present.
- Before replacement, sync resolves the original active provider from an explicit existing top-level `model_provider`; when that field is absent, it uses the planned template provider. It captures that provider's route URL when a unique supported `base_url` assignment exists.
- After applying selected fields, including `model_provider`, sync resolves the planned active provider and writes the captured route URL into that provider's `base_url` assignment.
- Explicit replacement of the planned active provider `base_url` reports a focused ownership error, and `--replace all` excludes that assignment.
- While proxy lifecycle is `installed`, state `provider_name` and its `base_url` stay lifecycle-owned. Explicit `model_provider` replacement reports an ownership error, and `--replace all` preserves it. Direct routing permits `model_provider` replacement with route URL rebinding.
- `installing` and `restoring` lifecycle states block sync apply and require the lifecycle command to finish.
- When the resolved original active route URL is absent, sync uses a template `base_url` only when the planned active provider has that template assignment. Other missing active routes fail before preview.
- `profiles.json` keeps its current sync rules in this iteration.
- `AGENTS.md` keeps its complete-template sync rule.

This iteration extends the existing TOML key and section helpers. Supported selectable fields are unique, single-line assignments with bare keys under the top level or one standard section header. Duplicate keys, duplicate sections, multiline values, and assignments that cannot be located uniquely fail before preview. A parser dependency and general TOML rewrite are outside this plan.

Assignment equality compares the complete physical assignment line after CRLF normalization. Whitespace and inline-comment differences count as differences. Selective sync preview preserves these differences instead of applying the existing comment-stripping TOML preview normalization.

#### Preview

Preview prints compact field summaries before the existing masked unified diff:

```text
different: 5  model, service_tier, features.goals, features.fast_mode, features.new_field
update:    3  model, features.goals, features.new_field
```

Summary rules:

- `different` lists every template leaf field that is absent locally or whose complete assignment differs from the packaged template.
- `update` is the subset of `different` whose planned content adds or replaces the assignment.
- `different - update` is the preserved set. Its keys remain visible in `different`; the masked diff contains only planned file changes.
- Every label includes a count and a wrapped dotted-key list.
- Empty groups render a compact zero count.
- Secret masking applies to summaries and diffs.
- Preview states that files change only after exact `yes` confirmation.

The preview plan stores the exact input bytes and exact next bytes for every file. After confirmation, apply acquires the shared CCS route-write lock and verifies that every input still matches the preview snapshot before backup. A stale plan exits and requires a new preview. Apply then creates the existing timestamped backup, writes the exact planned bytes without recomputing sync, reads every file back, compares it byte-for-byte with the planned content, and prints backup, write, and verification results. A plan with zero file changes exits after the field summary and skips confirmation.

### 2. Proxy base_url ownership

Proxy lifecycle writes to `config.toml` are limited to one existing quoted `base_url` string value. The provider-specific updater scans the original text, locates exactly one supported string-content span, and replaces that span by its original byte offsets while preserving quote delimiters. It never reconstructs the file by splitting and joining lines. Zero matches, multiple matches, and unsupported assignment syntax fail during preview. The update preserves CRLF form, indentation, quote style, and inline comments byte-for-byte.

Proxy state adds:

```text
state_schema_version
lifecycle: installing | installed | restoring
```

Only `installed` state allows status/watch to auto-start the proxy or profile switching to resolve the local proxy URL. `installing` and `restoring` are visible status values and block automatic start. The state schema and health protocol increment together, and readers require the current schema. The release has an explicit upgrade precondition: users restore with the previously installed CCS version before installing this version. A current-version reader that encounters legacy state rejects it and prints the state/config paths plus the exact previous-version restore instruction; it never interprets or mutates legacy state.

`ccs sync`, profile switching, proxy install, and proxy restore use one exclusive CCS route-write lock while revalidating and changing route files or lifecycle state. Confirmation happens before lock acquisition. Status rendering and request forwarding stay outside this lock.

#### Install

`ccs proxy install` performs this sequence:

1. Require an existing Codex config with an explicit non-empty top-level `model_provider`.
2. Require exactly one supported `base_url` assignment in that provider section.
3. Require `profiles.current` and a current profile with non-empty `baseURL` and `apiKey`.
4. Require absent proxy state and a current `base_url` different from the configured local proxy URL.
5. Build one immutable plan containing config bytes, provider, current profile identity, current URL, local proxy URL, state path, and timestamped backup path.
6. Print the plan and require exact `yes` confirmation.
7. Acquire the route-write lock and revalidate config bytes, provider, current profile identity, current profile values, and absent state before any side effect.
8. Back up only the current config under `~/.config/codex-tools/backups/ccs-proxy-<timestamp>/config.toml`.
9. Write `installing` state, start the owned background runtime, and verify the current health protocol.
10. Atomically replace the planned provider's `base_url` value with the local proxy URL and verify exact planned content.
11. Commit lifecycle state to `installed`.

Failure behavior:

- Backup failure leaves state, process, and config unchanged.
- Startup or health failure stops the owned process, removes its PID/start lock/state, and retains backup and runtime diagnostics.
- Config write failure preserves the original file, stops the owned process, removes state, and retains diagnostics.
- Verification or lifecycle commit failure rolls config back from the in-memory preview snapshot and verifies that rollback before process/state cleanup.
- A failed rollback or cleanup retains `installing` state, blocks automatic start, and reports the exact state, config, backup, and runtime log paths.
- Every lifecycle state makes repeated install fail before backup, process, state, or config changes.
- `ccs proxy restore` is the single recovery entrypoint for retained `installing` state. It builds a new immutable recovery plan from the actual config, the retained provider identity, and the then-current profile; after confirmation it writes and verifies that direct URL, stops the owned runtime, and removes state.

#### Restore

For `installed` and `installing`, `ccs proxy restore` defines the restore-time current profile as the profile named by `profiles.current` when the restore preview plan is built. A `restoring` continuation keeps the target persisted by the original restore plan.

Restore performs this sequence:

1. Require current-schema `installed`, `installing`, or `restoring` state and an existing Codex config.
2. Require exactly one supported `base_url` assignment in the state `provider_name` section.
3. For `installed` or `installing`, require `profiles.current`, its profile entry, and a non-empty `baseURL` different from `state.proxy_base_url`. For `restoring`, require complete persisted restore transaction fields.
4. For `installed` or `installing`, build one immutable plan containing config bytes, lifecycle identity, actual current URL, state proxy URL, current profile identity, target direct URL, and timestamped backup path. For `restoring`, use its persisted target identity and build a new immutable continuation plan from the actual config.
5. Print the plan and require exact `yes` confirmation.
6. Acquire the route-write lock and revalidate config bytes and lifecycle identity fields. An initial restore also revalidates current profile identity and target `baseURL`; a continuation revalidates its persisted target and phase. Continuously changing metrics are excluded from this identity check.
7. Back up only the current config under `~/.config/codex-tools/backups/ccs-proxy-<timestamp>/config.toml`.
8. Commit lifecycle state to `restoring`, including `restore_profile_name`, `restore_base_url`, `restore_phase`, and the before/after config hashes required for an idempotent continuation. This blocks status/watch restart and proxy URL resolution.
9. When the phase requires it, atomically replace the planned provider's `base_url` value with the plan target `baseURL` and verify exact planned content.
10. Stop the owned background runtime and verify both health unavailability and owned PID exit.
11. Remove proxy state.

Failure behavior:

- Preflight, confirmation, or backup failure leaves lifecycle, process, and config unchanged.
- Direct URL write failure returns lifecycle to `installed` only after verifying that config still equals the original preview snapshot; an uncertain file remains `restoring` and blocks automatic start.
- Direct URL verification failure uses the in-memory preview snapshot for transactional rollback. A verified rollback returns lifecycle to `installed`; an uncertain rollback remains `restoring`.
- Shutdown or state removal failure retains verified direct routing and `restoring` state for an explicit restore retry.
- Shutdown succeeds only after the health endpoint is unavailable and the owned PID has exited.
- A restore retry accepts `restoring`, verifies that the actual config matches the persisted before or after route state, advances from the persisted `restore_phase`, and prints a fresh continuation preview. It never repeats a verified route write or runtime stop. Any other config state fails with an explicit manual-inspection error and preserves state.

Each backup is an immutable safety and audit copy of `config.toml`. Install and restore retain it on success and failure. Automated lifecycle behavior uses the in-memory plan and current profile facts; backup content remains available for explicit manual recovery.

Proxy lifecycle state keeps current runtime facts and adds transaction facts only while a transition is active:

- Stable fields are `state_schema_version`, `lifecycle`, `installed_at`, `provider_name`, `proxy_base_url`, `mode`, `listen_host`, `listen_port`, and `metrics`.
- `restoring` additionally requires `restore_profile_name`, `restore_base_url`, `restore_phase`, `restore_before_hash`, and `restore_after_hash`; these fields disappear when state is removed or a verified rollback returns lifecycle to `installed`.
- Remove `original_base_url`, persistent `backup_path`, `codex_config_path`, and `profile_order`. Backup paths remain command results and transition diagnostics rather than routing inputs.
- Resolve status upstream display directly from current `profiles.current`.

`ccs proxy restore` continues to stop the runtime and remove state. `ccs proxy stop` continues to select passthrough mode while retaining local proxy routing.

### 3. Proxy request table views

Display view and proxy intervention mode remain separate concepts. `mode` continues to mean `recovery`, `intercept`, or `passthrough`. `view` controls table columns.

Command surface:

```text
ccs proxy [--once] [--history N] [--view overview|tokens|cost]
ccs proxy watch [--history N] [--view overview|tokens|cost]
```

Rules:

- `overview` is the default view.
- Status options accept any order within their command form.
- `--view` sets the initial view for one-shot and watch output.
- In TTY watch mode, `v` cycles `overview -> tokens -> cost -> overview` and repaints immediately.
- In TTY watch mode, `q` exits.
- Terminal cleanup restores cursor visibility, the main screen, stdin raw mode, and prior input listeners after `q`, signals, and rendering errors.
- Non-TTY watch output renders once and leaves stdin untouched.
- The watch footer names the current view and compact `v`/`q` controls.

Shared columns remain fixed across views:

```text
session time up model ... error
```

View-specific columns:

```text
overview  session time up model reas./code lat. size error
tokens    session time up model input_tokens output_tokens cached_input_tokens error
cost      session time up model input$ output$ cached$ total$ error
```

The final `error` column remains flexible. Fixed data columns remain right-aligned.

### 4. Model display

The model column width changes from the current combined width to 10 cells and moves directly after `up`.

Model rendering follows one order in all three views:

1. Compare original stored request and upstream values exactly and case-sensitively.
2. Select the upstream value when present; select the request value when the upstream value is absent.
3. Apply the display-only `gpt-` to `o` abbreviation.
4. Truncate the visible value to 10 terminal cells.
5. Apply semantic color from the original comparison result.

| Request model | Upstream model | Display | Color |
| --- | --- | --- | --- |
| missing | missing | `-` | dim |
| present | missing | request model | normal |
| missing | present | upstream model | normal |
| equal | equal | upstream model | green |
| different | different | upstream model | red |

Examples:

```text
request=gpt-5.6-sol upstream=missing       -> o5.6-sol
request=gpt-5.6-sol upstream=gpt-5.6-sol   -> green o5.6-sol
request=gpt-5.6-sol upstream=gpt-5.6-terra -> red o5.6-terra
```

Truncation runs after abbreviation and before color application. Stored request and upstream model fields keep their original values.

Visible equality after abbreviation never changes comparison. For example, request `gpt-5.6-sol` and upstream `o5.6-sol` display the upstream value `o5.6-sol` in red because their original values differ. Active rows begin with request-only normal color, change to green or red when upstream metadata arrives, and return to request-only normal color when a retry clears attempt-scoped upstream metadata.

### 5. All-attempt usage facts

Token and cost views aggregate every proxy-owned upstream attempt, including transport attempts, attempts rejected by a guard, and attempts followed by an internal retry.

The compact request record adds a bounded `usage_attempts` array as a one-to-one compact projection of every `attempt_records` entry. Each proxy-owned attempt has one entry keyed by attempt number and sorted ascending, including attempts without a parsed upstream response. Missing facts remain `null`, and projection upsert prevents duplicate attempts.

The maximum length is derived from the shared retry policy:

```text
(GUARD_RETRY_ATTEMPTS + 1) * (FETCH_FAILED_TRANSPORT_RETRIES + 1)
= (3 + 1) * (1 + 1)
= 8
```

State normalization enforces the same bound. Each entry stores normalized facts needed for stable historical rendering:

```text
attempt
input_tokens
output_tokens
cached_input_tokens
pricing_model: string | null
pricing_model_source: upstream_model | request_model | null
pricing_tier: standard | fast | null
pricing_tier_source: response | request | config | null
```

Pricing model attribution for each attempt is:

```text
upstream_model ?? request_model
```

`pricing_model_source` records `upstream_model` or `request_model`. Display abbreviations and alias inference never participate in price lookup.

An available upstream model is authoritative, including a model absent from the price cache. Request-model attribution applies only when the upstream model fact is absent.

Pricing tier attribution is captured when the request runs and remains stable for historical rows. "Present" means the source supplied a non-null value; validation happens only after source selection:

1. Select the first present source from attempt response `service_tier`, incoming request `service_tier`, and the Codex config tier captured when the request starts.
2. Map `default` and `standard` to `standard`.
3. Map `fast` and `priority` to `fast`.
4. Keep an unsupported selected value as unknown. A present unsupported higher-priority value does not advance to the next source.

The existing top-level model and token fields describe the final observed upstream response attempt used to produce the request outcome. The model column describes the current or final attempt. `usage_attempts` owns cumulative attempt totals and cost calculations. JSONL `attempt_records` retains detailed timing and response facts.

After each attempt inspection or completion, and before retry or final forwarding, active state rebuilds `usage_attempts` from the shared attempt records. Before compact history and JSONL writes, the projection is rebuilt once more from the same records. This gives active and history one exactly-once attempt basis.

The request schema version increments. Existing records keep their stored facts; records without `usage_attempts` render token and cost aggregates as unavailable.

### 6. Token view

Each token column sums its field across `usage_attempts`. An aggregate is numeric only when the array is non-empty and every entry contains an explicit non-negative integer for that field. Any `null` makes that aggregate unavailable. Explicit zero participates in the sum. A known subset is never presented as the all-attempt total.

The confirmed `999.9K` bound applies to each displayed request aggregate. Formatting uses decimal `K` units with at most one decimal place:

```text
0
123
1K
1.2K
312.4K
999.9K
```

A missing aggregate renders dim `-`. Explicit zero remains `0`.

### 7. Cost view

Only the cost view reads pricing. It reads the shared pricing cache once per frame and shares that result across active and history rows. Overview and token views remain independent of pricing files. Price sources remain aligned with `ccs cost` and `ccs models`:

- `~/.config/codex-tools/model-prices.json`
- built-in supplemental model prices
- `profiles.json.pricing.overrides`

The renderer performs exact `pricing_model` lookup. It reads the current config path locally; `ccs pricing` owns remote refresh. Cache read or validation failure produces a visible pricing error and missing cost cells while the monitor remains usable.

Model and tier attribution remain stored historical facts. Dollar values are derived from the current price cache on every cost frame, so a price refresh or override update changes historical row amounts.

Fast pricing follows the shared catalog contract. A model with no priority price fields uses its standard price schedule for fast requests. Once any priority price field exists, all fast components use priority fields and each absent required priority component produces `missing`; individual standard fields do not fill a partial priority schedule. Every price value must be finite and non-negative. The shared pricing validation, tests, and cost documentation adopt the finite and non-negative requirement.

Prices are USD per million tokens. For each usage attempt:

```text
input$  = (input_tokens - cached_input_tokens) * input_price / 1_000_000
cached$ = cached_input_tokens * cache_read_price / 1_000_000
output$ = output_tokens * output_price / 1_000_000
total$  = input$ + cached$ + output$
```

Request columns calculate each attempt at full numeric precision, sum the unrounded per-attempt components, and format only the final column values.

Validity rules:

- A component displays money only when every attempt has the token facts and prices required for that component; otherwise that component renders dim `-`. Input cost requires both input and cached-input facts, cached cost requires cached-input facts, and output cost requires output facts.
- Any missing component makes `total$` render red `missing` unless an invalid token relation is present; `invalid` has precedence.
- Any attempt with `cached_input_tokens > input_tokens` makes `input$` and `total$` render red `invalid`; independently valid cached and output components remain visible.
- A component with an explicit zero billable token count costs `$0` and requires no price for that component.
- An attempt whose input, cached input, and output tokens are all explicit zero contributes `$0` without model, tier, or prices.
- Passthrough responses retain their current direct-forwarding behavior; their null usage facts make token and cost aggregates unavailable.

Adaptive USD formatting:

```text
$0
<$0.0001
$0.0012
$1.23
```

Rules:

- Zero renders `$0`.
- Positive values below `$0.0001` render `<$0.0001`.
- Values below `$0.01` use up to four decimals.
- Values from `$0.01` use two decimals.

The adaptive formatter is a proxy table formatter built on shared numeric price helpers. Existing `ccs cost` report formatting remains unchanged.

## Implementation Plan

1. [ ] Add `ccs sync --replace` parsing, exact dotted-path selection, assignment replacement, planned-provider route URL preservation, field summaries, immutable preview, verification, and focused tests.
2. [ ] Add a provider-specific `base_url` value updater that preserves surrounding TOML text; keep the broader TOML parser work outside this change.
3. [ ] Redesign proxy install and restore around the shared route-write lock, lifecycle state machine, immutable plans, backups, atomic writes, read-back verification, repeated-install rejection, and recoverable transition states.
4. [ ] Add request-tier extraction, request-start config tier capture, per-attempt model/tier attribution, and compact `usage_attempts` persistence.
5. [ ] Add overview, tokens, and cost column definitions, model selection/color rules, token and USD formatters, shared catalog price validation, and one price-cache read per frame.
6. [ ] Extend the shared live-view controller with scoped key handling and complete terminal/input cleanup; wire `v` and `q` into proxy watch.
7. [ ] Update CLI help, no-argument command hints, README, `docs/CCS_PROXY_SPEC.md`, this plan's status, and reusable engineering preferences when the implementation yields a general rule.
8. [ ] Build `dist`, increment the package patch version, run the full test suite, inspect the final diff, and commit the completed implementation.

## Acceptance Criteria

### Sync

- Plain `ccs sync` remains additive.
- One and multiple `--replace` paths update only selected template assignments.
- Under direct routing, `--replace all` updates every differing template assignment except runtime `base_url`.
- Under installed proxy routing, `--replace all` also preserves lifecycle-owned `model_provider`.
- Replacing `model_provider` preserves the captured runtime route URL under the planned active provider.
- Local-only TOML keys, local profiles, API keys, current profile state, usage configuration, pricing overrides, and top configuration remain present.
- Preview reports `different` and `update` counts and dotted-key lists before the masked diff.
- Comment-only and whitespace-only assignment changes appear consistently in the key summary and diff.
- Duplicate keys, duplicate sections, multiline values, and ambiguous assignments fail before preview.
- Invalid selections fail before any write or confirmation.
- Exact `yes` applies the immutable preview bytes under the route-write lock, creates a backup, and verifies written files byte-for-byte.
- Config changes after preview produce a stale-plan error before backup or write.

### Proxy lifecycle

- Install changes only the recorded provider's `base_url` value after proxy health succeeds.
- Install requires a usable current profile, a unique provider URL, absent state, and a current URL distinct from the local proxy URL.
- Install startup failure keeps the original config, retains diagnostics, and clears owned runtime state.
- Repeated install fails before backup, process, state, or config changes.
- Restore reads `profiles.current` at restore time.
- Switching current profile while proxy is installed changes the later restore target.
- Restore preserves every config byte outside the selected `base_url` value.
- Restore leaves auth and profiles content unchanged, stops the runtime, verifies the target URL, and removes proxy state.
- `installing` and `restoring` states prevent status/watch restart and proxy URL resolution.
- A stale config, state identity, or restore target after confirmation fails before backup or mutation.
- Restore rejects a current profile target equal to the local proxy URL.
- Direct-route write failure, verification failure, shutdown failure, and state-removal failure each retain the documented recoverable lifecycle state.
- `ccs proxy restore` recovers retained `installing` state and resumes persisted `restoring` phases idempotently through a fresh confirmed preview.
- Shutdown verification requires both an unavailable health endpoint and an exited owned PID.
- Current state schema and health protocol are required; legacy state receives an explicit pre-upgrade restore instruction.

### Views and records

- Overview columns use `session time up model reas./code lat. size error`.
- Token and cost views use the confirmed columns and preserve alignment at supported terminal widths.
- `--view` works for default status, `--once`, and `watch`; status option order is stable.
- `v` cycles views immediately and `q` restores terminal and input state.
- Model rendering covers both missing, request-only, upstream-only, equal, and different cases with semantic ANSI assertions.
- Different models display the actual upstream model in red.
- Raw request `gpt-5.6-sol` and upstream `o5.6-sol` compare as different and display the upstream value in red even though abbreviation makes the visible text equal.
- Active model display transitions from request-only normal color to equal green or different red, then returns to request-only normal when retry state clears upstream metadata.
- Token formatting covers `0`, `999`, `1000`, `1200`, `312400`, `999900`, and missing values.
- Internal and transport retry fixtures prove that `usage_attempts` includes every proxy-owned attempt exactly once, including entries with null usage facts.
- Token aggregates require explicit non-negative values from every attempt; a mixed known/null field renders unavailable.
- Mixed-attempt model and tier fixtures prove per-attempt price selection before request totals.
- Pricing model attribution proves upstream-first and request-model attribution when upstream model is absent.
- Pricing tier attribution proves response, request, and request-start config sources, exact supported mappings, and unknown status for a present unsupported higher-priority value.
- Overview and token views run independently from pricing; cost reads one cache per frame for active and history together.
- Historical attribution remains fixed while price refresh and override updates recompute visible historical dollars.
- Cost tests cover cached-input subtraction, zero cached input, missing prices, missing facts, red invalid input when cached input exceeds input, standard prices, complete priority prices, partial priority prices, and adaptive USD formatting.
- Cost component tests keep independently known values visible, mark missing components with `-`, and mark incomplete totals as red `missing`.
- Fast pricing uses the complete standard schedule when the model has no priority schedule; a partial priority schedule stays partial and produces missing components. All stored prices require finite non-negative values.
- Per-attempt calculations retain full precision through summation and format only request totals.
- Passthrough records keep token and cost values unavailable.

## Verification

```bash
pnpm check
pnpm test
git diff --check
git status --short
```

Manual verification uses a temporary `HOME` and covers:

```bash
ccs sync
ccs sync --replace model
ccs sync --replace all
ccs proxy install
ccs proxy --view overview
ccs proxy --view tokens
ccs proxy --view cost
ccs proxy watch --view tokens
ccs proxy restore
```

The manual proxy flow switches `profiles.current` after install and confirms that restore selects the new current profile URL while preserving unrelated `config.toml` edits.

## Scope Boundaries

- This iteration reuses the existing TOML key and section handling. Parser dependencies and general TOML syntax work are deferred.
- `profiles.json` schema cleanup and removal of unknown historical fields are deferred.
- Price refresh remains owned by `ccs pricing`.
- Raw request and response payload storage remains outside proxy status and pricing work.
- Price lookup uses exact stored model names. Model aliases remain display-only.
