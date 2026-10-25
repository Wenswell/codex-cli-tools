# codex-tools

Personal Codex CLI helpers for Linux and macOS.

Includes Codex and Claude wrappers, provider profile switching, a local request
proxy, image generation, network monitoring, environment configuration, and
Codex session maintenance.

TTY output uses color for status, paths, warnings, and summaries. Set `NO_COLOR=1` to disable colors.

## Quick start

Requires Node.js 20+ and pnpm. Codex wrappers require Codex CLI; Claude wrappers
require Claude Code. Session renaming also requires sqlite3.

```bash
pnpm add -g github:Wenswell/codex-cli-tools
ccs version
ccs --help
```

Run `cx` to start Codex with search enabled. Run `ccs` to inspect provider
configuration. See [installation and updates](docs/INSTALL.md) for local
installation and background proxy updates.

## Commands

| Command | Purpose | Guide |
| --- | --- | --- |
| `cx` / `cxx` / `cxxs` | Start or resume Codex | [Wrappers](docs/WRAPPERS.md) |
| `ccx` / `ccxs` | Start or resume Claude Code | [Wrappers](docs/WRAPPERS.md#ccx--ccxs) |
| `ccs` | Provider profiles and local proxy | [CCS](docs/CCS.md) |
| `cimg` | Generate and edit images | [Images](docs/CIMG.md) |
| `clvm` | Inspect and monitor network connections | [Network](docs/CLVM.md) |
| `senv` | Manage shell environment configuration | [Environment](docs/SENV.md) |
| `codex-rename` | Maintain Codex session titles and paths | [Sessions](docs/CODEX_RENAME.md) |

`cxx`, `cxxs`, `ccx`, and `ccxs` bypass permission checks. Use them for trusted tasks.

## Documentation

- [Documentation index](docs/README.md): operation guides and specifications.
- [Contributor guide](AGENTS.md): development, verification, and commit requirements.
