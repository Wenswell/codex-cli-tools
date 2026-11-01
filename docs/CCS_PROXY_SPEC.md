# ccs proxy spec

`ccs proxy` reports proxy runtime state and HTTP request state from `~/.cache/codex-tools/proxy/proxy.json`. `CCS_PROXY_STATE_ROOT` overrides the default proxy state directory.

The proxy forwards every upstream response untouched. Its only policy is optional status retry, which applies to Codex and Claude Code requests alike.

## Storage files

Proxy state lives under `~/.cache/codex-tools/proxy`:

- `proxy.json`: state schema version, lightweight runtime state snapshot, counters, active requests, and the newest completed request snapshot.
- `proxy-requests.jsonl`: bounded completed request history up to 64M, one normalized request record per line in completion order.
- `proxy.log`: bounded policy, attempt, unsupported-path, upstream-error, and local proxy error events as JSONL up to 16M.
- `proxy-runtime.log`: bounded background process stdout and stderr up to 16M.
- `proxy.pid`: background process id.
- `captures/<timestamp>-<id>/`: explicitly requested client-boundary packet captures. Each captured request has one metadata JSON file plus byte-exact request and response body files.
- `backups/config-<timestamp>.toml`: complete `config.toml` snapshot made before `ccs proxy install`; the path is stored in `proxy.json.backup_path` while the install is active.
- `backups/config-restore-<timestamp>.toml`: complete `config.toml` snapshot made before `ccs proxy restore`.

## Route boundary

The proxy HTTP server separates local control traffic from upstream forwarding.

Local control endpoints:

- `GET /__codex_proxy/health`
- `GET /__codex_proxy/reroute`
- `POST /__codex_proxy/reroute`
- `GET /__codex_proxy/cancel`
- `POST /__codex_proxy/cancel`
- `GET /__codex_proxy/capture`
- `POST /__codex_proxy/capture`
- `DELETE /__codex_proxy/capture`

Health responses include `status`, `pid`, `version`, `protocol`, and `status_retry_enabled`. The reroute endpoints inspect and wake eligible status-retry waits. Control requests are handled before metrics and never enter request history.

Every other path is forwarded to the selected upstream with proxy authentication and enters request metrics. Response bodies are forwarded as received; the only body check is the bounded Capacity check while status retry is enabled. These OpenAI paths also set the endpoint class used for route conversion:

- `/responses`
- `/v1/responses`
- `/chat/completions`
- `/v1/chat/completions`

When the selected profile sets `routeConversion.enabled=true`, every OpenAI Responses request is translated to Chat Completions before forwarding to a provider that only implements `/chat/completions`. The proxy maps `instructions`, input messages, function calls, function outputs, function and namespace tools, and supported generation parameters to Chat Completions, sends `/v1/chat/completions`, and converts successful Chat JSON or SSE results back to the Responses contract. Hosted `web_search` tools remain unavailable on Chat-only providers. Request conversion failures return local `400` without contacting the upstream; JSON response conversion failures return local `502`; stream conversion failures terminate the response after the already-sent upstream status. The proxy never forwards an unconverted Responses body to `/v1/chat/completions`. Streaming conversion is incremental and emits the required Responses lifecycle through `response.completed` before closing.

`routeConversion.enabled` is a switching-profile setting. `ccs`, `ccs list`, and `ccs PROFILE` display `responses→chat` when it is enabled; otherwise they display `off`. Choose the profile in `ccs add` to edit the setting. In the `ccs proxy` status view, a converted request shows `R→C` in the active `state` column and on its history context line.

`ccs proxy search` prints the current setting and offers `off` plus every profile; profiles without non-empty `baseURL` and `apiKey` are listed as unavailable. Selecting a profile sets it and enables forwarding for `/alpha/search` and `/v1/alpha/search`; `off` disables forwarding and keeps the stored profile. An unchanged selection writes nothing; otherwise the change is previewed and written after exact `yes`, and apply rejects a `profiles.json` that changed after preview. The persisted configuration is:

