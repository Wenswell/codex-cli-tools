# ccs cost spec

Status: implemented

## Goal

`ccs cost` reports local and central Codex session token and cost usage.

The report answers these questions:

- Daily, weekly, monthly totals: how much Codex usage happened in each period.
- Project totals: which projects consumed the most usage in the selected range.
- One project by day: how one project changed over time.
- Model totals: how token categories and costs differ by model.
- One day by time: which time blocks consumed the most usage on a day.
- One day by project: which projects consumed the most usage on a day.

The user-facing metric set is intentionally small:

```text
input  output  cached  input$  output$  cached$  total$
```

`input` is uncached input. Terminal reports show the seven columns listed above.

## Command Surface

```bash
ccs pricing
ccs pricing list [--remote]
ccs pricing pattern
ccs pricing pattern watch PATTERN...
ccs pricing pattern unwatch PATTERN...
ccs pricing provider
ccs pricing provider add PROVIDER...
ccs pricing provider remove PROVIDER...
ccs pricing refresh
ccs cost
ccs cost daily
ccs cost weekly
ccs cost monthly
ccs cost projects
ccs cost project PROJECT
ccs cost models
ccs cost day YYYY-MM-DD
ccs cost push
ccs cost central
ccs cost central daily
ccs cost central weekly
ccs cost central monthly
ccs cost central projects
ccs cost central project PROJECT
ccs cost central models
ccs cost central day YYYY-MM-DD
```

`ccs cost` without arguments prints the local session source, pricing cache, central status URL, SSH upload target, timezone, pricing speed, and compact command/options hints. Its command hint lists only the `ccs cost` command family. Local reports require an explicit subcommand such as `ccs cost daily`.

`ccs cost push` uploads this machine's normalized token-event facts to the LAN server over SSH. `ccs cost central` reads the first reachable configured `top.stateUrls` server and prints uploaded machine status. `ccs cost central REPORT` renders the server-side aggregate report from uploaded machine snapshots.

`ccs pricing` prints local pricing selection state. `ccs pricing list` prints local snapshot models and prices without a network request. `ccs pricing list --remote` prints LiteLLM models filtered to watched providers. Both tables use `model`, `status`, `input/M`, `cache/M`, and `output/M`. `ccs pricing pattern` prints watched patterns with local matched-model counts. `ccs pricing pattern watch PATTERN...` and `ccs pricing pattern unwatch PATTERN...` fetch LiteLLM, preview the full provider-and-pattern filtered model table, then write the rebuilt snapshot after exact `yes`. `ccs pricing provider` prints watched providers. `provider add PROVIDER...` and `provider remove PROVIDER...` modify local selection state after exact `yes`; removal prunes local model records that no longer satisfy both filters. `ccs pricing refresh` fetches LiteLLM and rebuilds every selected model and price from watched patterns and providers after exact `yes`. Remote request failures render `unavailable` and write nothing.

Options:

```text
--since YYYY-MM-DD      inclusive start date
--until YYYY-MM-DD      inclusive end date
--timezone IANA_NAME    date grouping timezone; defaults to the system timezone
--bucket DURATION       time bucket for ccs cost day; default 1h
--json                  print stable JSON
--raw                   print full token counts and decimal costs
--speed auto|standard|fast
```

Supported bucket durations:

```text
15m
30m
1h
2h
```

`--speed auto` reads the active Codex config and applies fast pricing when the configured service tier requires it. `--speed standard` and `--speed fast` force the pricing mode.

`ccs models` uses the same pricing cache and speed resolution for visibility. Terminal output adds one `price` column next to each provider column. JSON output includes top-level pricing metadata and a per-profile `pricing` object keyed by model id.

Pricing status values:

```text
ok       input, output, and cache-read pricing are present
partial  input and output pricing are present, cache-read pricing is missing
missing  base input or output pricing is missing
```

## Reports

### Daily Totals

Command:

```bash
ccs cost daily --since 2026-05-01 --until 2026-05-30
```

Output:

