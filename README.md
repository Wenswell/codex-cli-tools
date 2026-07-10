# codex-tools

Personal Codex CLI helpers for Linux and macOS.

TTY output uses color for status, paths, warnings, and summaries. Set `NO_COLOR=1` to disable colors.

## Requirements

- Node.js 20+
- pnpm
- `codex` CLI for `cx`, `cxx`, and `cxxs`
- `claude` CLI for `ccx` and `ccxs`
- `sqlite3` CLI for `codex-rename`

## Install

From a local clone:

```bash
pnpm install
pnpm build
pnpm link --global
```

From GitHub:

```bash
pnpm add -g github:Wenswell/codex-cli-tools
```

If you clone the repository on that machine and want a live development link:

```bash
git clone git@github.com:Wenswell/codex-cli-tools.git
cd codex-cli-tools
pnpm install
pnpm build
pnpm link --global
```

## Commands

```bash
ccs
ccx
ccxs
clvm
cx
cxx
cxxs
senv
codex-rename
```

## Design Specs

- [CLI runtime records](docs/CLI_RUNTIME_RECORDS.md)
- [engineering preferences](docs/ENGINEERING_PREFERENCES.md)
- [testing guidelines](docs/TESTING_GUIDELINES.md)
- [runtime logging review](docs/RUNTIME_LOGGING_REVIEW.md)
- [runtime logging security plan](docs/RUNTIME_LOGGING_SECURITY_PLAN.md)
- [ccs cost spec](docs/CCS_COST_SPEC.md)
- [ccs pricing selection plan](docs/CCS_PRICING_REMOTE_MODELS_PLAN.md)
- [ccs proxy spec](docs/CCS_PROXY_SPEC.md)

## CLI conventions

- No-argument/status commands print active configuration values, not just file paths.
- New user-facing tools include a basic CLI surface, not only an internal hook/script entry.
- No-argument output combines compact status with a compact command/help line when the tool has user-facing commands.
- At tool entrypoints, `-h`, `--help`, and `help` are dedicated help output. They print one command per line and include a short comment for every command.
- Usage/help/commands text is lower-value than state and results, so it appears at the bottom when combined with other output.
- Commands that modify files default to preview and require typing exact `yes` at the prompt to write.
- Write/apply commands first print the same plan as preview, then ask for confirmation and print the actual result.
- Invalid arguments fail with a short explicit error instead of stack traces or silent fallback.
- Logs preserve normalized runtime facts by default. Raw payload archives are explicit debug surfaces with documented boundaries, private permissions, and size limits.
- Status and monitor commands that sample external runtime state write a latest JSON state file and append normalized JSONL history under `~/.cache/codex-tools`.
- Long-running monitors append history only when observed runtime facts change; watch refreshes do not imply history growth.
- Monitor headers use compact labels, bare `HH:mm:ss` clocks, single spaces between fields, and small semantic color sets.
- Tests protect behavior, data contracts, safety boundaries, parsing, formatting width, and calculations. Exact output assertions are reserved for explicit display contracts.
- Dense terminal byte, speed, duration, and compact counter values use three significant digits after the base unit, such as `160K`, `43.2M`, `160K/s`, `56ms`, and `2.34s`.
- Each commit updates `package.json` version. Use a patch version increment by default.
- Secrets live in environment variables or `~/.config/codex-tools`, not package files.
- Command surfaces stay small; legacy modes are removed when contracts change.
- Public tools support `version` and `-v`, and every tool reads the shared `package.json` version.
- Terminal tables use the shared renderer in `src/lib/table.ts`. Text columns are left-aligned, numeric columns are right-aligned, row numbers use explicit columns when present, and long path/rule/detail text lives in the final column. Columns can declare shrink priority so lower-value labels or endpoints compress before dense numeric details. ANSI color and wide characters are measured by terminal display width before padding or truncation. Truncated cell text uses the single-character ellipsis `…`.

## cx / cxx / cxxs

`cx` runs Codex in search mode and forwards stdin, stdout, stderr, arguments, and exit code.

```bash
cx ARGS...
cx version
cx -v
```

Equivalent to:

```bash
codex --search ARGS...
```

`cxx` also bypasses approvals and sandboxing.

```bash
cxx ARGS...
cxx version
cxx -v
```

Equivalent to:

```bash
codex --search --dangerously-bypass-approvals-and-sandbox ARGS...
```

`cxxs` resumes a Codex session with the same `cxx` flags.

```bash
cxxs ARGS...
cxxs version
cxxs -v
```

Equivalent to:

```bash
codex --search --dangerously-bypass-approvals-and-sandbox resume ARGS...
```

Use `cxx` and `cxxs` only in directories and tasks you trust.

## ccx / ccxs

`ccx` runs Claude Code with permission checks skipped and forwards stdin, stdout, stderr, arguments, and exit code.

```bash
ccx ARGS...
ccx version
ccx -v
```

Equivalent to:

```bash
claude --dangerously-skip-permissions ARGS...
```

`ccxs` resumes a Claude Code session with the same `ccx` flags.

```bash
ccxs ARGS...
ccxs version
ccxs -v
```

Equivalent to:

```bash
claude --dangerously-skip-permissions --resume ARGS...
```

Use `ccx` and `ccxs` only in directories and tasks you trust.

## ccs

`ccs` switches Codex between OpenAI-compatible provider profiles and can list usage-only keys.

`ccs version` and `ccs -v` print the package version from `package.json`.

Profile config lives at:

```text
~/.config/codex-tools/profiles.json
```

`ccs` updates:

```text
~/.codex/config.toml
~/.codex/AGENTS.md
~/.codex/auth.json
```

Run `ccs` without arguments to print the current profile, `user@host`, usage, and one compact command line:

```text
commands: ccs | version|-v | PROFILE | run PROFILE [ARGS] | models [--json] | pricing [list|pattern|provider|refresh] | proxy [--history N|--once [--history N]|watch [--history N]|mode|install|restore|stop|serve] | cost [push|central|daily|weekly|monthly|projects|project|day] | [toggle|add|rm] [PROFILE] | top | config [push|pull] | s [line|agent|server|history|pause|resume|reset|wezterm] | list [-u] | usage | init | sync
```

Supported commands:

```bash
ccs
ccs version
ccs -v
ccs PROFILE
ccs run PROFILE [CODEX_ARGS...]
ccs models [--json]
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
ccs cost day YYYY-MM-DD
ccs cost push
ccs cost central
ccs cost central daily
ccs cost central weekly
ccs cost central monthly
ccs cost central projects
ccs cost central project PROJECT
ccs cost central day YYYY-MM-DD
ccs toggle [PROFILE]
ccs top [--once] [--mark DURATION]
ccs config [push|pull]
ccs s [line]
ccs s agent
ccs s server [PORT]
ccs s history [PROFILE]
ccs s pause
ccs s resume
ccs s reset
ccs s wezterm
ccs s wezterm remove
ccs list | l [-u|--usage]
ccs usage
ccs usage add [PROFILE]
ccs usage remove | rm | delete PROFILE
ccs init
ccs sync
ccs add [PROFILE]
ccs remove | rm | delete PROFILE
```

`ccs models` requests `GET BASE_URL/v1/models` for every configured switching profile in `profiles.profiles`, using each profile API key as a Bearer token. Default output is a horizontal table with one provider column and one adjacent `price` column per provider. Price status is `ok` when input, output, and cache-read pricing are present, `partial` when input/output pricing exists without cache-read pricing, and `missing` when base pricing is unavailable. A provider request failure is shown in that provider column, and successful provider columns still show their model ids. `ccs models --json` prints stable JSON with each profile's `name`, `models`, `pricing`, and `error`, plus top-level pricing cache metadata.

`ccs cost` without arguments prints the local cost data source, pricing cache, central status URL, SSH upload target, timezone, pricing speed, and one compact command/options hint. Use an explicit report command to print usage tables.

`ccs cost daily`, `weekly`, `monthly`, `projects`, `project`, and `day` report local Codex session usage from `~/.codex`. They read the newest `~/.codex/state*.sqlite` for `threads.cwd` project attribution and stream each selected session JSONL file line by line for current-thread `token_count` usage events. Forked rollout files can contain copied parent history; `ccs cost` starts counting at the rollout thread's own `task_started` boundary and keeps subagent fork usage when it belongs to the current rollout. Terminal tables show `input`, `output`, `cost`, `share`, and `bar` columns, and add a `pricing` column when any row has missing prices.

```bash
ccs cost daily --since 2026-05-01 --until 2026-05-30
ccs cost weekly --since 2026-05-01 --until 2026-05-30
ccs cost monthly --since 2026-01-01
ccs cost projects --since 2026-05-01 --until 2026-05-30
ccs cost project /home/ilove/Documents/repos/codex-cli-tools --since 2026-05-01 --until 2026-05-30
ccs cost day 2026-05-29 --bucket 1h
ccs cost day 2026-05-29 --json
```

`ccs cost push` uploads this machine's normalized token-event facts to the LAN server over SSH:

```bash
ccs cost push
```

The fixed upload target is:

```text
ravvss@10.126.126.1:/home/ravvss/.cache/codex-tools/ccs-cost
```

The snapshot contains timestamp, project path, model name, and token counts. It does not contain prompt or response text. Re-running `ccs cost push` atomically replaces this machine's latest snapshot on the server. This command is intended for timers; it writes machine-generated cache data directly, triggers a debounced central cost refresh, and prints the remote file, machine name, event count, input, output totals, and refresh URL.

Install or update every reporting machine from the GitHub source before adding timers:

```bash
pnpm add -g github:Wenswell/codex-cli-tools
```

Linux user timers should run the global `ccs cost push` command with a PATH that includes the pnpm bin directory. Use `OnCalendar=*-*-* *:00:00` for one upload at every hourly boundary. macOS LaunchAgents should use the absolute pnpm shim path, for example `/Users/wswensw/Library/pnpm/ccs`, with 24 `StartCalendarInterval` entries at minute `0`. The job's environment should include Homebrew and pnpm bins:

