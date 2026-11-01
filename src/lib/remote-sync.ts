import { spawn } from "node:child_process";
import { join } from "node:path";
import { readTextIfExists } from "./fs.js";
import { codexToolsCacheDir } from "./paths.js";
import { writeJsonStateAtomic } from "./runtime-log.js";

// Same location relative to HOME on every device; the remote shell resolves it.
const REMOTE_PROFILES = ".config/codex-tools/profiles.json";
const PROTOCOL = "ccs-sync 1";
const CHECKSUM = /^\d+ \d+$/;

export type SyncTarget = {
  /** Text as typed, used as the remembered key: `[user@]host[:port]` or an ssh config alias. */
  raw: string;
  destination: string;
  port?: string;
};

export type RemoteProfiles = {
  host: string;
  text: string | null;
  mtime?: Date;
  /** `cksum` output (`CRC SIZE`); the write refuses to replace a file that no longer matches it. */
  checksum: string | null;
};

export type SyncDirection = "pull" | "push";

export type SyncHostEntry = {
  connected_at?: string;
  synced_at?: string;
  direction?: SyncDirection;
  host?: string;
};

type SyncHostsFile = {
  version: 1;
  hosts: Record<string, SyncHostEntry>;
};

// The leading character excludes `-`, so the destination can never be parsed as an ssh option.
const TARGET = /^(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{1,5}))?$/;

export function parseSyncTarget(raw: string): SyncTarget {
  const match = TARGET.exec(raw.trim());
  const port = match?.[3];
  if (!match || (port !== undefined && (Number(port) < 1 || Number(port) > 65_535))) {
    throw new Error(`invalid sync target: ${raw} (expected [user@]host[:port] or an ssh config alias)`);
  }
  const destination = match[1] ? `${match[1]}@${match[2]}` : match[2];
  return { raw: raw.trim(), destination, ...(port ? { port } : {}) };
}

export function syncTargetError(raw: string): string | null {
  try {
    parseSyncTarget(raw);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sshArgs(target: SyncTarget, script: string, batch: boolean): string[] {
  return [
    "-o", "ConnectTimeout=10",
    ...(batch ? ["-o", "BatchMode=yes"] : []),
    ...(target.port ? ["-p", target.port] : []),
    target.destination,
    // One single-quoted argument: the remote login shell (sh, bash, zsh, or fish) passes it to sh unchanged.
    `sh -c '${script}'`,
  ];
}

// ssh asks for passwords and host keys on the terminal itself; stderr stays visible for its diagnostics.
function runSsh(args: string[], stdin: string | null): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: [stdin === null ? "ignore" : "pipe", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => reject(new Error(`ssh failed to start: ${error.message}`)));
    child.on("close", (code) => resolve({ code: code ?? 255, stdout: Buffer.concat(chunks).toString("utf8") }));
    if (stdin !== null) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(stdin);
    }
  });
}

const READ_SCRIPT = [
  `f="$HOME/${REMOTE_PROFILES}"`,
  `if [ -f "$f" ]; then`,
  `m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")`,
  `echo "${PROTOCOL} present $m $(cksum < "$f") $(uname -n)"`,
  `cat "$f"`,
  "else",
  `echo "${PROTOCOL} missing $(uname -n)"`,
  "fi",
].join("\n");