```text
ccs cost daily  2026-05-01..2026-05-30  timezone Asia/Shanghai
date        input  output  cached  input$  output$  cached$  total$
2026-05-01  1.2M   46K     3.4M    $1      $1       $0       $2
2026-05-02  2.3M   57K     4.5M    $2      $1       $0       $3
----------------------------------------------------------------
total       3.5M   103K    7.9M    $3      $2       $0       $5
```

### Weekly Totals

Command:

```bash
ccs cost weekly --since 2026-05-01 --until 2026-05-30
```

Weeks start on Monday. The `week` value is the local date of the week start.

```text
week        input  output  cached  input$  output$  cached$  total$
2026-04-27  3.5M   90K     6.2M    $3      $2       $1       $6
2026-05-04  4.6M   101K    8.1M    $4      $2       $1       $7
----------------------------------------------------------------
total       8M     191K    14M     $7      $4       $2       $13
```

### Monthly Totals

Command:

```bash
ccs cost monthly --since 2026-01-01
```

```text
month    input  output  cached  input$  output$  cached$  total$
2026-01  12M    457K    25M     $12     $5       $2       $19
2026-02  23M    568K    41M     $23     $6       $4       $33
-------------------------------------------------------------
total    35M    1M      66M     $35     $11      $6       $52
```

### Project Totals

Command:

```bash
ccs cost projects --since 2026-05-01 --until 2026-05-30
```

```text
project                                      input  output  cached  input$  output$  cached$  total$
~/Documents/repos/codex-cli-tools            2.3M   57K     4.5M    $2      $1       $0       $3
~/Documents/repos/work-doc-organize          1.2M   46K     3.4M    $1      $1       $0       $2
-----------------------------------------------------------------------------------------
total                                        3.5M   103K    7.9M    $3      $2       $0       $5
```

Project sorting defaults to highest cost first.

### One Project By Day

Command:

```bash
ccs cost project ~/Documents/repos/codex-cli-tools --since 2026-05-01 --until 2026-05-30
```

```text
ccs cost project  ~/Documents/repos/codex-cli-tools
date        input  output  cached  input$  output$  cached$  total$
2026-05-01  123K   4.6K    420K    $1      $1       $0       $2
2026-05-02  235K   5.7K    680K    $2      $1       $0       $3
----------------------------------------------------------------
total       358K   10K     1.1M    $3      $2       $0       $5
```

### Models

Command:

```bash
ccs cost models --since 2026-05-01 --until 2026-05-30
```

Rows aggregate token and cost categories independently for each model. Unrounded complete totals sort from highest to lowest. Incomplete-price rows follow and sort by model name.

```text
model       input  output  cached  input$  output$  cached$  total$
gpt-5.5     1.2M   46K     3.4M    $6      $3       $1       $10
gpt-5-mini  2.3M   57K     4.5M    $3      $2       $1       $6
-----------------------------------------------------------------
total       3.5M   103K    7.9M    $9      $5       $2       $16
```

### One Day By Time

Command:

```bash
ccs cost day 2026-05-29 --bucket 1h
```

The day report prints a total row, then time buckets, then projects.

```text
ccs cost day  2026-05-29  bucket 1h  timezone Asia/Shanghai
total  input 3.5M  output 103K  cached 7.9M  total$ $5

by time
time         input  output  cached  input$  output$  cached$  total$
09:00-10:00  1.2M   46K     3.4M    $1      $1       $0       $2
10:00-11:00  2.3M   57K     4.5M    $2      $1       $0       $3

by project
project                                      input  output  cached  input$  output$  cached$  total$
~/Documents/repos/codex-cli-tools            2.3M   57K     4.5M    $2      $1       $0       $3
~/Documents/repos/work-doc-organize          1.2M   46K     3.4M    $1      $1       $0       $2
```

### One Day By Project

`ccs cost day YYYY-MM-DD` includes the one-day project table by default. This command owns the one-day project detail view.

## JSON Output

JSON uses stable lower camel case keys.

