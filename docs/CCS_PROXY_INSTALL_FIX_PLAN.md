# ccs proxy install fix plan

Status: implemented on 2026-07-14.

## Problem

When `ccs proxy install` previews a direct upstream URL, the preview is correct but the apply path starts the proxy before it updates `~/.codex/config.toml`. If runtime startup or health verification fails, the command removes proxy state and leaves the direct URL in place. A write failure after routing starts can also leave config and state inconsistent.

## Scope

- Keep `ccs proxy install` as the command that routes the configured provider to the local proxy.
- Keep explicit `yes` confirmation and the existing absent-state requirement.
- Make apply rollback the config when installation fails after the file was changed.
- Verify the installed routing and state/runtime result in tests.
- Update the proxy README/spec, built `dist`, and patch version.

## Implementation

1. Preserve the preview source and target TOML exactly as today.
2. Back up the source, write proxy state, start and health-check the runtime, then write and verify the target config.
3. On any apply failure, restore the source config only when the file still contains the planned target, stop the runtime, and remove proxy state. Preserve the existing backup for diagnosis.
4. Add a regression test using a non-proxy current URL and a failed runtime start to prove no partial local routing remains. Keep the existing successful install test as the positive path.
5. Sync user-facing documentation, build `dist`, increment the package patch version, run focused proxy tests, then the full test suite once before commit.

## Acceptance

- A direct current URL is replaced with `http://127.0.0.1:4610` after a successful install.
- A failed install does not leave the config pointed at the local proxy and does not leave `proxy.json`.
- The backup remains available after a failed install.
- Existing stop, restore, watch, and successful install behavior remains covered.

## Verification

```bash
pnpm check
node --test test/ccs-proxy.test.js
pnpm test
```

All checks pass: 138 tests.
