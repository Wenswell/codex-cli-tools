# Documentation

The root [README](../README.md) is the user guide and public command reference.
The files below are contributor standards and detailed implementation contracts.

| Document | Owns |
| --- | --- |
| [Engineering preferences](./ENGINEERING_PREFERENCES.md) | CLI design, configuration, terminal output, documentation, and release conventions |
| [Testing guidelines](./TESTING_GUIDELINES.md) | Test selection, assertion depth, and shared test helpers |
| [CLI runtime records](./CLI_RUNTIME_RECORDS.md) | Runtime state, bounded history, logs, raw archives, and retention |
| [cimg specification](./CIMG_SPEC.md) | Image generation, editing inputs, requests, outputs, and lifecycle records |
| [CCS proxy specification](./CCS_PROXY_SPEC.md) | Proxy lifecycle, routing, policies, request records, and status views |
| [CCS cost specification](./CCS_COST_SPEC.md) | Cost commands, JSON contracts, data sources, pricing, and aggregation |

## Ownership

- Document user-visible setup and command syntax in `README.md`.
- Document reusable engineering rules once in the relevant standard above.
- Document command-specific behavior and schemas in the owning specification.
- Use tests and Git history for completed implementation details; do not retain
  completed plans or audits as current documentation.
- Add a new document only when its subject has a distinct long-term owner and
  cannot be stated clearly in an existing document.
