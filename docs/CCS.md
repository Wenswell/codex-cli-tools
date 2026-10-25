# ccs

`ccs` switches Codex between OpenAI-compatible provider profiles and can list usage-only keys.

`ccs version` and `ccs -v` print the package version from `package.json`.

Profile config lives at:

```text
~/.config/codex-tools/profiles.json
```

`ccs` updates:

```text
~/.codex/config.toml
~/.codex/AGENTS.md
~/.codex/auth.json
```

Run `ccs` without arguments to print the current profile, `user@host`, and a compact two-level command footer:

```text
commands:   version | PROFILE | models | toggle | list | init | sync | add | remove
namespaces: proxy | config | --help
```

Supported commands:

```bash
ccs
ccs version
ccs -v
ccs PROFILE
ccs models [PROFILE] [--json]
ccs proxy [--history N] [--view overview|tokens|cost]
ccs proxy watch [--history N] [--view overview|tokens|cost]
ccs proxy reroute
ccs proxy cancel SESSION_OR_REQUEST|all
ccs proxy capture SESSION_PREFIX COUNT
ccs proxy capture
ccs proxy capture cancel
ccs proxy mode [passthrough [retry]|retry [on|off]|recovery|intercept]
ccs proxy config
ccs proxy install|restore|serve
ccs toggle [PROFILE]
ccs config [push|pull]
ccs list | l
ccs init
ccs sync
ccs sync --replace TOML_PATH [--replace TOML_PATH ...]
ccs sync --replace all
ccs add [PROFILE]
ccs remove | rm | delete PROFILE
```

`ccs list` marks the current profile with `*`.

`ccs models [PROFILE]` reads the model list from the selected profile's `v1/models` endpoint and prints `model`, `owned_by`, and `created` columns. It uses the current profile unless `PROFILE` is given, sends the profile API key as `Authorization: Bearer`, and resolves the endpoint from the profile `baseURL`:

- `https://ai.input.im` and `https://ai.input.im/v1` become `https://ai.input.im/v1/models`.
- `https://ai.input.im/api/v1` becomes `https://ai.input.im/api/v1/models`.

`ccs models PROFILE --json` prints `version`, `profile`, `url`, and a `models` array with `id`, `owned_by`, and `created` fields. Network, HTTP, and response-shape failures exit with a nonzero status and a short `GET <url> ...` error instead of a partial list.

Initial profile defaults are stored in this repository:

```text
config/ccs-profiles.json
```

`ccs init` creates `profiles.json` from that template if it does not already contain profiles:

```json
{
  "profiles": {
    "input": {
      "baseURL": "https://ai.input.im",
      "apiKey": "",
      "routeConversion": {
        "enabled": false
      }
    },
    "ciii": {
      "baseURL": "https://codex.ciii.club",
      "apiKey": "",
      "routeConversion": {
        "enabled": false
      }
    }
  },
  "current": "input",
  "toggle": ["input", "ciii"],
  "proxy": {
    "search": {
      "enabled": true,
      "profile": "ciii"
    }
  },
  "top": {
    "stateUrls": [
      "http://10.126.126.1:8765/ccs/top/state",
      "http://127.0.0.1:8765/ccs/top/state"
    ]
  }
}
```

Set `routeConversion.enabled` to `true` for a provider that only accepts Chat Completions. The proxy keeps Codex on the Responses API and translates both directions. `ccs`, `ccs list`, and `ccs PROFILE` show the active value. Fill in the API keys manually. The file is written with `0600` permissions.

When proxy mode is installed, use `ccs proxy search` to inspect alpha-search forwarding, `ccs proxy search set PROFILE` to select its provider, and `ccs proxy search up|down` to enable or disable it. The example above sends `/alpha/search` and `/v1/alpha/search` to `ciii`; an explicit `cx run PROFILE` (or equivalent) profile remains higher priority.

Use `ccs proxy compact set PROFILE` followed by `ccs proxy compact up` to route standalone `/responses/compact` and `/v1/responses/compact` calls, plus explicitly marked compaction requests, through a dedicated provider. `ccs proxy compact` shows the setting; `down` disables it. Explicit `run PROFILE` selection takes priority. Native remote-compaction v2 requests with boolean stream: true and a compaction_trigger item anywhere in input[] are also routed and marked [C]. The request model and body stay unchanged. The provider must support the compact API and return compaction items accepted by the main provider; cross-provider interoperability requires verification. Compaction performed inside a normal server response cannot be routed separately.


`ccs init` first reads the current Codex API settings from:

```text
~/.codex/config.toml
~/.codex/auth.json
~/.codex/AGENTS.md
```

It stores the current `base_url` and `OPENAI_API_KEY` as a profile named `current`, then makes `current` the active profile.

`ccs init` then syncs:

```text
~/.codex/config.toml
~/.codex/AGENTS.md
```

from:

```text
config/codex-config.toml
config/codex-agents.md
```

Preview first:

```bash
ccs init
```

After printing the plan, `ccs init` writes only if you type exact `yes` at the prompt.

Before writing, it backs up the current files to:

```text
~/.config/codex-tools/backups/ccs-YYYYMMDD-HHMMSS/
```

`ccs init` keeps the existing `~/.codex/config.toml` as the base file, appends missing top-level keys, missing sections, and missing section keys from `config/codex-config.toml`, and syncs the default global Codex guidelines to `~/.codex/AGENTS.md`. Existing Codex config keys, sections, comments, and local settings stay in place. Later profile switches only change the active provider API URL and `~/.codex/auth.json`.

`ccs init` shows:

- a short summary of files to modify and back up
- unified diff style output for each file that would change
- masked secrets in `profiles.json` and `auth.json`
- warnings for risky changes such as current-profile switches

If `config/ccs-profiles.json` changes later, run:

```bash
ccs sync
```

`ccs sync` prints `different` and `update` field summaries plus its masked diff, then writes the previewed result only if you type exact `yes` at the prompt.

Plain `ccs sync` keeps additive TOML behavior. Repeat `--replace` to select exact dotted leaf paths from `config/codex-config.toml`; duplicate paths count once. `--replace all` selects every template leaf except `model_providers.*.base_url`. Unknown paths, section paths, explicit provider `base_url` replacement, and combining `all` with explicit paths fail before preview. While proxy state exists, a selected `model_provider` change also fails before preview.

Missing template fields remain additive in every form. Selected fields receive template values; other existing values and local-only fields remain unchanged. `different` lists every template leaf that differs or is missing, while `update` lists fields changed by this invocation. Empty lists show `0`.

When applied, `ccs sync` creates the same backup directory first, writes the exact previewed content, and verifies each result by reading it back. It merges template profiles into `~/.config/codex-tools/profiles.json`, keeps existing local API keys and local-only profiles, seeds `top.stateUrls` when `top` is missing, and syncs `~/.codex/AGENTS.md` from `config/codex-agents.md`.

`ccs config` manages local `~/.config/codex-tools/profiles.json` sync with the LAN server copy at `ravvss@10.126.126.1:/home/ravvss/.config/codex-tools/profiles.json` over SSH port `32753`:

```bash
ccs config
ccs config push
ccs config pull
```

Run `ccs config` without arguments to print the local file summary, fixed LAN target, and a compact command line without connecting to the server.

```text
commands: push | pull | --help
```

`push` uploads the local file to the LAN server. `pull` downloads the LAN server file to the local machine. Only `push` and `pull` connect to the server and compare files. Both commands preview first and apply only after you type exact `yes`; explicit push/pull previews connect to the server, print a masked unified diff, replace the whole file instead of merging, and create a backup before overwriting an existing target.

Add or update a profile interactively:

```bash
ccs add
ccs add ciii
```

When editing an existing profile, press Enter to keep the current value. If `PROFILE` is passed, the name prompt uses it as the default.

Remove a profile:

```bash
ccs remove local
```

`ccs toggle` uses the `toggle` array in `profiles.json`; it is not hard-coded to specific profile names.
When proxy mode is installed, `ccs toggle` switches `profiles.current`, and the proxy uses that current profile as the active upstream and API key for new requests.

Switching profile:

```bash
ccs toggle input
ccs toggle ciii
ccs toggle
```

Show a profile without switching:

```bash
ccs PROFILE
```

Proxy commands live under `ccs proxy`:

```bash
ccs proxy
ccs proxy --history N
ccs proxy --view overview|tokens|cost
ccs proxy watch
ccs proxy watch --history N
ccs proxy watch --view overview|tokens|cost
ccs proxy reroute
ccs proxy cancel SESSION_OR_REQUEST|all
ccs proxy capture SESSION_PREFIX COUNT
ccs proxy capture
ccs proxy capture cancel
ccs proxy mode
ccs proxy mode passthrough
ccs proxy mode passthrough retry
ccs proxy mode retry [on|off]
ccs proxy mode recovery
ccs proxy mode intercept
ccs proxy config
ccs proxy config retry WINDOW BASE MAX [STATUSES]
ccs proxy config retry statuses STATUSES
ccs proxy config latency off
ccs proxy config latency FIRST TOTAL [return_502|retry_then_502]
ccs proxy install
ccs proxy restart
ccs proxy restart --force
ccs proxy restore
ccs proxy serve
```