```json
{
  "proxy": {
    "search": {
      "enabled": true,
      "profile": "search"
    }
  }
}
```

`/alpha/search` and `/v1/alpha/search` therefore use the `search` profile in this example. Query parameters do not affect selection.

`ccs proxy compact` uses the same selection, preview, exact-`yes`, validation, and status contract as search. It persists `proxy.compact: { enabled, profile }` in `profiles.json`. Selection recognizes `/responses/compact`, `/v1/responses/compact`, and existing explicit compaction header/body markers before choosing upstream. Explicit `x-ccs-profile` wins over the enabled compact route; otherwise the current profile is used. Retry dispatches reapply this selection using the original request kind. Invalid selected profiles fail explicitly without contacting another provider.

Claude Code requests (`/v1/messages` and every `/v1/messages/` subpath, such as `count_tokens`) use the claude current profile, `profiles.current.claude`; every other path uses `profiles.current.codex`. Search and compaction routes apply only to Codex traffic, and explicit `x-ccs-profile` still wins. Incoming `Authorization`, `x-api-key`, and `api-key` are replaced with `Authorization: Bearer <profile key>`, so the provider must accept Bearer authentication. The session column uses the `x-claude-code-session-id` request header. With a claude current profile, `ccs proxy install` also points `~/.claude/settings.json` `env.ANTHROPIC_BASE_URL` at the proxy and `restore` points it back at that profile's `baseURL`; both preview the change, back up the file to `backups/claude-settings-install|restore-<ms>.json` beside `proxy.json`, and keep other settings unchanged.

Compaction requests are recorded as `request_kind=context_compaction`. Besides the standalone compact paths, native remote-compaction v2 is identified by a Responses path (`/responses`, `/v1/responses`, `/openai/v1/responses`, or `/backend-api/codex/responses`), boolean `stream: true`, and an item with `type: "compaction_trigger"` anywhere in `input[]`. Capability headers alone do not identify compaction. Request model and payload are unchanged. Compact output contains opaque encrypted items; provider interoperability must be verified with a compact-and-continue flow. Server-side compaction within a normal response cannot be independently routed.

The `/__codex_proxy/*` namespace is reserved for local control. Unknown local control paths return local `404` JSON with `code: "unsupported_proxy_path"` and a message that identifies `ccs proxy` as the rejecting component. They write one `ccs_proxy_unsupported_path` event to `proxy.log` and do not enter request metrics or history.

Proxy startup reuses a healthy runtime only when its health `protocol` and `version` match the current CLI protocol and package version. A mismatch records one `ccs_proxy_runtime_restart` event with `reason=runtime_mismatch`, `old_protocol`, `new_protocol`, `old_version`, `new_version`, and the replaced process `pid`, then stops that process and starts the current proxy. Explicit replacement records the same event with `reason=explicit`. A remaining protocol or version mismatch after restart is a startup error.

Graceful shutdown stops accepting new requests, drains active responses, and closes idle keep-alive connections immediately so health checks do not delay restart or restore.

## Configuration lifecycle

`ccs proxy install` and `ccs proxy restore` semantically change only one TOML value: `model_providers.<provider>.base_url` in `~/.codex/config.toml`. Install targets `http://127.0.0.1:4610`; restore resolves `profiles.current.codex` and targets that profile's `baseURL`. The operations preserve other TOML fields, profile data, authentication, and unrelated config text.

`proxy.json.status_retry` is the sole proxy policy configuration. It contains `enabled`, `statuses`, `total_window_ms`, `backoff_base_ms`, and `backoff_max_ms`, and defaults to disabled with `statuses: [429, 503, 520]` and timing values `3600000`, `1000`, and `30000`. `ccs proxy config` prints these values, asks for status retry `on` or `off`, and when `on` prompts for the window, base backoff, maximum backoff, and statuses with the current values as defaults. Choosing `off` keeps the stored timing and status values. The result is previewed and requires exact `yes`; apply rechecks that `status_retry` still matches the preview. Values for `statuses` are integer HTTP status codes between 400 and 599 (or keyword `default` to reset to `429,503,520`), sorted and deduplicated. Timing values are positive Node timer-range integers and require `BASE <= MAX <= WINDOW`. Each new request reads the current `status_retry`, so changes apply without a restart.

