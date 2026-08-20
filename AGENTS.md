# Contributor guide

- Follow [engineering preferences](docs/ENGINEERING_PREFERENCES.md) for CLI,
  configuration, terminal output, documentation, and release conventions.
- Follow [testing guidelines](docs/TESTING_GUIDELINES.md) when selecting tests and
  assertions.
- Follow [CLI runtime records](docs/CLI_RUNTIME_RECORDS.md) for state, history,
  logs, retention, and raw debug data.
- Treat [the proxy specification](docs/CCS_PROXY_SPEC.md) and
  [the cost specification](docs/CCS_COST_SPEC.md) as the current command-specific
  contracts.
- Update `README.md`, the owning specification, tests, and built `dist` output in
  the same change when CLI behavior changes.
- Increment the `package.json` patch version in every commit unless the release
  explicitly requires a different semantic-version increment.