### Daily

```json
{
  "version": 2,
  "report": "daily",
  "range": {
    "since": "2026-05-01",
    "until": "2026-05-30",
    "timezone": "Asia/Shanghai"
  },
  "rows": [
    {
      "date": "2026-05-01",
      "inputTokens": 1234567,
      "outputTokens": 45678,
      "cachedInputTokens": 3456789,
      "inputCostUSD": 1.23,
      "outputCostUSD": 0.46,
      "cachedCostUSD": 0.35,
      "costUSD": 2.04,
      "missingPricingModels": []
    }
  ],
  "totals": {
    "inputTokens": 1234567,
    "outputTokens": 45678,
    "cachedInputTokens": 3456789,
    "inputCostUSD": 1.23,
    "outputCostUSD": 0.46,
    "cachedCostUSD": 0.35,
    "costUSD": 2.04,
    "missingPricingModels": []
  }
}
```

### Projects

```json
{
  "version": 2,
  "report": "projects",
  "range": {
    "since": "2026-05-01",
    "until": "2026-05-30",
    "timezone": "Asia/Shanghai"
  },
  "rows": [
    {
      "project": "/home/ilove/Documents/repos/codex-cli-tools",
      "inputTokens": 2345678,
      "outputTokens": 56789,
      "cachedInputTokens": 4567890,
      "inputCostUSD": 2.34,
      "outputCostUSD": 0.57,
      "cachedCostUSD": 0.46,
      "costUSD": 3.37,
      "missingPricingModels": []
    }
  ],
  "totals": {
    "inputTokens": 2345678,
    "outputTokens": 56789,
    "cachedInputTokens": 4567890,
    "inputCostUSD": 2.34,
    "outputCostUSD": 0.57,
    "cachedCostUSD": 0.46,
    "costUSD": 3.37,
    "missingPricingModels": []
  }
}
```

### Models

```json
{
  "version": 2,
  "report": "models",
  "range": {
    "since": "2026-05-01",
    "until": "2026-05-30",
    "timezone": "Asia/Shanghai"
  },
  "rows": [
    {
      "model": "gpt-5.5",
      "inputTokens": 1234567,
      "outputTokens": 45678,
      "cachedInputTokens": 3456789,
      "inputCostUSD": 1.23,
      "outputCostUSD": 0.46,
      "cachedCostUSD": 0.35,
      "costUSD": 2.04,
      "missingPricingModels": []
    }
  ],
  "totals": {
    "inputTokens": 1234567,
    "outputTokens": 45678,
    "cachedInputTokens": 3456789,
    "inputCostUSD": 1.23,
    "outputCostUSD": 0.46,
    "cachedCostUSD": 0.35,
    "costUSD": 2.04,
    "missingPricingModels": []
  }
}
```

### Day Detail

```json
{
  "version": 2,
  "report": "day",
  "date": "2026-05-29",
  "timezone": "Asia/Shanghai",
  "bucket": "1h",
  "totals": {
    "inputTokens": 12345678,
    "outputTokens": 456789,
    "cachedInputTokens": 34567890,
    "inputCostUSD": 12.34,
    "outputCostUSD": 4.57,
    "cachedCostUSD": 3.46,
    "costUSD": 20.37,
    "missingPricingModels": []
  },
  "timeBuckets": [
    {
      "start": "09:00",
      "end": "10:00",
      "inputTokens": 1234567,
      "outputTokens": 45678,
      "cachedInputTokens": 3456789,
      "inputCostUSD": 1.23,
      "outputCostUSD": 0.46,
      "cachedCostUSD": 0.35,
      "costUSD": 2.04,
      "missingPricingModels": []
    }
  ],
  "projects": [
    {
      "project": "/home/ilove/Documents/repos/codex-cli-tools",
      "inputTokens": 2345678,
      "outputTokens": 56789,
      "cachedInputTokens": 4567890,
      "inputCostUSD": 2.34,
      "outputCostUSD": 0.57,
      "cachedCostUSD": 0.46,
      "costUSD": 3.37,
      "missingPricingModels": []
    }
  ]
}
```

