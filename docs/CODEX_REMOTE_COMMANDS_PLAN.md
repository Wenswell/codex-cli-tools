# Codex Command Mode Plan

Status: implemented in `0.2.55`

## Scope

- Make `cx`, `cxx`, and `cxxs` connect to the Codex app-server daemon by default.
- Reserve the first positional argument `local` to run the same command against
  the local Codex session instead.
- Remove `cxr`, `cxxr`, and `cxxsr` from source, package bins, documentation,
  tests, and built output.

## Command Contract

| command | default | `local` mode |
| --- | --- | --- |
| `cx [local] ARGS...` | `codex --search --remote unix:// -C "$PWD" ARGS...` | `codex --search ARGS...` |
| `cxx [local] ARGS...` | `codex --search --dangerously-bypass-approvals-and-sandbox --remote unix:// -C "$PWD" ARGS...` | same command without `--remote unix:// -C "$PWD"` |
| `cxxs [local] ARGS...` | same as `cxx`, followed by `resume ARGS...` | same command without `--remote unix:// -C "$PWD"` |

`local` is consumed only when it is the first argument. It is not forwarded to
Codex. `version` and `-v` remain the shared package-version commands.

## Implementation

1. Change the launcher to default to remote mode and consume leading `local`.
2. Make the three retained bins use the default remote launcher behavior.
3. Delete the remote-only bin files and package registrations.
4. Update README, lifecycle documentation, and focused tests.
5. Rebuild `dist`, run type and test checks, then increment the patch version
   and commit the complete change.

## Acceptance

- Default invocations use `--remote unix:// -C CURRENT_DIRECTORY`.
- Each retained command accepts leading `local` and omits those remote flags.
- `cxr`, `cxxr`, and `cxxsr` are absent from source, package bins, and `dist`.
- The built command behavior, README, and tests agree.
