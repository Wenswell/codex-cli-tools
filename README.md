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

To update an existing installation:

- Local linked clone: run `git pull --ff-only`, `pnpm install`, and `pnpm build` in the linked clone. The global link continues to use that clone; run `pnpm link --global` again only if the link was removed.
- Global GitHub install: rerun `pnpm add -g github:Wenswell/codex-cli-tools`.

Verify either update with:

```bash
ccs version
```

Running foreground commands keep the code loaded when they start. Stop them before updating, then restart and verify them afterward:

| Command | Stop | Restart after update | Verify |
| --- | --- | --- | --- |
| `ccs s server [PORT]` | `Ctrl-C` | rerun with the same port | `curl http://127.0.0.1:8765/health` for the default port |
| `ccs s agent` | `Ctrl-C` | `ccs s agent` | confirm `~/.cache/codex-tools/ccs-top-status.txt` keeps updating |
| `ccs top` | `q` or `Ctrl-C` | rerun `ccs top` | confirm the live line refreshes |
| `clvm monitor` | `q` or `Ctrl-C` | rerun `clvm monitor` | confirm the monitor refreshes successfully |

An installed `ccs proxy` runs in the background. Update the package first, then run `ccs proxy restart`, confirm with exact `yes`, and verify with `ccs proxy`. If the WezTerm managed status block changed in an update, rerun `ccs s wezterm` and confirm the preview to replace it.

## Commands

```bash
cimg
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
- [public CLI surface regression plan](docs/CLI_SURFACE_REGRESSION_PLAN.md)
- [cimg CLI plan](docs/CIMG_PLAN.md)
- [engineering preferences](docs/ENGINEERING_PREFERENCES.md)
- [testing guidelines](docs/TESTING_GUIDELINES.md)
- [test suite audit](docs/TEST_SUITE_AUDIT.md)
- [runtime logging review](docs/RUNTIME_LOGGING_REVIEW.md)
- [runtime logging security plan](docs/RUNTIME_LOGGING_SECURITY_PLAN.md)
- [ccs cost spec](docs/CCS_COST_SPEC.md)
- [ccs cost model breakdown plan](docs/CCS_COST_MODEL_BREAKDOWN_PLAN.md)
- [ccs pricing selection plan](docs/CCS_PRICING_REMOTE_MODELS_PLAN.md)
- [Codex command mode plan](docs/CODEX_REMOTE_COMMANDS_PLAN.md)
- [ccs proxy spec](docs/CCS_PROXY_SPEC.md)
- [CLI lifecycle plan](docs/CLI_LIFECYCLE_PLAN.md)
- [CLI command footer plan](docs/CLI_COMMAND_SUMMARY_PLAN.md)
- [ccs proxy install fix plan](docs/CCS_PROXY_INSTALL_FIX_PLAN.md)
- [ccs proxy state upgrade plan](docs/CCS_PROXY_STATE_UPGRADE_PLAN.md)

## CLI conventions

- No-argument/status commands print active configuration values, not just file paths.
- New user-facing tools include a basic CLI surface, not only an internal hook/script entry.
- No-argument output combines compact status with a compact command footer when the tool has user-facing commands.
- The root `ccs` footer separates direct commands from command namespaces. Both lists use primary names only.
- A namespace footer lists its immediate primary subcommands and ends with `--help`.
- Explicit help contains parameters, aliases, nested commands, and command comments.
- Each labeled command footer row is emitted as one line without width-dependent formatting.
- At tool entrypoints, `-h`, `--help`, and `help` are dedicated help output. They print one command per line and include a short comment for every command.
- Every `package.json.bin` entry is automatically covered by the shared version and help regression test; adding a public tool requires no hand-maintained test list.
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

`cx`, `cxx`, and `cxxs` use the Codex CLI local app-server daemon through its Unix socket by default. Codex CLI owns this daemon. Bootstrap it once, then verify it before first use:

```bash
codex app-server daemon bootstrap
codex app-server daemon version
```

Manage it directly through Codex CLI:

```bash
codex app-server daemon start
codex app-server daemon restart
codex app-server daemon stop
codex app-server daemon version
```

After updating Codex CLI, run `codex app-server daemon restart`, then verify that `version` reports `running` and the expected app-server version. `ccs r` prints the same daemon status and running version in compact form.

`cx` runs Codex in search mode and forwards stdin, stdout, stderr, arguments, and exit code.

```bash
cx ARGS...
cx local ARGS...
cx run PROFILE [CODEX_ARGS...]
cx version
cx -v
```

Equivalent to:

```bash
codex --search --remote unix:// -C "$PWD" ARGS...
```

`cx local ARGS...` runs the original local-session command without `--remote`.

`cxx` also bypasses approvals and sandboxing.

```bash
cxx ARGS...
cxx local ARGS...
cxx run PROFILE [CODEX_ARGS...]
cxx version
cxx -v
```

Equivalent to:

```bash
codex --search --dangerously-bypass-approvals-and-sandbox --remote unix:// -C "$PWD" ARGS...
```

`cxx local ARGS...` runs the original local-session command without `--remote`.

`cxxs` resumes a Codex session with the same `cxx` flags.

```bash
cxxs ARGS...
cxxs local ARGS...
cxxs run PROFILE [RESUME_ARGS...]
cxxs version
cxxs -v
```

Equivalent to:

```bash
codex --search --dangerously-bypass-approvals-and-sandbox --remote unix:// -C "$PWD" resume ARGS...
```

`cxxs local ARGS...` resumes the original local-session command without `--remote`.

In default mode, all three commands pass the caller's absolute current directory through `-C`, so the daemon creates and resumes sessions in the directory where the wrapper was invoked instead of the daemon process's startup directory. `local` is only recognized as the first argument and is not forwarded to Codex.

All three wrappers can launch one local Codex process with a profile without changing the stored current profile:

```bash
cx run input
cxx run ciii "check this repo"
cxxs run input --last
```

`run PROFILE` is local because the selected provider API key is scoped to that Codex process. It passes temporary provider `base_url` and `env_key` overrides. When proxy mode is installed, it keeps using the local proxy and sends a temporary `x-ccs-profile` provider header; the proxy uses that profile for the process without changing `profiles.current` and removes the internal header before contacting the provider. No profile, Codex config, auth, or proxy state file is modified.

Use `cxx` and `cxxs` only in directories and tasks you trust.

## ccx / ccxs

`ccx` runs Claude Code with permission checks skipped and forwards stdin, stdout, stderr, arguments, and exit code.

```bash
ccx ARGS...
ccx version
ccx -v
ccx help
ccx -h
ccx --help
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
ccxs help
ccxs -h
ccxs --help
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