Each operation creates a complete config snapshot before writing. The install snapshot is named `backups/config-<timestamp>.toml`; the restore snapshot is named `backups/config-restore-<timestamp>.toml`. These files are archives, not an automatic restore source. `ccs proxy restore` computes the target from the active profile instead of copying the install snapshot, so a profile change is respected. Backups are retained until the state directory is removed.

### First install

The state file must be absent, and the configured provider must have an existing direct `base_url`. Run:

```bash
ccs proxy install
```

The command prints the same plan for preview and apply, then requires exact `yes`. Apply creates the install backup, writes proxy state with status retry disabled, starts and health-checks the runtime, writes the local provider URL, and verifies the parsed config value. A failed apply removes the state and restores the source config when the file still contains the planned local target; the backup remains for diagnosis.

### Update and restart

For a normal tool update, update the package or linked clone, then restart the installed proxy:

```bash
# update the package or rebuild the linked clone
ccs proxy restart
```

`restart` prints the current and target runtime details and states that nothing changes unless exact `yes` is entered. Apply rechecks that `metrics.active_requests` is still empty, gracefully stops the current runtime, starts the current package version, and verifies the health protocol and version. It preserves proxy routing, status retry configuration, counters, and completed history. When a runtime was running, the replacement has a different PID.

When requests are active, the preview lists the requests that would lose their client connection and asks to `keep running` (default) or `force restart`. Forcing is the deliberate interruption path: after exact `yes`, it terminates the old proxy process, including its in-flight upstream work, then starts and verifies a new process. Persisted active rows are cleared during new-process startup; completed history remains unchanged.

Running one-shot `ccs proxy` also replaces a healthy runtime whose protocol or package version does not match the current CLI. `ccs proxy watch` only reads state and health; it does not start, upgrade, or replace a runtime. Use explicit `restart` after an update for a visible preview, confirmation, and result.

`proxy.json.state_schema_version` is independent from package and health protocol versions; the current value is `5`. Ordinary package updates keep current state. A missing or different state schema is a destructive upgrade boundary: installed proxy commands gracefully stop the old runtime, preserve stable installation and local routing fields, keep a valid stored `status_retry` (otherwise use the disabled default), clear metrics and `proxy-requests.jsonl`, write the current schema, and append `ccs_proxy_state_reset` to `proxy.log`. Persisted active rows are not authoritative across process versions; a stop timeout leaves state unchanged. The command prints the schema transition once. Config backups plus event and runtime logs remain intact. A malformed current-schema file remains an error and is not reset.

If `restart` reports `proxy state file was not found`, inspect the current provider URL. Use `ccs proxy install` only when the provider has a direct URL and no proxy state exists. If the provider still points to the local proxy, restore its direct URL from a known profile or config archive first.

### State schema upgrade

An earlier state schema is reset automatically by the next installed proxy command. Manual cache deletion and reinstall are not part of the upgrade flow.

### Explicit restart

`ccs proxy restart` is the only explicit public runtime replacement command. There are no separate `start` or `stop` commands: one-shot installed proxy commands start a missing compatible runtime when needed, while `watch` remains read-only. Stopping while the configured provider still points to the local URL would break routing.

Restart requires installed proxy state. Preview prints the active PID, protocol, and package version plus the target protocol and package version, then requires exact `yes`. Ordinary apply rechecks that `metrics.active_requests` is empty before stopping the runtime. When requests are active, the command lists them and offers a forced restart that terminates the old proxy process after confirmation, so every affected client connection closes immediately. Without a terminal it refuses while requests are active. Both paths preserve `proxy.json`, `proxy-requests.jsonl`, routing, status retry configuration, counters, and completed history, then verify the new PID and matching health contract. The new process clears stale active rows before serving.

