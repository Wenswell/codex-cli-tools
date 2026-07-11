# test suite audit

## scope

This audit covers every test selected by `pnpm test`: 131 tests across 10 files, plus the shared terminal test helper. The review compares each test with current source behavior, public documentation, adjacent tests, and the change history that introduced the regression case.

## decision model

The first-principles unit of value is a distinct product failure that a test can identify. A test earns its maintenance cost when it protects at least one durable behavior:

- a public CLI or stored-data contract;
- a security, privacy, or file-write boundary;
- parser, formatter, table-width, or calculation behavior with meaningful edge cases;
- runtime state transitions, retries, retention, or process lifecycle;
- a confirmed regression with a distinct failure mode.

The audit uses evidence in this order:

1. Current source and specifications establish the active behavior contract.
2. Adjacent tests establish whether another test already detects the same failure.
3. Git history establishes whether a narrow assertion represents a confirmed regression.
4. Test size, fixture complexity, and runtime establish maintenance cost.

Bayesian updating starts with a strong retention prior for safety boundaries, data contracts, calculations, and confirmed regressions. The decision uses posterior odds rather than arbitrary scores:

```text
posterior odds(keep | evidence) = prior odds(keep) * product(likelihood ratio of each independent fact)
```

Evidence for removal increases when the protected command has been removed, the same observable failure is fully covered elsewhere, or assertions only restate implementation structure. Occam's razor selects the smallest set that still distinguishes every relevant failure mode.

## removal threshold

Direct removal requires conclusive evidence for one of these conditions:

- the production behavior or command contract no longer exists;
- another test exercises the same path and checks every meaningful observable outcome;
- the assertion covers incidental wording, spacing, color, or an internal constant without a documented contract;
- a broader acceptance test makes a lower-level test unable to identify an additional regression.

Each retained test must have a distinct contract or regression reason. Candidates with incomplete evidence remain listed under `Open decisions` for explicit review.

## initial inventory

| Area | File | Tests | Lines |
| --- | --- | ---: | ---: |
| Proxy runtime and views | `test/ccs-proxy.test.js` | 51 | 5,279 |
| CCS commands | `test/ccs.test.js` | 34 | 1,413 |
| CLVM commands and monitor | `test/clvm.test.js` | 24 | 1,407 |
| Pricing selection | `test/pricing.test.js` | 8 | 221 |
| Codex usage parsing | `test/codex-usage.test.js` | 2 | 216 |
| Terminal tables | `test/table.test.js` | 5 | 90 |
| Compact formatting | `test/format.test.js` | 3 | 34 |
| Runtime log retention | `test/runtime-log.test.js` | 2 | 40 |
| Live terminal lifecycle | `test/live-view.test.js` | 1 | 57 |
| Text style | `test/style.test.js` | 1 | 15 |

## audit results

The suite now contains 128 tests and 8,736 test/helper lines. Four whole tests were removed, and one strict proxy request-record contract test was added during the resolved schema review.

### removed tests

| Test | Evidence |
| --- | --- |
| `pricing reports partial status when cache-read pricing is missing` | `ccs models lists every provider as a column` reaches the same `modelPricingStatus` implementation and checks `ok`, `partial`, and `missing`. |
| `pricing rebuild replaces models with the watched provider and pattern intersection` | The production CLI uses `buildModelPriceSnapshotPlanFromRemoteCatalog`; the confirmed watch and refresh tests cover replacement, provider filtering, pattern filtering, and writes. |
| `pricing rebuild fails before cache writes when remote fetch fails` | The tested wrapper had no production caller. The CLI remote-failure test covers unavailable output, absence of confirmation, and unchanged local state. |
| `proxy refinement uses request schema and health protocol version 4` | The request-record acceptance test checks schema `5`; the protocol-restart test checks protocol `4` through the health endpoint, restart event, and replacement process. |

Deleting the two snapshot-wrapper tests left `buildModelPriceSnapshotPlan` without a production or test caller, so the wrapper was removed with them. The proxy constants remain internal implementation details after deleting their test-only exports.

### retained groups

| Group | Tests | Distinct failure signals |
| --- | ---: | --- |
| Proxy runtime and views | 51 | Routing, authentication, retries, continuation, modes, records, privacy, process lifecycle, status views, interaction, token projection, and costs. |
| CCS commands | 34 | Public versions, model inventory, pricing and cost commands, runtime state, invalid arguments, and sync safety. |
| CLVM commands and monitor | 24 | Config precedence, sampling, close behavior, runtime records, raw-data boundaries, retries, history growth, and terminal layout. |
| Pricing selection | 5 | Cost calculation, built-in prices, local-only lookup, remote catalog parsing, and provider/pattern intersection. |
| Codex usage parsing | 2 | Fork accounting with and without rollback events. |
| Shared format, table, log, style, and live-view libraries | 12 | Numeric boundaries, ANSI/wide-character width, retention, permissions, color control, and terminal cleanup. |

Every retained whole test maps to a current public contract, stored-data or safety boundary, ambiguous parser/formatter case, runtime transition, calculation, or confirmed regression. Repeated setup in process and HTTP tests remains because each test drives a different production branch and produces a different failure signal.

### local cleanup

- Replaced the terminal helper's handwritten ANSI expression with the existing `strip-ansi` dependency and made its process executor internal.
- Removed five assertions already implied by stronger adjacent assertions or exact output checks.
- Removed repeated proxy column checks and their helper; the proxy view-column contract and shared table tests cover those failures directly.
- Reduced the proxy status fixture to representative active, pending, completed, and retry rows. Shared formatter tests retain the full byte and duration boundary matrix.
- Renamed three invalid-argument tests and their inputs around the current parser contract, while preserving one test for each independent parser.
- Removed stale schema suffixes and historical limit wording from active test names and fixtures.
- Removed one unused proxy fixture parameter.

## resolved decisions

### previous proxy record shapes

Schema `5` is the sole proxy request-record contract. State snapshots and JSONL history require complete schema `5` records. Readers reject earlier schemas and missing fields instead of translating previous field names, synthesizing values, or silently removing invalid entries.

`proxy state persists request metrics` now uses complete schema `5` fixtures. Dedicated rejection tests cover earlier schemas, incomplete state records, and incompatible JSONL history. Earlier request schemas require a clean proxy reinstall, which creates current metrics and history files.

## related source finding

A strict `tsc --noUnusedLocals --noUnusedParameters` audit also reports pre-existing unused production symbols in `ccs-proxy.ts`, `ccs.ts`, and `clvm.ts`. They are independent of test selection and belong in a dedicated production cleanup. The unused pricing snapshot wrapper was included here because its only callers were the tests removed by this audit.

## verification

- Focused module runs: 128 passed, 0 failed.
- `pnpm check`: passed.
- `pnpm build`: passed and refreshed tracked `dist` files.
- Repository test-file search: exactly the 10 `test/*.test.js` files selected by `pnpm test`; `test/helpers/terminal.js` is the only supporting file.
- Full configured `pnpm test`: 128 passed, 0 failed, 9.17 seconds.