Run `ccs` without arguments to print the current profile, `user@host`, usage, and a compact two-level command footer:

```text
commands:   version | r | PROFILE | models | toggle | top | list | init | sync | add | remove
namespaces: pricing | proxy | cost | config | s | usage | --help
```

Supported commands:

```bash
ccs
ccs version
ccs -v
ccs r
ccs PROFILE
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
ccs proxy [--history N] [--view overview|tokens|cost]
ccs proxy watch [--history N] [--view overview|tokens|cost]
ccs proxy mode [passthrough|retry|recovery|intercept]
ccs proxy config
ccs proxy install|restore|serve
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
ccs sync --replace TOML_PATH [--replace TOML_PATH ...]
ccs sync --replace all
ccs add [PROFILE]
ccs remove | rm | delete PROFILE
```

`ccs r` runs `codex app-server daemon version` and prints the daemon status and running app-server version. Status and version values use semantic TTY colors.

`ccs models` requests `GET BASE_URL/v1/models` for every configured switching profile in `profiles.profiles`, using each profile API key as a Bearer token. Default output is a horizontal table with one provider column and one adjacent `price` column per provider. Price status is `ok` when input, output, and cache-read pricing are present, `partial` when input/output pricing exists without cache-read pricing, and `missing` when base pricing is unavailable. A provider request failure is shown in that provider column, and successful provider columns still show their model ids. `ccs models --json` prints stable JSON with each profile's `name`, `models`, `pricing`, and `error`, plus top-level pricing cache metadata.

`ccs cost` without arguments prints the local cost data source, pricing cache, central status URL, SSH upload target, timezone, pricing speed, and its immediate commands. Use `ccs cost --help` for complete report syntax and options.

```text
commands: daily | weekly | monthly | projects | project | models | day | push | central | --help
```

The options apply to local and central report forms. `ccs cost push` accepts no additional arguments and always uploads the complete machine snapshot.

`ccs cost daily`, `weekly`, `monthly`, `projects`, `project`, `models`, and `day` report local Codex session usage from `~/.codex`. They read the newest `~/.codex/state*.sqlite` for `threads.cwd` project attribution and stream each selected session JSONL file line by line for current-thread `token_count` usage events. Forked rollout files can contain copied parent history; `ccs cost` starts counting at the rollout thread's own `task_started` boundary and keeps subagent fork usage when it belongs to the current rollout. Terminal tables use `input`, `output`, `cached`, `input$`, `output$`, `cached$`, and `total$`. `input` is uncached input. A `pricing` column appears when any required price is missing.