## Data Sources

Primary index:

```text
~/.codex/state*.sqlite
  threads.id
  threads.cwd
  threads.rollout_path
  threads.created_at_ms
  threads.updated_at_ms
  threads.model
```

Usage events:

```text
~/.codex/sessions/**/*.jsonl
  event_msg payload.type=task_started
  event_msg payload.type=thread_rolled_back
  event_msg payload.type=token_count
```

The SQLite index provides project attribution. JSONL files provide request-level token events.

The command uses the newest `state*.sqlite` under `~/.codex`.

## Central Cost

Client upload:

```bash
ccs cost push
```

The upload target is fixed to:

```text
ravvss@10.126.126.1:/home/ravvss/.cache/codex-tools/ccs-cost
```

Each machine writes one latest snapshot named from `user@host`. The snapshot contains only normalized token-event facts:

```text
timestampMs
project
model
inputTokens
cachedInputTokens
outputTokens
reasoningOutputTokens
totalTokens
```

Prompt text, response text, and raw session JSONL lines are not uploaded. Snapshot upload uses a temporary remote file followed by an atomic rename to the machine's final snapshot path.

Install or update every reporting machine from the GitHub source:

```bash
pnpm add -g github:Wenswell/codex-cli-tools
```

`ccs cost push` is intended for unattended timers. Linux user services should run the global `ccs cost push` command with pnpm on PATH and `OnCalendar=*-*-* *:00:00` for one upload at every hourly boundary. macOS LaunchAgents should use the absolute pnpm shim path, such as `/Users/wswensw/Library/pnpm/ccs`, configure 24 `StartCalendarInterval` entries at minute `0`, and include this PATH:

