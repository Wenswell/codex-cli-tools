# CLI Command Footer Plan

Status: implemented in `0.2.50`

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

### Width

- Separate entries with ` | `.
- Wrap only between entries when output exceeds the terminal width.
- Continuation lines use hanging indentation aligned with the first entry.
- Preserve every entry; do not truncate or add an ellipsis.

## Implementation

1. Add one structured footer renderer for labeled command rows.
2. Replace root and namespace status summaries with primary command names.
3. Add dedicated help for `ccs config`, `ccs s`, and `ccs usage`.
4. Keep existing complete help for `ccs pricing`, `ccs proxy`, and `ccs cost`.
5. Update README examples, focused display tests, built output, and version.

## Acceptance

- Root no-argument output has separate `commands` and `namespaces` rows.
- Root aliases and parameter syntax appear in `ccs --help`, not the footer.
- Namespace no-argument output ends with its immediate commands and `--help`.
- Every namespace help entry prints namespace-local help.
- An 80-column footer wraps at entry boundaries and every visible line fits.
- Status and result content above each footer is unchanged.

## Non-goals

- No parser or command behavior changes outside help routing.
- No redesign of full help content beyond adding missing namespace-local help.
- No footer changes for tools outside the `ccs` command family.

## Outcome

Compact footers work when they act as navigation rather than full syntax
references. Separating direct commands from namespaces preserves hierarchy,
while namespace-local help keeps detailed syntax available without repeating it
after every status result.
