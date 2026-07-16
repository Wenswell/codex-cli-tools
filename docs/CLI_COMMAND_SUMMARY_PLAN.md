# CLI Command Summary Plan

Status: implemented in `0.2.49`

## Goal

Make no-argument `commands:` summaries follow the CLI hierarchy: the `ccs`
status shows only immediate commands, while each command namespace shows its
complete accepted command and parameter surface.

## Contract

### `ccs`

- Keep direct top-level parameters such as `run PROFILE [ARGS]`,
  `models [--json]`, and `sync [--replace ...]`.
- Show namespaces only as `pricing`, `proxy`, `cost`, `config`, `s`, and
  `usage`; do not expand their subcommands at the root.
- Keep aliases that are directly accepted at the root.

### Namespaces

- `ccs proxy`: include status/watch history and view options, every mode,
  latency configuration forms, install, restart, restore, and serve.
- `ccs pricing`: include list options, pattern/provider status and mutation
  arguments, and refresh.
- `ccs cost`: include every local and central report form plus the existing
  report options line.
- Keep `ccs cost push` as the documented full-snapshot command and reject the
  parser's accidental report/options suffix.
- `ccs config`: include status, push, and pull.
- `ccs s`: include line, agent, server port, history profile, controls, and
  both WezTerm forms.
- `ccs usage`: include status, add, and all remove aliases with arguments.
- Keep each no-argument summary compact at the bottom of state/results.

## Implementation

1. Replace the root summary with immediate command syntax only.
2. Complete each namespace summary from its actual parser contract.
3. Add the missing usage summary after the usage target list.
4. Update README examples and the relevant proxy/cost/pricing specifications.
5. Reject arguments after `ccs cost push` so the parser and summary agree.
6. Update focused display-contract tests, build `dist`, bump the patch version,
   run focused tests, then run the full suite once.

## Acceptance

- Root output contains `ccs proxy` but not `ccs proxy [...]`; the same rule
  applies to every namespace.
- Each namespace no-argument output includes every supported leaf command,
  positional placeholder, and documented option relevant to that namespace.
- Runtime state/results remain above the summary.
- Explicit `help` behavior and command parsing outside `ccs cost push` do not
  change.
- README, source, built output, and tests agree.

## Non-goals

- No parser changes except removing accidental arguments after `ccs cost push`.
- No redesign of explicit `help` output.
- No multiline help framework or new rendering abstraction.
