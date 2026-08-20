# test suite audit

## Standard

A test is retained when it protects a distinct public command, data contract, safety boundary, calculation, parser edge case, runtime transition, or confirmed regression. Duplicate setup and assertions are not retained when another test reports the same product failure.

## Inventory

Package version `0.3.0` contains 166 tests across 14 files. Test files and the shared terminal helper contain 10,701 lines.

| Area | Tests | Lines |
| --- | ---: | ---: |
| Proxy runtime and policy | 62 | 6,264 |
| CCS commands | 40 | 1,802 |
| CLVM | 25 | 1,483 |
| Pricing | 10 | 222 |
| CIMG | 9 | 218 |
| CLI surface | 3 | 70 |
| Shared and focused modules | 17 | 642 |

## Cleanup

- Removed the proxy watch `--history` integration case because parser, history sizing, and watch lifecycle tests already cover the same failure.
- Merged the basic proxy status summary fixture into the complete event-count summary test.
- Removed help assertions from an unrelated proxy argument-rejection test.
- Reduced wrapper-specific help content checks to one help entrypoint per wrapper; the shared CLI surface test continues to cover `help`, `-h`, and `--help` for every public tool.
- Consolidated six CCS invalid-argument tests onto one shared profile fixture.
- Reused one child-process health stub for protocol and package-version proxy replacement tests.

## Runtime Finding

Proxy process tests exposed a real shutdown delay: a keep-alive health connection could keep `server.close()` pending until the HTTP keep-alive timeout. Proxy shutdown now registers signal handling before publishing readiness, stops new accepts, drains active responses, and closes connections when they become idle. This preserves graceful shutdown while removing the restart/restore race.

A long-running watch also exposed package-version contention: its loaded code could replace a newer healthy runtime on every refresh. Watch now reads state and health without starting, upgrading, or replacing the runtime. One-shot status and explicit lifecycle commands retain runtime enforcement.

## Verification

- Watch lifecycle focused run: 3 passed, 0 failed.
- Full `pnpm test`: 166 passed, 0 failed, 70.8 seconds.
- `pnpm build` refreshed tracked `dist` output.
- `ccs version` reports `0.3.0`.