```bash
ccs cost daily --since 2026-05-01 --until 2026-05-30
ccs cost weekly --since 2026-05-01 --until 2026-05-30
ccs cost monthly --since 2026-01-01
ccs cost projects --since 2026-05-01 --until 2026-05-30
ccs cost project /home/ilove/Documents/repos/codex-cli-tools --since 2026-05-01 --until 2026-05-30
ccs cost models --since 2026-05-01 --until 2026-05-30
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

The snapshot contains timestamp, project path, model name, and token counts. It does not contain prompt or response text. Re-running `ccs cost push` atomically replaces this machine's latest snapshot on the server. This command is intended for timers; it writes machine-generated cache data directly, triggers a debounced central cost refresh, and prints the remote file, machine name, event count, uncached input, output, cached input totals, and refresh URL.

Install or update every reporting machine from the GitHub source before adding timers:

```bash
pnpm add -g github:Wenswell/codex-cli-tools
```

Linux user timers should run the global `ccs cost push` command with a PATH that includes the pnpm bin directory. Use `OnCalendar=*-*-* *:00:00` for one upload at every hourly boundary. macOS LaunchAgents should use the absolute pnpm shim path, for example `/Users/wswensw/Library/pnpm/ccs`, with 24 `StartCalendarInterval` entries at minute `0`. The job's environment should include Homebrew and pnpm bins:

```text
/opt/homebrew/bin:/Users/wswensw/Library/pnpm:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

`ccs cost central` reads the first reachable configured `top.stateUrls` server and prints uploaded machine status. `ccs cost central daily`, `weekly`, `monthly`, `projects`, `project`, `models`, and `day` render server-side aggregate reports from all uploaded machine snapshots:

```bash
ccs cost central
ccs cost central daily --since 2026-05-01 --until 2026-05-30
ccs cost central projects --since 2026-05-01 --until 2026-05-30
ccs cost central models --since 2026-05-01 --until 2026-05-30
ccs cost central day 2026-05-29 --bucket 1h
```

The central report endpoints are served by `ccs s server`:

```text
GET /ccs/cost/status
GET /ccs/cost/report
POST /ccs/cost/refresh
```

`POST /ccs/cost/refresh` schedules central derived-data generation after a five-minute debounce. Multiple uploads inside the debounce window push the refresh later, so a group of hourly uploads causes one snapshot scan and one derived-data write. The server writes derived aggregates to `~/.cache/codex-tools/ccs-cost-derived.json`; report requests read that file and do not parse raw snapshot events on the query path. During the debounce window, reports keep serving the previous derived version until the next derived file is written.

Central reports use the server's pricing cache. With `--speed auto`, each uploaded machine snapshot uses the speed resolved on that machine at upload time; explicit `--speed standard` or `--speed fast` applies one speed to the whole central report. Central status and report payloads use schema version `2`. JSON includes `missingPricingModels` when uploaded usage contains models without complete pricing.

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

Daily, weekly, monthly, project, one-project, and model reports include a `total` row. Weeks start on Monday. `ccs cost projects` and `ccs cost models` sort by unrounded complete cost from highest to lowest, followed by incomplete-price rows sorted by name. `ccs cost day YYYY-MM-DD` prints a total line, time buckets, and projects for that day; time buckets sort by time and day projects use the same cost ordering.

Terminal tables compact token counts by default with `K`, `M`, and `B` suffixes and round complete costs to whole dollars. Headers and total rows use simple emphasis, and total rows are separated from body rows. Set `NO_COLOR=1` to disable color. Use `--raw` to print full token counts with thousands separators and decimal costs. JSON metric records contain `inputTokens`, `outputTokens`, `cachedInputTokens`, `inputCostUSD`, `outputCostUSD`, `cachedCostUSD`, `costUSD`, and `missingPricingModels`. A missing required component price makes that component and total `null`; terminal output renders it as `-`.

Costs use LiteLLM model pricing cached at `~/.config/codex-tools/model-prices.json`. Its `patterns`, `providers`, and `models` fields form one selection snapshot: `patterns` stores normalized model patterns, `providers` stores normalized LiteLLM `litellm_provider` names, and `models` maps exact selected model names to their price records. Remote selection first keeps watched providers and then applies the pattern union, so saved models always meet both filters. Entries without a string `litellm_provider` never enter the snapshot. `ccs cost`, `ccs cost central`, and `ccs models` read the local cache, built-in supplemental prices, and manual overrides. `ccs pricing` prints local selection state. `ccs pricing list` reads and prints selected local prices without a network request. `ccs pricing list --remote` fetches LiteLLM and prints every model from watched providers. Both modes use `model`, `status`, `input/M`, `cache/M`, and `output/M` columns. `ccs pricing pattern` prints watched patterns and local matched-model counts. `ccs pricing pattern watch PATTERN...` and `unwatch PATTERN...` rebuild the complete remote snapshot after exact `yes`. `ccs pricing provider` prints watched providers; `add PROVIDER...` and `remove PROVIDER...` modify only local cache state after exact `yes`, with removal pruning local models that no longer satisfy provider and pattern filters. `ccs pricing refresh` rebuilds the complete snapshot from watched patterns and providers after exact `yes`. Remote request failures render `unavailable` and write nothing. The built-in supplemental table covers GLM-5.2 names. Manual pricing overrides remain under `pricing.overrides` in `profiles.json` with `inputCostPerToken`, `outputCostPerToken`, and `cacheReadInputTokenCost` fields. Missing model prices are reported through terminal `pricing` status and JSON `missingPricingModels`. Cost speed resolution uses top-level `service_tier` from `~/.codex/config.toml`; `fast` or `priority` uses priority pricing, and `standard` or `default` uses standard pricing. JSON output keeps project paths absolute; terminal output shortens paths under `$HOME` to `~/...`.

