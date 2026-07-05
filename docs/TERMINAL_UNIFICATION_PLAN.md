# terminal unification plan

## Goal

Unify repeated terminal behavior across `ccs proxy`, `clvm`, and related status commands with shared helpers.

The target state is one implementation for each cross-cutting terminal concern:

- live monitor/watch frame lifecycle
- terminal width and single-line fitting
- compact numeric formatting
- color style selection
- TTY-oriented tests

## Principles

- Prefer shared helpers for behavior already repeated in two command families.
- Remove duplicated local implementations when the shared helper exists.
- Keep command-specific code responsible for domain data and row content only.
- Keep terminal display behavior deterministic in non-TTY output.
- Keep JSON state and history formats unchanged unless the display contract requires a schema change.

## Current Duplication

### Live View Lifecycle

`ccs proxy watch` and `clvm monitor` both own:

- alternate screen enter and restore
- cursor hide and restore
- frame writes from cursor home
- row clearing and tail clearing
- resize-triggered repaint
- SIGINT and SIGTERM cleanup

### Terminal Width and Fitting

The commands currently carry several local helpers:

- `fitProxyTerminalLine`
- `fitSingleTerminalLine`
- `fitCommandsLine`
- `terminalColumns`

These helpers all derive terminal width and then use ANSI-aware visible width truncation.

### Compact Numeric Formatting

The codebase has repeated functions for:

- three-significant-digit numbers
- byte quantities
- byte rates
- durations and latencies

The visible output contract is already shared by docs: compact units such as `160K`, `43.2M`, `160K/s`, `56ms`, and `2.34s`.

### Color Style Selection

`text.ts` exports color functions, while `clvm` creates a local `Style` object for `--no-color`. This should become a shared style factory.

### TTY Test Harness

`ccs-proxy.test.js` and `clvm.test.js` both simulate TTY properties, terminal resize, and subprocess output capture.

## Implementation Plan

## Progress

- [x] Phase 1: Live View Helper.
- [x] Phase 2: Terminal Helper.
- [x] Phase 3: Compact Format Helper.
- [x] Phase 4: Style Helper.
- [x] Phase 5: Test Harness.

### Phase 1: Live View Helper

Add `src/lib/live-view.ts` with one API for terminal live frames:

- enter alternate screen when enabled and TTY
- hide cursor while active
- restore cursor and main screen on cleanup
- write frames with `\u001b[H`, per-line `\u001b[2K`, and trailing `\u001b[J`
- register resize repaint
- serialize repaint requests when an async renderer is already running
- handle SIGINT and SIGTERM cleanup

Refactor:

- `runProxyStatusWatch`
- `runMonitor`

Acceptance:

- existing proxy watch tests pass
- existing clvm monitor TTY test passes
- no command owns raw alternate-screen lifecycle code after the refactor

### Phase 2: Terminal Helper

Add shared terminal utilities, likely in `src/lib/terminal.ts`:

- `terminalColumns(stream, defaultColumns)`
- `fitTerminalLine(line, options)`
- `fitCommandsLine(full, compact, columns)`
- shared monitor frame capture for tests when useful

Refactor:

- `ccs proxy` title/summary/footer fitting
- `ccs top` single-line fitting
- `clvm` command footer fitting and table layout width reads

Acceptance:

- no local `terminalColumns` or single-line fitting helpers remain in command files when the shared helper covers them
- existing width tests pass

### Phase 3: Compact Format Helper

Add `src/lib/format.ts`:

- `formatThreeSignificant`
- `formatCompactBytes`
- `formatCompactRate`
- `formatDurationMs`

Refactor:

- `ccs proxy` byte and latency formatting
- `clvm` duration, byte, and rate formatting
- `ccs` status-line duration or byte formatting where it matches the shared contract

Acceptance:

- all compact unit tests pass
- docs and implementation use the same unit contract
- raw JSON values remain numeric

### Phase 4: Style Helper

Add shared style creation around `text.ts`:

- identity style for explicit no-color modes
- color style for normal terminal output
- small semantic color set remains unchanged

Refactor:

- `clvm` local `createStyle`
- future command-local style factories when they match the same shape

Acceptance:

- `NO_COLOR` and command-level `--no-color` behavior stay explicit and tested
- command code uses style methods rather than branching on color state

### Phase 5: Test Harness

Add `test/helpers/terminal.js`:

- run subprocesses with controlled TTY-like stdout properties
- capture stdout and stderr
- emit resize events during a test frame
- strip ANSI when semantic assertions need visible text

Refactor:

- proxy watch tests
- clvm monitor TTY tests

Acceptance:

- no duplicated TTY capture helper logic across watch/monitor tests
- tests stay behavior-focused and avoid full snapshots

## Documentation Updates

Update these docs during implementation:

- `README.md`
- `docs/CLI_RUNTIME_RECORDS.md`
- `docs/ENGINEERING_PREFERENCES.md`
- command-specific docs when command behavior changes

## Verification

Run after each phase:

```sh
pnpm build
node --test test/ccs-proxy.test.js
node --test test/clvm.test.js
```

Run before final commit:

```sh
pnpm test
```

## Work Not Included

- Changing runtime JSON schema.
- Changing user command names.
- Adding compatibility aliases.
- Preserving old duplicate helper implementations after shared helpers replace them.
