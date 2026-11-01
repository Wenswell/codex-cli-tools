# ccs

`ccs` switches Codex between OpenAI-compatible provider profiles and can list usage-only keys.

`ccs stats` summarizes the local usage records written by every tool (see [CLI runtime records](./CLI_RUNTIME_RECORDS.md#command-usage-records)): runs, last run, ok/error/cancelled counts, median duration, and shortcut share per command, then how often each interactive prompt was cancelled or answered with its default.

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
commands:   version | PROFILE | models | use | list | init | sync | add | remove | config | stats
namespaces: proxy | --help
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
ccs proxy cancel
ccs proxy capture
ccs proxy mode
ccs proxy search
ccs proxy compact
ccs proxy config
ccs proxy install|restart|restore|serve
ccs use
ccs config
ccs list | l
ccs init
ccs sync
ccs add
ccs remove
ccs stats
```

`ccs list` marks the current profile with `*`.

`ccs models [PROFILE]` reads the model list from the selected profile's `v1/models` endpoint and prints `model`, `owned_by`, and `created` columns. It uses the current profile unless `PROFILE` is given, sends the profile API key as `Authorization: Bearer`, and resolves the endpoint from the profile `baseURL`:

- `https://ai.example.com` and `https://ai.example.com/v1` become `https://ai.example.com/v1/models`.
- `https://ai.example.com/api/v1` becomes `https://ai.example.com/api/v1/models`.

`ccs models PROFILE --json` prints `version`, `profile`, `url`, and a `models` array with `id`, `owned_by`, and `created` fields. Network, HTTP, and response-shape failures exit with a nonzero status and a short `GET <url> ...` error instead of a partial list.

Initial profile defaults are stored in this repository:

```text
config/ccs-profiles.json
```

`ccs init` creates `profiles.json` from that template if it does not already contain profiles:

```json
{
  "profiles": {
    "test001": {
      "baseURL": "https://ai.example.com",
      "apiKey": "",
      "routeConversion": {
        "enabled": false
      }
    },
    "test002": {
      "baseURL": "https://codex.example.com",
      "apiKey": "",
      "routeConversion": {
        "enabled": false
      }
    }
  },
  "current": "test001",
  "proxy": {
    "search": {
      "enabled": true,
      "profile": "test002"
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

When proxy mode is installed, run `ccs proxy search` to show alpha-search forwarding and pick its provider, or `off`, from a list. Profiles without a `baseURL` or `apiKey` are shown but cannot be selected. Picking a profile selects and enables it in one step; `off` disables forwarding and keeps the stored profile. The change is previewed and written after exact `yes`. The example above sends `/alpha/search` and `/v1/alpha/search` to `test002`; an explicit `cx run PROFILE` (or equivalent) profile remains higher priority.

Run `ccs proxy compact` and pick a profile to route standalone `/responses/compact` and `/v1/responses/compact` calls, plus explicitly marked compaction requests, through a dedicated provider; it works like `ccs proxy search`, and `off` disables it. Explicit `run PROFILE` selection takes priority. Native remote-compaction v2 requests with boolean stream: true and a compaction_trigger item anywhere in input[] are also routed and marked [C]. The request model and body stay unchanged. The provider must support the compact API and return compaction items accepted by the main provider; cross-provider interoperability requires verification. Compaction performed inside a normal server response cannot be routed separately.


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

`ccs sync` always adds missing template fields. When existing `config.toml` values differ from `config/codex-config.toml`, it first lists those dotted leaf paths with `current -> template` values; select the values to replace with space (`a` selects all) and press Enter. Nothing is selected by default, so Enter alone keeps the sync additive. Provider `model_providers.*.base_url` fields are never listed, and `model_provider` cannot be selected while proxy state exists. The command then prints `different` and `update` field summaries plus its masked diff, and writes the previewed result only if you type exact `yes` at the prompt. Without a terminal, the preview is additive and nothing is written.

Selected fields receive template values; other existing values and local-only fields remain unchanged. `different` lists every template leaf that differs or is missing, while `update` lists fields changed by this invocation. Empty lists show `0`.

When applied, `ccs sync` creates the same backup directory first, writes the exact previewed content, and verifies each result by reading it back. It merges template profiles into `~/.config/codex-tools/profiles.json`, keeps existing local API keys and local-only profiles, seeds `top.stateUrls` when `top` is missing, and syncs `~/.codex/AGENTS.md` from `config/codex-agents.md`.

`ccs config` manages local `~/.config/codex-tools/profiles.json` sync with the LAN server copy at `ravvss@10.126.126.1:/home/ravvss/.config/codex-tools/profiles.json` over SSH port `32753`:

```bash
ccs config
```

`ccs config` prints the local file summary and fixed LAN target, then asks whether to `pull` or `push`. Without a terminal, it prints the summary only and does not connect to the server. `push` uploads the local file to the LAN server. `pull` downloads the LAN server file to the local machine. After the choice, the command connects to the server, prints a masked unified diff, and applies only after you type exact `yes`. Both directions replace the whole file instead of merging and create a backup before overwriting an existing target.

Add or update a profile interactively:

```bash
ccs add
```

`ccs add` lists existing profiles plus `+ new profile`. Editing a profile shows its current `baseURL` and masked `apiKey`; press Enter to keep a value. A new profile asks for a name first. The API key is masked while typing. The last step chooses between a Responses provider and a Chat Completions-only provider. The result is previewed with a masked key and written after exact `yes`.

Remove a profile:

```bash
ccs remove
```

`ccs remove` lists profiles with the current one marked, previews the removed profile and any `current` switch, then writes after exact `yes`. `ccs add` and `ccs remove` require an interactive terminal.

Switch the current profile:

```bash
ccs use
```

`ccs use` lists profiles with `current`, the last use, and the last switch time. The cursor starts on the most recently active profile other than the current one, so `ccs use` followed by Enter returns to the previous profile. Profiles without an API key cannot be selected. Selecting a profile switches immediately: the selection is the confirmation. It writes the provider URL in `~/.codex/config.toml`, `~/.codex/auth.json`, and `profiles.current`; selecting the current profile changes nothing. Without a terminal, it prints the list only. When proxy mode is installed, the proxy uses the new current profile as the active upstream and API key for new requests.

Profile times live in `~/.cache/codex-tools/profile-usage.json`, outside the LAN-synced `profiles.json`:

- `switched_at`: the profile became current through `ccs use`.
- `launched_at`: `cx run`, `cxx run`, or `cxxs run` started Codex with the profile.
- `requested_at`: the proxy sent a request with the profile, including search, compaction, and pinned `run PROFILE` routing. The proxy writes it at most once per minute per profile.

"Used" is the newer of `launched_at` and `requested_at`. `ccs` shows when the current profile was switched to, and `ccs list` adds `used` and `switched` columns. The file is a display aid: a missing or unreadable file shows no times, and concurrent writers can drop one timestamp update.

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
ccs proxy cancel
ccs proxy capture
ccs proxy mode
ccs proxy search
ccs proxy compact
ccs proxy config
ccs proxy install
ccs proxy restart
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

`install` previews the config change and writes only after exact `yes` confirmation. A successful install starts with `passthrough` forwarding and status retry disabled. The final `ccs proxy` verifies the active URL, PID, version, protocol, response mode, and retry state. Run `ccs proxy mode` and pick `passthrough` with status retry `on` for transparent forwarding with bounded transient-status retry; pick `recovery` or `intercept` only when response inspection is needed.

For a normal tool update, leave the installed routing and state in place:

1. Update the tool using one of the `Install` procedures above.
2. Run `ccs proxy restart` and confirm it with exact `yes`.
3. Run `ccs proxy` and verify the new PID, current package version, health protocol, and preserved mode/history.

`restart` preserves `config.toml` routing, proxy state, mode, and history. When requests are active, `restart` lists them and asks whether to keep running or force the restart; a forced restart terminates the old proxy and all of its active client connections after exact `yes`. Without a terminal it refuses while requests are active. Proxy shutdown stops accepting new requests, drains active responses, and closes idle keep-alive connections immediately. Running one-shot `ccs proxy` also replaces a healthy runtime automatically when its protocol or package version does not match the current CLI. `ccs proxy watch` only observes state and health, so a long-running watch from an earlier package cannot replace a newer runtime.

`proxy.json` has an explicit state schema version. When an update changes that schema, the next installed proxy command automatically stops the old runtime, preserves local routing and installation metadata, resets policy to safe `passthrough` defaults, clears incompatible request metrics/history, and starts the current runtime when needed. Current-schema corruption remains an explicit error; manual cache-file deletion is not part of the update flow.

Use `ccs proxy restore` when removing the proxy or before a clean reinstall. It restores the active profile URL, stops the runtime, and removes `proxy.json`. Selecting `passthrough` in `ccs proxy mode` instead keeps the local proxy URL and runtime while forwarding responses transparently; status retry `off` disables the independent status-retry policy. When the state file is absent, inspect `~/.codex/config.toml` and restore its provider URL from a known profile or backup before installing again.

Behavior:

- `ccs proxy install` and `ccs proxy restore` semantically modify only `model_providers.<provider>.base_url` in `~/.codex/config.toml`. Install points it to `http://127.0.0.1:4610`; restore resolves `profiles.current` and points it to that profile's `baseURL`. Other TOML fields, profiles, authentication, and unrelated config text remain unchanged.
- Writes `~/.codex/auth.json` as `{ "OPENAI_API_KEY": "..." }`.
- `cx run`, `cxx run`, and `cxxs run` set `CODEX_TOOLS_PROFILE_API_KEY` only for the launched `codex` process and pass temporary provider `base_url` and `env_key` overrides. When proxy state exists, they also pass `http_headers.x-ccs-profile=PROFILE`; the proxy validates and uses that profile for the request, then strips the header before forwarding. The commands do not write `config.toml`, `auth.json`, or `profiles.json`.
- `ccs proxy install` requires explicit `model_provider`, its existing `base_url`, a current profile, and absent proxy state. It previews the current and proxy URLs plus backup path, backs up the current config, starts and health-checks the proxy, then changes and verifies that provider's `base_url` is the local proxy URL. If apply fails after routing is written, it restores the preview source, removes proxy state, and keeps the backup. It starts in `passthrough` with status retry disabled.
- `ccs proxy mode` prints the active response mode and independent status-retry state, then asks for the response mode and for status retry `on` or `off`, with the current values selected. Changes are previewed together and require one exact `yes`. `passthrough` forwards responses without inspection. Status retry applies to configured HTTP statuses (default: 429, 503, and transient gateway 520) without changing the response mode; `passthrough` with retry `on` is the transparent-plus-retry combination. Retries continue while the configured total window allows another wait and dispatch. `recovery` enables continuation recovery for eligible streaming Responses guard hits; `intercept` uses ordinary guard retry.
- `ccs proxy config` prints the active status-retry and latency settings, then asks which one to edit. Each value prompt shows the current value; press Enter to keep it. Invalid values are rejected at the prompt. Changes are previewed and written after exact `yes`.
- The status retry policy prompts for the total window, base backoff, and maximum backoff in milliseconds (defaults `3600000`, `1000`, and `30000`; positive timer-range integers with `BASE <= MAX <= WINDOW`), then retryable statuses such as `400,429,502,503`, or `default` for `429,503,520`. Status codes must be integers from 400 through 599 and are sorted and deduplicated.
- Latency deadlines are disabled by default. Choosing `on` prompts for the first-progress timeout, its action (`return_502` or `retry_then_502`, skipped when that timeout is `0`), and the total timeout; at least one timeout must be positive. Choosing `off` disables them.
- `ccs proxy restore` resolves `profiles.current` when preview is built, backs up the current config, changes and verifies only the installed provider's `base_url` to that profile's `baseURL`, stops the proxy, and removes state. Install and restore backups remain available for manual recovery; unrelated config edits, profiles, and authentication stay unchanged.
- `ccs proxy` reads one active upstream for each new request. A validated internal `x-ccs-profile` header from a Codex wrapper `run PROFILE` selects that profile for the request; otherwise the proxy uses `profiles.current`. It removes the internal routing header and overwrites incoming `Authorization`, `api-key`, and `x-api-key` headers with `Authorization: Bearer <selected profile apiKey>`. Long-running ordinary Codex CLI processes therefore keep using the proxy URL after `ccs use`, while explicit profile launches remain pinned to their requested profile.
- A profile can set `routeConversion.enabled` when its provider only supports Chat Completions. `ccs add` prompts for this setting. Codex continues to send `/responses`; the proxy sends `/v1/chat/completions` upstream and returns equivalent Responses JSON or SSE events, including the terminal `response.completed` event.
- When status retry is enabled, configured HTTP error responses (default: 429, 503, and transient gateway 520) are withheld and retried while the configured total window allows another wait and dispatch. In `passthrough + retry`, every non-stream response body up to 1 MiB is checked for the Capacity message, including bodies returned with HTTP `200`; matching responses use the same window and backoff while counting as `upstream_capacity`. Non-matching responses follow the ordinary status rule. The proxy honors `Retry-After` seconds or HTTP dates when they fit the configured window; otherwise it uses full-jitter exponential backoff capped by `backoff_max_ms`. The window starts with the first upstream fetch. Before every retry dispatch, an unpinned request reloads `profiles.current`; explicit `x-ccs-profile` requests stay pinned. Expiry returns the last original response. An aborted request, premature client socket close, or unfinished response close stops the wait and prevents another upstream attempt. In `passthrough`, final responses remain uninspected.
- After `ccs use`, run `ccs proxy reroute` to preview default-profile requests currently waiting after 429, 503, 520, or a Capacity response. Exact `yes` wakes every still-eligible wait immediately; its next attempt uses the new current profile on the original client connection. Fetching, forwarding, completed, and explicitly pinned requests are excluded. Reroute preserves the original retry deadline and counters.
- Use `ccs proxy cancel` when a Codex UI session has been closed but its request connection is still open. It lists current 429, 503, 520, or Capacity retry waits, lets you select requests with space (`a` selects all), then previews the selection and requires exact `yes`. Cancellation also applies to pinned waits, prevents the next attempt, and records status `499`.
- Use `ccs proxy capture` to save the next complete client-boundary HTTP exchanges. The list starts with `all sessions` (every request through the proxy, including requests without a session) and `next new session` (the first Codex session created after the capture starts, such as a newly opened `cx`), followed by sessions from active and recent requests. Select one, enter a request count (default `5`), and the command shows live progress. Press `c` to cancel the capture (already written files are retained) or `q` to leave the view while the capture continues; running `ccs proxy capture` again reopens the view. The view closes by itself when the requested count is reached and prints the result. The selected short session id binds the first matching full session id; an ambiguous later match ends the task with an explicit error. Captures start after arming, stop automatically after the requested count, and live under `~/.cache/codex-tools/proxy/captures/` as private metadata plus byte-exact request/response body files. Authentication and cookie headers are redacted; prompt and response bodies are intentionally retained until manually removed. Proxy restart discards an unfinished capture task.
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