```text
/opt/homebrew/bin:/Users/wswensw/Library/pnpm:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

`ccs cost central` reads the first reachable configured `top.stateUrls` server and prints uploaded machine status. `ccs cost central daily`, `weekly`, `monthly`, `projects`, `project`, and `day` render server-side aggregate reports from all uploaded machine snapshots:

```bash
ccs cost central
ccs cost central daily --since 2026-05-01 --until 2026-05-30
ccs cost central projects --since 2026-05-01 --until 2026-05-30
ccs cost central day 2026-05-29 --bucket 1h
```

The central report endpoints are served by `ccs s server`:

```text
GET /ccs/cost/status
GET /ccs/cost/report
POST /ccs/cost/refresh
```

`POST /ccs/cost/refresh` schedules central derived-data generation after a five-minute debounce. Multiple uploads inside the debounce window push the refresh later, so a group of hourly uploads causes one snapshot scan and one derived-data write. The server writes derived aggregates to `~/.cache/codex-tools/ccs-cost-derived.json`; report requests read that file and do not parse raw snapshot events on the query path. During the debounce window, reports keep serving the previous derived version until the next derived file is written.

Central reports use the server's pricing cache. With `--speed auto`, each uploaded machine snapshot uses the speed resolved on that machine at upload time; explicit `--speed standard` or `--speed fast` applies one speed to the whole central report. Central status and report JSON include `missingPricingModels` when uploaded usage contains models without complete pricing.

Options:

```text
--since YYYY-MM-DD      inclusive start date
--until YYYY-MM-DD      inclusive end date
--timezone IANA_NAME    date grouping timezone; defaults to the system timezone
--bucket 15m|30m|1h|2h  time bucket for ccs cost day; default 1h
--json                  print stable JSON
--raw                   print full token counts and decimal costs
--speed auto|standard|fast
```

Daily, weekly, monthly, project, and one-project reports include a `total` row. Weeks start on Monday. `ccs cost projects` sorts by highest cost first. `ccs cost day YYYY-MM-DD` prints a total line, time buckets, and projects for that day; time buckets sort by time and day projects sort by cost.

Terminal tables compact token counts by default with `K`, `M`, and `B` suffixes, round costs to whole dollars, and use simple colors for `input`, `output`, `cost`, and project paths. The `share` and `bar` columns compare each row's cost against the report total. Headers and total rows use simple emphasis, and total rows are separated from body rows. Set `NO_COLOR=1` to disable color. Use `--raw` to print full token counts with thousands separators and decimal costs. JSON output always keeps numeric token and cost fields and includes `missingPricingModels` for every metric record.

Costs use LiteLLM model pricing cached at `~/.config/codex-tools/model-prices.json`. Its `patterns`, `providers`, and `models` fields form one selection snapshot: `patterns` stores normalized model patterns, `providers` stores normalized LiteLLM `litellm_provider` names, and `models` maps exact selected model names to their price records. Remote selection first keeps watched providers and then applies the pattern union, so saved models always meet both filters. Entries without a string `litellm_provider` never enter the snapshot. `ccs cost`, `ccs cost central`, and `ccs models` read the local cache, built-in supplemental prices, and manual overrides. `ccs pricing` prints local selection state. `ccs pricing list` reads and prints selected local prices without a network request. `ccs pricing list --remote` fetches LiteLLM and prints every model from watched providers. Both modes use `model`, `status`, `input/M`, `cache/M`, and `output/M` columns. `ccs pricing pattern` prints watched patterns and local matched-model counts. `ccs pricing pattern watch PATTERN...` and `unwatch PATTERN...` rebuild the complete remote snapshot after exact `yes`. `ccs pricing provider` prints watched providers; `add PROVIDER...` and `remove PROVIDER...` modify only local cache state after exact `yes`, with removal pruning local models that no longer satisfy provider and pattern filters. `ccs pricing refresh` rebuilds the complete snapshot from watched patterns and providers after exact `yes`. Remote request failures render `unavailable` and write nothing. The built-in supplemental table covers GLM-5.2 names. Manual pricing overrides remain under `pricing.overrides` in `profiles.json` with `inputCostPerToken`, `outputCostPerToken`, and `cacheReadInputTokenCost` fields. Missing model prices are reported through terminal `pricing` status and JSON `missingPricingModels`. Cost speed resolution uses top-level `service_tier` from `~/.codex/config.toml`; `fast` or `priority` uses priority pricing, and `standard` or `default` uses standard pricing. JSON output keeps project paths absolute; terminal output shortens paths under `$HOME` to `~/...`.

```bash
ccs pricing provider add openai
ccs pricing pattern watch 'gpt-5.*'
ccs pricing list
ccs pricing list --remote
ccs pricing refresh
ccs pricing provider remove openai
```

`ccs list` marks the current profile with `*`. `ccs l -u` also shows `usage` entries from the same config file. Usage-only entries are never written to `~/.codex/config.toml` or `~/.codex/auth.json`, so they are safe for Claude or other app-specific keys you only want to monitor.

`ccs top` prints all `profiles` and `usage` costs in one terminal line. Each profile refreshes independently: it starts at 25 seconds, backs off by 30 seconds when the cost does not change, caps at 300 seconds, and resets to 25 seconds when the cost changes.

```text
14:09:12 | input $ 31.0 (+$9.9  9s ago, r 25s) | claude $123.0 (r 55s)      | gemini $  4.2 (+$0.1  3m ago, r 25s)
```

By default, `ccs top` prints a checkpoint line on 5-minute wall-clock boundaries, then continues refreshing the live line below it:

```text
14:15:00 | input $ 32.3 +$1.3 | claude $123.0 - | gemini $  4.3 +$0.1
```

Use `--mark 15m` to change the checkpoint interval; checkpoints align to that wall-clock interval. Supported duration suffixes are `s`, `m`, and `h`.

Countdowns use fixed-width labels such as `r  5s`, `r 55s`, or `r123s`. Provider names are shown as background-color labels when color is enabled. Each `ccs top` cost is formatted with one decimal and a 3-digit integer slot. Change display is bounded to one digit: when a movement reaches `9.9`, that event is shown as `+$9.9` or `-$9.9`, and subsequent changes are measured again from the current cost. Recent changes are red or green for 1 minute, then dimmed while the timestamp remains visible. The relative time is when this running `ccs top` process first observed the cost change. Change markers expire after 1 hour. If a later refresh fails after a successful read, `ccs top` keeps the last cost and marks it `stale`. When every provider reaches the `300s` interval and then has 3 more unchanged refreshes, `ccs top` marks them `done` and stops requesting. Press `r` to refresh all providers and resume from 25 seconds; press `q` or `Ctrl-C` to exit. Use `ccs top --once` to print one line and exit.

Run `ccs s` to print the same compact status plus one compact command line:

```text
22:52:22 r7s | *input 181.9 | ciii 161.3 | oops ? | input-cc 0
commands: ccs s [line|agent|server|history|pause|resume|reset|wezterm]
```

Use `ccs s line` from terminal status bars or shell prompts. It reads configured top state, prints one compact line, and exits:

```text
14:09:12 r18s | *input 6.6 | ciii 22.6 +0.3 | input-cc 0
```

Run `ccs top` locally to produce a local snapshot. The status line does not request usage APIs directly; it renders configured state URLs first, then falls back to the latest active local `ccs top` state from `~/.cache/codex-tools/ccs-top-state.json`. A leading `*` marks the local switching profile from `profiles.current`; usage-only entries remain unmarked. The clock updates on every status-line call, while usage refresh cadence, deltas, stale state, and done state come from the running collector. Deltas such as `+0.3` stay visible for 1 minute after the collector observes the change. If no active state exists, the status line prints `ccs top inactive`.

Use `ccs s server [PORT]` to run the same collector without an interactive terminal and expose the current snapshot over HTTP. It listens on `0.0.0.0` and defaults to port `8765`:

```bash
ccs s server
ccs s server 8765
```

The server uses a longer unattended backoff: `25s`, `1m`, `2m`, `5m`, `10m`, then `15m`. Providers never become `done`; unchanged providers keep refreshing every 15 minutes after reaching the maximum interval, and any observed usage change resets that provider to `25s`. The server only requests usage when a provider is due; `/ccs/top/state` serves the current status view, `/ccs/top/history` serves compact aggregated history for a requested window, `/ccs/cost/status` serves uploaded cost snapshot status, `/ccs/cost/report` serves central cost reports from uploaded snapshots, `/health` returns a compact health JSON, and `POST /ccs/top/pause` / `POST /ccs/top/resume` pause or resume polling. Startup publishes the top HTTP endpoints before refreshing central cost derived data; cost refresh failures are logged and the top endpoints stay available. `POST /ccs/top/reset` accepts the request immediately, refreshes in the server task queue, and resets top polling to `25s`. Control and status HTTP clients use at least a five-second timeout. Run `ccs s pause`, `ccs s resume`, or `ccs s reset` from any client machine with `top.stateUrls`; the command posts to the first reachable configured server, so it does not need to be run on the cloud server itself. Point status-line and central cost clients at LAN servers with `top.stateUrls` in `~/.config/codex-tools/profiles.json`, for example:

`ccs s server` listens on `0.0.0.0`; expose it only on a trusted network or behind an access-controlled proxy.

```json
{
  "top": {
    "stateUrls": [
      "http://10.126.126.1:8765/ccs/top/state",
      "http://127.0.0.1:8765/ccs/top/state"
    ]
  }
}
```

If the first server is unavailable, `ccs s line` tries the next configured URL, then reads the local snapshot.

Run `ccs s history` to render today's usage from the first reachable configured top server. Usage counters reset at midnight, so the default report starts at local `00:00` instead of mixing two daily accounting windows. In history output, `reset` means a usage counter decreased inside that displayed window; the `5h delta` cell uses only the trailing five-hour window. History is collected by `ccs s server`; `ccs top --once` also appends one local snapshot. Restart the server after updating so it serves the compact `/ccs/top/history` API. The client requires the version 2 `series` payload from `/ccs/top/history`. The server appends snapshot records to `~/.cache/codex-tools/ccs-top-history.jsonl`, caps the file at 64M, and readers load only the recent window from the JSONL tail. HTTP clients request only display data for the needed window: stacked trend with summary, and 30-minute bucket changes. The stacked trend shows the first two providers by current history order and combines any remaining providers as `other`. Bucket changes print two consecutive buckets per row. The endpoint accepts `since`, `until`, `bucketMinutes`, and `profile` query parameters, and rejects windows longer than 24h30m. Use `ccs s history PROFILE` to focus the same report on one provider:

```bash
ccs s history
ccs s history input
```

Example output:

```text
ccs usage history  today  bucket 30m
source: http://10.126.126.1:8765/ccs/top/history?since=...&bucketMinutes=30