```text
/opt/homebrew/bin:/Users/wswensw/Library/pnpm:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

Server endpoints are part of `ccs s server`:

```text
GET /ccs/cost/status
GET /ccs/cost/report
POST /ccs/cost/refresh
POST /ccs/top/pause
POST /ccs/top/resume
POST /ccs/top/reset
```

`/ccs/cost/status` returns uploaded machine summaries. `/ccs/cost/report` accepts `report`, `since`, `until`, `timezone`, `bucket`, `speed`, `project`, and `day` query parameters. Both transports use schema version `2` and the same metric fields as local `ccs cost --json`. The HTTP report envelope additionally includes `source`, `generatedAt`, and internal row `key` fields; the CLI JSON maps each row key to `date`, `week`, `month`, `project`, or `model`. Every metric record includes `missingPricingModels`. `/ccs/cost/refresh` schedules derived-data generation after a five-minute debounce. Multiple uploads inside the debounce window delay the refresh, so a group of hourly uploads causes one scan. The server writes derived aggregates to `~/.cache/codex-tools/ccs-cost-derived.json`; central status and report requests read the derived file rather than raw snapshot events. During the debounce window, status and reports keep serving the previous derived version. Startup publishes top HTTP endpoints before central cost derived refresh; cost refresh failures are logged and do not block `/health` or `/ccs/top/state`. `POST /ccs/top/reset` accepts the request immediately, refreshes in the server task queue, and resets top polling to `25s`; `pause` and `resume` use the same queued control path. Control and status HTTP clients use at least a five-second timeout.

Central CLI:

```bash
ccs cost central
ccs cost central daily --since 2026-05-01 --until 2026-05-30
ccs cost central projects --since 2026-05-01 --until 2026-05-30
ccs cost central models --since 2026-05-01 --until 2026-05-30
ccs cost central day 2026-05-29 --bucket 1h
```

Central reports use the server's pricing cache. With `--speed auto`, each uploaded machine snapshot uses the speed resolved on that machine at upload time. Explicit `--speed standard` or `--speed fast` applies one pricing speed to the whole central report.

## Event Parsing

Each matching thread gives one `rollout_path` and one `cwd`.

The parser streams each JSONL file line by line.

Relevant event types:

```text
turn_context
event_msg payload.type=task_started
event_msg payload.type=thread_rolled_back
event_msg payload.type=token_count
```

Codex fork files can include copied parent transcript history before the current rollout's own turns. The parser uses `threads.created_at_ms` plus `task_started.turn_id` UUIDv7 time, falling back to `task_started.started_at`, to find the current rollout task boundary. Token events before that boundary are inherited history and are excluded. Token events at or after that boundary are counted, including subagent fork sessions.

`thread_rolled_back` resets adjacent duplicate suppression for later token events. It is a structure event inside the counted rollout; the current rollout boundary remains the source of inherited-history deduplication.

Model resolution:

```text
turn_context.payload.model
payload.model
payload.model_name
payload.info.model
payload.info.model_name
payload.metadata.model
payload.info.metadata.model
threads.model
```

Token usage resolution:

```text
payload.info.last_token_usage
payload.info.total_token_usage
```

If `last_token_usage` exists, it is the event delta.

If `last_token_usage` is missing and `total_token_usage` exists, the event delta is:

```text
current total_token_usage - previous total_token_usage in the same file
```

The subtraction is per field:

```text
input_tokens
cached_input_tokens
output_tokens
reasoning_output_tokens
total_tokens
```

Negative deltas are treated as invalid input data and fail the command with the session file path and line number.

Zero events are ignored:

```text
input_tokens=0
cached_input_tokens=0
output_tokens=0
reasoning_output_tokens=0
```

Adjacent duplicate token events are skipped when both the effective delta and `total_token_usage` match the previous effective token event in the same file.

## Display Metrics

Displayed `input`:

```text
input_tokens - cached_input_tokens
```

Displayed `output`:

```text
output_tokens
```

Displayed `cached`:

```text
cached_input_tokens
```

Displayed cost columns:

```text
input$   = uncached input cost
output$  = output cost
cached$  = cached input cost
total$   = complete sum of the three components
```

`reasoning_output_tokens` remains part of raw usage validation and is included in `output_tokens` billing according to the upstream usage fact.

Terminal tables compact token counts by default with `K`, `M`, and `B` suffixes and round complete costs to whole dollars. Headers and total rows use simple emphasis, and total rows are separated from body rows. A `pricing` column appears when any row has missing prices. `NO_COLOR=1` disables color. `--raw` prints full token counts with thousands separators and decimal costs. JSON output uses numeric token fields, nullable cost fields, and `missingPricingModels`.

## Cost Calculation

Pricing source:

```text
LiteLLM model_prices_and_context_window.json
```

Local model-prices configuration:

```text
~/.config/codex-tools/model-prices.json
```

File format:

```json
{
  "source": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  "fetchedAt": "2026-05-30T00:00:00.000Z",
  "patterns": ["gpt-5.*"],
  "providers": ["openai"],
  "models": {
    "gpt-5.5": {
      "litellm_provider": "openai",
      "input_cost_per_token": 0.000005,
      "cache_read_input_token_cost": 0.0000005,
      "output_cost_per_token": 0.00001
    }
  }
}
```

Cost formula:

```text
non_cached_input = input_tokens - cached_input_tokens

cost =
  non_cached_input * input_price
  + cached_input_tokens * cache_read_price
  + output_tokens * output_price
