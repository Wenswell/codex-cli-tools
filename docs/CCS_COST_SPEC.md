# ccs cost spec

Status: implemented

## Goal

`ccs cost` reports local Codex session token and cost usage from `~/.codex`.

The report answers these questions:

- Daily, weekly, monthly totals: how much Codex usage happened in each period.
- Project totals: which projects consumed the most usage in the selected range.
- One project by day: how one project changed over time.
- One day by time: which time blocks consumed the most usage on a day.
- One day by project: which projects consumed the most usage on a day.

The user-facing metric set is intentionally small:

```text
input  output  cost
```

Default reports show only the three metric columns listed above.

## Command Surface

```bash
ccs cost
ccs cost daily
ccs cost weekly
ccs cost monthly
ccs cost projects
ccs cost project PROJECT
ccs cost day YYYY-MM-DD
```

`ccs cost` is the same as `ccs cost daily`.

Options:

```text
--since YYYY-MM-DD      inclusive start date
--until YYYY-MM-DD      inclusive end date
--timezone IANA_NAME    date grouping timezone; defaults to the system timezone
--bucket DURATION       time bucket for ccs cost day; default 1h
--json                  print stable JSON
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

## Reports

### Daily Totals

Command:

```bash
ccs cost daily --since 2026-05-01 --until 2026-05-30
```

Output:

```text
ccs cost daily  2026-05-01..2026-05-30  timezone Asia/Shanghai
date        input       output    cost
2026-05-01  1,234,567   45,678    $1.23
2026-05-02  2,345,678   56,789    $2.34
total       3,580,245   102,467   $3.57
```

### Weekly Totals

Command:

```bash
ccs cost weekly --since 2026-05-01 --until 2026-05-30
```

Weeks start on Monday. The `week` value is the local date of the week start.

```text
week        input       output    cost
2026-04-27  3,456,789   90,123    $4.56
2026-05-04  4,567,890   101,234   $5.67
total       8,024,679   191,357   $10.23
```

### Monthly Totals

Command:

```bash
ccs cost monthly --since 2026-01-01
```

```text
month    input        output     cost
2026-01  12,345,678   456,789    $12.34
2026-02  23,456,789   567,890    $23.45
total    35,802,467   1,024,679  $35.79
```

### Project Totals

Command:

```bash
ccs cost projects --since 2026-05-01 --until 2026-05-30
```

```text
project                                      input       output    cost
~/Documents/repos/codex-cli-tools            2,345,678   56,789    $2.34
~/Documents/repos/work-doc-organize          1,234,567   45,678    $1.23
total                                        3,580,245   102,467   $3.57
```

Project sorting defaults to highest cost first.

### One Project By Day

Command:

```bash
ccs cost project ~/Documents/repos/codex-cli-tools --since 2026-05-01 --until 2026-05-30
```

```text
ccs cost project  ~/Documents/repos/codex-cli-tools
date        input      output   cost
2026-05-01  123,456    4,567    $0.12
2026-05-02  234,567    5,678    $0.23
total       358,023    10,245   $0.35
```

### One Day By Time

Command:

```bash
ccs cost day 2026-05-29 --bucket 1h
```

The day report prints a total row, then time buckets, then projects.

```text
ccs cost day  2026-05-29  bucket 1h  timezone Asia/Shanghai
total  input 12,345,678  output 456,789  cost $12.34

by time
time         input       output    cost
09:00-10:00 1,234,567   45,678    $1.23
10:00-11:00 2,345,678   56,789    $2.34

by project
project                                      input       output   cost
~/Documents/repos/codex-cli-tools            2,345,678   56,789   $2.34
~/Documents/repos/work-doc-organize          1,234,567   45,678   $1.23
```

### One Day By Project

`ccs cost day YYYY-MM-DD` includes the one-day project table by default. This command owns the one-day project detail view.

## JSON Output

JSON uses stable lower camel case keys.

### Daily

```json
{
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
      "costUSD": 1.23
    }
  ],
  "totals": {
    "inputTokens": 1234567,
    "outputTokens": 45678,
    "costUSD": 1.23
  }
}
```

### Projects

```json
{
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
      "costUSD": 2.34
    }
  ],
  "totals": {
    "inputTokens": 2345678,
    "outputTokens": 56789,
    "costUSD": 2.34
  }
}
```

### Day Detail

```json
{
  "report": "day",
  "date": "2026-05-29",
  "timezone": "Asia/Shanghai",
  "bucket": "1h",
  "totals": {
    "inputTokens": 12345678,
    "outputTokens": 456789,
    "costUSD": 12.34
  },
  "timeBuckets": [
    {
      "start": "09:00",
      "end": "10:00",
      "inputTokens": 1234567,
      "outputTokens": 45678,
      "costUSD": 1.23
    }
  ],
  "projects": [
    {
      "project": "/home/ilove/Documents/repos/codex-cli-tools",
      "inputTokens": 2345678,
      "outputTokens": 56789,
      "costUSD": 2.34
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
  event_msg payload.type=token_count
```

The SQLite index provides project attribution. JSONL files provide request-level token events.

The command uses the newest `state*.sqlite` under `~/.codex`.

## Event Parsing

Each matching thread gives one `rollout_path` and one `cwd`.

The parser streams each JSONL file line by line.

Relevant event types:

```text
turn_context
event_msg payload.type=token_count
```

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
input_tokens
```

Displayed `output`:

```text
output_tokens
```

Displayed `cost`:

```text
costUSD
```

`cached_input_tokens` and `reasoning_output_tokens` are parsed for correct cost calculation and validation. Default tables omit them.

## Cost Calculation

Pricing source:

```text
LiteLLM model_prices_and_context_window.json
```

Local cache:

```text
~/.cache/codex-tools/model-prices.json
```

Cache format:

```json
{
  "source": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  "fetchedAt": "2026-05-30T00:00:00.000Z",
  "models": {}
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

Cost reporting requires pricing entries for every model with priced usage. The command fails and lists the missing model names when pricing is incomplete.

When pricing cache is missing and network refresh fails, the command fails and prints the pricing cache path.

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
- missing model errors.

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
NO_COLOR=1 node dist/bin/ccs.js cost --help
NO_COLOR=1 node dist/bin/ccs.js cost daily --since 2026-05-01 --until 2026-05-30
NO_COLOR=1 node dist/bin/ccs.js cost weekly --since 2026-05-01 --until 2026-05-30
NO_COLOR=1 node dist/bin/ccs.js cost monthly --since 2026-01-01
NO_COLOR=1 node dist/bin/ccs.js cost projects --since 2026-05-01 --until 2026-05-30
NO_COLOR=1 node dist/bin/ccs.js cost day 2026-05-29 --bucket 1h
NO_COLOR=1 node dist/bin/ccs.js cost project /home/ilove/Documents/repos/codex-cli-tools --since 2026-05-01 --until 2026-05-30
NO_COLOR=1 node dist/bin/ccs.js cost day 2026-05-29 --json
```

Acceptance:

- Default tables show only `input`, `output`, and `cost` metric columns.
- Daily, weekly, monthly, and project totals each include a total row.
- `ccs cost day` includes both time buckets and projects for that day.
- `ccs cost project PROJECT` shows one project by day.
- JSON output uses stable lower camel case keys.
- Unknown pricing models fail the command with model names.
- JSONL files are read line by line.
- README help, source help, built `dist`, and this spec describe the same command surface.