stacked trend                                                        summary
stack: input / ciii                                                  provider    now  5h delta   last  change
    $25  ┼                                                           input     $22.4    +$10.0  14:32   +$0.2
    $20  ┤                          ╭────────────────────────        ciii       $4.2     +$1.1  13:58   +$0.4
    $15  ┤                          │
    $10  ┤             ╭────────────╯
     $5  ┤      ╭──────╯
     $0  ┼──────╯────────────────────┬────────────┬─────────────┬
         00:00       06:00         12:00        18:00       24:00

bucket changes
time          total  input  ciii  |  time          total  input  ciii
19:00-19:30  +$4.1  +$3.7  +$0.4  |  19:30-20:00  +$2.3  +$2.3  $0
20:00-20:30  +$0.2  +$0.2    $0  |
```

For WezTerm, keep `ccs s agent` running in one terminal. It writes a timestamped status suffix to `~/.cache/codex-tools/ccs-top-status.txt` on wall-clock second boundaries and reloads `profiles.json` so the `*` marker follows profile switches. The WezTerm integration renders the clock locally and reads only the suffix from that file, so the GUI callback stays lightweight and the clock stays aligned with the actual clock. If the cached status file goes stale, WezTerm shows `ccs top unavailable`.

Install the WezTerm status bar integration with the project command:

```bash
ccs s wezterm
ccs s wezterm remove
```

`ccs s wezterm` previews the `~/.wezterm.lua` change, then writes after you type exact `yes`; it backs up the existing file under `~/.config/codex-tools/backups/` and inserts a managed status block before `return config`. `ccs s wezterm remove` previews removing that managed block, then removes it after the same confirmation. The installed block reads `~/.cache/codex-tools/ccs-top-status.txt`, renders the clock locally, and hides stale status after a short freshness window; override the file path with `CCS_WEZTERM_STATUS_FILE`.

Example:

```json
{
  "profiles": {
    "input": {
      "baseURL": "https://ai.input.im",
      "apiKey": "codex-key"
    }
  },
  "usage": {
    "claude": {
      "baseURL": "https://ai.input.im",
      "apiKey": "claude-key"
    }
  },
  "current": "input",
  "toggle": ["input"]
}
```

Initial profile defaults are stored in this repository:

```text
config/ccs-profiles.json
```

`ccs init` creates `profiles.json` from that template if it does not already contain profiles:

```json
{
  "profiles": {
    "input": {
      "baseURL": "https://ai.input.im",
      "apiKey": ""
    },
    "ciii": {
      "baseURL": "https://codex.ciii.club",
      "apiKey": ""
    }
  },
  "current": "input",
  "toggle": ["input", "ciii"],
  "top": {
    "stateUrls": [
      "http://10.126.126.1:8765/ccs/top/state",
      "http://127.0.0.1:8765/ccs/top/state"
    ]
  }
}
```

Fill in the API keys manually. The file is written with `0600` permissions.

`ccs init` first reads the current Codex API settings from:

```text
~/.codex/config.toml
~/.codex/auth.json
~/.codex/AGENTS.md
```

It stores the current `base_url` and `OPENAI_API_KEY` as a profile named `current`, then makes `current` the active profile.

`ccs init` then syncs:

```text
~/.codex/config.toml
~/.codex/AGENTS.md
```

from:

```text
config/codex-config.toml
config/codex-agents.md
```

Preview first:

```bash
ccs init
```

After printing the plan, `ccs init` writes only if you type exact `yes` at the prompt.

Before writing, it backs up the current files to:

```text
~/.config/codex-tools/backups/ccs-YYYYMMDD-HHMMSS/
```

`ccs init` keeps the existing `~/.codex/config.toml` as the base file, appends missing top-level keys, missing sections, and missing section keys from `config/codex-config.toml`, and syncs the default global Codex guidelines to `~/.codex/AGENTS.md`. Existing Codex config keys, sections, comments, and local settings stay in place. Later profile switches only change the active provider API URL and `~/.codex/auth.json`.

`ccs init` shows:

- a short summary of files to modify and back up
- unified diff style output for each file that would change
- masked secrets in `profiles.json` and `auth.json`
- warnings for risky changes such as current-profile switches

If `config/ccs-profiles.json` changes later, run:

```bash
ccs sync
```

`ccs sync` prints its plan first and writes only if you type exact `yes` at the prompt.

When applied, `ccs sync` also creates the same backup directory first. Then it merges template profiles into `~/.config/codex-tools/profiles.json`, keeps existing local API keys, keeps local profiles that are not in the template, seeds `top.stateUrls` with the cloud-first/local-fallback defaults when `top` is missing, appends missing Codex config keys and sections from `config/codex-config.toml` into `~/.codex/config.toml`, and syncs `~/.codex/AGENTS.md` from `config/codex-agents.md`.

`ccs config` manages local `~/.config/codex-tools/profiles.json` sync with the LAN server copy at `ravvss@10.126.126.1:/home/ravvss/.config/codex-tools/profiles.json` over SSH port `32753`:

```bash
ccs config
ccs config push
ccs config pull
```

Run `ccs config` without arguments to print the local file summary, fixed LAN target, and a compact command line without connecting to the server.

`push` uploads the local file to the LAN server. `pull` downloads the LAN server file to the local machine. Only `push` and `pull` connect to the server and compare files. Both commands preview first and apply only after you type exact `yes`; explicit push/pull previews connect to the server, print a masked unified diff, replace the whole file instead of merging, and create a backup before overwriting an existing target.

Add or update a profile interactively:

```bash
ccs add
ccs add ciii
```

When editing an existing profile, press Enter to keep the current value. If `PROFILE` is passed, the name prompt uses it as the default.

Remove a profile:

```bash
ccs remove local
```

`ccs toggle` uses the `toggle` array in `profiles.json`; it is not hard-coded to specific profile names.
When proxy mode is installed, `ccs toggle` switches `profiles.current`, and the proxy uses that current profile as the active upstream and API key for new requests.

Switching profile:

```bash
ccs toggle input
ccs toggle ciii
ccs toggle
```

Show a profile without switching:

```bash
ccs PROFILE
```

Launch a new Codex CLI once with a profile without switching the stored current profile:

```bash
ccs run input
ccs run ciii exec "check this repo"
```

Proxy commands live under `ccs proxy`:

```bash
ccs proxy
ccs proxy --history N
ccs proxy --once
ccs proxy --once --history N
ccs proxy watch
ccs proxy watch --history N
ccs proxy mode
ccs proxy mode recovery
ccs proxy mode intercept
ccs proxy install
ccs proxy restore
ccs proxy serve
ccs proxy stop
```

Behavior:

- Updates the current provider's `base_url` in `~/.codex/config.toml`.
- Writes `~/.codex/auth.json` as `{ "OPENAI_API_KEY": "..." }`.
- `ccs run PROFILE [CODEX_ARGS...]` sets `CCS_RUN_OPENAI_API_KEY` only for the launched `codex` process and passes temporary `-c model_providers.<current>.base_url=...` and `-c model_providers.<current>.env_key=...` overrides, so it does not write `config.toml`, `auth.json`, or `profiles.json`.
- `ccs proxy install` stores proxy runtime state under `~/.cache/codex-tools/proxy/`, backs up the current `~/.codex/config.toml`, rewrites the active provider `base_url` to the proxy URL, starts the proxy in the background, and sets mode to `recovery`.
- `ccs proxy mode` prints the active mode. `ccs proxy mode recovery` enables continuation recovery for eligible streaming Responses guard hits and uses ordinary guard retry when recovery is unavailable. `ccs proxy mode intercept` disables continuation recovery and uses ordinary guard retry.
- `ccs proxy stop` switches mode to `passthrough`, keeps the proxy URL active, and directly forwards original client request bodies and upstream responses without reasoning guard retries, continuation recovery, response body stripping, capacity retries, or transport retries.
- `ccs proxy restore` restores `~/.codex/config.toml` from the saved backup, stops the background proxy, removes proxy state, and exits proxy routing.
- `ccs proxy` reads one active upstream from `profiles.current` for each new request. It overwrites incoming `Authorization`, `api-key`, and `x-api-key` headers with `Authorization: Bearer <current profile apiKey>`, so long-running Codex CLI processes can keep using the proxy URL after `ccs toggle` changes the active profile. `ccs toggle` owns profile switching.
- Upstream HTTP responses are forwarded as received when the local reasoning guard leaves the response unchanged. This includes `401`, `403`, `408`, `429`, and `5xx`. Upstream `4xx` and `5xx` responses record `failure_summary.type=upstream_error`, keep `error=null`, and render the upstream error summary in the history `error` column.
- In `recovery` and `intercept` modes, upstream capacity errors retry the same upstream when an error response body contains `Selected model is at capacity. Please try a different model.`, or contains both `selected model is at capacity` and `try a different model` case-insensitively. Plain `429` and `5xx` responses without that text are forwarded as received. Capacity retries use the same three-attempt internal retry budget as the reasoning guard, and the final upstream status and body are forwarded if that budget is exhausted.
- In `recovery` and `intercept` modes, transport-level `TypeError: fetch failed` is retried once for the same upstream. Repeated transport failure returns `502` with error type `upstream_error` and code `upstream_fetch_failed`.
- `ccs proxy` forwards only model API paths: `/responses`, `/v1/responses`, `/chat/completions`, and `/v1/chat/completions`. `GET /__codex_proxy/health` is local control traffic. Unsupported paths return local `404 unsupported_proxy_path`, write one event to `~/.cache/codex-tools/proxy/proxy.log`, and do not enter request metrics or history.
- In `recovery` and `intercept` modes, the reasoning guard checks JSON responses and SSE `data:` JSON payloads for explicit non-negative integer `reasoning_tokens` values `516`, `1034`, and `1552`. Guard matches retry the same upstream request up to three times, then return `502 reasoning_guard_triggered`.
- In `recovery` mode, streaming Responses requests automatically include `reasoning.encrypted_content` when needed for recovery. If a guarded stream contains encrypted reasoning items, `ccs proxy` first retries with a continuation request. Context compaction requests and `intercept` mode use ordinary guard retry.
- Guard actions are recorded in request history under `guard_actions` and as JSON lines in `~/.cache/codex-tools/proxy/proxy.log`. Each action stores `action`, `upstream`, `attempt`, `status`, `reasoning_tokens`, and `error`; `continuation_recovery` marks a Responses continuation retry.
- `ccs proxy` starts the background proxy when proxy state exists and a current-protocol healthy proxy process is unavailable. If the health endpoint reports a different protocol, it records `ccs_proxy_protocol_restart` with `server_protocol`, `client_protocol`, and `pid` in `proxy.log`, stops that process, and starts the current proxy.
- Proxy runtime files live beside the proxy state under `~/.cache/codex-tools/proxy/`: `proxy.pid` stores the background process id, `proxy-runtime.log` stores recent background stdout/stderr up to 16M, `proxy.log` stores recent guard, unsupported-path, and proxy error events up to 16M, and `proxy-requests.jsonl` stores recent completed model API requests with JSONL-only `attempt_records` and sanitized `request_headers` up to 64M.
- A newly started proxy process clears persisted `active_requests` before serving traffic, so `active` only shows requests owned by the current proxy process.
- `ccs proxy` without arguments prints runtime state, mode, server version, protocol, proxy URL, state/requests/events/runtime/config files, request status totals, reasoning token totals, latency summary, upstream hit counts, active requests, and completed history once and exits. The title starts with a labeled `ccs proxy` and bare `HH:mm:ss` time. `ccs proxy --once` prints the same snapshot. `ccs proxy watch` refreshes the live view in the terminal alternate screen, keeps the proxy URL on the title line, omits path lines, and repaints immediately when the terminal size changes.
- `ccs proxy` terminal output displays local file paths under `$HOME` with `~/`.
- `ccs proxy serve` runs the proxy server in the foreground for direct debugging.
- `ccs proxy` forwards request bodies at their original size. Runtime and upstream resources determine practical payload bounds.
- `ccs proxy` forwards upstream requests without a proxy-owned response deadline. Codex client settings such as `stream_idle_timeout_ms` own stream idle timeout behavior.
- The live proxy view separates `active` and `history`. `active` contains supported model API requests currently being processed by the proxy, including upstream SSE buffering before client headers are written. Completed, failed, and fully streamed model API responses move to `history`. `proxy.json.metrics.recent_requests` keeps the newest 100 completed model API requests as a compact status snapshot; `proxy-requests.jsonl` keeps bounded completed model API request history in completion order. Compact state history is written before the complete JSONL record append, so JSONL append failures are recorded in `proxy.log` after the client response state is settled. Default status rendering reads history from `proxy.json`. TTY output computes history row count from terminal height, non-TTY output uses 5 history rows, and `--history N` overrides both. When `--history N` exceeds the snapshot length, status rendering reads the tail of `proxy-requests.jsonl`.
- Active and history records use the same request schema and shared row formatter. Both tables use `session time up reas./code lat. size model error` columns. Fixed-width columns are right-aligned; the final `error` column takes remaining width and renders as a single current-width line. The full error text remains in the request record and appears with more visible content when the terminal becomes wider. The `session` column uses a small bright palette: the same session id keeps the same color in active and history rows, while missing sessions stay dim. Active rows show known upstream, status, reasoning metadata, and model fields as soon as the proxy observes them. `model` renders `request_model/upstream_model`, shortens `gpt-5.5` to `o5.5`, and keeps stored model fields unchanged. Examples include `o5.5/-`, `o5.5/[same]`, and `o5.5/o5.5-mini`. `reas./code` renders examples such as `516/200`, `text/200`, and `-/-`. A new retry attempt clears attempt-scoped `reas./code` and upstream model until that attempt observes fresh values.
- For `/v1/chat/completions`, `/chat/completions`, `/v1/responses`, and `/responses`, proxy metrics record mode, request kind, request model, request reasoning effort, client turn id, client request attempt, upstream model, upstream self-reported `system_fingerprint` and `service_tier`, explicit usage token counts, token-count source, reasoning text observation, reasoning text source, response shape booleans, retry summary, and timing fields when the JSON or SSE payload contains them. Token counts come from explicit usage paths such as `/usage/input_tokens`, `/usage/output_tokens`, `/usage/total_tokens`, `/usage/output_tokens_details/reasoning_tokens`, and the matching `response.usage` paths. Reasoning text observations come from GLM/OpenAI-compatible fields such as `delta.reasoning_content`, `message.reasoning_content`, and `delta.reasoning`. Response shape booleans record commentary, final-answer, tool-call, and reasoning-item presence. Request records store `request_body_sha256`; prompt text and response text stay outside runtime records. Missing request and upstream model fields are stored as `null` and render as dim `-`; matching request/upstream models render as dim `[same]`; differing upstream models render in red. Missing reasoning tokens with observed reasoning text render as `text`; absent reasoning metadata renders as dim `-`. In `recovery` and `intercept` modes, SSE responses are buffered before client response headers, scanned for model and reasoning metadata, then forwarded when accepted by the guard. In `recovery` mode, automatically requested encrypted reasoning fields are removed from accepted client-visible responses.
- Proxy-internal retry attempts render as a yellow number after the upstream name, such as `input3`. Repeated Codex client requests with the same `turn_id` and `request_body_sha256` render `client:<attempt>` in the `error` prefix, such as `[client:2] upstream_http_502: upstream returned HTTP 502`. Request rows with guard actions prefix `error` with bracketed local-action labels: `guard:<value>` for standard reasoning guard retry, `cap:<value>` for capacity retry, `rec:<value>` for Responses continuation recovery, `block:<value>` for final local guard failure, and `err:<value>` for upstream transport errors. Prefix values use `reasoning_tokens` when present, then action HTTP status, then the final local request status for terminal upstream transport failures, then `-`; HTTP status entries are yellow and reasoning-token entries are red, such as `[guard:516 guard:516 block:516] reasoning_guard_triggered ...` and `[err:502 err:502] upstream_fetch_failed: fetch failed`. The visible error text uses local `error` first, then `failure_summary.code/message` for upstream HTTP failures.
- Proxy tables format elapsed time and byte size with compact 3-significant-digit units after the base unit, such as `56ms`, `2.34s`, `43.2s`, `3.12m`, `32.0K`, and `3.41M`.
- Proxy metrics are recomputed from `proxy.json.metrics.recent_requests`, so request statistics cover the newest 100 completed model API requests in the state file plus the current active count. Unsupported paths are event-log facts and do not contribute to status, latency, upstream, reasoning, active, or history metrics. Status counters use exact HTTP status code events, such as `200`, `499`, and `502`. `status total` is the sum of those exact event counters. Upstream counters use the same status-event basis and count the upstream attached to each guard action or final response when present. Reasoning counters use the same event basis: guard retry actions and final responses with explicit `reasoning_tokens` each contribute one count. A final local `502 reasoning_guard_triggered` records the last guarded value through its `return_status_502` action, so the matching request field does not add a second count for the same observation. `max` is the largest observed reasoning token value. Reasoning summary renders non-zero fixed groups `0`, `516`, `1034`, `1552`, and `other`; when all groups are zero, only `total` and `max` are shown. When Responses continuation recovery activity exists, the same line renders `recovery=... recovered=... exhausted=...`; `recovery` counts continuation retry attempts, `recovered` counts requests accepted after continuation, and `exhausted` counts requests that still ended in local guard `502`. Guarded values are red, `0` and `recovery` are yellow, and `other` is green. Latency shows `last`, `avg`, `min`, and `max` for the same state window. `ccs proxy restore` removes the state file, and the next install starts a new statistics window.
- `ccs proxy help` prints the proxy command summary.
- Does not print API keys directly; status output masks keys and includes `user@host`.
- `ccs`, `ccs toggle`, and `ccs PROFILE` print a `usage:` line with local time. `ccs list --usage` fetches usage for all profiles in parallel and prints cost, input, output, cache, and request counts as aligned columns. `ccs top` fetches all profiles and usage-only profiles in parallel and keeps the display to one refreshing line. Usage is fetched from `BASE_URL/v1/usage` with the profile API key; failures print `usage: HH:MM:SS unavailable` or `unavailable`, and missing keys print `usage: HH:MM:SS skipped` or `skipped`.
- Fails if the profile or API key is missing.

## clvm

`clvm` monitors Clash Verge Rev / mihomo `/connections` data for configured domains.

`clvm version` and `clvm -v` print the shared package version.

Config lives at:

```text
~/.config/codex-tools/clvm.json
```

Runtime records live under `${XDG_CACHE_HOME:-~/.cache}/codex-tools`:

```text
~/.cache/codex-tools/clvm-state.json
~/.cache/codex-tools/clvm-history.jsonl
~/.cache/codex-tools/clvm-raw/
```

Default template lives at:

```text
config/clvm.json
```

The bundled template contains no API secret or domains. Use `clvm setup` to write machine-specific values under `~/.config/codex-tools/clvm.json`.

Default status:

```bash
clvm
```

The no-argument command prints the active config values, masks the API secret, fetches one `/connections` snapshot when domains are configured, writes the latest state, appends one compact history record, and prints a compact command line at the bottom. Raw HTTP archive files are a debug layer enabled with `rawArchive: true` or `--raw-archive on`.

Commands:

```bash
clvm
clvm version
clvm -v
clvm monitor
clvm config
clvm setup --domain example.com --base-url http://127.0.0.1:9090 --secret SECRET
clvm setup --interval 1s
clvm setup --close-zero-for-seconds 300
clvm setup --close-zero-for-seconds off
clvm setup --raw-archive on
clvm sync
clvm help
```

`clvm config` prints the active config without calling the mihomo API.

`clvm setup` merges the active config with the provided flags, prints the target file, active values, backup plan, and a masked JSON diff, then writes only after you type exact `yes`.

`clvm sync` merges `config/clvm.json` into `~/.config/codex-tools/clvm.json`, keeps local overrides, prints the source file, target file, backup plan, and masked JSON diff, then writes only after you type exact `yes`.
When the merged result already matches the local file, `clvm sync` prints `already synced` and exits without prompting.

When applied, `clvm setup` and `clvm sync` back up the existing target file before writing:

```text
~/.config/codex-tools/backups/clvm-YYYYMMDD-HHMMSS-SSS/clvm.json
```

Config shape:

```json
{
  "baseUrl": "http://127.0.0.1:9090",
  "secret": "",
  "domains": ["example.com"],
  "interval": "1s",
  "zeroSpeedThreshold": 0,
  "closeZeroForSeconds": null,
  "rawArchive": false
}
```

Monitor mode:

```bash
clvm monitor
clvm monitor --domain example.com --interval 1s
clvm monitor --json
clvm monitor --no-clear
clvm monitor --raw-archive on
```

Monitor tables read the active terminal width. `clvm monitor` uses the terminal alternate screen in TTY mode, hides the cursor while active, repaints from the home cursor position, clears rewritten lines and the remaining screen tail, restores the main screen on exit, and repaints immediately when the terminal size changes. `--no-clear` appends samples in the main screen. The monitor header starts with a labeled `clvm monitor` and bare `HH:mm:ss` time, and TTY output fits that header to the active terminal width. Current connection rows show endpoint, merged `age/zeroFor`, `up/s`, `down/s`, optional traffic totals, optional chain, and rule. The `status` column is omitted; zero time carries the status color, with `0ms` green and non-zero values yellow. Speed cells omit `/s` because the unit is already in the `up/s` and `down/s` headers. Unknown table speed and traffic cells render as `-`. Narrower terminals omit traffic total and chain columns before truncating long text. When the visible columns still exceed the terminal width, `endpoint` compresses before speed, chain, and rule details. The final `rule` column takes remaining width and uses the shared ANSI/wide-character-aware table truncation. Table traffic totals and speed cells use compact 3-significant-digit units such as `160K` and `43.2M`; config and header speed summaries keep explicit `/s` units such as `160K/s`.

`recent closed` shows connections that `clvm monitor` successfully closed through mihomo. The monitor keeps up to 100 recent closed records in memory. TTY output computes visible `recent closed` rows from terminal height after the header and current connection table, so small terminals can show zero closed rows and taller terminals show more. Non-TTY output renders 5 closed rows for deterministic logs.

When Clash Verge Rev / mihomo is unavailable, `clvm` writes an unavailable runtime record instead of discarding the error. `clvm` status prints one unavailable result and exits. Long-running `clvm monitor` keeps running and retries with backoff from the configured interval through `2x`, `5x`, `10x`, `30x`, `60x`, then `5m`. A successful refresh resets retry state to the configured interval.

Every `clvm` status sample writes `~/.cache/codex-tools/clvm-state.json` and appends one JSON line to `~/.cache/codex-tools/clvm-history.jsonl`. `clvm monitor` writes the first runtime record, then writes only when the observed runtime fingerprint changes; idle repeated samples, such as empty `/connections` results, do not append once per interval. State stores the latest normalized matched/closed connection data for status inspection. History stores only `ok`, active non-secret config summary, computed summary counts, error/retry fields, and `raw_ref`; it omits per-connection endpoint, process, rule, node, and matched-domain details and is capped at 16M. `rawArchive` defaults to `false`, so `raw_ref` is `null` and raw `/connections` payloads stay out of runtime records. When `rawArchive` is enabled, raw HTTP response records are stored once by SHA-256 under `~/.cache/codex-tools/clvm-raw/`, sensitive response headers are redacted, payloads above 1M are omitted, and the archive is bounded to 256 files and 64M. Unavailable records store `ok: false`, error code/message details, retry metadata when monitor mode will retry, and a `raw_ref` only when raw archive is enabled and a raw response body exists. HTTP response bodies stay out of state and history. Automatic close failures keep the sample as `ok: true`, record `summary.closeFailed` in state and history, and keep per-connection failure summaries in state without raw response bodies.

Domain matching:

- `example.com` matches `example.com` and `*.example.com`.
- Connection host candidates come from mihomo metadata fields such as `host`, `destinationHost`, `sniffHost`, `sni`, and `domain`.
- Domain rule payload is included when the connection rule is domain-based.

Automatic close:

```bash
clvm setup --close-zero-for-seconds 300
clvm monitor
```

`closeZeroForSeconds` enables automatic close in `clvm monitor`. `clvm` status does not close connections and shows `autoClose=configured` when the threshold is configured.

## senv

`senv` regenerates a target env file from an example env file while preserving existing values.

`senv version` and `senv -v` print the shared package version.

Default:

```bash
senv
```

Preview mode is equivalent to:

```bash
senv --source .env.example --target .env
```

Default mode is preview. Nothing is modified unless you type exact `yes` at the prompt.
Preview prints a unified diff; common sensitive env keys such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASS`, `AUTH`, and `CREDENTIAL` are masked in that diff. Apply mode first prints the same planned summary and diff as preview, asks for confirmation, then prints the updated result after writing.

