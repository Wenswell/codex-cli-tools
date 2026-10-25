# clvm

`clvm` monitors Clash Verge Rev / mihomo `/connections` data for configured domains.

`clvm version` and `clvm -v` print the shared package version.

Config lives at:

```text
~/.config/codex-tools/clvm.json
```

Runtime records live under `${XDG_CACHE_HOME:-~/.cache}/codex-tools`:

```text
~/.cache/codex-tools/clvm-state.json
~/.cache/codex-tools/clvm-history.jsonl
~/.cache/codex-tools/clvm-raw/
```

Default template lives at:

```text
config/clvm.json
```

The bundled template contains no API secret or domains. Use `clvm setup` to write machine-specific values under `~/.config/codex-tools/clvm.json`.

Default status:

```bash
clvm
```

The no-argument command prints the active config values, masks the API secret, fetches one `/connections` snapshot when domains are configured, writes the latest state, appends one compact history record, and prints a compact command line at the bottom. Raw HTTP archive files are a debug layer enabled with `rawArchive: true` or `--raw-archive on`.

Commands:

```bash
clvm
clvm version
clvm -v
clvm monitor
clvm config
clvm setup --domain example.com --base-url http://127.0.0.1:9090 --secret SECRET
clvm setup --interval 1s
clvm setup --close-zero-for-seconds 300
clvm setup --close-zero-for-seconds off
clvm setup --raw-archive on
clvm sync
clvm help
```

`clvm config` prints the active config without calling the mihomo API.

`clvm setup` merges the active config with the provided flags, prints the target file, active values, backup plan, and a masked JSON diff, then writes only after you type exact `yes`.

`clvm sync` merges `config/clvm.json` into `~/.config/codex-tools/clvm.json`, keeps local overrides, prints the source file, target file, backup plan, and masked JSON diff, then writes only after you type exact `yes`.
When the merged result already matches the local file, `clvm sync` prints `already synced` and exits without prompting.

When applied, `clvm setup` and `clvm sync` back up the existing target file before writing:

```text
~/.config/codex-tools/backups/clvm-YYYYMMDD-HHMMSS-SSS/clvm.json
```

Config shape:

```json
{
  "baseUrl": "http://127.0.0.1:9090",
  "secret": "",
  "domains": ["example.com"],
  "interval": "1s",
  "zeroSpeedThreshold": 0,
  "closeZeroForSeconds": null,
  "rawArchive": false
}
```

Monitor mode:

```bash
clvm monitor
clvm monitor --domain example.com --interval 1s
clvm monitor --json
clvm monitor --no-clear
clvm monitor --raw-archive on
```

Monitor tables read the active terminal width. `clvm monitor` uses the terminal alternate screen in TTY mode, hides the cursor while active, repaints from the home cursor position, clears rewritten lines and the remaining screen tail, restores the main screen on exit, and repaints immediately when the terminal size changes. Its footer stays on the terminal's bottom row and shows history visibility plus `t history  q/Ctrl-C exit`; press `t` to hide or show `recent closed`. History starts visible, and hiding it changes only terminal rendering while collection continues. `--no-clear` appends samples in the main screen without interactive keys or the shortcut footer. The monitor header starts with a labeled `clvm monitor` and bare `HH:mm:ss` time, and TTY output fits that header to the active terminal width. Current connection rows show endpoint, merged `age/zeroFor`, `up/s`, `down/s`, optional traffic totals, optional chain, and rule. The `status` column is omitted; zero time carries the status color, with `0ms` green and non-zero values yellow. Speed cells omit `/s` because the unit is already in the `up/s` and `down/s` headers. Unknown table speed and traffic cells render as `-`. Narrower terminals omit traffic total and chain columns before truncating long text. When the visible columns still exceed the terminal width, `endpoint` compresses before speed, chain, and rule details. The final `rule` column takes remaining width and uses the shared ANSI/wide-character-aware table truncation. Table traffic totals and speed cells use compact 3-significant-digit units such as `160K` and `43.2M`; config and header speed summaries keep explicit `/s` units such as `160K/s`.

`recent closed` shows connections that `clvm monitor` successfully closed through mihomo. Its data rows are dimmed while the section label and table header remain at normal intensity, separating closed history from current connections. The monitor keeps up to 100 recent closed records in memory. TTY output computes visible `recent closed` rows from terminal height after the header and current connection table, so small terminals can show zero closed rows and taller terminals show more. Non-TTY output renders 5 closed rows for deterministic logs.

When Clash Verge Rev / mihomo is unavailable, `clvm` writes an unavailable runtime record instead of discarding the error. `clvm` status prints one unavailable result and exits. Long-running `clvm monitor` keeps running and retries with backoff from the configured interval through `2x`, `5x`, `10x`, `30x`, `60x`, then `5m`. A successful refresh resets retry state to the configured interval.

Every `clvm` status sample writes `~/.cache/codex-tools/clvm-state.json` and appends one JSON line to `~/.cache/codex-tools/clvm-history.jsonl`. `clvm monitor` writes the first runtime record, then writes only when the observed runtime fingerprint changes; idle repeated samples, such as empty `/connections` results, do not append once per interval. State stores the latest normalized matched/closed connection data for status inspection. History stores only `ok`, active non-secret config summary, computed summary counts, error/retry fields, and `raw_ref`; it omits per-connection endpoint, process, rule, node, and matched-domain details and is capped at 16M. `rawArchive` defaults to `false`, so `raw_ref` is `null` and raw `/connections` payloads stay out of runtime records. When `rawArchive` is enabled, raw HTTP response records are stored once by SHA-256 under `~/.cache/codex-tools/clvm-raw/`, sensitive response headers are redacted, payloads above 1M are omitted, and the archive is bounded to 256 files and 64M. Unavailable records store `ok: false`, error code/message details, retry metadata when monitor mode will retry, and a `raw_ref` only when raw archive is enabled and a raw response body exists. HTTP response bodies stay out of state and history. Automatic close failures keep the sample as `ok: true`, record `summary.closeFailed` in state and history, and keep per-connection failure summaries in state without raw response bodies.

Domain matching:

- `example.com` matches `example.com` and `*.example.com`.
- Connection host candidates come from mihomo metadata fields such as `host`, `destinationHost`, `sniffHost`, `sni`, and `domain`.
- Domain rule payload is included when the connection rule is domain-based.

Automatic close:

```bash
clvm setup --close-zero-for-seconds 300
clvm monitor
```

`closeZeroForSeconds` enables automatic close in `clvm monitor`. `clvm` status does not close connections and shows `autoClose=configured` when the threshold is configured.

