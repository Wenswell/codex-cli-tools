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

- [ccs cost spec](docs/CCS_COST_SPEC.md)
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
- Logs preserve complete original input, event, and response data. Summaries or previews can be added, but cannot replace the raw facts.
- Secrets live in environment variables or `~/.config/codex-tools`, not package files.
- Command surfaces stay small; legacy modes are removed when contracts change.
- Terminal tables use the shared renderer in `src/lib/table.ts`. Text columns are left-aligned, numeric columns are right-aligned, row numbers use explicit columns when present, and long path/rule/detail text lives in the final column. ANSI color and wide characters are measured by terminal display width before padding or truncation.

## cx / cxx / cxxs

`cx` runs Codex in search mode and forwards stdin, stdout, stderr, arguments, and exit code.

```bash
cx ARGS...
```

Equivalent to:

```bash
codex --search ARGS...
```

`cxx` also bypasses approvals and sandboxing.

```bash
cxx ARGS...
```

Equivalent to:

```bash
codex --search --dangerously-bypass-approvals-and-sandbox ARGS...
```

`cxxs` resumes a Codex session with the same `cxx` flags.

```bash
cxxs ARGS...
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
```

Equivalent to:

```bash
claude --dangerously-skip-permissions ARGS...
```

`ccxs` resumes a Claude Code session with the same `ccx` flags.

```bash
ccxs ARGS...
```

Equivalent to:

```bash
claude --dangerously-skip-permissions --resume ARGS...
```

Use `ccx` and `ccxs` only in directories and tasks you trust.

## ccs

`ccs` switches Codex between OpenAI-compatible provider profiles and can list usage-only keys.

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
commands: ccs | PROFILE | run PROFILE [ARGS] | proxy [--once] [install|restore|stop|serve] | cost [push|central|daily|weekly|monthly|projects|project|day] | [toggle|add|rm] [PROFILE] | top | config [push|pull] | s [line|agent|server|history|pause|resume|reset|wezterm] | list [-u] | usage | init | sync
```

Supported commands:

```bash
ccs
ccs PROFILE
ccs run PROFILE [CODEX_ARGS...]
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

`ccs cost` without arguments prints the local cost data source, pricing cache, central status URL, SSH upload target, timezone, pricing speed, and one compact command/options hint. Use an explicit report command to print usage tables.

`ccs cost daily`, `weekly`, `monthly`, `projects`, `project`, and `day` report local Codex session usage from `~/.codex`. They read the newest `~/.codex/state*.sqlite` for `threads.cwd` project attribution and stream each selected session JSONL file line by line for current-thread `token_count` usage events. Forked rollout files can contain copied parent history; `ccs cost` starts counting at the rollout thread's own `task_started` boundary and keeps subagent fork usage when it belongs to the current rollout. Terminal tables show `input`, `output`, `cost`, `share`, and `bar` columns.

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

Central reports use the server's pricing cache. With `--speed auto`, each uploaded machine snapshot uses the speed resolved on that machine at upload time; explicit `--speed standard` or `--speed fast` applies one speed to the whole central report.

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

Terminal tables compact token counts by default with `K`, `M`, and `B` suffixes, round costs to whole dollars, and use simple colors for `input`, `output`, `cost`, and project paths. The `share` and `bar` columns compare each row's cost against the report total. Headers and total rows use simple emphasis, and total rows are separated from body rows. Set `NO_COLOR=1` to disable color. Use `--raw` to print full token counts with thousands separators and decimal costs. JSON output always keeps numeric token and cost fields.