Options:

```bash
senv
senv version
senv -v
senv --source .env.example --target .env.local
senv -b
```

`-b` is short for `--backup`.

Parsing:

- Supports `KEY=value`.
- Supports `export KEY=value`.
- Key pattern: `[A-Za-z_][A-Za-z0-9_]*`.
- Value is kept exactly as text after `=`.
- Empty lines, comments, and unparsable lines are raw lines.

Merge behavior:

- Output order follows the source file.
- Source comments, blank lines, and raw lines are preserved.
- `export KEY=value` is normalized to `KEY=value`.
- If target does not contain a source key, the source value is used and counted as `added`.
- If target contains a non-empty value, the target value is preserved.
- If target contains an empty value and source has a non-empty value, the source default is filled.
- If both target and source values are empty, the empty value is preserved.
- Keys that exist only in target are appended at the end under `# Extra keys from existing .env`.
- Extra keys are written as `KEY=value`; their original comments and positions are not preserved.
- Output always ends with a newline.

Important: an intentionally empty target value is filled when the source has a non-empty default. This is for default-value migration, not for cases where empty means disabled.

CLI output includes the target file and counts/lists for added, filled defaults, preserved, preserved empty, and extra keys.

## codex-rename

`codex-rename` renames a project folder and updates local Codex session directory associations in the same command.

