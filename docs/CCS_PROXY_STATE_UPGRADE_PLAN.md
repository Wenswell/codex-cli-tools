# ccs proxy state upgrade plan

## Problem

`ccs proxy` strictly parses `proxy.json` before it checks the running proxy version. When an update changes the state contract, parsing fails first and the existing automatic runtime restart cannot run. Users then have to locate and delete cache files manually.

## Contract

- Add `state_schema_version` to `proxy.json`. Package and runtime version changes do not change this value unless the state shape changes.
- Before installed proxy commands or a Codex wrapper `run PROFILE` reads strict state, inspect the schema version. `ccs sync` uses raw state existence because it only protects the routing field.
- A current-schema file remains strict. Corruption is an error and is never silently reset.
- A missing or different schema is an upgrade boundary: gracefully stop the old runtime, preserve stable installation/routing fields, reset mode to `passthrough`, disable latency policy, clear metrics and incompatible request history, and write current state. Persisted active rows are not authoritative across process versions; a stop timeout leaves state unchanged and reports the error.
- Record the reset in `proxy.log` and print the schema transition once. Config backups and event/runtime logs remain intact.
- `install` keeps its existing absent-state requirement. `restore`, `restart`, and `serve` do not start an extra runtime after a reset; status, watch, mode, and config restore the current runtime before continuing.

## Acceptance

- `ccs proxy` upgrades a legacy state without manual file deletion and starts the current runtime.
- The Codex provider remains routed to the same local proxy URL.
- Old request snapshots and JSONL history are removed instead of being parsed as the current contract.
- A current-schema malformed state still fails with its exact validation error.
- Focused proxy tests, type checking, and the full suite pass.
