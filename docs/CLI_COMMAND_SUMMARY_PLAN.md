# CLI Command Footer Plan

Status: implemented in `0.2.51`

## Goal

Keep no-argument status output compact while preserving a clear route to the
complete command reference.

## Contract

### Root footer

The `ccs` footer separates direct commands from command namespaces:

```text
commands:   version | r | PROFILE | run | models | toggle | top | list | init | sync | add | remove
namespaces: pricing | proxy | cost | config | s | usage | --help
```

- `commands` lists primary direct commands only.
- `namespaces` lists first-level commands that also own subcommands.
- Aliases, parameters, and nested commands remain in explicit help.
- `--help` is the canonical complete-help entry and stays at the end.

### Namespace footer

A namespace status lists only its immediate primary subcommands. For example:

```text
commands: list | pattern | provider | refresh | --help
```

Every namespace accepts `help`, `-h`, and `--help` and prints its complete
syntax, parameters, aliases, and command comments.

### Lines

- Separate entries with ` | `.
- Print each labeled footer row as one line.
- Do not inspect terminal width, wrap entries, indent continuations, truncate, or
  add an ellipsis.

## Implementation

1. Format each structured footer row as one line.
2. Replace root and namespace status summaries with primary command names.
3. Add dedicated help for `ccs config`, `ccs s`, and `ccs usage`.
4. Keep existing complete help for `ccs pricing`, `ccs proxy`, and `ccs cost`.
5. Update README examples, focused display tests, built output, and version.

## Acceptance

- Root no-argument output has separate `commands` and `namespaces` rows.
- Root aliases and parameter syntax appear in `ccs --help`, not the footer.
- Namespace no-argument output ends with its immediate commands and `--help`.
- Every namespace help entry prints namespace-local help.
- Every footer row is emitted as one line without width-dependent formatting.
- Status and result content above each footer is unchanged.

## Non-goals

- No parser or command behavior changes outside help routing.
- No redesign of full help content beyond adding missing namespace-local help.
- No footer changes for tools outside the `ccs` command family.

## Outcome

Compact footers work when they act as navigation rather than full syntax
references. Separating direct commands from namespaces preserves hierarchy,
while namespace-local help keeps detailed syntax available without repeating it
after every status result. Footer formatting remains predictable by emitting one
line per row and leaving terminal display behavior to the terminal.