`codex-rename version` and `codex-rename -v` print the shared package version.

Codex stores the directory association in:

```text
~/.codex/state_5.sqlite
  threads.cwd

~/.codex/sessions/**/*.jsonl
  first line session_meta.payload.cwd
```

Usage:

```bash
codex-rename version                                  # print package version
codex-rename -v                                       # print package version
codex-rename OLD_PATH NEW_PATH                         # preview directory rename and exact session cwd update
codex-rename OLD_PATH NEW_PATH --prefix                # preview directory rename and child session cwd updates
codex-rename OLD_PATH NEW_PATH --sessions-only --prefix # update sessions only after directory was already renamed
```

Default mode is preview. Nothing is modified unless you type exact `yes` at the prompt.
Apply mode first prints the same directory, session, and rollout-file plan as preview, asks for confirmation, then renames the directory, updates Codex state, and prints backup, update, and verification counts.
Use `--sessions-only` when the directory has already been renamed and only Codex session cwd values need to be updated.

Path behavior:

- `OLD_PATH` must exist and must be a directory.
- `NEW_PATH` must not exist.
- `NEW_PATH` must not be inside `OLD_PATH`.
- `--sessions-only` skips all filesystem rename checks and operations.
- Default: migrate sessions whose `cwd` is exactly `OLD_PATH`.
- `--prefix`: migrate `OLD_PATH` and every child path under it.
- Prefix mode preserves the relative path below `OLD_PATH` for session cwd updates. The actual directory operation is still one rename from `OLD_PATH` to `NEW_PATH`.

