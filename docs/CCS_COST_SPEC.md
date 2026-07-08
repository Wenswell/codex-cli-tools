# ccs cost spec

Status: implemented

## Goal

`ccs cost` reports local and central Codex session token and cost usage.

The report answers these questions:

- Daily, weekly, monthly totals: how much Codex usage happened in each period.
- Project totals: which projects consumed the most usage in the selected range.
- One project by day: how one project changed over time.
- One day by time: which time blocks consumed the most usage on a day.
- One day by project: which projects consumed the most usage on a day.

The user-facing metric set is intentionally small:

```text
input  output  cost  share  bar
```

Terminal reports show the five columns listed above.

## Command Surface

```bash
ccs cost
ccs cost daily
ccs cost weekly
ccs cost monthly
ccs cost projects
ccs cost project PROJECT
ccs cost day YYYY-MM-DD
ccs cost push
ccs cost central
ccs cost central daily
ccs cost central weekly
ccs cost central monthly
ccs cost central projects
ccs cost central project PROJECT
ccs cost central day YYYY-MM-DD
```

`ccs cost` without arguments prints the local session source, pricing cache, central status URL, SSH upload target, timezone, pricing speed, and compact command/options hints. Local reports require an explicit subcommand such as `ccs cost daily`.

`ccs cost push` uploads this machine's normalized token-event facts to the LAN server over SSH. `ccs cost central` reads the first reachable configured `top.stateUrls` server and prints uploaded machine status. `ccs cost central REPORT` renders the server-side aggregate report from uploaded machine snapshots.

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

## Reports

### Daily Totals

Command:

```bash
ccs cost daily --since 2026-05-01 --until 2026-05-30
```

Output:

```text
ccs cost daily  2026-05-01..2026-05-30  timezone Asia/Shanghai
date        input  output  cost  share   bar
2026-05-01  1.2M   46K     $1    25.0%   ████████
2026-05-02  2.3M   57K     $3    75.0%   ███████████████████████
---------------------------------------------------------
total       3.5M   103K    $4    100.0%  ██████████████████████████████
```

### Weekly Totals

Command:

```bash
ccs cost weekly --since 2026-05-01 --until 2026-05-30
```

Weeks start on Monday. The `week` value is the local date of the week start.

```text
week        input  output  cost  share   bar
2026-04-27  3.5M   90K     $5    50.0%   ███████████████
2026-05-04  4.6M   101K    $5    50.0%   ███████████████
----------------------------------------------------
total       8M     191K    $10   100.0%  ██████████████████████████████
```

### Monthly Totals

Command:

```bash
ccs cost monthly --since 2026-01-01
```

```text
month    input  output  cost  share   bar
2026-01  12M    457K    $12   33.3%   ██████████
2026-02  23M    568K    $24   66.7%   ████████████████████
-------------------------------------------------
total    35M    1M      $36   100.0%  ██████████████████████████████
```

### Project Totals

Command:

```bash
ccs cost projects --since 2026-05-01 --until 2026-05-30
```

```text
project                                      input  output  cost  share   bar
~/Documents/repos/codex-cli-tools            2.3M   57K     $2    66.7%   ████████████████████
~/Documents/repos/work-doc-organize          1.2M   46K     $1    33.3%   ██████████
--------------------------------------------------------------------------------
total                                        3.5M   103K    $3    100.0%  ██████████████████████████████
```

Project sorting defaults to highest cost first.

### One Project By Day

Command:

```bash
ccs cost project ~/Documents/repos/codex-cli-tools --since 2026-05-01 --until 2026-05-30
```

```text
ccs cost project  ~/Documents/repos/codex-cli-tools
date        input  output  cost  share   bar
2026-05-01  123K   4.6K    $1    25.0%   ████████
2026-05-02  235K   5.7K    $3    75.0%   ███████████████████████
---------------------------------------------------------
total       358K   10K     $4    100.0%  ██████████████████████████████
```

### One Day By Time

Command:

```bash
ccs cost day 2026-05-29 --bucket 1h
```

The day report prints a total row, then time buckets, then projects.

```text
ccs cost day  2026-05-29  bucket 1h  timezone Asia/Shanghai
total  input 3.5M  output 103K  cost $3

by time
time         input  output  cost  share  bar
09:00-10:00 1.2M   46K     $1    33.3%  ██████████
10:00-11:00 2.3M   57K     $2    66.7%  ████████████████████

by project
project                                      input  output  cost  share  bar
~/Documents/repos/codex-cli-tools            2.3M   57K     $2    66.7%  ████████████████████
~/Documents/repos/work-doc-organize          1.2M   46K     $1    33.3%  ██████████
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

`/ccs/cost/status` returns uploaded machine summaries. `/ccs/cost/report` accepts `report`, `since`, `until`, `timezone`, `bucket`, `speed`, `project`, and `day` query parameters and returns the same public metric shape as local `ccs cost --json`. `/ccs/cost/refresh` schedules derived-data generation after a five-minute debounce. Multiple uploads inside the debounce window delay the refresh, so a group of hourly uploads causes one scan. The server writes derived aggregates to `~/.cache/codex-tools/ccs-cost-derived.json`; central status and report requests read the derived file rather than raw snapshot events. During the debounce window, status and reports keep serving the previous derived version. Startup publishes top HTTP endpoints before central cost derived refresh; cost refresh failures are logged and do not block `/health` or `/ccs/top/state`. `POST /ccs/top/reset` accepts the request immediately, refreshes in the server task queue, and resets top polling to `25s`; `pause` and `resume` use the same queued control path. Control and status HTTP clients use at least a five-second timeout.

Central CLI:

```bash
ccs cost central
ccs cost central daily --since 2026-05-01 --until 2026-05-30
ccs cost central projects --since 2026-05-01 --until 2026-05-30
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

Terminal tables compact token counts by default with `K`, `M`, and `B` suffixes, round displayed costs to whole dollars, and use simple colors for `input`, `output`, `cost`, and project paths. The `share` and `bar` columns compare each row's cost against the report total. Headers and total rows use simple emphasis, and total rows are separated from body rows. `NO_COLOR=1` disables color. `--raw` prints full token counts with thousands separators and decimal costs. JSON output always keeps numeric token and cost fields.

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
NO_COLOR=1 node dist/bin/ccs.js cost day 2026-05-29 --raw
```

Acceptance:

- Default tables show `input`, `output`, `cost`, `share`, and `bar` columns.
- Default terminal tables use compact token units and whole-dollar costs.
- `--raw` prints full token counts and decimal costs.
- Daily, weekly, monthly, and project totals each include a total row.
- `ccs cost day` includes both time buckets and projects for that day.
- `ccs cost project PROJECT` shows one project by day.
- JSON output uses stable lower camel case keys.
- Unknown pricing models fail the command with model names.
- JSONL files are read line by line.
- README help, source help, built `dist`, and this spec describe the same command surface.
