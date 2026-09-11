# cxxs Remote Resume Fix

## Scope

Fix the `cxxs` default remote resume launch. Codex rejects permission overrides
when resuming a remote task, so the remote wrapper must omit
`--dangerously-bypass-approvals-and-sandbox`.

## Implementation

- Keep `cxxs` resume behavior and remote app-server routing unchanged.
- Add the bypass flag only when the launch is local, or when the command is not
  a resume wrapper.
- Keep bypass enabled for `cxxs local` and `cxxs run PROFILE`.
- Update the CLI regression tests, README command equivalence, and built `dist`.

## Acceptance

- `cxxs THREAD` emits `--search --remote unix:// -C <cwd> resume THREAD` with
  no permission override.
- `cxxs local THREAD` and `cxxs run PROFILE THREAD` retain the bypass flag.
- Targeted wrapper tests and the full test suite pass.