Example:

```bash
codex-rename /home/me/repos/old /home/me/repos/new --prefix
```

This maps:

```text
/home/me/repos/old
/home/me/repos/old/app
```

to:

```text
/home/me/repos/new
/home/me/repos/new/app
```

Apply behavior:

- Finds the latest `~/.codex/state*.sqlite`.
- Reads matching rows from `threads`.
- Preflights every rollout JSONL file.
- Builds and re-checks planned JSONL writes before updating SQLite.
- Creates a backup directory under `~/.codex/backups/session-cwd-migration-YYYYMMDD-HHMMSS/`.
- Backs up the state SQLite file and every rollout JSONL that will be modified.
- Renames `OLD_PATH` to `NEW_PATH` with the native filesystem rename operation.
- Updates SQLite in a transaction.
- Updates only the first line of each rollout JSONL.
- If a JSONL update fails after SQLite is updated, attempts to roll back SQLite and already-written JSONL files.
- Verifies old cwd remaining count, threads at the new cwd, and JSONL first-line sync.

Dry-run output lists matched sessions and rollout files.

Apply output includes:

```text
backup: ...
sqlite updated: ...
jsonl updated: ...
old cwd remaining: ...
threads at new cwd: ...
jsonl synced: ...
```

## Development

```bash
pnpm install
pnpm build
```