The no-argument pricing status ends with its immediate commands:

```text
commands: list | pattern | provider | refresh | --help
```

```bash
ccs pricing provider add openai
ccs pricing pattern watch 'gpt-5.*'
ccs pricing list
ccs pricing list --remote
ccs pricing refresh
ccs pricing provider remove openai
```

`ccs list` marks the current profile with `*`. `ccs l -u` also shows `usage` entries from the same config file. Usage-only entries are never written to `~/.codex/config.toml` or `~/.codex/auth.json`, so they are safe for Claude or other app-specific keys you only want to monitor.

`ccs usage` prints the usage-only profiles followed by its immediate commands:

```text
commands: add | remove | --help
```

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
commands: line | agent | server | history | pause | resume | reset | wezterm | --help
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

The server runs in the foreground. Stop it with `Ctrl-C`; after updating, rerun it with the same port and verify the new process through its local health endpoint:

```bash
curl http://127.0.0.1:8765/health
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

For WezTerm, keep `ccs s agent` running in one terminal. It runs in the foreground; stop it with `Ctrl-C` and rerun `ccs s agent` after updating. It writes a timestamped status suffix to `~/.cache/codex-tools/ccs-top-status.txt` on wall-clock second boundaries and reloads `profiles.json` so the `*` marker follows profile switches. Verify it by confirming that file keeps updating. The WezTerm integration renders the clock locally and reads only the suffix from that file, so the GUI callback stays lightweight and the clock stays aligned with the actual clock. If the cached status file goes stale, WezTerm shows `ccs top unavailable`.

Install the WezTerm status bar integration with the project command:

```bash
ccs s wezterm
ccs s wezterm remove
```

`ccs s wezterm` previews the `~/.wezterm.lua` change, then writes after you type exact `yes`; it backs up the existing file under `~/.config/codex-tools/backups/` and inserts a managed status block before `return config`. `ccs s wezterm remove` previews removing that managed block, then removes it after the same confirmation. The installed block reads `~/.cache/codex-tools/ccs-top-status.txt`, renders the clock locally, and hides stale status after a short freshness window; override the file path with `CCS_WEZTERM_STATUS_FILE`.

Rerun `ccs s wezterm` after an update when the managed block needs refreshing. The command replaces the existing managed block after showing the exact preview and receiving `yes`.

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

`ccs sync` prints `different` and `update` field summaries plus its masked diff, then writes the previewed result only if you type exact `yes` at the prompt.

Plain `ccs sync` keeps additive TOML behavior. Repeat `--replace` to select exact dotted leaf paths from `config/codex-config.toml`; duplicate paths count once. `--replace all` selects every template leaf except `model_providers.*.base_url`. Unknown paths, section paths, explicit provider `base_url` replacement, and combining `all` with explicit paths fail before preview. While proxy state exists, a selected `model_provider` change also fails before preview.

Missing template fields remain additive in every form. Selected fields receive template values; other existing values and local-only fields remain unchanged. `different` lists every template leaf that differs or is missing, while `update` lists fields changed by this invocation. Empty lists show `0`.

When applied, `ccs sync` creates the same backup directory first, writes the exact previewed content, and verifies each result by reading it back. It merges template profiles into `~/.config/codex-tools/profiles.json`, keeps existing local API keys and local-only profiles, seeds `top.stateUrls` when `top` is missing, and syncs `~/.codex/AGENTS.md` from `config/codex-agents.md`.

`ccs config` manages local `~/.config/codex-tools/profiles.json` sync with the LAN server copy at `ravvss@10.126.126.1:/home/ravvss/.config/codex-tools/profiles.json` over SSH port `32753`:

```bash
ccs config
ccs config push
ccs config pull
```

Run `ccs config` without arguments to print the local file summary, fixed LAN target, and a compact command line without connecting to the server.

```text
commands: push | pull | --help
```

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

Proxy commands live under `ccs proxy`:

```bash
ccs proxy
ccs proxy --history N
ccs proxy --view overview|tokens|cost
ccs proxy watch
ccs proxy watch --history N
ccs proxy watch --view overview|tokens|cost
ccs proxy mode
ccs proxy mode passthrough
ccs proxy mode retry
ccs proxy mode recovery
ccs proxy mode intercept
ccs proxy config
ccs proxy config retry WINDOW BASE MAX
ccs proxy config latency off
ccs proxy config latency FIRST TOTAL [return_502|retry_then_502]
ccs proxy install
ccs proxy restart
ccs proxy restore
ccs proxy serve
```

The no-argument proxy snapshot ends with its immediate commands. Use `ccs proxy --help` for status options, modes, and configuration syntax.

```text
commands: watch | mode | config | install | restart | restore | serve | --help
```

### Proxy lifecycle

For a first installation, use `ccs` to confirm the active profile and inspect `model_provider` plus `model_providers.<model_provider>.base_url` in `~/.codex/config.toml`. The URL must still be the direct provider URL. Then run:

```bash
ccs proxy
ccs proxy install
ccs proxy
```

`install` previews the config change and writes only after exact `yes` confirmation. A successful install starts the proxy in `passthrough` mode. The final `ccs proxy` verifies the active URL, PID, version, protocol, and mode. Use `ccs proxy mode retry` for lightweight 429/503 handling; use `recovery` or `intercept` only when response inspection is needed.

For a normal tool update, leave the installed routing and state in place:

1. Update the tool using one of the `Install` procedures above.
2. Run `ccs proxy restart` and confirm it with exact `yes`.
3. Run `ccs proxy` and verify the new PID, current package version, health protocol, and preserved mode/history.

`restart` preserves `config.toml` routing, proxy state, mode, and history. It refuses to restart while requests are active. Running `ccs proxy` also replaces a healthy runtime automatically when its protocol or package version does not match the current CLI.

`proxy.json` has an explicit state schema version. When an update changes that schema, the next installed proxy command automatically stops the old runtime, preserves local routing and installation metadata, resets policy to safe `passthrough` defaults, clears incompatible request metrics/history, and starts the current runtime when needed. Current-schema corruption remains an explicit error; manual cache-file deletion is not part of the update flow.

Use `ccs proxy restore` when removing the proxy or before a clean reinstall. It restores the active profile URL, stops the runtime, and removes `proxy.json`. `ccs proxy mode passthrough` instead keeps the local proxy URL and runtime while disabling proxy intervention. When the state file is absent, inspect `~/.codex/config.toml` and restore its provider URL from a known profile or backup before installing again.

Behavior:

- `ccs proxy install` and `ccs proxy restore` semantically modify only `model_providers.<provider>.base_url` in `~/.codex/config.toml`. Install points it to `http://127.0.0.1:4610`; restore resolves `profiles.current` and points it to that profile's `baseURL`. Other TOML fields, profiles, authentication, and unrelated config text remain unchanged.
- Writes `~/.codex/auth.json` as `{ "OPENAI_API_KEY": "..." }`.
- `cx run`, `cxx run`, and `cxxs run` set `CODEX_TOOLS_PROFILE_API_KEY` only for the launched `codex` process and pass temporary provider `base_url` and `env_key` overrides. When proxy state exists, they also pass `http_headers.x-ccs-profile=PROFILE`; the proxy validates and uses that profile for the request, then strips the header before forwarding. The commands do not write `config.toml`, `auth.json`, or `profiles.json`.
- `ccs proxy install` requires explicit `model_provider`, its existing `base_url`, a current profile, and absent proxy state. It previews the current and proxy URLs plus backup path, backs up the current config, starts and health-checks the proxy, then changes and verifies that provider's `base_url` is the local proxy URL. If apply fails after routing is written, it restores the preview source, removes proxy state, and keeps the backup. Mode starts as `passthrough`; use `ccs proxy mode retry` to enable lightweight status retry.
- `ccs proxy mode` prints the active mode. All four mode writes preview the current and target values and require exact `yes`. `passthrough` performs one transparent upstream fetch. `retry` checks only response status and retries 429/503 without reading or inspecting response bodies. `recovery` enables continuation recovery for eligible streaming Responses guard hits; `intercept` uses ordinary guard retry.
- `ccs proxy config` prints the active status-retry and latency settings. `ccs proxy config retry WINDOW BASE MAX` configures the total retry window, base backoff, and maximum backoff in milliseconds; defaults are `3600000`, `1000`, and `30000`. The values are positive timer-range integers with `BASE <= MAX <= WINDOW`. Configuration writes require exact `yes`.
- Latency deadlines are disabled by default. `ccs proxy config latency FIRST TOTAL [ACTION]` enables them after exact `yes`; `ccs proxy config latency off` disables them.
- `ccs proxy restore` resolves `profiles.current` when preview is built, backs up the current config, changes and verifies only the installed provider's `base_url` to that profile's `baseURL`, stops the proxy, and removes state. Install and restore backups remain available for manual recovery; unrelated config edits, profiles, and authentication stay unchanged.
- `ccs proxy` reads one active upstream for each new request. A validated internal `x-ccs-profile` header from a Codex wrapper `run PROFILE` selects that profile for the request; otherwise the proxy uses `profiles.current`. It removes the internal routing header and overwrites incoming `Authorization`, `api-key`, and `x-api-key` headers with `Authorization: Bearer <selected profile apiKey>`. Long-running ordinary Codex CLI processes therefore keep using the proxy URL after `ccs toggle`, while explicit profile launches remain pinned to their requested profile.
- In `retry` mode, only HTTP 429 and 503 are withheld. The proxy honors `Retry-After` seconds or HTTP dates when they fit the configured window; otherwise it uses full-jitter exponential backoff capped by `backoff_max_ms`. The window starts with the first upstream fetch. Expiry returns the last original 429/503 response, and client abort stops the wait. Other statuses and all accepted response bodies are forwarded without inspection.
- Upstream HTTP responses are forwarded as received when the active policy accepts them. Upstream `4xx` and `5xx` responses record `failure_summary.type=upstream_error` and render the upstream failure summary in the history `result` column.
- In `recovery` and `intercept`, upstream capacity errors retry the same upstream when an error response body contains `Selected model is at capacity. Please try a different model.`, or contains both `selected model is at capacity` and `try a different model` case-insensitively. Plain `429` and `5xx` responses without that text are forwarded as received. Capacity defaults to `retry_then_pass_through`; HTTP 429 defaults to `pass_through`. Capacity, 429, reasoning, and first-progress retries share the three-retry policy budget; transport retry remains independent.
- A retryable Capacity response uses `Retry-After` seconds or HTTP date when present. Values over 60 seconds are not waited; missing or invalid values use bounded jitter. Retry waits stop on client abort or the absolute total deadline.
- Transport-level `TypeError: fetch failed` is retried once in `intercept` and `recovery`. `passthrough` does not retry it. A terminal transport failure returns `502` with error type `upstream_error` and code `upstream_fetch_failed`.
- `ccs proxy` forwards only model API paths: `/responses`, `/v1/responses`, `/chat/completions`, and `/v1/chat/completions`. `GET /__codex_proxy/health` is local control traffic. Unsupported paths return local `404 unsupported_proxy_path`, write one event to `~/.cache/codex-tools/proxy/proxy.log`, and do not enter request metrics or history.
- In `recovery` and `intercept` modes, the reasoning guard checks JSON responses and SSE `data:` JSON payloads for explicit non-negative integer `reasoning_tokens` values `516`, `1034`, and `1552`. Guard matches retry the same upstream request up to three times, then return `502 reasoning_guard_triggered`.
- In `recovery` mode, streaming Responses requests automatically include `reasoning.encrypted_content` when needed for recovery. If a guarded stream contains encrypted reasoning items, `ccs proxy` first retries with a continuation request. Context compaction requests and `intercept` mode use ordinary guard retry.
- Guard actions are recorded in request history under `guard_actions` and as JSON lines in `~/.cache/codex-tools/proxy/proxy.log`. Each action stores `action`, `upstream`, `attempt`, `status`, `reasoning_tokens`, and `error`; `continuation_recovery` marks a Responses continuation retry.
- `ccs proxy` starts the background proxy when proxy state exists and a current-protocol healthy proxy process is unavailable. If the health endpoint reports a different protocol, it records `ccs_proxy_protocol_restart` with `server_protocol`, `client_protocol`, and `pid` in `proxy.log`, stops that process, and starts the current proxy.
- Proxy runtime files live beside the proxy state under `~/.cache/codex-tools/proxy/`: `proxy.pid` stores the background process id, `proxy-runtime.log` stores recent background stdout/stderr up to 16M, `proxy.log` stores recent guard, unsupported-path, and proxy error events up to 16M, and `proxy-requests.jsonl` stores recent completed model API requests with JSONL-only `attempt_records` and sanitized `request_headers` up to 64M.
- `backups/config-<timestamp>.toml` is a complete `config.toml` snapshot made before install; `backups/config-restore-<timestamp>.toml` is a complete snapshot made before restore. They are archives for manual inspection or recovery, are not automatically selected by `restore`, and are not automatically deleted.
- A newly started proxy process clears persisted `active_requests` before serving traffic, so `active` only shows requests owned by the current proxy process.
- `ccs proxy` without arguments prints runtime state, paths, summaries, active requests, and completed history once and exits. `ccs proxy watch` keeps the table-focused view compact: `passthrough` hides policy and reasoning summaries, `retry` shows only 429/503 retry counts, and inspection modes show the complete policy and reasoning summaries. Latency statistics remain visible in every mode.
- Every view begins with `session time up model` and ends with `result`. Overview adds `reas./code dur. size`; tokens adds `input output cached`; cost adds `input$ output$ cached$ total$`. Active `dur.` is elapsed time and history `dur.` is total request time. The 10-cell model column shows the available actual model, colors equal request/upstream models green and differing actual upstream models red, then abbreviates `gpt-` to `o` and truncates.
- Token and cost columns aggregate every proxy-owned upstream attempt. `input` is uncached input (`input_tokens - cached_input_tokens`), matching the `input$` pricing basis; `cached` reports cached input separately. A token total appears only when every attempt reports the required fields. Cost uses each attempt's exact upstream/request model and response/request/config service tier with local cached prices and profile overrides; it performs no network refresh. Missing facts render as `-`, and cached input above input tokens renders `invalid`.
- `ccs proxy` terminal output displays local file paths under `$HOME` with `~/`.
- `ccs proxy serve` runs the proxy server in the foreground for direct debugging.
- `ccs proxy` forwards request bodies at their original size. Runtime and upstream resources determine practical payload bounds.
- In `recovery` and `intercept`, an enabled latency policy starts the absolute total deadline with the first upstream fetch and spans retries and waits. The first-progress deadline restarts for each real attempt and accepts only non-empty output text, a final answer, or a tool call as progress.
- In `recovery` and `intercept`, SSE inspection is incremental across arbitrary chunks, mixed LF/CR/CRLF delimiters, and a BOM split across chunks. Accepted bytes are forwarded unchanged. A candidate SSE event larger than 1 MiB fails with `response_inspection_limit_exceeded`. `passthrough` does not run this scanner.
- The live proxy view separates `active` and `history`. `active` contains supported model API requests currently being processed by the proxy, including upstream SSE buffering before client headers are written. Completed, failed, and fully streamed model API responses move to `history`, whose data rows are dimmed while section labels and table headers remain at normal intensity. `proxy.json.metrics.recent_requests` keeps the newest 100 completed model API requests as a compact status snapshot; `proxy-requests.jsonl` keeps bounded completed model API request history in completion order. Compact state history is written before the complete JSONL record append, so JSONL append failures are recorded in `proxy.log` after the client response state is settled. Default status rendering reads history from `proxy.json`. TTY output computes history row count from terminal height, non-TTY output uses 5 history rows, and `--history N` overrides both. When `--history N` exceeds the snapshot length, status rendering reads the tail of `proxy-requests.jsonl`.
- Active and history records use request schema `7`; proxy health uses protocol `6`. State snapshots and JSONL history require the current contract. `retry_summary` separates HTTP 429 and 503 retries. JSONL `attempt_records` identify each real upstream dispatch and store status retry triggers and delays without prompt or response bodies.
- For supported model paths, proxy metrics record request facts, retry summary, and timing. Intervention modes also record inspected upstream metadata, usage, reasoning observations, and response shape. `passthrough` deliberately leaves response-content-derived fields empty. `latency_ms` is total proxy request latency, `upstream_wait_ms` is final-attempt time to upstream headers, and `client_ttfb_ms` is time to proxy response headers written to the client. Request records store `request_body_sha256`; prompt and response text stay outside runtime records.
- Proxy-internal retry attempts render as a yellow number after the upstream name, such as `input3`. The `result` column combines successful policy-action prefixes and failure summaries. Repeated Codex client requests use `client:<attempt>`; guard actions use `guard`, `cap`, `rec`, `block`, and `err` prefixes. The visible detail uses local `error` first, then `failure_summary.code/message` for upstream HTTP failures.
- Proxy tables format elapsed time and byte size with compact 3-significant-digit units after the base unit, such as `56ms`, `2.34s`, `43.2s`, `3.12m`, `32.0K`, and `3.41M`.
- Proxy metrics are recomputed from `proxy.json.metrics.recent_requests`, so request statistics cover the newest 100 completed model API requests plus the current active count. `status events` is the sum of exact status-code events. The `policy` line aggregates `retry_summary` across the complete recent-request window, independent of rendered history rows and `--history`; `retries` equals Capacity, 429, reasoning, timeout, and transport retries. The title shows `deadline: off` or the active first/total values and action. Reasoning and latency summaries use the same state window. `ccs proxy restore` removes the state file, and the next install starts a new statistics window.
- `ccs proxy help` prints the proxy command summary.
- Does not print API keys directly; status output masks keys and includes `user@host`.
- `ccs`, `ccs toggle`, and `ccs PROFILE` print a `usage:` line with local time. `ccs list --usage` fetches usage for all profiles in parallel and prints cost, input, output, cache, and request counts as aligned columns. `ccs top` fetches all profiles and usage-only profiles in parallel and keeps the display to one refreshing line. Usage is fetched from `BASE_URL/v1/usage` with the profile API key; failures print `usage: HH:MM:SS unavailable` or `unavailable`, and missing keys print `usage: HH:MM:SS skipped` or `skipped`.
- Fails if the profile or API key is missing.