```

All prices are per token.

Standard pricing fields:

```text
input_cost_per_token
cache_read_input_token_cost
output_cost_per_token
```

Fast pricing fields:

```text
input_cost_per_token_priority
cache_read_input_token_cost_priority
output_cost_per_token_priority
```

Each component cost requires complete pricing for every model with usage in that component. An incomplete component is `null` in JSON and `-` in terminal output. `costUSD` is `null` when any component is incomplete. Missing model prices do not fail local reports, central reports, or central status. Metric JSON includes `missingPricingModels`, and terminal tables show `missing N` in the `pricing` column.

Cost reporting, central reporting, and `ccs models` never write a full LiteLLM price cache automatically. They read the local cache, built-in supplemental prices, and manual overrides only. Missing prices are reported explicitly so cache writes stay tied to explicit `ccs pricing refresh` commands.

Pricing model plan:

- `~/.config/codex-tools/model-prices.json.patterns` stores normalized watched patterns.
- `~/.config/codex-tools/model-prices.json.providers` stores normalized LiteLLM `litellm_provider` names.
- `~/.config/codex-tools/model-prices.json.models` stores only exact model records matching both fields.
- `ccs pricing pattern watch PATTERN...` and `unwatch PATTERN...` rebuild models from the remote catalog after changing patterns.
- `ccs pricing provider add PROVIDER...` and `remove PROVIDER...` update local providers only; removal prunes local models using stored `litellm_provider` values.
- `ccs pricing refresh` rebuilds the remote snapshot from current patterns and providers.
- `ccs pricing list` reads local snapshot prices, and `list --remote` reads all remote models from watched providers.
- Remote records without a string `litellm_provider` do not enter remote lists or snapshots.
- Remote network, HTTP, and response-format errors render `unavailable` and preserve the current local snapshot.

Pricing selection:

```bash
ccs pricing provider add openai
ccs pricing pattern watch 'gpt-5.*'
ccs pricing list
ccs pricing refresh
ccs pricing provider remove openai
```

Remote rebuilds first keep records with a watched exact `litellm_provider`, then apply the union of watched patterns. A rebuild replaces the entire `models` object, removing remote models that disappeared or no longer satisfy either filter. `provider remove` uses only the local cache and applies the same filters to its stored model records. The commands update the local machine only; central reports use the server machine's pricing cache.

Built-in supplemental prices cover GLM-5.2 aliases:

```text
glm-5.2
GLM-5.2
zai/glm-5.2
```

Manual overrides live in `~/.config/codex-tools/profiles.json`:

```json
{
  "pricing": {
    "models": [
      "gpt-5.*",
      "glm-5.2",
      "claude-sonnet-4.5"
    ],
    "overrides": {
      "custom-model": {
        "inputCostPerToken": 0.000001,
        "outputCostPerToken": 0.000002,
        "cacheReadInputTokenCost": 0.0000001
      }
    }
  }
}
```

## Date And Time Rules

Default timezone is the system timezone.

`--timezone` accepts an IANA timezone name.

Daily period:

```text
YYYY-MM-DD in selected timezone
```

Weekly period:

```text
Monday-start week in selected timezone
```

The printed week key is the local date of the week start.

Monthly period:

```text
YYYY-MM in selected timezone
```

Day time buckets are based on the selected timezone and the requested bucket duration.

## Project Attribution

Project path is `threads.cwd` from the selected state SQLite database.

Terminal display uses a compact home-relative path:

```text
/home/ilove/Documents/repos/codex-cli-tools
```

prints as:

```text
~/Documents/repos/codex-cli-tools
```

JSON always stores the absolute path.

When multiple threads point to the same rollout file, the command requires the same `cwd`. Different `cwd` values for one rollout file are treated as invalid state and fail with the affected thread ids.

## Sorting

Summary reports:

```text
daily    date ascending
weekly   week ascending
monthly  month ascending
```

Project totals:

```text
cost descending
```

Day time buckets:

```text
time ascending
```

Day projects:

```text
cost descending
```

Project by day:

```text
date ascending
```

## Implementation Shape

New files:

```text
src/lib/codex-usage.ts
src/lib/pricing.ts
```

Changed files:

```text
package.json
pnpm-lock.yaml
src/commands/ccs.ts
src/lib/paths.ts
test/codex-usage.test.js
README.md
dist/bin/ccs.js
dist/commands/ccs.js
dist/lib/codex-usage.js
dist/lib/paths.js
dist/lib/pricing.js
```

`src/lib/codex-usage.ts` owns:

- SQLite thread loading.
- JSONL streaming parser.
- token event extraction.
- project attribution.
- date, week, month, bucket aggregation.
- IANA timezone grouping through Luxon.

`src/lib/pricing.ts` owns:

- model price cache.
- LiteLLM pricing refresh.
- cost calculation.
- missing model detection.

`src/commands/ccs.ts` owns:

- command parsing.
- terminal tables.
- JSON output.
- help text.

## Verification

Required checks:

```bash
pnpm check
pnpm build
git diff --check
NO_COLOR=1 node dist/bin/ccs.js --help
NO_COLOR=1 node dist/bin/ccs.js models
NO_COLOR=1 node dist/bin/ccs.js models --json
NO_COLOR=1 node dist/bin/ccs.js cost --help
NO_COLOR=1 node dist/bin/ccs.js pricing
NO_COLOR=1 node dist/bin/ccs.js pricing list
NO_COLOR=1 node dist/bin/ccs.js pricing list --remote
NO_COLOR=1 node dist/bin/ccs.js pricing pattern
NO_COLOR=1 node dist/bin/ccs.js pricing pattern watch 'gpt-5.*'
NO_COLOR=1 node dist/bin/ccs.js pricing pattern unwatch 'gpt-5.*'
NO_COLOR=1 node dist/bin/ccs.js pricing provider
NO_COLOR=1 node dist/bin/ccs.js pricing provider add openai
NO_COLOR=1 node dist/bin/ccs.js pricing provider remove openai
NO_COLOR=1 node dist/bin/ccs.js pricing refresh
NO_COLOR=1 node dist/bin/ccs.js cost daily --since 2026-05-01 --until 2026-05-30
NO_COLOR=1 node dist/bin/ccs.js cost weekly --since 2026-05-01 --until 2026-05-30
NO_COLOR=1 node dist/bin/ccs.js cost monthly --since 2026-01-01
NO_COLOR=1 node dist/bin/ccs.js cost projects --since 2026-05-01 --until 2026-05-30
NO_COLOR=1 node dist/bin/ccs.js cost models --since 2026-05-01 --until 2026-05-30
NO_COLOR=1 node dist/bin/ccs.js cost day 2026-05-29 --bucket 1h
NO_COLOR=1 node dist/bin/ccs.js cost project /home/ilove/Documents/repos/codex-cli-tools --since 2026-05-01 --until 2026-05-30
NO_COLOR=1 node dist/bin/ccs.js cost day 2026-05-29 --json
NO_COLOR=1 node dist/bin/ccs.js cost day 2026-05-29 --raw
```

Acceptance:

- Default tables show `input`, `output`, `cached`, `input$`, `output$`, `cached$`, and `total$` columns.
- `ccs cost models` and `ccs cost central models` aggregate and display the selected range by model.
- `input` is uncached input in terminal and JSON output.
- Incomplete component prices produce `null` JSON costs and `-` terminal costs.
- Default terminal tables use compact token units and whole-dollar costs.
- `--raw` prints full token counts and decimal costs.
- Daily, weekly, monthly, and project totals each include a total row.
- `ccs cost day` includes both time buckets and projects for that day.
- `ccs cost project PROJECT` shows one project by day.
- JSON output uses stable lower camel case keys.
- Unknown pricing models appear in `missingPricingModels` and terminal pricing status.
- `ccs models` shows one adjacent price column per provider and JSON per-model pricing status.
- `ccs pricing list` prints local model prices, and `ccs pricing list --remote` prints remote model prices.
- `ccs pricing pattern` displays watched patterns with local model counts.
- `ccs pricing pattern watch PATTERN...` and `unwatch PATTERN...` preview provider-filtered remote models and rebuild the local snapshot after exact `yes`.
- `ccs pricing provider` displays local providers; `add` and `remove` update local selection state after exact `yes`.
- `ccs pricing refresh` previews and rebuilds the complete pattern-and-provider snapshot after exact `yes`.
- Cost and model status commands never write a full LiteLLM pricing cache automatically.
- JSONL files are read line by line.
- README help, source help, built `dist`, and this spec describe the same command surface.