The no-argument proxy snapshot uses the same compact runtime, policy, active, and grouped-history layout as `watch`. Use `ccs proxy --help` for file locations, status options, modes, commands, and configuration syntax.

## Proxy lifecycle

For a first installation, use `ccs` to confirm the active profile and inspect `model_provider` plus `model_providers.<model_provider>.base_url` in `~/.codex/config.toml`. The URL must still be the direct provider URL. Then run:

```bash
ccs proxy
ccs proxy install
ccs proxy
```

`install` previews the config change and writes only after exact `yes` confirmation. A successful install starts with `passthrough` forwarding and status retry disabled. The final `ccs proxy` verifies the active URL, PID, version, protocol, response mode, and retry state. Use `ccs proxy mode passthrough retry` for transparent forwarding with bounded transient-status retry; use `recovery` or `intercept` only when response inspection is needed.

For a normal tool update, leave the installed routing and state in place:

1. Update the tool using one of the `Install` procedures above.
2. Run `ccs proxy restart` and confirm it with exact `yes`.
3. Run `ccs proxy` and verify the new PID, current package version, health protocol, and preserved mode/history.

`restart` preserves `config.toml` routing, proxy state, mode, and history. It refuses to restart while requests are active. Use `ccs proxy restart --force` to preview those requests, then, after exact `yes`, terminate the old proxy and all of its active client connections before starting the replacement. Proxy shutdown stops accepting new requests, drains active responses, and closes idle keep-alive connections immediately. Running one-shot `ccs proxy` also replaces a healthy runtime automatically when its protocol or package version does not match the current CLI. `ccs proxy watch` only observes state and health, so a long-running watch from an earlier package cannot replace a newer runtime.

`proxy.json` has an explicit state schema version. When an update changes that schema, the next installed proxy command automatically stops the old runtime, preserves local routing and installation metadata, resets policy to safe `passthrough` defaults, clears incompatible request metrics/history, and starts the current runtime when needed. Current-schema corruption remains an explicit error; manual cache-file deletion is not part of the update flow.

Use `ccs proxy restore` when removing the proxy or before a clean reinstall. It restores the active profile URL, stops the runtime, and removes `proxy.json`. `ccs proxy mode passthrough` instead keeps the local proxy URL and runtime while selecting transparent response forwarding; use `ccs proxy mode retry off` to disable the independent status-retry policy. When the state file is absent, inspect `~/.codex/config.toml` and restore its provider URL from a known profile or backup before installing again.

Behavior:

