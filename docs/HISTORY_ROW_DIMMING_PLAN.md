# history row dimming plan

## Goal

Visually separate completed connection history from active connections in terminal views.

## Scope

- Dim completed request rows under `ccs proxy` history.
- Dim `clvm monitor` recent closed rows.
- Keep section labels and table headers at normal intensity.
- Preserve existing semantic colors inside dimmed rows.
- Keep stored state, history records, commands, and layout unchanged.

## Implementation

1. Add a small shared table-row styling helper so both commands apply ANSI dim consistently to every populated cell.
2. Apply the helper only to historical data rows in both command families.
3. Document the display distinction in `README.md`.
4. Add focused color tests, rebuild `dist`, then run the complete test suite.

## Acceptance

- Active connection rows retain their current intensity.
- Historical data cells use ANSI dim when color output is enabled.
- Historical data remains unchanged with `NO_COLOR` or `clvm --no-color`.
- Table width and row count behavior remain unchanged.

## Result

- Added shared populated-cell styling through `styleTableRow`.
- Applied dim styling only to proxy history and recent closed data rows.
- Preserved normal-intensity section labels, headers, and active rows.
- Updated `README.md` and built `dist` files.
- Verified with focused proxy, clvm, and table tests plus the complete 139-test suite.