Costs use LiteLLM model pricing cached at `~/.cache/codex-tools/model-prices.json`. When the cache is missing, `ccs cost` refreshes it from LiteLLM. `--speed auto` reads top-level `service_tier` from `~/.codex/config.toml`; `fast` or `priority` uses priority pricing, and `standard` or `default` uses standard pricing. JSON output keeps project paths absolute; terminal output shortens paths under `$HOME` to `~/...`.

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
22:52:22 r7s | input 181.9 | ciii 161.3 | oops ? | input-cc 0
commands: ccs s [line|agent|server|history|pause|resume|reset|wezterm]
```

Use `ccs s line` from terminal status bars or shell prompts. It reads configured top state, prints one compact line, and exits:

```text
14:09:12 r18s | input 6.6 | ciii 22.6 +0.3 | input-cc 0
```

Run `ccs top` locally to produce a local snapshot. The status line does not request usage APIs directly; it renders configured state URLs first, then falls back to the latest active local `ccs top` state from `~/.cache/codex-tools/ccs-top-state.json`. The clock updates on every status-line call, while usage refresh cadence, deltas, stale state, and done state come from the running collector. Deltas such as `+0.3` stay visible for 1 minute after the collector observes the change. If no active state exists, the status line prints `ccs top inactive`.

Use `ccs s server [PORT]` to run the same collector without an interactive terminal and expose the current snapshot over HTTP. It listens on `0.0.0.0` and defaults to port `8765`:

```bash
ccs s server
ccs s server 8765
```

The server uses a longer unattended backoff: `25s`, `1m`, `2m`, `5m`, `10m`, then `15m`. Providers never become `done`; unchanged providers keep refreshing every 15 minutes after reaching the maximum interval, and any observed usage change resets that provider to `25s`. The server only requests usage when a provider is due; `/ccs/top/state` serves the current status view, `/ccs/top/history` serves compact aggregated history for a requested window, `/ccs/cost/status` serves uploaded cost snapshot status, `/ccs/cost/report` serves central cost reports from uploaded snapshots, `/health` returns a compact health JSON, and `POST /ccs/top/pause` / `POST /ccs/top/resume` pause or resume polling. `POST /ccs/top/reset` accepts the request immediately, refreshes in the server task queue, and resets polling to `25s`. Control and status HTTP clients use at least a five-second timeout. Run `ccs s pause`, `ccs s resume`, or `ccs s reset` from any client machine with `top.stateUrls`; the command posts to the first reachable configured server, so it does not need to be run on the cloud server itself. Point status-line and central cost clients at LAN servers with `top.stateUrls` in `~/.config/codex-tools/profiles.json`, for example:

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

Run `ccs s history` to render today's usage from the first reachable configured top server. Usage counters reset at midnight, so the default report starts at local `00:00` instead of mixing two daily accounting windows. In history output, `reset` means a usage counter decreased inside that displayed window; the `5h delta` cell uses only the trailing five-hour window. History is collected by `ccs s server`, not `ccs s agent`; restart the server after updating so it serves the compact `/ccs/top/history` API. The client requires the version 2 `series` payload from `/ccs/top/history`. The server keeps raw snapshot records in `~/.cache/codex-tools/ccs-top-history.jsonl`, but HTTP clients request only display data for the needed window: stacked trend with summary, and 30-minute bucket changes. The stacked trend shows the first two providers by current history order and combines any remaining providers as `other`. Bucket changes print two consecutive buckets per row. The endpoint accepts `since`, `until`, `bucketMinutes`, and `profile` query parameters. Use `ccs s history PROFILE` to focus the same report on one provider:

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

For WezTerm, keep `ccs s agent` running in one terminal. It writes a timestamped status suffix to `~/.cache/codex-tools/ccs-top-status.txt` on wall-clock second boundaries. The WezTerm integration renders the clock locally and reads only the suffix from that file, so the GUI callback stays lightweight and the clock stays aligned with the actual clock. If the cached status file goes stale, WezTerm shows `ccs top unavailable`.

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
When proxy mode is installed, `ccs toggle` still switches the current profile and the proxy keeps using `profiles.toggle` order for upstream priority, with the first item as the primary upstream.

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
ccs proxy --once
ccs proxy install
ccs proxy restore
ccs proxy serve
ccs proxy stop
```

Behavior:

- Updates the current provider's `base_url` in `~/.codex/config.toml`.
- Writes `~/.codex/auth.json` as `{ "OPENAI_API_KEY": "..." }`.
- `ccs run PROFILE [CODEX_ARGS...]` sets `CCS_RUN_OPENAI_API_KEY` only for the launched `codex` process and passes temporary `-c model_providers.<current>.base_url=...` and `-c model_providers.<current>.env_key=...` overrides, so it does not write `config.toml`, `auth.json`, or `profiles.json`.
- `ccs proxy install` stores proxy state in `~/.config/codex-tools/proxy.json`, backs up the current `~/.codex/config.toml`, rewrites the active provider `base_url` to the proxy URL, and starts the proxy in the background.
- `ccs proxy restore` restores `~/.codex/config.toml` from the saved backup and removes proxy state.
- `ccs proxy` reads `profiles.toggle` for upstream priority, keeps the first profile as the primary upstream, and falls through the remaining profiles in order.
- `ccs proxy` starts the background proxy when proxy state exists and no healthy proxy process is running.
- Background runtime files live beside the proxy state: `~/.config/codex-tools/proxy.pid` and `~/.config/codex-tools/proxy.log`.
- `ccs proxy` without arguments watches runtime state, active paths, state/log files, request status totals, latency summary, upstream hit counts, active requests, and completed history live in the terminal. `ccs proxy --once` prints the same snapshot once and exits.
- `ccs proxy serve` runs the proxy server in the foreground for direct debugging.
- The live proxy view separates `active` and `history`. `active` contains HTTP requests currently being processed by the proxy. Completed, failed, and fully streamed responses move to `history`. Both tables use `time code up ms size session req_model up_model method path` columns, include an aligned row-number column, and show up to 5 rows.
- For `/v1/chat/completions`, `/chat/completions`, `/v1/responses`, and `/responses`, proxy metrics record request model and upstream model metadata when the JSON or SSE payload contains it. Missing model fields are stored as `null` and render as empty cells. SSE model extraction stops after the first valid model value and keeps the forwarded response bytes unchanged.
- Proxy metrics count completed requests by HTTP status group: `2xx`, `3xx`, `4xx`, and `5xx`. Latency shows `last`, `avg`, `min`, and `max`.
- `ccs proxy help` prints the proxy command summary.
- Does not print API keys directly; status output masks keys and includes `user@host`.
- `ccs`, `ccs toggle`, and `ccs PROFILE` print a `usage:` line with local time. `ccs list --usage` fetches usage for all profiles in parallel and prints cost, input, output, cache, and request counts as aligned columns. `ccs top` fetches all profiles and usage-only profiles in parallel and keeps the display to one refreshing line. Usage is fetched from `BASE_URL/v1/usage` with the profile API key; failures print `usage: HH:MM:SS unavailable` or `unavailable`, and missing keys print `usage: HH:MM:SS skipped` or `skipped`.
- Fails if the profile or API key is missing.

## clvm

`clvm` monitors Clash Verge Rev / mihomo `/connections` data for configured domains.

Config lives at:

```text
~/.config/codex-tools/clvm.json
```

Default template lives at:

```text
config/clvm.json
```

Default status:

```bash
clvm
```

The no-argument command prints the active config values, masks the API secret, fetches one `/connections` snapshot when domains are configured, and prints a compact command line at the bottom.

Commands:

```bash
clvm
clvm monitor
clvm config
clvm setup --domain example.com --base-url http://127.0.0.1:9090 --secret SECRET
clvm setup --interval 1s
clvm setup --close-zero-for-seconds 300
clvm setup --close-zero-for-seconds off
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
  "closeZeroForSeconds": null
}
```

Monitor mode:

```bash
clvm monitor
clvm monitor --domain example.com --interval 1s
clvm monitor --json
clvm monitor --no-clear
```

Domain matching:

- `example.com` matches `example.com` and `*.example.com`.
- Connection host candidates come from mihomo metadata fields such as `host`, `destinationHost`, `sniffHost`, `sni`, and `domain`.
- Domain rule payload is included when the connection rule is domain-based.

Automatic close:

```bash
clvm setup --close-zero-for-seconds 300
clvm monitor
```

`closeZeroForSeconds` enables automatic close in `clvm monitor`. `clvm` status remains read-only and shows `autoClose=configured` when the threshold is configured.

## senv

`senv` regenerates a target env file from an example env file while preserving existing values.

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

Codex stores the directory association in:

```text
~/.codex/state_5.sqlite
  threads.cwd

~/.codex/sessions/**/*.jsonl
  first line session_meta.payload.cwd
```

Usage:

```bash
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