## cimg

`cimg` generates one PNG from one text prompt through the active `ccs` profile. It always calls `{baseURL}/v1/images/generations` with `model=gpt-image-2`, `n=1`, and `output_format=png`.

```bash
cimg
cimg -p "A red ceramic cup on a white background"
cimg -p "A wide mountain landscape" --ratio 16:9 --size 2048x1152 --quality high
cimg -p "A vertical poster without text" --ratio 9:16 -o poster.png
cimg version
cimg -v
cimg --help
```

The default is `1:1`, `1024x1024`, and `auto` quality. Ratios are fixed to `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`, and `9:21`; each ratio accepts only the sizes printed by `cimg --help`. Quality accepts `auto`, `low`, `medium`, or `high`.

With no arguments, `cimg` prints the active profile, base URL, API key state, fixed model, defaults, output directory, and request log path. Generation prints the same request plan and writes nothing until you type exact `yes`. The default output name is `image-<timestamp>.png` in the current directory; existing files are not overwritten. Completion output and logs use the PNG's actual IHDR dimensions and warn when the provider returns a different size from the request; `cimg` does not resize the image.

Every API request writes two schema v1 lifecycle events with the same `request_id`:

```text
~/.cache/codex-tools/cimg/requests.jsonl
```

`started` is appended before the HTTP request. `succeeded` or `failed` is appended after completion with duration, HTTP status, output bytes, actual PNG width and height, or normalized error facts. The bounded `0600` log stores the prompt SHA-256 and character count, not the API key, prompt text, provider error message, response body, or image base64.

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

