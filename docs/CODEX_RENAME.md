# codex-rename

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

