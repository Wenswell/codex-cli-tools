# CLI Lifecycle Plan

Status: implemented in `0.2.48`

## Goal

Document the first-run, update, stop, restart, and verification paths for every
public command that owns or depends on a long-running process. Add the one
missing managed-process command needed by `ccs proxy`.

## Scope

### Managed background processes

- `ccs proxy`: add `restart`; keep `ccs proxy` as status/automatic start.
- Treat a healthy proxy as reusable only when both health protocol and package
  version match the current CLI.
- Keep `mode passthrough` as the supported way to disable interception while
  preserving local routing. Do not add `start` or `stop` aliases.
- Reject an explicit restart while requests are active. Restart remains a
  preview-first action requiring exact `yes`.

### Upstream daemon dependency

- Document `codex app-server daemon bootstrap`, `start`, `restart`, `stop`, and
  `version` for the default `cx`, `cxx`, and `cxxs` mode.
- Keep daemon ownership in Codex CLI; do not duplicate those commands in this
  package.

### Foreground long-running commands

- Document that `ccs s server`, `ccs s agent`, `ccs top`, and `clvm monitor`
  run in the foreground.
- Document stop, update restart, and the existing status/health verification
  surface for each command.
- Document rerunning `ccs s wezterm` after an update when the managed status
  integration needs refreshing.

## Implementation

1. Replace protocol-only proxy reuse checks with protocol-and-version runtime
   checks in normal startup and start-lock paths.
2. Record one normalized runtime-restart event with old/new protocol and version.
3. Add `ccs proxy restart` preview, exact confirmation, graceful stop, current
   version start, and post-start verification.
4. Update proxy help, top-level help, README, and proxy spec.
5. Build `dist`, bump the patch version, run focused tests, then run the full
   suite once before committing.

## Acceptance

- An old healthy proxy version is replaced the next time proxy startup is
  ensured; a matching runtime is reused.
- `ccs proxy restart` changes the PID, preserves config/routing/mode/history,
  and reports the current package version and health protocol.
- Restart preview writes nothing; only exact `yes` applies it.
- Restart refuses while `active_requests` is non-empty.
- README contains executable first-run and update lifecycle instructions for
  every process listed in this plan.
- Source help and built `dist` agree; focused and full tests pass.

## Non-goals

- No service-manager generator or supervisor abstraction.
- No proxy `start`/`stop` aliases.
- No state-corruption recovery redesign.
- No lifecycle commands for one-shot wrappers or file-only configuration tools.
