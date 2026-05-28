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
cx
cxx
cxxs
senv
codex-rename
codex-notice
```

## CLI conventions

- No-argument/status commands print active configuration values, not just file paths.
- New user-facing tools include a basic CLI surface, not only an internal hook/script entry.
- No-argument output combines compact status with a compact command/help line when the tool has user-facing commands.
- `-h`, `--help`, and `help` are dedicated help output. They print one command per line and include a short comment for every command.
- Usage/help/commands text is lower-value than state and results, so it appears at the bottom when combined with other output.
- Commands that modify files default to preview and require typing exact `yes` at the prompt to write.
- Write/apply commands first print the same plan as preview, then ask for confirmation and print the actual result.
- Invalid arguments fail with a short explicit error instead of stack traces or silent fallback.
- Logs preserve complete original input, event, and response data. Summaries or previews can be added, but cannot replace the raw facts.
- Secrets live in environment variables or `~/.config/codex-tools`, not package files.
- Command surfaces stay small; legacy modes are removed when contracts change.

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

## codex-notice

`codex-notice` receives Codex native `notify` payloads and forwards them to a Feishu custom bot.

Set `FEISHU_BOT_WEBHOOK` in the environment, or create `~/.config/codex-tools/notice.env`:

```bash
mkdir -p ~/.config/codex-tools
chmod 700 ~/.config/codex-tools
printf 'FEISHU_BOT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx\n' > ~/.config/codex-tools/notice.env
chmod 600 ~/.config/codex-tools/notice.env
```

File format:

```text
FEISHU_BOT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
```

Read order:

```text
FEISHU_BOT_WEBHOOK environment variable
~/.config/codex-tools/notice.env
```

Add this to `~/.codex/config.toml`:

```toml
notify = ["codex-notice", "hook"]
```

`ccs init` and `ccs sync` include this `notify` line in the default Codex config template.

Local test:

```bash
codex-notice test
codex-notice test "done"
```

Other commands:

```bash
codex-notice                           # show active webhook, config, log, and commands
codex-notice status                    # show active webhook, config, and log
codex-notice config WEBHOOK           # preview, confirm, and write Feishu webhook config
codex-notice test [MESSAGE]            # send a test notification
codex-notice logs [N]                  # show recent send logs
codex-notice hook JSON_PAYLOAD         # receive Codex notify payload and send Feishu card
```

`codex-notice` prints the active webhook URL, config path, log path, and one compact `commands:` line. `codex-notice status` prints only the active configuration. `codex-notice config WEBHOOK` previews the config write, then writes `~/.config/codex-tools/notice.env` with `0600` permissions only after you type exact `yes`.

Message format uses a Feishu interactive card. The title is the assistant reply preview with no low-value prefix, so notification lists show the useful content first. Common Markdown decoration is removed from the title only, and common Chinese punctuation is normalized to ASCII punctuation. time/user, cwd, and user input are shown as separate grey blocks, followed by a Markdown preview and a collapsed remaining reply panel when the reply is long.

```text
[done]
🕒 2026-05-22 11:05:27  👤 user@host

📁 ~/project

💬 do it

---

done

剩余回复（点击展开）
```

`codex-notice` only sends Feishu notifications for main Codex TUI conversations (`client: "codex-tui"`). Other notify payloads, such as subagent completions, are skipped for Feishu delivery but still written to the local log with the complete original payload.

`codex-notice` keeps the latest 10 debug entries in `codex-notice.log.jsonl`. Each sent entry stores the complete original Codex notify payload, the generated Feishu card request, and the Feishu response. Skipped entries store the complete original payload and skip reason. The log is ignored by Git.

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
commands: ccs | PROFILE | [toggle|add|rm] [PROFILE] | top | config [push|pull] | s [line|agent|server|history|pause|resume|reset|wezterm] | list [-u] | usage | init | sync
```

Supported commands:

```bash
ccs
ccs PROFILE
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

The server uses a longer unattended backoff: `25s`, `1m`, `2m`, `5m`, `10m`, then `15m`. Providers never become `done`; unchanged providers keep refreshing every 15 minutes after reaching the maximum interval, and any observed usage change resets that provider to `25s`. The server only requests usage when a provider is due; `/ccs/top/state` serves the current status view, `/ccs/top/history` serves compact aggregated history for a requested window, `/health` returns a compact health JSON, and `POST /ccs/top/pause` / `POST /ccs/top/resume` pause or resume polling. `POST /ccs/top/reset` refreshes immediately and resets polling to `25s`. Run `ccs s pause`, `ccs s resume`, or `ccs s reset` from any client machine with `top.stateUrls`; the command posts to the first reachable configured server, so it does not need to be run on the cloud server itself. Point status-line clients at LAN servers with `top.stateUrls` in `~/.config/codex-tools/profiles.json`, for example:

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

Run `ccs s history` to render today's usage from the first reachable configured top server. Usage counters reset at midnight, so the default report starts at local `00:00` instead of mixing two daily accounting windows. History is collected by `ccs s server`, not `ccs s agent`; restart the server after updating so it serves the compact `/ccs/top/history` API. The server keeps raw snapshot records in `~/.cache/codex-tools/ccs-top-history.jsonl`, but HTTP clients request only display data for the needed window: total trend with summary, and 30-minute bucket changes. Bucket changes print two consecutive buckets per row. The endpoint accepts `since`, `until`, `bucketMinutes`, and `profile` query parameters. Use `ccs s history PROFILE` to focus the same report on one provider:

```bash
ccs s history
ccs s history input
```

Example output:

```text
ccs usage history  today  bucket 30m
source: http://10.126.126.1:8765/ccs/top/history?since=...&bucketMinutes=30