Monitor tables read the active terminal width. `clvm monitor` uses the terminal alternate screen in TTY mode, hides the cursor while active, repaints from the home cursor position, clears rewritten lines and the remaining screen tail, restores the main screen on exit, and repaints immediately when the terminal size changes. Its footer stays on the terminal's bottom row and shows history visibility plus `t history  q/Ctrl-C exit`; press `t` to hide or show `recent closed`. History starts visible, and hiding it changes only terminal rendering while collection continues. `--no-clear` appends samples in the main screen without interactive keys or the shortcut footer. The monitor header starts with a labeled `clvm monitor` and bare `HH:mm:ss` time, and TTY output fits that header to the active terminal width. Current connection rows show endpoint, merged `age/zeroFor`, `up/s`, `down/s`, optional traffic totals, optional chain, and rule. The `status` column is omitted; zero time carries the status color, with `0ms` green and non-zero values yellow. Speed cells omit `/s` because the unit is already in the `up/s` and `down/s` headers. Unknown table speed and traffic cells render as `-`. Narrower terminals omit traffic total and chain columns before truncating long text. When the visible columns still exceed the terminal width, `endpoint` compresses before speed, chain, and rule details. The final `rule` column takes remaining width and uses the shared ANSI/wide-character-aware table truncation. Table traffic totals and speed cells use compact 3-significant-digit units such as `160K` and `43.2M`; config and header speed summaries keep explicit `/s` units such as `160K/s`.

`recent closed` shows connections that `clvm monitor` successfully closed through mihomo. Its data rows are dimmed while the section label and table header remain at normal intensity, separating closed history from current connections. The monitor keeps up to 100 recent closed records in memory. TTY output computes visible `recent closed` rows from terminal height after the header and current connection table, so small terminals can show zero closed rows and taller terminals show more. Non-TTY output renders 5 closed rows for deterministic logs.

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

Default discovery:

```bash
senv
```

With no path options, `senv` finds the single file in the current directory whose
name ends with `.env.example` and removes the final `.example` suffix for the
target. For example, `.env.example` targets `.env`, while
`runtime.env.example` targets `runtime.env`. If the directory has no matching
file or more than one, specify both paths explicitly.

Explicit paths:

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
codex-rename help | -h | --help                         # show help
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
node dist/bin/cimg.js -v
node dist/bin/cimg.js --help
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
node --test test/cli-surface.test.js
git diff --check
node dist/bin/ccs.js --help
node dist/bin/ccs.js -v
node dist/bin/cimg.js -v
node dist/bin/cimg.js --help
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
