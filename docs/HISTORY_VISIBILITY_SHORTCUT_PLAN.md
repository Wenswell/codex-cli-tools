# history visibility shortcut plan

## Goal

Let interactive proxy and connection monitors hide completed history without restarting or changing configuration.

## Contract

- `ccs proxy watch` and interactive `clvm monitor` start with history visible.
- Press `t` to toggle history visibility for the current process.
- Press `q` or `Ctrl-C` to exit.
- Footers show `history:on` or `history:off` plus the active keys.
- Interactive footers stay on the terminal's last row as content changes.
- Hidden proxy history is not rendered, and explicit JSONL tail reads are skipped.
- Hidden clvm history remains collected in memory and runtime records; only terminal rendering changes.
- One-shot and non-interactive output keep their existing history behavior and command footer.

## Implementation

1. Move raw keyboard input ownership into the shared live-view controller.
2. Add proxy watch visibility state and omit the complete history section when disabled.
3. Add clvm monitor visibility state, omit `recent closed` when disabled, and render a compact footer.
4. Pin the last live-view line to the terminal bottom by padding short frames while preserving explicit overflowing output.
5. Update user documentation, built files, and focused interaction tests.

## Acceptance

- `t` immediately repaints both interactive views.
- Repeated `t` presses switch between visible and hidden history.
- Footers reflect the current state and fit the terminal width.
- Footers remain on the last terminal row across history toggles and resize events.
- Existing view cycling, resize repaint, sampling, logging, and exit behavior remain unchanged.

## Result

- Shared live-view controllers now own raw keyboard input and terminal restoration.
- Proxy watch and clvm monitor both toggle history with `t` and exit with `q` or `Ctrl-C`.
- Proxy and clvm footers report `history:on|off` and remain on the terminal's last row as content changes.
- Non-interactive output and runtime record behavior remain unchanged.
- README, proxy specification, version, tests, and built files were updated.
- The complete 141-test suite passes.
