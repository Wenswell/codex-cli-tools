# Documentation

The root [README](../README.md) introduces the project and provides a quick start.
[AGENTS.md](../AGENTS.md) owns development workflow, verification, and commit requirements.
This directory owns detailed operation guides and implementation contracts.

## Operation guides

| Guide | Covers |
| --- | --- |
| [Installation](./INSTALL.md) | Requirements, installation, updates, and runtime restart |
| [Wrappers](./WRAPPERS.md) | cx, cxx, cxxs, ccx, and ccxs |
| [CCS](./CCS.md) | Provider profiles, configuration sync, proxy setup and operation |
| [Images](./CIMG.md) | cimg usage |
| [Network](./CLVM.md) | clvm setup, sync, and monitoring |
| [Environment](./SENV.md) | senv configuration |
| [Sessions](./CODEX_RENAME.md) | Session titles and working directory maintenance |

## Standards and specifications

| Document | Owns |
| --- | --- |
| [Engineering preferences](./ENGINEERING_PREFERENCES.md) | CLI design, configuration, terminal output, documentation, and release conventions |
| [Testing guidelines](./TESTING_GUIDELINES.md) | Test selection, assertion depth, and shared test helpers |
| [CLI runtime records](./CLI_RUNTIME_RECORDS.md) | Runtime state, bounded history, logs, raw archives, and retention |
| [cimg specification](./CIMG_SPEC.md) | Image generation, editing inputs, requests, outputs, and lifecycle records |
| [CCS proxy specification](./CCS_PROXY_SPEC.md) | Proxy lifecycle, routing, policies, request records, and status views |
| [v0.4.0 refactoring plan](./V0.4.0_REFACTORING_PLAN.md) | Architecture refactoring, simplification, and cleanup plan for v0.4.0 |

## Ownership

- Keep the root README focused on introduction, quick start, and documentation links.
- Document detailed setup and command syntax in the operation guides above.
- Document reusable engineering rules once in the relevant standard above.
- Document command-specific behavior and schemas in the owning specification.
- Use tests and Git history for completed implementation details; do not retain
  completed plans or audits as current documentation.
- Add a new document only when its subject has a distinct long-term owner and
  cannot be stated clearly in an existing document.