export async function readRemoteProfiles(target: SyncTarget, options: { batch?: boolean } = {}): Promise<RemoteProfiles> {
  const { code, stdout } = await runSsh(sshArgs(target, READ_SCRIPT, options.batch ?? false), null);
  if (code !== 0) {
    throw new Error(`ssh ${target.raw} failed with exit code ${code}`);
  }
  // Login banners may print before the header; the header line starts the payload.
  const marker = stdout.startsWith(`${PROTOCOL} `) ? -1 : stdout.indexOf(`\n${PROTOCOL} `);
  if (marker < 0 && !stdout.startsWith(`${PROTOCOL} `)) {
    throw new Error(`ssh ${target.raw} returned no ccs sync header; is the remote shell POSIX sh compatible?`);
  }
  const start = marker + 1;
  const lineEnd = stdout.indexOf("\n", start);
  const header = (lineEnd < 0 ? stdout.slice(start) : stdout.slice(start, lineEnd)).split(" ");
  const body = lineEnd < 0 ? "" : stdout.slice(lineEnd + 1);
  if (header[2] === "missing") {
    return { host: header[3] ?? target.destination, text: null, checksum: null };
  }
  const [, , , mtime, crc, size, host] = header;
  if (header[2] !== "present" || !/^\d+$/.test(mtime ?? "") || !CHECKSUM.test(`${crc} ${size}`)) {
    throw new Error(`ssh ${target.raw} returned an invalid ccs sync header`);
  }
  if (Buffer.byteLength(body, "utf8") !== Number(size)) {
    throw new Error(`ssh ${target.raw} returned ${Buffer.byteLength(body, "utf8")} bytes, expected ${size}`);
  }
  return { host: host ?? target.destination, text: body, mtime: new Date(Number(mtime) * 1000), checksum: `${crc} ${size}` };
}

function writeScript(expected: string | null, stamp: string, bytes: number): string {
  return [
    "umask 077",
    `f="$HOME/${REMOTE_PROFILES}"`,
    `if [ -f "$f" ]; then now=$(cksum < "$f"); else now=missing; fi`,
    `if [ "$now" != "${expected ?? "missing"}" ]; then echo "${PROTOCOL} changed"; exit 3; fi`,
    `mkdir -p "$(dirname "$f")"`,
    `if [ -f "$f" ]; then b="$(dirname "$f")/backups/ccs-${stamp}"; mkdir -p "$b"; cp -p "$f" "$b/profiles.json"; echo "${PROTOCOL} backup $b"; fi`,
    `t="$f.ccs-sync.$$"`,
    // A dropped connection leaves a short temp file; only the complete content replaces the target.
    `cat > "$t" && set -- $(wc -c < "$t") && [ "$1" = "${bytes}" ] && mv "$t" "$f" || { rm -f "$t"; exit 4; }`,
    `echo "${PROTOCOL} written"`,
  ].join("\n");
}

export async function writeRemoteProfiles(
  target: SyncTarget,
  text: string,
  expectedChecksum: string | null,
  stamp: string,
): Promise<{ backup: string | null }> {
  if (expectedChecksum !== null && !CHECKSUM.test(expectedChecksum)) {
    throw new Error(`invalid remote checksum: ${expectedChecksum}`);
  }
  if (!/^[0-9-]+$/.test(stamp)) {
    throw new Error(`invalid backup stamp: ${stamp}`);
  }
  const { code, stdout } = await runSsh(sshArgs(target, writeScript(expectedChecksum, stamp, Buffer.byteLength(text, "utf8")), false), text);
  if (code === 3) {
    throw new Error(`remote profiles.json changed after preview; run ccs sync again`);
  }
  if (code !== 0 || !stdout.includes(`${PROTOCOL} written`)) {
    throw new Error(`ssh ${target.raw} write failed with exit code ${code}`);
  }
  const backup = /^ccs-sync 1 backup (.+)$/m.exec(stdout)?.[1] ?? null;
  return { backup };
}

export function syncHostsPath(): string {
  return join(codexToolsCacheDir(), "sync-hosts.json");
}

// A missing or unreadable file means no remembered devices.
export async function readSyncHosts(): Promise<Record<string, SyncHostEntry>> {
  const text = await readTextIfExists(syncHostsPath());
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Partial<SyncHostsFile>;
    if (parsed.version !== 1 || !parsed.hosts || typeof parsed.hosts !== "object") return {};
    return Object.fromEntries(Object.entries(parsed.hosts).filter(([raw, entry]) => (
      entry && typeof entry === "object" && syncTargetError(raw) === null
    )));
  } catch {
    return {};
  }
}

export async function recordSyncHost(raw: string, entry: SyncHostEntry): Promise<void> {
  const hosts = await readSyncHosts();
  hosts[raw] = { ...hosts[raw], ...entry };
  await writeJsonStateAtomic(syncHostsPath(), { version: 1, hosts } satisfies SyncHostsFile);
}
