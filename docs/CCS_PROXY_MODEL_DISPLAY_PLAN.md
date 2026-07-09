# ccs proxy model display plan

## Goal

Simplify `ccs proxy` terminal model display for OpenAI-style `gpt-*` names.

## Scope

- Status `active` and `history` table model cells display `gpt-` model names with an `o` prefix.
- Example: `gpt-5.5` displays as `o5.5`.
- Request records, state JSON, JSONL history, and upstream metadata keep original model values.
- Matching request/upstream models continue to display `[same]`.

## Plan

1. Add a shared proxy model display formatter.
2. Apply the formatter to request and upstream model terminal cells before truncation.
3. Add focused status-rendering assertions for `gpt-*` display.
4. Update README and proxy spec examples.
5. Build `dist`, run targeted tests, and increment the patch version.

## Completion Notes

- Added a display-only proxy model formatter for terminal request/upstream cells.
- `gpt-*` values render as `o*`, for example `gpt-5.5` renders as `o5.5`.
- Runtime records and history files continue to store upstream and request model names unchanged.