Run commands locally from `dist` after building:

```bash
node dist/bin/ccs.js --help
node dist/bin/ccs.js -v
node dist/bin/ccx.js -v
node dist/bin/ccxs.js -v
node dist/bin/clvm.js -v
node dist/bin/cx.js -v
node dist/bin/cxx.js -v
node dist/bin/cxxs.js -v
node dist/bin/senv.js -v
node dist/bin/codex-rename.js -v
node dist/bin/clvm.js --help
node dist/bin/clvm.js sync --help
node dist/bin/senv.js --help
node dist/bin/codex-rename.js --help
```

Check TypeScript:

```bash
pnpm check
```

Before committing command-surface or documentation changes, verify:

```bash
pnpm check
pnpm test
pnpm build
git diff --check
node dist/bin/ccs.js --help
node dist/bin/ccs.js -v
node dist/bin/ccx.js -v
node dist/bin/ccxs.js -v
node dist/bin/clvm.js -v
node dist/bin/cx.js -v
node dist/bin/cxx.js -v
node dist/bin/cxxs.js -v
node dist/bin/senv.js -v
node dist/bin/codex-rename.js -v
node dist/bin/clvm.js --help
node dist/bin/clvm.js sync --help
node dist/bin/senv.js --help
node dist/bin/codex-rename.js --help
```

Use a temporary `HOME` for manual `ccs init` or `ccs sync` apply-path checks so real `~/.codex` files are not changed during verification.

Release from this repository is GitHub-first:

```bash
git push origin main
```

Do not publish to npm unless the registry release path is explicitly requested.
