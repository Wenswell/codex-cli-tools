# Contributor guide

- Follow [engineering preferences](docs/ENGINEERING_PREFERENCES.md) for CLI,
  configuration, terminal output, documentation, and release conventions.
- Follow [testing guidelines](docs/TESTING_GUIDELINES.md) when selecting tests and
  assertions.
- Follow [CLI runtime records](docs/CLI_RUNTIME_RECORDS.md) for state, history,
  logs, retention, and raw debug data.
- Find command guides and specifications in the [documentation index](docs/README.md).
- Update the owning guide, specification, tests, and built `dist` output in the
  same change when CLI behavior changes. Update README when its overview or quick start changes.
- Increment the `package.json` patch version in every commit unless the release
  explicitly requires a different semantic-version increment.

## Development workflow

- Read the owning documentation before edits. Write a concise plan with scope
  and acceptance criteria, then implement one focused change.
- Clarify blocking product decisions before proceeding. Confirm scope again if it expands.
- Install with `pnpm install`; build with `pnpm build`. Run local commands as
  `node dist/bin/COMMAND.js`.
- Run focused tests during development. `pnpm check` checks TypeScript without rebuilding.
- Before committing code changes, run `pnpm test` once. It builds `dist` and runs
  all tests; do not repeat builds or tests already covered.
- For documentation-only changes, check local Markdown links and run
  `node --test test/cli-surface.test.js`. A full build and test run is unnecessary.
- Run `git diff --check` before every commit.
- Use a temporary `HOME` for manual `ccs init` or `ccs sync` apply checks.
- Commit each completed change. Releases are GitHub-first (`git push origin main`);
  push only when requested, and publish to npm only when explicitly requested.

## Documentation ownership

- README owns project introduction, quick start, and documentation links.
- AGENTS.md owns development workflow, verification scope, and commit requirements.
- docs/ owns detailed operation guides, specifications, and engineering conventions.
- Record reusable decisions in the owning document. Git history owns completed plans and reports.