total trend                                                                        summary
    $25  ┼                                                                         input
    $20  ┤                                  ╭─────────────────────────────          now      $22.4
    $15  ┤                                  │                                         5h delta +$10.0
    $10  ┤                ╭─────────────────╯                                         last     14:32 +$0.2
     $5  ┤                │
     $0  ┼────────────────╯┬─────────────────┬────────────────┬─────────────────┬
         00:00           06:00             12:00            18:00           24:00

bucket changes
time          total  input  |  time          total  input
19:00-19:30  +$4.1  +$4.1  |  19:30-20:00  +$2.3  +$2.3
20:00-20:30  +$0.2  +$0.2  |
```

For WezTerm, keep `ccs s agent` running in one terminal. It writes a tiny complete status line to `~/.cache/codex-tools/ccs-top-status.txt` every second. The WezTerm integration reads that file directly, so it does not spawn `node` or request HTTP from the GUI status callback. If the configured state source is unavailable, the agent writes `ccs top unavailable`; if the agent stops, the whole status line stops changing instead of showing a fresh clock with stale usage values.

Install the WezTerm status bar integration with the project command:

```bash
ccs s wezterm
ccs s wezterm remove
```

`ccs s wezterm` previews the `~/.wezterm.lua` change, then writes after you type exact `yes`; it backs up the existing file under `~/.config/codex-tools/backups/` and inserts a managed status block before `return config`. `ccs s wezterm remove` previews removing that managed block, then removes it after the same confirmation. The installed block reads `~/.cache/codex-tools/ccs-top-status.txt`; override the file path with `CCS_WEZTERM_STATUS_FILE`.

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

`ccs init` preserves the current top-level `model_provider`, preserves any existing extra `[model_providers.*]` sections that are not in the template, restores the current provider's `base_url` after syncing the template, and syncs the default global Codex guidelines to `~/.codex/AGENTS.md`. Later profile switches only change that API URL and `~/.codex/auth.json`.

`ccs init` shows:

- a short summary of files to modify and back up
- unified diff style output for each file that would change
- masked secrets in `profiles.json` and `auth.json`
- warnings for risky changes such as removed sections or current-profile switches

If `config/ccs-profiles.json` changes later, run:

```bash
ccs sync
```

`ccs sync` prints its plan first and writes only if you type exact `yes` at the prompt.

When applied, `ccs sync` also creates the same backup directory first. Then it merges template profiles into `~/.config/codex-tools/profiles.json`, keeps existing local API keys, keeps local profiles that are not in the template, seeds `top.stateUrls` with the cloud-first/local-fallback defaults when `top` is missing, syncs `~/.codex/config.toml` from the template while preserving the current `model_provider`, current provider `base_url`, and existing extra `[model_providers.*]` sections, and syncs `~/.codex/AGENTS.md` from `config/codex-agents.md`.

`ccs config` compares the local `~/.config/codex-tools/profiles.json` with the LAN server copy at `ravvss@10.126.126.1:/home/ravvss/.config/codex-tools/profiles.json` over SSH port `32753`:

```bash
ccs config
ccs config push
ccs config pull
```

Run `ccs config` without arguments to print the local file summary, fixed LAN target, and a compact command line without connecting to the server.

`push` uploads the local file to the LAN server. `pull` downloads the LAN server file to the local machine. Both commands preview first and apply only after you type exact `yes`; explicit push/pull previews connect to the server, print a masked unified diff, replace the whole file instead of merging, and create a backup before overwriting an existing target.

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

Behavior:

- Updates the current provider's `base_url` in `~/.codex/config.toml`.
- Writes `~/.codex/auth.json` as `{ "OPENAI_API_KEY": "..." }`.
- Does not print API keys directly; status output masks keys and includes `user@host`.
- `ccs`, `ccs toggle`, and `ccs PROFILE` print a `usage:` line with local time. `ccs list --usage` fetches usage for all profiles in parallel and prints cost, input, output, cache, and request counts as aligned columns. `ccs top` fetches all profiles and usage-only profiles in parallel and keeps the display to one refreshing line. Usage is fetched from `BASE_URL/v1/usage` with the profile API key; failures print `usage: HH:MM:SS unavailable` or `unavailable`, and missing keys print `usage: HH:MM:SS skipped` or `skipped`.
- Fails if the profile or API key is missing.

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
node dist/bin/senv.js --help
node dist/bin/codex-rename.js --help
```

Check TypeScript:

```bash
pnpm check
```
