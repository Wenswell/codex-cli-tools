# codex-tools

Personal Codex CLI helpers for Linux and macOS.

## Requirements

- Node.js 20+
- pnpm
- `codex` CLI for `cxs` and `cxsx`
- `sqlite3` CLI for `codex-session-move`

## Install

From this repository:

```bash
pnpm install
pnpm build
pnpm link --global
```

From a private Git repository:

```bash
pnpm add -g git+ssh://git@github.com/YOUR_NAME/codex-tools.git#master
```

Update to the latest version on another machine with the same command:

```bash
pnpm add -g git+ssh://git@github.com/YOUR_NAME/codex-tools.git#master
```

If you clone the repository on that machine and want a live development link:

```bash
git clone git@github.com:YOUR_NAME/codex-tools.git
cd codex-tools
pnpm install
pnpm build
pnpm link --global
```

## Commands

```bash
ccs
cxs
cxsx
envsync
codex-session-move
```

## cxs / cxsx

`cxs` runs Codex in search mode and forwards stdin, stdout, stderr, arguments, and exit code.

```bash
cxs ARGS...
```

Equivalent to:

```bash
codex --search ARGS...
```

`cxsx` also bypasses approvals and sandboxing.

```bash
cxsx ARGS...
```

Equivalent to:

```bash
codex --search --dangerously-bypass-approvals-and-sandbox ARGS...
```

Use `cxsx` only in directories and tasks you trust.

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

Run `ccs` without arguments to print the current profile plus command help.

Supported commands:

```bash
ccs
ccs init
ccs sync
ccs status
ccs list
ccs input
ccs ciii
ccs PROFILE
ccs toggle
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
  "current": "input"
}
```

Fill in the API keys manually. The file is written with `0600` permissions.

`ccs init` also fills missing defaults in:

```text
~/.codex/config.toml
```

Those defaults come from:

```text
config/codex-config.toml
```

This is used for baseline Codex settings such as top-level model/provider fields, `[features]`, and `[model_providers.codex]`. Existing keys and unrelated sections, such as trusted projects, are kept.

If `config/ccs-profiles.json` changes later, run:

```bash
ccs sync
```

`ccs sync` merges template profiles into `~/.config/codex-tools/profiles.json` and keeps existing local API keys. It also keeps local profiles that are not in the template.

`ccs sync` also fills missing defaults from `config/codex-config.toml` into `~/.codex/config.toml`.

Switching profile:

```bash
ccs input
ccs ciii
ccs PROFILE
ccs toggle
```

Behavior:

- Updates `base_url` in `~/.codex/config.toml`.
- Writes `~/.codex/auth.json` as `{ "OPENAI_API_KEY": "..." }`.
- Does not print API keys directly; status output masks keys.
- Fails if the profile or API key is missing.

## envsync

`envsync` regenerates a target env file from an example env file while preserving existing values.

Default:

```bash
envsync
```

Equivalent to:

```bash
envsync --source .env.example --target .env
```

Options:

```bash
envsync --source .env.example --target .env.local
envsync --backup
```

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

CLI output includes the updated file and counts/lists for added, filled defaults, preserved, preserved empty, and extra keys.

## codex-session-move

`codex-session-move` updates local Codex session directory associations after a project folder is renamed.

Codex stores the directory association in:

```text
~/.codex/state_5.sqlite
  threads.cwd

~/.codex/sessions/**/*.jsonl
  first line session_meta.payload.cwd
```

Usage:

```bash
codex-session-move OLD_PATH NEW_PATH
codex-session-move OLD_PATH NEW_PATH --prefix
codex-session-move OLD_PATH NEW_PATH --prefix --apply
```

Default mode is dry-run. Nothing is modified unless `--apply` is provided.

Path behavior:

- Default: migrate sessions whose `cwd` is exactly `OLD_PATH`.
- `--prefix`: migrate `OLD_PATH` and every child path under it.
- Prefix mode preserves the relative path below `OLD_PATH`.

Example:

```bash
codex-session-move /home/me/repos/old /home/me/repos/new --prefix --apply
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
- Creates a backup directory under `~/.codex/backups/session-cwd-migration-YYYYMMDD-HHMMSS/`.
- Backs up the state SQLite file and every rollout JSONL that will be modified.
- Updates SQLite in a transaction.
- Updates only the first line of each rollout JSONL.
- Verifies old cwd remaining count, new cwd count, and JSONL first-line sync.

Dry-run output lists matched sessions and rollout files.

Apply output includes:

```text
backup: ...
sqlite updated: ...
jsonl updated: ...
old cwd remaining: ...
new cwd count: ...
jsonl synced: ...
```

## Development

```bash
pnpm install
pnpm build
```

Run commands locally from `dist` after building:

```bash
node dist/bin/envsync.js --help
node dist/bin/codex-session-move.js --help
```

Check TypeScript:

```bash
pnpm check
```
