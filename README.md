# codex-tools

Personal Codex CLI helpers for Linux and macOS.

TTY output uses color for status, paths, warnings, and summaries. Set `NO_COLOR=1` to disable colors.

## Requirements

- Node.js 20+
- pnpm
- `codex` CLI for `cx`, `cxx`, and `cxxs`
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
cx
cxx
cxxs
senv
codex-rename
codex-notice
```

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

## codex-notice

`codex-notice` receives Codex native `notify` payloads and forwards them to a Feishu custom bot.

Set `FEISHU_BOT_WEBHOOK` in the environment, or create `.env` in this package directory:

```dotenv
FEISHU_BOT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
```

Add this to `~/.codex/config.toml`:

```toml
notify = ["codex-notice"]
```

`ccs init` and `ccs sync` include this `notify` line in the default Codex config template.

Local test:

```bash
codex-notice '{"type":"agent-turn-complete","cwd":"/home/me/project","input-messages":["do it"],"last-assistant-message":"done"}'
```

Message format:

```text
Codex agent-turn-complete
cwd: ~/project
user: do it

done
```

## ccs

`ccs` switches Codex between OpenAI-compatible provider profiles.

Profile config lives at:

```text
~/.config/codex-tools/profiles.json
```

`ccs` updates:

```text
~/.codex/config.toml
~/.codex/auth.json
```

Run `ccs` without arguments to print the current profile, `user@host`, usage, and one usage line.

Supported commands:

```bash
ccs
ccs PROFILE
ccs toggle [PROFILE]
ccs list | l [-u|--usage]
ccs init [-n|--dry-run|-y|--yes]
ccs sync [-n|--dry-run|-y|--yes]
ccs add [PROFILE]
ccs remove | rm | delete PROFILE
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
  "toggle": ["input", "ciii"]
}
```

Fill in the API keys manually. The file is written with `0600` permissions.

`ccs init` first reads the current Codex API settings from:

```text
~/.codex/config.toml
~/.codex/auth.json
```

It stores the current `base_url` and `OPENAI_API_KEY` as a profile named `current`, then makes `current` the active profile.

`ccs init` then syncs:

```text
~/.codex/config.toml
```

from:

```text
config/codex-config.toml
```

Preview first:

```bash
ccs init
```

Apply changes:

```bash
ccs init -y
```

`--yes` is also accepted. Preview output includes `Dry run only. Re-run with -y or --yes to apply changes.`

Before writing, it backs up the current files to:

```text
~/.config/codex-tools/backups/ccs-YYYYMMDD-HHMMSS/
```

`ccs init` preserves the current top-level `model_provider`, preserves any existing extra `[model_providers.*]` sections that are not in the template, and restores the current provider's `base_url` after syncing the template. Later profile switches only change that API URL and `~/.codex/auth.json`.

`ccs init` without `-y` shows:

- a short summary of files to modify and back up
- unified diff style output for each file that would change
- masked secrets in `profiles.json` and `auth.json`
- warnings for risky changes such as removed sections or current-profile switches

If `config/ccs-profiles.json` changes later, run:

```bash
ccs sync
```

`ccs sync` previews by default. To apply changes:

```bash
ccs sync -y
```

`--yes` is also accepted.

When applied, `ccs sync` also creates the same backup directory first. Then it merges template profiles into `~/.config/codex-tools/profiles.json`, keeps existing local API keys, keeps local profiles that are not in the template, and syncs `~/.codex/config.toml` from the template while preserving the current `model_provider`, current provider `base_url`, and existing extra `[model_providers.*]` sections.

Explicit dry-run flags are also accepted:

```bash
ccs init -n
ccs sync -n
```

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
- `ccs`, `ccs toggle`, and `ccs PROFILE` print a `usage:` line with local time. `ccs list --usage` fetches usage for all profiles in parallel and prints it as the last column. Usage is fetched from `BASE_URL/v1/usage` with the profile API key; failures print `usage: HH:MM:SS unavailable` or `unavailable`, and missing keys print `usage: HH:MM:SS skipped` or `skipped`.
- Fails if the profile or API key is missing.

## senv

`senv` regenerates a target env file from an example env file while preserving existing values.

Default:

```bash
senv -y
```

Equivalent to:

```bash
senv --source .env.example --target .env -y
```

Run `senv` without arguments to print help.

Default mode is dry-run. Nothing is modified unless `-y` or `--yes` is provided.

Options:

```bash
senv -y
senv --source .env.example --target .env.local -y
senv -b -y
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

`codex-rename` updates local Codex session directory associations after a project folder is renamed.

Codex stores the directory association in:

```text
~/.codex/state_5.sqlite
  threads.cwd

~/.codex/sessions/**/*.jsonl
  first line session_meta.payload.cwd
```

Usage:

```bash
codex-rename OLD_PATH NEW_PATH
codex-rename OLD_PATH NEW_PATH --prefix
codex-rename OLD_PATH NEW_PATH --prefix --apply
```

Default mode is dry-run. Nothing is modified unless `--apply` is provided.

Path behavior:

- Default: migrate sessions whose `cwd` is exactly `OLD_PATH`.
- `--prefix`: migrate `OLD_PATH` and every child path under it.
- Prefix mode preserves the relative path below `OLD_PATH`.

Example:

```bash
codex-rename /home/me/repos/old /home/me/repos/new --prefix --apply
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
