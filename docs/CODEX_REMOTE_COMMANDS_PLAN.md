# Codex remote commands plan

## Scope

- Add `ccs r` to query `codex app-server daemon version` and print the daemon `status` and `appServerVersion` with semantic terminal colors.
- Add `cxr`, `cxxr`, and `cxxsr` as the remote counterparts of `cx`, `cxx`, and `cxxs`; each adds `--remote unix:// -C CURRENT_DIRECTORY` before any Codex subcommand.
- Reuse the existing Codex launcher and shared package-version behavior. Do not add aliases, configuration, or fallback process detection.

## Implementation

1. Parse the daemon command's JSON response and require the two displayed fields.
2. Reserve `r` in the `ccs` router and document it in status/help output.
3. Extend the existing launcher options with remote mode, pass the caller's absolute current directory through `-C`, and add three small bin entrypoints.
4. Register the bins, update README examples, and rebuild `dist`.

## Acceptance

- `ccs r` prints colored `status` and `version` values from the daemon JSON response.
- `cxr`, `cxxr`, and `cxxsr` preserve their base command flags and pass `--remote unix:// -C CURRENT_DIRECTORY` to Codex.
- All six Codex wrappers print the shared package version through `version` and `-v`.
- Focused tests, type checking, and the full repository test suite pass.
