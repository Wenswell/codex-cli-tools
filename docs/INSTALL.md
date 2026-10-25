# Installation and updates

## Requirements

- Node.js 20+
- pnpm
- `codex` CLI for `cx`, `cxx`, and `cxxs`
- `claude` CLI for `ccx` and `ccxs`
- `sqlite3` CLI for `codex-rename`

## Install

From a local clone:

```bash
pnpm install
pnpm build
pnpm link --global
```

From GitHub:

```bash
pnpm add -g github:Wenswell/codex-cli-tools
```

If you clone the repository on that machine and want a live development link:

```bash
git clone git@github.com:Wenswell/codex-cli-tools.git
cd codex-cli-tools
pnpm install
pnpm build
pnpm link --global
```

To update an existing installation:

- Local linked clone: run `git pull --ff-only`, `pnpm install`, and `pnpm build` in the linked clone. The global link continues to use that clone; run `pnpm link --global` again only if the link was removed.
- Global GitHub install: rerun `pnpm add -g github:Wenswell/codex-cli-tools`.

Verify either update with:

```bash
ccs version
```

Running foreground commands keep the code loaded when they start. Stop them before updating, then restart and verify them afterward:

| Command | Stop | Restart after update | Verify |
| --- | --- | --- | --- |
| `clvm monitor` | `q` or `Ctrl-C` | rerun `clvm monitor` | confirm the monitor refreshes successfully |

An installed `ccs proxy` runs in the background. Update the package first, then run `ccs proxy restart`, confirm with exact `yes`, and verify with `ccs proxy`.