## Request lifecycle

- A forwarded request enters `metrics.active_requests` after the proxy accepts the request.
- Active records use the same request record schema as history records. Pending-only fields use `null` or `0` until completion.
- Proxy process startup clears stale persisted `metrics.active_requests` entries before accepting new requests. Explicit restart refuses live active requests before startup.
- A request moves to `metrics.recent_requests` when the upstream response is fully written, the request fails, or the response stream ends.
- History records are the completed form of the same request record and include completion time, status code, request kind, upstream, proxy-internal attempts, client request attempt, latency, request bytes, response bytes, session short id, request model, retry summary, failure summary, and error text.
- `proxy-requests.jsonl` records include JSONL-only `attempt_records` with complete upstream attempt facts. `proxy.json.metrics.recent_requests` keeps compact records without `attempt_records`.
- Compact state history is written before the complete JSONL record append. JSONL append failures after client response completion are recorded in `proxy.log`, and the proxy keeps serving.
- Requests stay active while they wait for a status retry and while the response body is written to the client.
- Client-aborted response streams are completed as failed history with status `499`.
- Proxy state writes are serialized in the proxy process so concurrent requests update one metrics snapshot in order.

## Session packet capture

`ccs proxy capture` is interactive. Without an active task it lists two global scopes followed by distinct short session ids from `metrics.active_requests` and then `metrics.recent_requests`, newest first, with route and age. A count prompt (default `5`) becomes `COUNT`. The command arms one in-memory capture task with `POST /__codex_proxy/capture` and body `{ scope, target?, count }`:

- `all`: the next `COUNT` requests of any session, including requests without a session id.
- `new`: the next `COUNT` requests of the first session created after arming. Codex session ids are UUIDv7, so a session id qualifies when its embedded 48-bit Unix-millisecond creation time is at or after the task start; ids that are not UUIDv7 never qualify. The first qualifying request binds the full session id; requests from other sessions, including later new sessions, are skipped.
- `session`: the next `COUNT` requests whose full Codex session id starts with `target`, the selected short id. A target that encounters more than one full session id fails as ambiguous. Only one capture task can be active. With an active task, the command opens the same progress view instead. Without a terminal it only reports the active task or `inactive`.

The progress view polls `GET /__codex_proxy/capture` once per second and shows target, bound session (`any` for `all`), `captured/requested`, and directory. The final summary for `all` reports the number of distinct session ids in the written records. `c` sends `DELETE /__codex_proxy/capture`; `q` or Ctrl-C leaves the view and keeps the task. When the task becomes inactive, the view closes and prints `complete` or `ended early` from the metadata files written to the task directory, or `cancelled` after `c`.

Capture starts after the command succeeds; earlier and already-active requests are excluded. For `session` and `new`, the first matching request binds the task to its full session id. Each completed match consumes one count, including local proxy errors and client-aborted responses. The task becomes inactive after `COUNT` records are written. Cancelling from the progress view makes the task inactive immediately; a request already claimed before cancellation may still finish writing its complete record. Proxy restart discards an unfinished in-memory task.

Each record represents the client/proxy HTTP boundary after any status retry or protocol conversion. Metadata version `2` stores the request id, full session id, method, URL path and query, timestamps, response status observed at the client boundary, final client status, final action, failure summary, retry summary, byte counts, sanitized request headers, response headers, and body file names. This keeps an upstream response distinguishable from a later stream or local failure. Request and response bodies are saved byte-for-byte in separate files; SSE remains raw SSE bytes. Authentication-bearing headers, cookies, proxy authorization, and API-key headers are replaced with `[redacted]`. Other headers are retained. Files use private permissions: capture directories `0700`, files `0600`.

Capture data is an explicit diagnostic archive: it is not copied into `proxy.json`, `proxy-requests.jsonl`, or `proxy.log`, has no automatic retention or silent payload truncation, and remains until manually removed. A capture write failure ends the task and records an explicit proxy event rather than producing a successful partial record. Ordinary runtime records continue to exclude prompt and response bodies.