- `ccs proxy install` and `ccs proxy restore` semantically modify only `model_providers.<provider>.base_url` in `~/.codex/config.toml`. Install points it to `http://127.0.0.1:4610`; restore resolves `profiles.current` and points it to that profile's `baseURL`. Other TOML fields, profiles, authentication, and unrelated config text remain unchanged.
- Writes `~/.codex/auth.json` as `{ "OPENAI_API_KEY": "..." }`.
- `cx run`, `cxx run`, and `cxxs run` set `CODEX_TOOLS_PROFILE_API_KEY` only for the launched `codex` process and pass temporary provider `base_url` and `env_key` overrides. When proxy state exists, they also pass `http_headers.x-ccs-profile=PROFILE`; the proxy validates and uses that profile for the request, then strips the header before forwarding. The commands do not write `config.toml`, `auth.json`, or `profiles.json`.
- `ccs proxy install` requires explicit `model_provider`, its existing `base_url`, a current profile, and absent proxy state. It previews the current and proxy URLs plus backup path, backs up the current config, starts and health-checks the proxy, then changes and verifies that provider's `base_url` is the local proxy URL. If apply fails after routing is written, it restores the preview source, removes proxy state, and keeps the backup. It starts in `passthrough` with status retry disabled.
- `ccs proxy mode` prints the active response mode and independent status-retry state. Every change previews and requires exact `yes`. `passthrough` forwards responses without inspection. `ccs proxy mode retry [on|off]` controls retry for configured HTTP statuses (default: 429, 503, and transient gateway 520) without changing the response mode; `ccs proxy mode passthrough retry` selects the transparent-plus-retry combination. Retries continue while the configured total window allows another wait and dispatch. `recovery` enables continuation recovery for eligible streaming Responses guard hits; `intercept` uses ordinary guard retry.
- `ccs proxy config` prints the active status-retry and latency settings. `ccs proxy config retry WINDOW BASE MAX [STATUSES]` configures an enabled retry policy's total window, base backoff, and maximum backoff in milliseconds; defaults are `3600000`, `1000`, and `30000`. The values are positive timer-range integers with `BASE <= MAX <= WINDOW`. Use `ccs proxy config retry statuses 400,429,502,503` to select retryable statuses, or `statuses default` to reset to `429,503,520`; status codes must be integers from 400 through 599 and are sorted and deduplicated. Configuration writes require exact `yes`.
- Latency deadlines are disabled by default. `ccs proxy config latency FIRST TOTAL [ACTION]` enables them after exact `yes`; `ccs proxy config latency off` disables them.
- `ccs proxy restore` resolves `profiles.current` when preview is built, backs up the current config, changes and verifies only the installed provider's `base_url` to that profile's `baseURL`, stops the proxy, and removes state. Install and restore backups remain available for manual recovery; unrelated config edits, profiles, and authentication stay unchanged.
- `ccs proxy` reads one active upstream for each new request. A validated internal `x-ccs-profile` header from a Codex wrapper `run PROFILE` selects that profile for the request; otherwise the proxy uses `profiles.current`. It removes the internal routing header and overwrites incoming `Authorization`, `api-key`, and `x-api-key` headers with `Authorization: Bearer <selected profile apiKey>`. Long-running ordinary Codex CLI processes therefore keep using the proxy URL after `ccs toggle`, while explicit profile launches remain pinned to their requested profile.
- A profile can set `routeConversion.enabled` when its provider only supports Chat Completions. `ccs add` prompts for this setting. Codex continues to send `/responses`; the proxy sends `/v1/chat/completions` upstream and returns equivalent Responses JSON or SSE events, including the terminal `response.completed` event.
- When status retry is enabled, configured HTTP error responses (default: 429, 503, and transient gateway 520) are withheld and retried while the configured total window allows another wait and dispatch. In `passthrough + retry`, every non-stream response body up to 1 MiB is checked for the Capacity message, including bodies returned with HTTP `200`; matching responses use the same window and backoff while counting as `upstream_capacity`. Non-matching responses follow the ordinary status rule. The proxy honors `Retry-After` seconds or HTTP dates when they fit the configured window; otherwise it uses full-jitter exponential backoff capped by `backoff_max_ms`. The window starts with the first upstream fetch. Before every retry dispatch, an unpinned request reloads `profiles.current`; explicit `x-ccs-profile` requests stay pinned. Expiry returns the last original response. An aborted request, premature client socket close, or unfinished response close stops the wait and prevents another upstream attempt. In `passthrough`, final responses remain uninspected.
- After `ccs toggle`, run `ccs proxy reroute` to preview default-profile requests currently waiting after 429, 503, 520, or a Capacity response. Exact `yes` wakes every still-eligible wait immediately; its next attempt uses the new current profile on the original client connection. Fetching, forwarding, completed, and explicitly pinned requests are excluded. Reroute preserves the original retry deadline and counters.
- Use `ccs proxy cancel SESSION_OR_REQUEST` when a Codex UI session has been closed but its request connection is still open. The target is the displayed session prefix or an exact request ID. It previews only current 429, 503, 520, or Capacity retry waits and requires exact `yes`; ambiguous session prefixes are rejected. Cancellation also applies to pinned waits, prevents the next attempt, and records status `499`.
- Use `ccs proxy capture SESSION_PREFIX COUNT` to save the next `COUNT` complete client-boundary HTTP exchanges for one Codex session. Use `ccs proxy capture cancel` to stop an active capture immediately; already written files are retained. The prefix follows the session matching rule used by `cancel`; the first match binds the full session id and an ambiguous later match ends the task with an explicit error. `ccs proxy capture` reports the active task. Captures start after arming, stop automatically after the requested count, and live under `~/.cache/codex-tools/proxy/captures/` as private metadata plus byte-exact request/response body files. Authentication and cookie headers are redacted; prompt and response bodies are intentionally retained until manually removed. Proxy restart discards an unfinished capture task.
- Upstream HTTP responses are forwarded as received when the active policy accepts them. Upstream `4xx` and `5xx` responses record `failure_summary.type=upstream_error` and render the upstream failure summary in the history `result` column. Summaries include only bounded non-secret `server`, request-id, and `cf-ray` diagnostics; a response-body read failure is labeled `upstream stream terminated`.
- In `recovery` and `intercept`, upstream Capacity bodies retry the same upstream when a non-stream response body contains `Selected model is at capacity. Please try a different model.`, or contains both `selected model is at capacity` and `try a different model` case-insensitively, regardless of status including `200`. `passthrough + retry` applies the same Capacity recognition and uses the independent status-retry window. Plain `429` and `5xx` responses without that text are forwarded as received. Capacity defaults to `retry_then_pass_through`; HTTP 429 defaults to `pass_through` in intervention modes. Capacity, 429, reasoning, and first-progress retries share the three-retry policy budget in intervention modes; transport retry remains independent.
- A retryable Capacity response uses `Retry-After` seconds or HTTP date when present. Values over 60 seconds are not waited; missing or invalid values use bounded jitter. Retry waits stop on client abort or the absolute total deadline.
- Transport-level `TypeError: fetch failed` is retried once in `intercept` and `recovery`. `passthrough` does not retry it. A terminal transport failure returns `502` with error type `upstream_error` and code `upstream_fetch_failed`.
- `ccs proxy` applies the active proxy mode only to `/responses`, `/v1/responses`, `/chat/completions`, and `/v1/chat/completions`. Other upstream API paths are transparently forwarded once and still enter request metrics. When search routing is enabled, `/alpha/search` and `/v1/alpha/search` use its selected profile. Health and reroute endpoints under `/__codex_proxy/*` are local control traffic; unknown local control paths return a local `404 unsupported_proxy_path` that identifies `ccs proxy` as the rejecting component and do not enter request metrics or history.
- In `recovery` and `intercept` modes, the reasoning guard checks JSON responses and SSE `data:` JSON payloads for explicit non-negative integer `reasoning_tokens` values `516`, `1034`, and `1552`. Guard matches retry the same upstream request up to three times, then return `502 reasoning_guard_triggered`.
- In `recovery` mode, streaming Responses requests automatically include `reasoning.encrypted_content` when needed for recovery. If a guarded stream contains encrypted reasoning items, `ccs proxy` first retries with a continuation request. Context compaction requests and `intercept` mode use ordinary guard retry.
- Guard actions are recorded in request history under `guard_actions` and as JSON lines in `~/.cache/codex-tools/proxy/proxy.log`. Each action stores `action`, `upstream`, `attempt`, `status`, `reasoning_tokens`, and `error`; `continuation_recovery` marks a Responses continuation retry.
- `ccs proxy` starts the background proxy when proxy state exists and a current-protocol healthy proxy process is unavailable. If the health endpoint reports a different protocol, it records `ccs_proxy_protocol_restart` with `server_protocol`, `client_protocol`, and `pid` in `proxy.log`, stops that process, and starts the current proxy.
- Proxy runtime files live beside the proxy state under `~/.cache/codex-tools/proxy/`: `proxy.pid` stores the background process id, `proxy-runtime.log` stores recent background stdout/stderr up to 16M, `proxy.log` stores recent guard, unsupported-path, and proxy error events up to 16M, and `proxy-requests.jsonl` stores recent completed model API requests with JSONL-only `attempt_records` and sanitized `request_headers` up to 64M.
- `backups/config-<timestamp>.toml` is a complete `config.toml` snapshot made before install; `backups/config-restore-<timestamp>.toml` is a complete snapshot made before restore. They are archives for manual inspection or recovery, are not automatically selected by `restore`, and are not automatically deleted.
- A newly started proxy process clears persisted `active_requests` before serving traffic, so `active` only shows requests owned by the current proxy process.
- `ccs proxy` without arguments ensures the installed runtime and prints one compact snapshot. `ccs proxy watch` reads state and health without starting, upgrading, or replacing the runtime. Both show mode, last/average latency, status counts, active/non-zero policy details, compact active requests, and grouped history. Healthy output omits URL, PID, version, protocol, file paths, disabled policies, zero policy counters, latency minimum/maximum, and command hints.
- `active` and `history` remain separate. Active rows use `session route state age size`; route combines a six-character provider with an eight-character normalized model, and state carries search (green `[S]`), compaction (green `[C]`), conversion, or current retry facts. History also marks search requests with a green `[S]` and compaction requests with a green `[C]` in `result`, shows each non-empty session once using its newest route context, retains the newest five complete `time status dur. size result` events, then compresses older events to ordered `status/dur.` pairs. Requests without a session remain separate. Equal visible session ids keep the same color across sections, while the first 11 distinct visible ids use different ANSI 256 palette colors.
- Token and cost columns aggregate every proxy-owned upstream attempt. `input` is uncached input (`input_tokens - cached_input_tokens`), matching the `input$` pricing basis; `cached` reports cached input separately. A token total appears only when every attempt reports the required fields. Cost uses each attempt's exact upstream/request model and response/request/config service tier with local cached prices and profile overrides; it performs no network refresh. Missing facts render as `-`, and cached input above input tokens renders `invalid`.
- `ccs proxy` terminal output displays local file paths under `$HOME` with `~/`.
- `ccs proxy serve` runs the proxy server in the foreground for direct debugging.
- `ccs proxy` forwards request bodies at their original size. Runtime and upstream resources determine practical payload bounds.
- In `recovery` and `intercept`, an enabled latency policy starts the absolute total deadline with the first upstream fetch and spans retries and waits. The first-progress deadline restarts for each real attempt and accepts only non-empty output text, a final answer, or a tool call as progress.
- In `recovery` and `intercept`, SSE inspection is incremental across arbitrary chunks, mixed LF/CR/CRLF delimiters, and a BOM split across chunks. Accepted bytes are forwarded unchanged. A candidate SSE event larger than 1 MiB fails with `response_inspection_limit_exceeded`. `passthrough` does not run this scanner.
- The active section includes current requests during upstream SSE buffering before client headers are written. Streaming byte progress stays in memory and is not periodically written to `proxy.json`; the exact final byte count is persisted when the request completes. Completed, failed, and fully streamed model API responses move to grouped, dim history rows. `proxy.json.metrics.recent_requests` keeps the newest 100 completed model API requests as a compact status snapshot; `proxy-requests.jsonl` keeps bounded completed model API request history in completion order. Default status rendering reads history from `proxy.json`. TTY output uses rows remaining after status, active rows, history group overhead, and the watch footer; non-TTY reads 11 completed records for five complete rows plus compact trend samples. `--history N` selects up to `N` session groups, with each request without a session counting as one group.
- Active and history records use request schema `8`; proxy health uses protocol `8`. State snapshots and JSONL history require the current contract. `retry_summary` separates HTTP 429 and 503 retries, with gateway 520 counted in the existing `http_503` bucket. JSONL `attempt_records` identify each dispatched forwarding attempt and store protocol conversion, actual upstream endpoint, conversion failure stage, status retry triggers, and delays without prompt or response bodies. Capture metadata uses version `2` and records upstream/final status, final action, failure summary, and retry summary alongside byte-exact bodies.
- `proxy.log` includes protocol conversion and failure stage on request-error and attempt-completion events, so request, JSON-response, and streaming-response conversion failures remain distinguishable.
- For supported model paths, proxy metrics record request facts, retry summary, and timing. Intervention modes also record inspected upstream metadata, usage, reasoning observations, and response shape. `passthrough` deliberately leaves response-content-derived fields empty. Session display uses `x-codex-turn-metadata.session_id` when present and otherwise reads `session_id` from the JSON request body, including for transparently forwarded paths. `latency_ms` is total proxy request latency, `upstream_wait_ms` is final-attempt time to upstream headers, and `client_ttfb_ms` is time to proxy response headers written to the client. Request records store `request_body_sha256`; prompt and response text stay outside runtime records.
- Active retry state includes its retry cycle, such as `retry:503 x2`; active rows have no terminal result. History `result` combines successful policy-action prefixes and failure summaries. Repeated Codex client requests use `client:<attempt>`; guard actions use `guard`, `cap`, `rec`, `block`, and `err` prefixes. The visible detail uses local `error` first, then `failure_summary.code/message` for upstream HTTP failures.
- Proxy tables format elapsed time and byte size with compact 3-significant-digit units after the base unit, such as `56ms`, `2.34s`, `43.2s`, `3.12m`, `32.0K`, and `3.41M`.
- Proxy metrics are recomputed from `proxy.json.metrics.recent_requests`. Exact status-code events appear on the status line. Policy summaries aggregate `retry_summary` across the complete recent-request window, independent of rendered rows and `--history`, and omit zero categories. Enabled deadlines and retry configuration remain visible. Reasoning groups and last/average latency use the same state window. `ccs proxy restore` removes the state file, and the next install starts a new statistics window.
- `ccs proxy help` prints the proxy command summary.
- Does not print API keys directly; status output masks keys and includes `user@host`.
- Fails if the profile or API key is missing.

