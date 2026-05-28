import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as asciichart from "asciichart";
import { createTwoFilesPatch } from "diff";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { ensureDir, readTextIfExists, writeTextFile } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import {
  codexAgentsPath,
  codexAuthPath,
  codexConfigPath,
  codexDir,
  codexToolsCacheDir,
  codexToolsConfigDir,
  profilesPath,
  weztermConfigPath,
} from "../lib/paths.js";
import {
  bgDarkBlue,
  maskSecret,
  textBlue,
  textBold,
  textDim,
  textGreen,
  textRed,
  visibleLength,
} from "../lib/text.js";
import {
  colorCost,
  colorHost,
  colorInput,
  colorName,
  colorOutput,
  colorPath,
  colorUrl,
  printKeyValue,
} from "../lib/output.js";
import {
  listTomlSectionNames,
  mergeTomlModelProviderSections,
  readTomlBaseUrl,
  readTopLevelTomlString,
  updateTomlBaseUrl,
  updateTopLevelTomlString,
} from "../lib/toml.js";

type Profile = {
  baseURL: string;
  apiKey: string;
};

type ProfilesFile = {
  profiles?: Record<string, Profile>;
  usage?: Record<string, Profile>;
  current?: string;
  toggle?: string[];
  top?: {
    stateUrls?: string[];
  };
};

type CcsFileBackup = {
  source: string;
  target: string;
};

type ConfigSyncPlan = {
  nextContent: string;
  removedSections: string[];
};

type PreviewFile = {
  label: string;
  path: string;
  current: string;
  next: string;
};

type PreviewPlan = {
  title: string;
  previewFiles: PreviewFile[];
  backupFiles: CcsFileBackup[];
  warnings: string[];
};

type UsageResult = {
  used: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requests: number;
};

type UsageTopTarget = {
  name: string;
  profile: Profile;
};

type UsageTopState = {
  used?: number;
  delta?: number;
  changedAt?: Date;
};

type UsageTopEntry = {
  name: string;
  profile: Profile;
  usage: UsageResult | null;
  skipped: boolean;
  stale: boolean;
  nextRefreshAt: Date | null;
  refreshIntervalMs: number;
  maxIntervalIdleCount: number;
  done: boolean;
  refreshing: boolean;
};

type UsageTopOptions = {
  once: boolean;
  markIntervalMs: number;
};

type UsageTopRuntime = {
  entries: UsageTopEntry[];
  states: Map<string, UsageTopState>;
};

type UsageTopRefreshOptions = {
  resetInterval: boolean;
  stopAtMaxIdle: boolean;
  intervalMode: "top" | "server";
};

type UsageTopSnapshotEntry = {
  name: string;
  used?: number;
  delta?: number;
  changedAt?: string;
  skipped?: boolean;
  unavailable?: boolean;
  stale?: boolean;
  done?: boolean;
  nextRefreshAt?: string;
};

type UsageTopSnapshot = {
  version: 1;
  active: boolean;
  pid: number;
  updatedAt: string;
  paused?: boolean;
  entries: UsageTopSnapshotEntry[];
};

type UsageTopSnapshotSource = {
  snapshot: UsageTopSnapshot;
  remote: boolean;
};

type UsageTopHistory = {
  version: 1;
  updatedAt: string;
  windowHours: number;
  bucketMinutes: number;
  records: UsageTopSnapshot[];
};

type UsageTopHistorySource = {
  history: UsageTopHistory;
  source: string;
  remote: boolean;
};

type UsageTopPoint = {
  at: Date;
  value: number;
};

type UsageTopSummary = {
  name: string;
  first?: number;
  latest?: number;
  delta?: number;
  reset: boolean;
  changes: number;
  lastChangeAt?: Date;
  lastChangeDelta?: number;
  lastResetAt?: Date;
};

type UsageTopBucketDelta = {
  delta?: number;
  reset: boolean;
};

type UsageTopBucket = {
  start: Date;
  end: Date;
  deltas: Map<string, UsageTopBucketDelta>;
  total?: number;
  reset: boolean;
};

type UsageTopControlAction = "pause" | "resume" | "reset";

type WeztermOptions = {
  remove: boolean;
};

type ConfigSyncAction = "status" | "push" | "pull";

type ConfigSyncOptions = {
  action: ConfigSyncAction;
};

type ConfigFileSummary = {
  exists: boolean;
  size?: number;
  sha256?: string;
  mtime?: Date;
};

const execFile = promisify(execFileCallback);
const usageTopMinIntervalMs = 25_000;
const usageTopStepIntervalMs = 30_000;
const usageTopMaxIntervalMs = 300_000;
const usageTopServerIntervalsMs = [
  25_000,
  60_000,
  120_000,
  300_000,
  600_000,
  1_200_000,
  1_800_000,
  3_600_000,
];
const usageTopMaxIntervalIdleLimit = 3;
const usageTopDefaultMarkIntervalMs = 5 * 60 * 1000;
const usageTopTickMs = 1000;
const usageTopChangeTtlMs = 60 * 60 * 1000;
const usageTopChangeColorTtlMs = 60 * 1000;
const usageTopMaxDisplayDelta = 10;
const usageTopStatusWidth = 24;
const usageTopMarkNameWidth = 8;
const usageTopMarkDeltaWidth = 5;
const usageTopSnapshotActiveTtlMs = 5_000;
const usageTopHistoryWindowMs = 24 * 60 * 60 * 1000;
const usageTopHistoryBucketMs = 60 * 60 * 1000;
const usageTopHistoryRetentionMs = usageTopHistoryWindowMs + usageTopHistoryBucketMs;
const usageTopHistoryWindowHours = usageTopHistoryWindowMs / (60 * 60 * 1000);
const usageTopHistoryBucketMinutes = usageTopHistoryBucketMs / (60 * 1000);
const usageTopHistoryPeakLimit = 5;
const usageTopHistoryEpsilon = 0.05;
let usageTopStatusWriteSequence = 0;
const configSyncUser = "ravvss";
const configSyncHost = "10.126.126.1";
const configSyncPort = "32753";
const configSyncRemotePath = "/home/ravvss/.config/codex-tools/profiles.json";
const configSyncRemoteDisplay = `${configSyncUser}@${configSyncHost}:${configSyncRemotePath}`;
const weztermStatusBegin = "-- ccs wezterm status begin";
const weztermStatusEnd = "-- ccs wezterm status end";

function assertProfile(value: unknown, name: string): Profile {
  if (!value || typeof value !== "object") {
    throw new Error(`profile ${name} is invalid`);
  }

  const profile = value as Partial<Profile>;
  if (typeof profile.baseURL !== "string" || typeof profile.apiKey !== "string") {
    throw new Error(`profile ${name} is missing baseURL or apiKey`);
  }

  return { baseURL: profile.baseURL, apiKey: profile.apiKey };
}

async function readProfiles(): Promise<ProfilesFile> {
  const text = await readTextIfExists(profilesPath());
  if (!text) {
    return {};
  }

  try {
    return parseJsonObject(text) as ProfilesFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid profiles.json: ${message}`);
  }
}

async function writeProfiles(profiles: ProfilesFile): Promise<void> {
  await writeTextFile(profilesPath(), stringifyJson(profiles), 0o600);
}

async function readDefaultProfiles(): Promise<ProfilesFile> {
  const path = fileURLToPath(new URL("../../config/ccs-profiles.json", import.meta.url));
  const text = await readTextIfExists(path);
  if (!text) {
    throw new Error(`default profiles template not found: ${path}`);
  }
  return parseJsonObject(text) as ProfilesFile;
}

async function readDefaultCodexConfig(): Promise<string> {
  const path = fileURLToPath(new URL("../../config/codex-config.toml", import.meta.url));
  const text = await readTextIfExists(path);
  if (!text) {
    throw new Error(`default Codex config template not found: ${path}`);
  }
  return text;
}

async function readDefaultCodexAgents(): Promise<string> {
  const path = fileURLToPath(new URL("../../config/codex-agents.md", import.meta.url));
  const text = await readTextIfExists(path);
  if (!text) {
    throw new Error(`default Codex AGENTS template not found: ${path}`);
  }
  return text;
}

async function readCurrentCodexProfile(): Promise<Profile> {
  const configText = (await readTextIfExists(codexConfigPath())) ?? "";
  const authText = (await readTextIfExists(codexAuthPath())) ?? "";
  const auth = authText ? parseJsonObject(authText) : {};
  const apiKey = typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "";
  return {
    baseURL: readTomlBaseUrl(configText) ?? "",
    apiKey,
  };
}

function getCcsBackupFiles(): CcsFileBackup[] {
  return [
    { source: codexConfigPath(), target: "config.toml" },
    { source: codexAgentsPath(), target: "AGENTS.md" },
    { source: codexAuthPath(), target: "auth.json" },
    { source: profilesPath(), target: "profiles.json" },
  ];
}

async function getExistingBackupFiles(): Promise<CcsFileBackup[]> {
  const existing: CcsFileBackup[] = [];
  for (const file of getCcsBackupFiles()) {
    if ((await readTextIfExists(file.source)) !== null) {
      existing.push(file);
    }
  }
  return existing;
}

async function backupCcsFiles(files: CcsFileBackup[]): Promise<string | null> {
  const backupDir = join(codexToolsConfigDir(), "backups", `ccs-${formatTimestamp(new Date())}`);

  for (const file of files) {
    const content = await readTextIfExists(file.source);
    if (content === null) continue;
    await writeTextFile(join(backupDir, file.target), content, 0o600);
  }

  return files.length > 0 ? backupDir : null;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
  return [
    date.getFullYear().toString(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    milliseconds,
  ].join("");
}

async function planCodexConfigSync(): Promise<ConfigSyncPlan> {
  const defaults = await readDefaultCodexConfig();
  const existing = (await readTextIfExists(codexConfigPath())) ?? "";
  const provider = readTopLevelTomlString(existing, "model_provider")
    ?? readTopLevelTomlString(defaults, "model_provider")
    ?? "codex";
  const baseURL = readTomlBaseUrl(existing);
  const templateSections = new Set(listTomlSectionNames(defaults));
  const existingSections = listTomlSectionNames(existing);

  let next = mergeTomlModelProviderSections(defaults, existing);
  next = updateTopLevelTomlString(next, "model_provider", provider);
  if (baseURL !== null) {
    next = updateTomlBaseUrl(next, baseURL);
  }

  const nextSections = listTomlSectionNames(next);

  return {
    nextContent: next,
    removedSections: existingSections.filter((name) => !nextSections.includes(name)),
  };
}

async function syncCodexConfigFromTemplate(): Promise<ConfigSyncPlan> {
  await ensureDir(codexDir());
  const plan = await planCodexConfigSync();
  await writeTextFile(codexConfigPath(), plan.nextContent);
  return plan;
}

async function syncCodexAgentsFromTemplate(): Promise<string> {
  await ensureDir(codexDir());
  const next = await readDefaultCodexAgents();
  await writeTextFile(codexAgentsPath(), next);
  return next;
}

async function planInitProfilesFromCurrent(): Promise<ProfilesFile> {
  const defaults = await readDefaultProfiles();
  const existing = await readProfiles();
  const existingProfilesText = await readTextIfExists(profilesPath());
  const shouldCaptureCurrent = existingProfilesText === null;
  const defaultProfiles = defaults.profiles ?? {};
  const existingProfiles = existing.profiles ?? {};
  const profiles: Record<string, Profile> = { ...existingProfiles };

  for (const [name, defaultProfile] of Object.entries(defaultProfiles)) {
    const existingProfile = existingProfiles[name];
    profiles[name] = {
      baseURL: defaultProfile.baseURL,
      apiKey: existingProfile?.apiKey || defaultProfile.apiKey,
    };
  }

  if (shouldCaptureCurrent) {
    const current = await readCurrentCodexProfile();
    profiles.current = {
      baseURL: current.baseURL,
      apiKey: current.apiKey,
    };
  }

  const next = {
    ...existing,
    ...defaults,
    profiles,
    current: shouldCaptureCurrent ? "current" : (existing.current ?? defaults.current),
    toggle: existing.toggle ?? defaults.toggle,
    top: existing.top ?? defaults.top,
  };
  return next;
}

async function initProfilesFromCurrent(): Promise<ProfilesFile> {
  const next = await planInitProfilesFromCurrent();
  await writeProfiles(next);
  return next;
}

async function planSyncProfiles(): Promise<ProfilesFile> {
  const defaults = await readDefaultProfiles();
  const existing = await readProfiles();
  const defaultProfiles = defaults.profiles ?? {};
  const existingProfiles = existing.profiles ?? {};
  const nextProfiles: Record<string, Profile> = { ...existingProfiles };

  for (const [name, defaultProfile] of Object.entries(defaultProfiles)) {
    const current = existingProfiles[name];
    nextProfiles[name] = {
      baseURL: defaultProfile.baseURL,
      apiKey: current?.apiKey || defaultProfile.apiKey,
    };
  }

  const next: ProfilesFile = {
    ...existing,
    profiles: nextProfiles,
    current: existing.current ?? defaults.current,
    toggle: existing.toggle ?? defaults.toggle,
    top: existing.top ?? defaults.top,
  };
  return next;
}

async function syncProfiles(): Promise<ProfilesFile> {
  const next = await planSyncProfiles();
  await writeProfiles(next);
  return next;
}

function configFileHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function formatConfigSummary(summary: ConfigFileSummary): string {
  if (!summary.exists) {
    return textDim("missing");
  }
  const size = summary.size === undefined ? "?" : `${summary.size}b`;
  const mtime = summary.mtime ? formatClockTime(summary.mtime) : "?";
  return `${size} ${textDim(mtime)}`;
}

async function readLocalConfigText(): Promise<string> {
  const text = await readTextIfExists(profilesPath());
  if (text === null) {
    throw new Error(`local profiles.json not found: ${profilesPath()}`);
  }
  try {
    parseJsonObject(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid local profiles.json: ${message}`);
  }
  return text;
}

async function localConfigSummary(): Promise<ConfigFileSummary> {
  const text = await readTextIfExists(profilesPath());
  if (text === null) {
    return { exists: false };
  }
  const file = await stat(profilesPath());
  return {
    exists: true,
    size: file.size,
    sha256: configFileHash(text),
    mtime: file.mtime,
  };
}

async function execConfigSyncFile(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile(command, args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(stderr || message);
  }
}

async function configSyncSsh(script: string): Promise<string> {
  const { stdout } = await execConfigSyncFile("ssh", [
    "-p",
    configSyncPort,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "StrictHostKeyChecking=accept-new",
    `${configSyncUser}@${configSyncHost}`,
    script,
  ]);
  return stdout;
}

async function configSyncScp(source: string, target: string): Promise<void> {
  await execConfigSyncFile("scp", [
    "-P",
    configSyncPort,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "StrictHostKeyChecking=accept-new",
    source,
    target,
  ]);
}

async function remoteConfigSummary(): Promise<ConfigFileSummary> {
  const script = [
    `p=${JSON.stringify(configSyncRemotePath)}`,
    'if [ -f "$p" ]; then',
    '  size=$(wc -c < "$p" | tr -d " ")',
    '  hash=$(sha256sum "$p" | awk \'{print $1}\')',
    '  mtime=$(stat -c %Y "$p")',
    '  printf "exists\\t%s\\t%s\\t%s\\n" "$size" "$hash" "$mtime"',
    "else",
    '  printf "missing\\n"',
    "fi",
  ].join("\n");
  const output = (await configSyncSsh(script)).trim();
  if (output === "missing") {
    return { exists: false };
  }
  const [status, size, sha256, mtime] = output.split("\t");
  if (status !== "exists") {
    throw new Error(`unexpected remote status: ${output}`);
  }
  return {
    exists: true,
    size: Number(size),
    sha256,
    mtime: new Date(Number(mtime) * 1000),
  };
}

async function readRemoteConfigTextIfExists(remote: ConfigFileSummary): Promise<string | null> {
  if (!remote.exists) {
    return null;
  }
  return configSyncSsh(`cat ${JSON.stringify(configSyncRemotePath)}`);
}

function printConfigSyncPlan(
  action: ConfigSyncAction,
  local: ConfigFileSummary,
  remote: ConfigFileSummary,
  localText: string | null,
  remoteText: string | null,
): void {
  console.log(textBold(`ccs config ${action}`));
  printKeyValue("local:", `${colorPath(profilesPath())}  ${formatConfigSummary(local)}`, 9);
  printKeyValue("remote:", `${colorPath(configSyncRemoteDisplay)}  ${formatConfigSummary(remote)}`, 9);
  const same = local.exists && remote.exists && local.sha256 === remote.sha256;
  printKeyValue("same:", same ? textGreen("yes") : textRed("no"), 9);
  if (action === "push") {
    printKeyValue("action:", "upload local profiles.json to LAN server", 9);
  } else if (action === "pull") {
    printKeyValue("action:", "download LAN server profiles.json to local", 9);
  } else {
    printKeyValue("action:", "status only", 9);
  }
  if (action !== "status") {
    console.log(textDim("no changes are written unless you type yes at the prompt."));
  }
  printConfigSyncDiff(action, localText, remoteText);
}

function printConfigSyncDiff(action: ConfigSyncAction, localText: string | null, remoteText: string | null): void {
  if (localText === null && remoteText === null) {
    printKeyValue("diff:", textDim("none"), 9);
    return;
  }
  const file = action === "push"
    ? {
      label: "profiles.json",
      path: configSyncRemoteDisplay,
      current: remoteText ?? "",
      next: localText ?? "",
    }
    : {
      label: "profiles.json",
      path: action === "pull" ? profilesPath() : `${profilesPath()} <-> ${configSyncRemoteDisplay}`,
      current: localText ?? "",
      next: remoteText ?? "",
    };
  if (normalizePreviewContent(file.label, file.current) === normalizePreviewContent(file.label, file.next)) {
    printKeyValue("diff:", textDim("none"), 9);
    return;
  }
  printDiffBlock(file);
}

function printConfigSyncStatus(local: ConfigFileSummary): void {
  console.log(textBold("ccs config"));
  printKeyValue("local:", `${colorPath(profilesPath())}  ${formatConfigSummary(local)}`, 9);
  printKeyValue("remote:", colorPath(configSyncRemoteDisplay), 9);
  printKeyValue("action:", "status only", 9);
  console.log(textDim("commands: ccs config | ccs config push | ccs config pull"));
}

async function pushConfigToServer(local: ConfigFileSummary, remote: ConfigFileSummary): Promise<void> {
  await readLocalConfigText();
  if (remote.exists && local.sha256 === remote.sha256) {
    console.log(textDim("already synced"));
    return;
  }

  const tmpRemotePath = `${configSyncRemotePath}.${process.pid}.${Date.now()}.tmp`;
  const backupRemotePath = `${configSyncRemotePath}.backup-${formatTimestamp(new Date())}`;
  await configSyncSsh([
    `dir=$(dirname ${JSON.stringify(configSyncRemotePath)})`,
    'mkdir -p "$dir"',
  ].join("\n"));
  await configSyncScp(profilesPath(), `${configSyncUser}@${configSyncHost}:${tmpRemotePath}`);
  await configSyncSsh([
    `p=${JSON.stringify(configSyncRemotePath)}`,
    `tmp=${JSON.stringify(tmpRemotePath)}`,
    `backup=${JSON.stringify(backupRemotePath)}`,
    'if [ -f "$p" ]; then cp -p "$p" "$backup"; fi',
    'chmod 600 "$tmp"',
    'mv "$tmp" "$p"',
    'printf "%s\\n" "$backup"',
  ].join("\n"));
  console.log(`uploaded: ${textGreen(configSyncRemoteDisplay)}`);
  if (remote.exists) {
    console.log(`remote backup: ${textBlue(`${configSyncUser}@${configSyncHost}:${backupRemotePath}`)}`);
  }
}

async function pullConfigFromServer(local: ConfigFileSummary, remote: ConfigFileSummary): Promise<void> {
  if (!remote.exists) {
    throw new Error(`remote profiles.json not found: ${configSyncRemoteDisplay}`);
  }
  if (local.exists && local.sha256 === remote.sha256) {
    console.log(textDim("already synced"));
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "ccs-config-"));
  const tempPath = join(tempDir, "profiles.json");
  try {
    await configSyncScp(`${configSyncUser}@${configSyncHost}:${configSyncRemotePath}`, tempPath);
    const nextText = await readFile(tempPath, "utf8");
    try {
      parseJsonObject(nextText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid remote profiles.json: ${message}`);
    }
    const backupDir = await backupCcsFiles([{ source: profilesPath(), target: "profiles.json" }]);
    await writeTextFile(profilesPath(), nextText, 0o600);
    if (backupDir) {
      console.log(`backup: ${textBlue(backupDir)}`);
    }
    console.log(`downloaded: ${textGreen(profilesPath())}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runConfigSync(args: string[]): Promise<void> {
  if (isHelpArgument(args[0])) {
    assertExactArgs(args.slice(1), "config help", 0);
    printHelp();
    return;
  }

  const options = parseConfigSyncArgs(args);
  const local = await localConfigSummary();
  if (options.action === "status") {
    printConfigSyncStatus(local);
    return;
  }

  const remote = await remoteConfigSummary();
  const localText = await readTextIfExists(profilesPath());
  const remoteText = await readRemoteConfigTextIfExists(remote);
  printConfigSyncPlan(options.action, local, remote, localText, remoteText);

  if (!(await confirmApply())) {
    return;
  }
  if (options.action === "push") {
    await pushConfigToServer(local, remote);
    return;
  }
  await pullConfigFromServer(local, remote);
}

function assertNameAvailable(name: string, profiles: ProfilesFile, target: "profiles" | "usage"): void {
  const other = target === "profiles" ? profiles.usage : profiles.profiles;
  if (other?.[name]) {
    throw new Error(`${name} already exists in ${target === "profiles" ? "usage" : "profiles"}`);
  }
}

function assertOnlyFlags(argv: string[], command: string, allowed: string[]): void {
  for (const arg of argv) {
    if (!allowed.includes(arg)) {
      throw new Error(`unknown argument for ccs ${command}: ${arg}`);
    }
  }
}

function assertMaxArgs(argv: string[], command: string, count: number): void {
  if (argv.length > count) {
    throw new Error(`usage: ccs ${command}`);
  }
}

function assertExactArgs(argv: string[], command: string, count: number): void {
  if (argv.length !== count) {
    throw new Error(`usage: ccs ${command}`);
  }
}

function parseConfigSyncArgs(args: string[]): ConfigSyncOptions {
  rejectRemovedYesFlags(args, "ccs config");
  const action = (args[0] ?? "status") as ConfigSyncAction;
  if (action !== "status" && action !== "push" && action !== "pull") {
    throw new Error(`unknown argument for ccs config: ${action}`);
  }
  const flags = args.slice(args[0] ? 1 : 0);
  assertOnlyFlags(flags, `config ${action}`, []);
  return { action };
}

function parseDurationMs(value: string): number {
  const match = /^(\d+)(s|m|h)?$/.exec(value.trim());
  if (!match) {
    throw new Error(`invalid duration: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "h" ? 60 * 60 * 1000 : unit === "m" ? 60 * 1000 : 1000;
  return amount * multiplier;
}

function nextAlignedTimeMs(now: number, interval: number): number {
  return Math.ceil((now + 1) / interval) * interval;
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function buildConfigSection(plan: ConfigSyncPlan): { lines: string[]; warnings: string[] } {
  const warnings: string[] = [];
  for (const section of plan.removedSections) {
    warnings.push(`config section [${section}] will be removed`);
  }
  return { lines: [], warnings };
}

function printPreviewSummary(
  title: string,
  modifiedFiles: string[],
  backupFiles: string[],
  warnings: string[],
  dryRun: boolean,
): void {
  console.log(textBold(`Plan: ${title}`));
  if (dryRun) {
    console.log(textDim("no changes are written unless you type yes at the prompt."));
  }
  console.log(`Will modify: ${textBlue(formatList(modifiedFiles))}`);
  console.log(`Will back up: ${textBlue(formatList(backupFiles))}`);
  console.log(`Warnings: ${warnings.length === 0 ? textDim("0") : textRed(String(warnings.length))}`);
}

function collectChangedPreviewFiles(files: PreviewFile[]): PreviewFile[] {
  return files.filter((file) => {
    const current = normalizePreviewContent(file.label, file.current);
    const next = normalizePreviewContent(file.label, file.next);
    return current !== next;
  });
}

function collectExistingBackupFilesForPaths(paths: string[]): Promise<CcsFileBackup[]> {
  const wanted = new Set(paths);
  return getExistingBackupFiles().then((files) => files.filter((file) => wanted.has(file.source)));
}

function printDiffBlock(file: PreviewFile): void {
  const current = normalizePreviewContent(file.label, file.current);
  const next = normalizePreviewContent(file.label, file.next);
  if (current === next) {
    return;
  }
  const redactedCurrent = normalizePreviewContent(file.label, redactPreviewSecrets(file.current));
  const redactedNext = normalizePreviewContent(file.label, redactPreviewSecrets(file.next));

  console.log("");
  console.log(`${textBold("File:")} ${textBlue(file.path)}`);

  if (redactedCurrent === redactedNext) {
    console.log(textDim("  changes only affect masked secret values"));
    return;
  }

  const patch = createTwoFilesPatch(
    `current/${file.label}`,
    `next/${file.label}`,
    redactedCurrent,
    redactedNext,
    "",
    "",
    { context: 3 },
  );
  const lines = patch.split("\n");

  for (const line of lines) {
    if (line.startsWith("===")) {
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      console.log(textDim(`  ${line}`));
      continue;
    }
    if (line.startsWith("@@")) {
      console.log(textBlue(`  ${line}`));
      continue;
    }
    if (line.startsWith("+")) {
      console.log(textGreen(`  ${line}`));
      continue;
    }
    if (line.startsWith("-")) {
      console.log(textRed(`  ${line}`));
      continue;
    }
    console.log(textDim(`  ${line}`));
  }
}

function redactPreviewSecrets(content: string): string {
  return content
    .replace(/("apiKey"\s*:\s*")([^"]*)(")/g, (_match, before: string, value: string, after: string) => {
      return `${before}${maskSecretValue(value)}${after}`;
    })
    .replace(/("OPENAI_API_KEY"\s*:\s*")([^"]*)(")/g, (_match, before: string, value: string, after: string) => {
      return `${before}${maskSecretValue(value)}${after}`;
    });
}

function maskSecretValue(value: string): string {
  if (!value) {
    return value;
  }
  return maskSecret(value);
}

function normalizePreviewContent(label: string, content: string): string {
  if (label.endsWith(".json")) {
    return normalizeJsonPreview(content);
  }
  if (label.endsWith(".toml")) {
    return normalizeTomlPreview(content);
  }
  return content;
}

function normalizeJsonPreview(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return stringifyJson(JSON.parse(trimmed));
  } catch {
    return content;
  }
}

function normalizeTomlPreview(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized
    .split("\n")
    .map((line) => stripTomlInlineComment(line).trimEnd());

  const compact: string[] = [];
  let previousBlank = false;
  for (const line of lines) {
    const isBlank = line.trim() === "";
    if (isBlank) {
      if (!previousBlank) {
        compact.push("");
      }
      previousBlank = true;
      continue;
    }
    compact.push(line);
    previousBlank = false;
  }

  while (compact[0] === "") {
    compact.shift();
  }
  while (compact.at(-1) === "") {
    compact.pop();
  }

  return compact.length > 0 ? `${compact.join("\n")}\n` : "";
}

function stripTomlInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const prev = i > 0 ? line[i - 1] : "";

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === "\"" && !inSingle && prev !== "\\") {
      inDouble = !inDouble;
      continue;
    }
    if (char === "#" && !inSingle && !inDouble) {
      return line.slice(0, i).trimEnd();
    }
  }

  return line;
}

function printWarnings(warnings: string[]): void {
  console.log("");
  console.log(textBold("Warnings:"));
  if (warnings.length === 0) {
    console.log(textDim("  (none)"));
    return;
  }
  for (const warning of warnings) {
    console.log(`  ${textRed("-")} ${warning}`);
  }
}

async function buildInitPreviewPlan(): Promise<PreviewPlan> {
  const nextProfiles = await planInitProfilesFromCurrent();
  const configPlan = await planCodexConfigSync();
  const currentProfilesText = (await readTextIfExists(profilesPath())) ?? "";
  const currentConfigText = (await readTextIfExists(codexConfigPath())) ?? "";
  const currentAgentsText = (await readTextIfExists(codexAgentsPath())) ?? "";
  const currentAuthText = (await readTextIfExists(codexAuthPath())) ?? "";
  const nextAgentsText = await readDefaultCodexAgents();
  const configSection = buildConfigSection(configPlan);
  const nextCurrentProfile = nextProfiles.profiles?.[nextProfiles.current ?? ""];
  const nextAuthText = nextCurrentProfile?.apiKey
    ? stringifyJson({ OPENAI_API_KEY: nextCurrentProfile.apiKey })
    : currentAuthText;
  const warnings = [...configSection.warnings];
  const currentProfiles = await readProfiles();
  if ((currentProfiles.current ?? null) !== (nextProfiles.current ?? null)) {
    warnings.unshift(
      `profile current will change from ${currentProfiles.current ?? "(none)"} to ${nextProfiles.current ?? "(none)"}`,
    );
  }

  const previewFiles = collectChangedPreviewFiles([
    {
      label: "profiles.json",
      path: profilesPath(),
      current: currentProfilesText,
      next: stringifyJson(nextProfiles),
    },
    {
      label: "config.toml",
      path: codexConfigPath(),
      current: currentConfigText,
      next: configPlan.nextContent,
    },
    {
      label: "AGENTS.md",
      path: codexAgentsPath(),
      current: currentAgentsText,
      next: nextAgentsText,
    },
    {
      label: "auth.json",
      path: codexAuthPath(),
      current: currentAuthText,
      next: nextAuthText,
    },
  ]);
  const backupFiles = await collectExistingBackupFilesForPaths(previewFiles.map((file) => file.path));

  return {
    title: "ccs init",
    previewFiles,
    backupFiles,
    warnings,
  };
}

async function buildSyncPreviewPlan(): Promise<PreviewPlan> {
  const nextProfiles = await planSyncProfiles();
  const configPlan = await planCodexConfigSync();
  const currentProfilesText = (await readTextIfExists(profilesPath())) ?? "";
  const currentConfigText = (await readTextIfExists(codexConfigPath())) ?? "";
  const currentAgentsText = (await readTextIfExists(codexAgentsPath())) ?? "";
  const nextAgentsText = await readDefaultCodexAgents();
  const configSection = buildConfigSection(configPlan);
  const previewFiles = collectChangedPreviewFiles([
    {
      label: "profiles.json",
      path: profilesPath(),
      current: currentProfilesText,
      next: stringifyJson(nextProfiles),
    },
    {
      label: "config.toml",
      path: codexConfigPath(),
      current: currentConfigText,
      next: configPlan.nextContent,
    },
    {
      label: "AGENTS.md",
      path: codexAgentsPath(),
      current: currentAgentsText,
      next: nextAgentsText,
    },
  ]);
  const backupFiles = await collectExistingBackupFilesForPaths(previewFiles.map((file) => file.path));

  return {
    title: "ccs sync",
    previewFiles,
    backupFiles,
    warnings: configSection.warnings,
  };
}

function buildWeztermStatusBlock(): string {
  return [
    weztermStatusBegin,
    "config.enable_tab_bar = true",
    "config.hide_tab_bar_if_only_one_tab = false",
    "config.status_update_interval = 1000",
    "",
    "local function ccs_status()",
    `\tlocal path = os.getenv("CCS_WEZTERM_STATUS_FILE") or ${JSON.stringify(usageTopStatusTextPath())}`,
    "\tlocal handle = io.open(path, \"r\")",
    "\tif not handle then",
    "\t\treturn os.date(\"%H:%M:%S\") .. \" | ccs status inactive\"",
    "\tend",
    "",
    "\tlocal value = handle:read(\"*a\") or \"\"",
    "\thandle:close()",
    "\tvalue = value:gsub(\"%s+$\", \"\")",
    "\tif value == \"\" then",
    "\t\treturn os.date(\"%H:%M:%S\") .. \" | ccs status inactive\"",
    "\tend",
    "\treturn value",
    "end",
    "",
    "wezterm.on(\"update-right-status\", function(window)",
    "\tlocal status = ccs_status()",
    "\tif status == \"\" then",
    "\t\twindow:set_right_status(\"\")",
    "\t\treturn",
    "\tend",
    "",
    "\twindow:set_right_status(wezterm.format({",
    "\t\t{ Foreground = { Color = \"#89b4fa\" } },",
    "\t\t{ Text = \" \" .. status .. \" \" },",
    "\t}))",
    "end)",
    weztermStatusEnd,
    "",
  ].join("\n");
}

function stripWeztermStatusBlock(content: string): string {
  const begin = content.indexOf(weztermStatusBegin);
  if (begin === -1) {
    return content;
  }
  const end = content.indexOf(weztermStatusEnd, begin);
  if (end === -1) {
    throw new Error(`found ${weztermStatusBegin} without ${weztermStatusEnd}`);
  }
  const afterEnd = end + weztermStatusEnd.length;
  const afterNewline = content.slice(afterEnd).match(/^\r?\n/);
  const before = content.slice(0, begin).trimEnd();
  const after = content.slice(afterEnd + (afterNewline?.[0].length ?? 0)).trimStart();
  return after ? `${before}\n${after}` : `${before}\n`;
}

function insertWeztermStatusBlock(content: string, block: string): string {
  const stripped = stripWeztermStatusBlock(content).trimEnd();
  if (/\breturn\s+config\s*$/m.test(stripped)) {
    return `${stripped.replace(/\breturn\s+config\s*$/m, `${block}\nreturn config`)}\n`;
  }
  if (stripped.length === 0) {
    return `local wezterm = require("wezterm")\nlocal config = wezterm.config_builder()\n\n${block}\nreturn config\n`;
  }
  return `${stripped}\n\n${block}`;
}

function planWeztermStatusConfig(current: string): string {
  return insertWeztermStatusBlock(current, buildWeztermStatusBlock());
}

function planWeztermStatusRemove(current: string): string {
  return stripWeztermStatusBlock(current);
}

async function buildWeztermPreviewPlan(): Promise<PreviewPlan> {
  const currentConfigText = (await readTextIfExists(weztermConfigPath())) ?? "";
  const nextConfigText = planWeztermStatusConfig(currentConfigText);
  const previewFiles = collectChangedPreviewFiles([
    {
      label: ".wezterm.lua",
      path: weztermConfigPath(),
      current: currentConfigText,
      next: nextConfigText,
    },
  ]);
  const backupFiles = await collectExistingBackupFilesForPaths(previewFiles.map((file) => file.path));

  return {
    title: "ccs s wezterm",
    previewFiles,
    backupFiles,
    warnings: [],
  };
}

async function buildWeztermRemovePreviewPlan(): Promise<PreviewPlan> {
  const currentConfigText = (await readTextIfExists(weztermConfigPath())) ?? "";
  const nextConfigText = planWeztermStatusRemove(currentConfigText);
  const previewFiles = collectChangedPreviewFiles([
    {
      label: ".wezterm.lua",
      path: weztermConfigPath(),
      current: currentConfigText,
      next: nextConfigText,
    },
  ]);
  const backupFiles = await collectExistingBackupFilesForPaths(previewFiles.map((file) => file.path));

  return {
    title: "ccs s wezterm remove",
    previewFiles,
    backupFiles,
    warnings: [],
  };
}

function printPreviewPlan(plan: PreviewPlan, dryRun: boolean): void {
  printPreviewSummary(
    plan.title,
    plan.previewFiles.map((file) => file.label),
    plan.backupFiles.map((file) => file.target),
    plan.warnings,
    dryRun,
  );
  for (const file of plan.previewFiles) {
    printDiffBlock(file);
  }
  printWarnings(plan.warnings);
}

async function addProfile(defaultName?: string): Promise<void> {
  const data = await readProfiles();
  const profiles = data.profiles ?? {};
  const input = createPrompt();
  let name = "";

  try {
    name = await askRequired(input, "name", defaultName);
    assertNameAvailable(name, data, "profiles");
    const existing = profiles[name];
    const baseURL = await askRequired(input, "baseURL", existing?.baseURL);
    const apiKey = await askOptional(input, "apiKey", existing?.apiKey);

    profiles[name] = { baseURL, apiKey };
  } finally {
    input.close();
  }

  await writeProfiles({ ...data, profiles, current: data.current ?? name });
  console.log(`profile saved: ${textGreen(name)}`);
}

async function addUsageProfile(defaultName?: string): Promise<void> {
  const data = await readProfiles();
  const usage = data.usage ?? {};
  const input = createPrompt();
  let name = "";

  try {
    name = await askRequired(input, "name", defaultName);
    assertNameAvailable(name, data, "usage");
    const existing = usage[name];
    const baseURL = await askRequired(input, "baseURL", existing?.baseURL);
    const apiKey = await askOptional(input, "apiKey", existing?.apiKey);

    usage[name] = { baseURL, apiKey };
  } finally {
    input.close();
  }

  await writeProfiles({ ...data, usage });
  console.log(`usage saved: ${textGreen(name)}`);
}

function printProfile(name: string, profiles: ProfilesFile): void {
  const profile = profiles.profiles?.[name];
  if (!profile) {
    throw new Error(`profile not found: ${name}`);
  }
  const normalized = assertProfile(profile, name);
  printProfileSummary("profile", name, normalized);
}

function printProfileDetails(name: string, profile: Profile): void {
  printProfileSummary("profile", name, profile);
}

function formatApiKey(apiKey: string): string {
  return apiKey ? textDim(maskSecret(apiKey)) : textDim("(empty)");
}

function formatSystemLabel(): string {
  const username = process.env.USER || process.env.LOGNAME || userInfo().username || "unknown";
  const host = (process.env.HOSTNAME || hostname() || "unknown").split(".")[0] || "unknown";
  return `${username}@${host}`;
}

function formatDisplayPath(path: string): string {
  const home = process.env.HOME;
  if (!home) {
    return path;
  }
  if (path === home) {
    return "~";
  }
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function printProfileSummary(label: string, name: string, profile: Profile): void {
  printKeyValue(`${label}:`, `${colorName(name)}  ${colorUrl(profile.baseURL)}  ${formatApiKey(profile.apiKey)}`);
}

function buildUsageUrl(baseURL: string): string | null {
  const value = baseURL.trim();
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = path === "" || path === "/v1" ? "/v1/usage" : `${path}/v1/usage`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseUsageResponse(value: unknown): UsageResult {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const usage = root.usage && typeof root.usage === "object" ? root.usage as Record<string, unknown> : {};
  const today = usage.today && typeof usage.today === "object" ? usage.today as Record<string, unknown> : {};

  return {
    used: readNumber(today.actual_cost),
    inputTokens: readNumber(today.input_tokens),
    outputTokens: readNumber(today.output_tokens),
    cacheReadTokens: readNumber(today.cache_read_tokens),
    requests: readNumber(today.requests),
  };
}

async function fetchUsage(profile: Profile): Promise<UsageResult | null> {
  if (!profile.apiKey) {
    return null;
  }
  const url = buildUsageUrl(profile.baseURL);
  if (!url) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return parseUsageResponse(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function prettifyBigNum(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${formatCompact(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${formatCompact(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${formatCompact(value / 1_000)}K`;
  return Math.round(value).toString();
}

function formatCompact(value: number): string {
  const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return fixed.replace(/\.0$/, "");
}

function formatCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toFixed(2)}`;
}

function formatSignedCost(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatCost(Math.abs(value))}`;
}

function formatTopCost(value: number): string {
  return `$${value.toFixed(1).padStart(5, " ")}`;
}

function formatSignedTopCost(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.min(Math.abs(value), usageTopMaxDisplayDelta - 0.1).toFixed(1)}`;
}

function formatUsage(result: UsageResult): string {
  return formatUsageColumns(result).join("  ");
}

function formatUsageColumns(result: UsageResult): string[] {
  return [
    colorCost(formatCost(result.used)),
    `${colorInput(prettifyBigNum(result.inputTokens))}↑`,
    `${colorOutput(prettifyBigNum(result.outputTokens))}↓`,
    `${textDim(prettifyBigNum(result.cacheReadTokens))}↻`,
    `${textDim(prettifyBigNum(result.requests))}⤨`,
  ];
}

async function formatProfileUsageColumns(profile: Profile): Promise<string[]> {
  if (!profile.apiKey || !profile.baseURL.trim()) {
    return [textDim("skipped"), "", "", "", ""];
  }

  const usage = await fetchUsage(profile);
  return usage ? formatUsageColumns(usage) : [textRed("unavailable"), "", "", "", ""];
}

async function printUsageLine(profile: Profile | null): Promise<void> {
  const time = formatClockTime(new Date());
  if (!profile?.apiKey || !profile.baseURL.trim()) {
    printKeyValue("usage:", `${textDim(time)} ${textDim("skipped")}`);
    return;
  }

  const usage = await fetchUsage(profile);
  printKeyValue("usage:", `${textDim(time)} ${usage ? formatUsage(usage) : textRed("unavailable")}`);
}

function formatClockTime(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatRelativeTime(date: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  const pad = (value: number): string => value.toString().padStart(2, " ");
  if (seconds < 60) return `${pad(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${pad(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${pad(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function askRequired(
  input: Prompt,
  label: string,
  current?: string,
): Promise<string> {
  const value = await askOptional(input, label, current);
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function askOptional(
  input: Prompt,
  label: string,
  current?: string,
): Promise<string> {
  const suffix = current ? ` [${label === "apiKey" ? maskSecret(current) : current}]` : "";
  const value = await input.question(`${label}${suffix}: `);
  return value || current || "";
}

type Prompt = {
  question(prompt: string): Promise<string>;
  close(): void;
};

function createPrompt(): Prompt {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const iterator = rl[Symbol.asyncIterator]();

  return {
    async question(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      const next = await iterator.next();
      return next.done ? "" : next.value;
    },
    close(): void {
      rl.close();
    },
  };
}

async function removeProfile(name: string): Promise<void> {
  if (!name) {
    throw new Error("usage: ccs remove NAME");
  }
  const data = await readProfiles();
  const profiles = data.profiles ?? {};
  if (!profiles[name]) {
    throw new Error(`profile not found: ${name}`);
  }
  delete profiles[name];
  const names = Object.keys(profiles);
  const current = data.current === name ? names[0] : data.current;
  const toggle = data.toggle?.filter((item) => item !== name);
  await writeProfiles({ ...data, profiles, current, toggle });
  console.log(`profile removed: ${textRed(name)}`);
}

async function removeUsageProfile(name: string): Promise<void> {
  if (!name) {
    throw new Error("usage: ccs usage remove NAME");
  }
  const data = await readProfiles();
  const usage = data.usage ?? {};
  if (!usage[name]) {
    throw new Error(`usage profile not found: ${name}`);
  }
  delete usage[name];
  await writeProfiles({ ...data, usage });
  console.log(`usage removed: ${textRed(name)}`);
}

async function switchProfile(name: string): Promise<Profile> {
  const data = await readProfiles();
  const profiles = data.profiles ?? {};
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`profile not found: ${name}`);
  }

  const normalized = assertProfile(profile, name);
  if (!normalized.apiKey) {
    throw new Error(`profile ${name} is missing apiKey`);
  }

  await ensureDir(codexDir());

  const currentConfig = (await readTextIfExists(codexConfigPath())) ?? "";
  const nextConfig = updateTomlBaseUrl(currentConfig, normalized.baseURL);
  await writeTextFile(codexConfigPath(), nextConfig);

  await writeTextFile(codexAuthPath(), stringifyJson({ OPENAI_API_KEY: normalized.apiKey }), 0o600);

  await writeProfiles({
    ...data,
    current: name,
    profiles,
  });

  printProfileDetails(name, normalized);
  return normalized;
}

async function printStatus(): Promise<Profile | null> {
  const profiles = await readProfiles();
  const current = profiles.current ?? "input";
  const profile = profiles.profiles?.[current];
  const systemLabel = formatSystemLabel();
  if (!profile) {
    printKeyValue("current:", `${textDim("none")}  ${colorHost(systemLabel)}`);
    printKeyValue("files:", `${colorPath(formatDisplayPath(profilesPath()))}  ${colorPath(formatDisplayPath(codexConfigPath()))}`);
    return null;
  }
  const normalized = assertProfile(profile, current);
  printKeyValue("current:", `${colorName(current)}  ${colorHost(systemLabel)}`);
  printKeyValue("api:", `${colorUrl(normalized.baseURL)}  ${formatApiKey(normalized.apiKey)}`);
  printKeyValue("files:", `${colorPath(formatDisplayPath(profilesPath()))}  ${colorPath(formatDisplayPath(codexConfigPath()))}`);
  return normalized;
}

type TableAlign = "left" | "right";

function alignTableCell(value: string, width: number, align: TableAlign): string {
  const padding = " ".repeat(Math.max(0, width - visibleLength(value)));
  return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}

function printTable(rows: string[][], aligns: TableAlign[] = []): void {
  const widths = rows[0]?.map((_, index) => (
    Math.max(...rows.map((row) => visibleLength(row[index] ?? "")))
  )) ?? [];

  for (const row of rows) {
    console.log(row.map((value, index) => (
      alignTableCell(value, widths[index] ?? 0, aligns[index] ?? "left")
    )).join("  ").trimEnd());
  }
}

async function printProfileList(profiles: ProfilesFile, includeUsage: boolean): Promise<void> {
  const entries = Object.entries(profiles.profiles ?? {});
  const current = profiles.current ?? "";
  const switchRows = await Promise.all(entries.map(async ([name, profile]) => ({
    name,
    profile,
    type: includeUsage ? textDim("codex") : "",
    marker: name === current ? textGreen("*") : "",
    usage: includeUsage ? await formatProfileUsageColumns(profile) : [],
  })));
  const usageRows = includeUsage
    ? await Promise.all(Object.entries(profiles.usage ?? {}).map(async ([name, profile]) => ({
      name,
      profile,
      type: textDim("usage"),
      marker: "",
      usage: await formatProfileUsageColumns(profile),
    })))
    : [];
  const rows = [...switchRows, ...usageRows];

  printTable(rows.map((row) => (
    [
      row.marker,
      ...(includeUsage ? [row.type] : []),
      colorName(row.name),
      colorUrl(row.profile.baseURL),
      row.profile.apiKey ? textDim(maskSecret(row.profile.apiKey)) : textDim("(empty)"),
      ...(includeUsage ? row.usage : []),
    ]
  )), includeUsage ? ["left", "left", "left", "left", "left", "right", "right", "right", "right", "right"] : []);
}

async function printUsageTargets(profiles: ProfilesFile): Promise<void> {
  const rows = await Promise.all(Object.entries(profiles.usage ?? {}).map(async ([name, profile]) => ({
    name,
    profile,
    usage: await formatProfileUsageColumns(profile),
  })));

  if (rows.length === 0) {
    console.log(textDim("no usage profiles"));
    return;
  }

  printTable(rows.map((row) => [
    colorName(row.name),
    colorUrl(row.profile.baseURL),
    row.profile.apiKey ? textDim(maskSecret(row.profile.apiKey)) : textDim("(empty)"),
    ...row.usage,
  ]), ["left", "left", "left", "right", "right", "right", "right", "right"]);
}

function collectUsageTopTargets(profiles: ProfilesFile): UsageTopTarget[] {
  return [
    ...Object.entries(profiles.profiles ?? {}).map(([name, profile]) => ({ name, profile })),
    ...Object.entries(profiles.usage ?? {}).map(([name, profile]) => ({ name, profile })),
  ];
}

async function readUsageTopEntry(target: UsageTopTarget, now: Date, nextRefreshAt: Date | null): Promise<UsageTopEntry> {
  const { name, profile } = target;
  if (!profile.apiKey || !profile.baseURL.trim()) {
    return {
      name,
      profile,
      usage: null,
      skipped: true,
      stale: false,
      nextRefreshAt: null,
      refreshIntervalMs: usageTopMinIntervalMs,
      maxIntervalIdleCount: 0,
      done: true,
      refreshing: false,
    };
  }
  return {
    name,
    profile,
    usage: await fetchUsage(profile),
    skipped: false,
    stale: false,
    nextRefreshAt,
    refreshIntervalMs: usageTopMinIntervalMs,
    maxIntervalIdleCount: 0,
    done: false,
    refreshing: false,
  };
}

async function readInitialUsageTopEntries(targets: UsageTopTarget[], once: boolean): Promise<UsageTopEntry[]> {
  const now = new Date();
  const nextRefreshAt = once ? null : new Date(now.getTime() + usageTopMinIntervalMs);
  return Promise.all(targets.map((target) => readUsageTopEntry(target, now, nextRefreshAt)));
}

async function createUsageTopRuntime(targets: UsageTopTarget[], once: boolean): Promise<UsageTopRuntime> {
  const entries = await readInitialUsageTopEntries(targets, once);
  const states = new Map<string, UsageTopState>();
  for (const entry of entries) {
    const state = states.get(entry.name) ?? {};
    updateUsageTopState(state, entry.usage, new Date());
    states.set(entry.name, state);
  }
  return { entries, states };
}

function formatUsageTopEntry(
  entry: UsageTopEntry,
  state: UsageTopState | undefined,
  now: Date,
): string {
  const { name, usage, skipped } = entry;
  if (skipped) {
    return `${formatTopName(name)} ${textDim("skipped")}`;
  }

  const delta = state?.delta;
  const changedAt = state?.changedAt;
  const shouldShowChange = delta !== undefined
    && changedAt !== undefined
    && now.getTime() - changedAt.getTime() < usageTopChangeTtlMs;
  const tags: string[] = [];
  if (shouldShowChange) {
    const age = now.getTime() - changedAt.getTime();
    const formattedDelta = formatSignedTopCost(delta);
    const coloredDelta = age < usageTopChangeColorTtlMs
      ? (delta >= 0 ? textRed(formattedDelta) : textGreen(formattedDelta))
      : textDim(formattedDelta);
    tags.push(`${coloredDelta} ${textDim(formatRelativeTime(changedAt, now))}`);
  }
  const used = usage?.used ?? state?.used;
  if (used === undefined) {
    return `${formatTopName(name)} ${textRed("unavailable")}`;
  }
  if (entry.stale) {
    tags.push(textRed("stale"));
  }
  if (entry.done) {
    tags.push(textDim("done"));
  }
  if (entry.nextRefreshAt) {
    tags.push(textDim(`r${formatCountdownSeconds(entry.nextRefreshAt, now)}`));
  }
  const status = tags.length > 0 ? `${textDim("(")}${tags.join(textDim(", "))}${textDim(")")}` : "";
  return `${formatTopName(name)} ${colorCost(formatTopCost(used))} ${padVisibleRight(status, usageTopStatusWidth)}`;
}

function padVisibleRight(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function padVisibleLeft(value: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - visibleLength(value)))}${value}`;
}

function formatTopName(name: string): string {
  return bgDarkBlue(` ${name} `);
}

function formatCountdownSeconds(date: Date, now: Date): string {
  const seconds = Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 1000));
  return `${seconds.toString().padStart(3, " ")}s`;
}

function nextUsageTopInterval(current: number, changed: boolean): number {
  if (changed) {
    return usageTopMinIntervalMs;
  }
  return Math.min(usageTopMaxIntervalMs, current + usageTopStepIntervalMs);
}

function nextUsageTopServerInterval(current: number, changed: boolean): number {
  if (changed) {
    return usageTopMinIntervalMs;
  }
  return usageTopServerIntervalsMs.find((interval) => interval > current)
    ?? usageTopServerIntervalsMs[usageTopServerIntervalsMs.length - 1];
}

function nextUsageTopRefreshInterval(current: number, changed: boolean, mode: UsageTopRefreshOptions["intervalMode"]): number {
  return mode === "server"
    ? nextUsageTopServerInterval(current, changed)
    : nextUsageTopInterval(current, changed);
}

function nextUsageTopMaxIdleCount(entry: UsageTopEntry, changed: boolean, nextInterval: number): number {
  if (changed) {
    return 0;
  }
  if (entry.refreshIntervalMs === usageTopMaxIntervalMs && nextInterval === usageTopMaxIntervalMs) {
    return entry.maxIntervalIdleCount + 1;
  }
  return 0;
}

async function refreshUsageTopEntries(
  entries: UsageTopEntry[],
  states: Map<string, UsageTopState>,
  options: UsageTopRefreshOptions,
): Promise<UsageTopEntry[]> {
  return Promise.all(entries.map(async (entry) => {
    if (entry.skipped) {
      return entry;
    }

    const refreshedAt = new Date();
    const nextEntry = await readUsageTopEntry(entry, refreshedAt, null);
    const state = states.get(entry.name) ?? {};
    const changed = updateUsageTopState(state, nextEntry.usage, refreshedAt);
    states.set(entry.name, state);
    const interval = options.resetInterval
      ? usageTopMinIntervalMs
      : nextUsageTopRefreshInterval(entry.refreshIntervalMs, changed, options.intervalMode);
    const maxIntervalIdleCount = options.resetInterval || !options.stopAtMaxIdle
      ? 0
      : nextUsageTopMaxIdleCount(entry, changed, interval);
    const done = options.stopAtMaxIdle
      && !options.resetInterval
      && maxIntervalIdleCount >= usageTopMaxIntervalIdleLimit;

    return {
      ...nextEntry,
      usage: nextEntry.usage ?? entry.usage,
      stale: nextEntry.usage ? false : entry.usage !== null,
      refreshIntervalMs: interval,
      maxIntervalIdleCount,
      done,
      nextRefreshAt: done ? null : new Date(Date.now() + interval),
    };
  }));
}

function updateUsageTopState(state: UsageTopState, usage: UsageResult | null, now: Date): boolean {
  if (!usage) {
    return false;
  }
  if (state.used === undefined) {
    state.used = usage.used;
    return false;
  }

  const delta = usage.used - state.used;
  if (Math.abs(delta) < 0.0000001) {
    return false;
  }

  state.used = usage.used;
  state.delta = delta;
  state.changedAt = now;
  return true;
}

async function refreshDueUsageTopRuntime(
  runtime: UsageTopRuntime,
  now: Date,
  stopAtMaxIdle: boolean,
  intervalMode: UsageTopRefreshOptions["intervalMode"],
): Promise<void> {
  const due = runtime.entries.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (
      !entry.done && entry.nextRefreshAt && !entry.refreshing && now >= entry.nextRefreshAt
    ));
  for (const { index } of due) {
    runtime.entries[index] = { ...runtime.entries[index], refreshing: true };
  }
  const refreshed = await refreshUsageTopEntries(due.map(({ entry }) => entry), runtime.states, {
    resetInterval: false,
    stopAtMaxIdle,
    intervalMode,
  });
  for (const [refreshedIndex, { index }] of due.entries()) {
    runtime.entries[index] = refreshed[refreshedIndex];
  }
}

async function refreshAllUsageTopRuntime(
  runtime: UsageTopRuntime,
  stopAtMaxIdle: boolean,
  intervalMode: UsageTopRefreshOptions["intervalMode"],
): Promise<void> {
  runtime.entries = await refreshUsageTopEntries(runtime.entries, runtime.states, {
    resetInterval: true,
    stopAtMaxIdle,
    intervalMode,
  });
}

function nextUsageTopRuntimeDelayMs(runtime: UsageTopRuntime, now: Date): number | null {
  const dueAt = runtime.entries
    .filter((entry) => !entry.done && entry.nextRefreshAt && !entry.refreshing)
    .map((entry) => entry.nextRefreshAt?.getTime() ?? Number.POSITIVE_INFINITY);
  if (dueAt.length === 0) {
    return null;
  }
  return Math.max(0, Math.min(...dueAt) - now.getTime());
}

function fitSingleTerminalLine(line: string): string {
  const columns = process.stdout.columns;
  if (!process.stdout.isTTY || !columns || visibleLength(line) < columns) {
    return line;
  }

  let visible = 0;
  let result = "";
  for (let index = 0; index < line.length && visible < columns - 1;) {
    const ansi = /^\u001b\[[0-9;]*m/.exec(line.slice(index));
    if (ansi) {
      result += ansi[0];
      index += ansi[0].length;
      continue;
    }
    result += line[index];
    visible += 1;
    index += 1;
  }

  return `${result}\u001b[0m`;
}

function buildUsageTopLine(
  entries: UsageTopEntry[],
  states: Map<string, UsageTopState>,
  now: Date,
): string {
  const parts = entries.map((entry) => (
    formatUsageTopEntry(entry, states.get(entry.name), now)
  ));
  return fitSingleTerminalLine(`${textDim(formatClockTime(now))} ${textDim("|")} ${parts.join(` ${textDim("|")} `)}`);
}

function readUsageTopCosts(entries: UsageTopEntry[]): Map<string, number> {
  const costs = new Map<string, number>();
  for (const entry of entries) {
    if (entry.usage) {
      costs.set(entry.name, entry.usage.used);
    }
  }
  return costs;
}

function formatTopMarkDelta(value: number): string {
  if (Math.abs(value) < 0.05) {
    return padVisibleLeft(textDim("-"), usageTopMarkDeltaWidth);
  }
  const formatted = formatSignedTopCost(value);
  return padVisibleLeft(value >= 0 ? textRed(formatted) : textGreen(formatted), usageTopMarkDeltaWidth);
}

function formatTopMarkName(name: string): string {
  return padVisibleRight(name, usageTopMarkNameWidth);
}

function formatUsageTopMarkLine(entries: UsageTopEntry[], previousCosts: Map<string, number>, now: Date): string {
  const parts = entries.map((entry) => {
    const used = entry.usage?.used;
    if (used === undefined) {
      return `${formatTopMarkName(entry.name)} ${padVisibleRight(entry.skipped ? "skipped" : "unavailable", visibleLength(formatTopCost(0)) + 1 + usageTopMarkDeltaWidth)}`;
    }
    const previous = previousCosts.get(entry.name);
    const delta = previous === undefined ? padVisibleLeft(textDim("-"), usageTopMarkDeltaWidth) : formatTopMarkDelta(used - previous);
    return `${formatTopMarkName(entry.name)} ${formatTopCost(used)} ${delta}`;
  });
  return `${formatClockTime(now)} ${textDim("|")} ${parts.join(` ${textDim("|")} `)}`;
}

function formatStatusLineCost(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function formatStatusLineDelta(value: number | undefined, changedAt: string | undefined, now: Date): string {
  if (value === undefined || Math.abs(value) < 0.05 || !changedAt) {
    return "";
  }

  const changed = new Date(changedAt);
  if (Number.isNaN(changed.getTime()) || now.getTime() - changed.getTime() >= usageTopChangeColorTtlMs) {
    return "";
  }

  return formatSignedTopCost(value).replace("$", "");
}

function formatStatusLineClock(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatStatusLineRefresh(snapshot: UsageTopSnapshot, now: Date): string {
  if (snapshot.paused) {
    return "paused";
  }
  const { entries } = snapshot;
  const dueAt = entries
    .map((entry) => entry.nextRefreshAt ? new Date(entry.nextRefreshAt).getTime() : Number.POSITIVE_INFINITY)
    .filter((value) => Number.isFinite(value));
  if (dueAt.length === 0) {
    return entries.length > 0 && entries.every((entry) => entry.done) ? "done" : "";
  }

  const seconds = Math.max(0, Math.ceil((Math.min(...dueAt) - now.getTime()) / 1000));
  return `r${seconds}s`;
}

function renderUsageTopStatusSuffix(snapshot: UsageTopSnapshot, stateNow: Date): string {
  const parts = snapshot.entries.map((entry) => {
    if (entry.skipped) {
      return `${entry.name} -`;
    }
    if (entry.used === undefined) {
      return `${entry.name} ?`;
    }
    const delta = formatStatusLineDelta(entry.delta, entry.changedAt, stateNow);
    const tags = [
      delta,
      entry.stale ? "stale" : "",
      entry.done ? "done" : "",
    ].filter(Boolean);
    return `${entry.name} ${formatStatusLineCost(entry.used)}${tags.length > 0 ? ` ${tags.join(" ")}` : ""}`;
  });
  const refresh = formatStatusLineRefresh(snapshot, stateNow);
  return `${refresh ? ` ${refresh}` : ""} | ${parts.join(" | ")}`;
}

function renderUsageTopStatusLine(snapshot: UsageTopSnapshot, displayNow: Date, stateNow: Date): string {
  return `${formatStatusLineClock(displayNow)}${renderUsageTopStatusSuffix(snapshot, stateNow)}`;
}

function usageTopSnapshotPath(): string {
  return join(codexToolsCacheDir(), "ccs-top-state.json");
}

function usageTopHistoryPath(): string {
  return join(codexToolsCacheDir(), "ccs-top-history.jsonl");
}

function usageTopStatusTextPath(): string {
  return join(codexToolsCacheDir(), "ccs-top-status.txt");
}

function toUsageTopSnapshotEntry(entry: UsageTopEntry, state: UsageTopState | undefined): UsageTopSnapshotEntry {
  const used = entry.usage?.used ?? state?.used;
  return {
    name: entry.name,
    used,
    delta: state?.delta,
    changedAt: state?.changedAt?.toISOString(),
    skipped: entry.skipped || undefined,
    unavailable: !entry.skipped && used === undefined ? true : undefined,
    stale: entry.stale || undefined,
    done: entry.done || undefined,
    nextRefreshAt: entry.nextRefreshAt?.toISOString(),
  };
}

function normalizeUsageTopSnapshot(value: unknown): UsageTopSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rawSnapshot = value as Partial<UsageTopSnapshot>;
  const entries = Array.isArray(rawSnapshot.entries)
    ? rawSnapshot.entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.name !== "string") {
        return [];
      }
      const raw = entry as UsageTopSnapshotEntry;
      return [{
        name: raw.name,
        used: typeof raw.used === "number" && Number.isFinite(raw.used) ? raw.used : undefined,
        delta: typeof raw.delta === "number" && Number.isFinite(raw.delta) ? raw.delta : undefined,
        changedAt: typeof raw.changedAt === "string" ? raw.changedAt : undefined,
        skipped: raw.skipped === true ? true : undefined,
        unavailable: raw.unavailable === true ? true : undefined,
        stale: raw.stale === true ? true : undefined,
        done: raw.done === true ? true : undefined,
        nextRefreshAt: typeof raw.nextRefreshAt === "string" ? raw.nextRefreshAt : undefined,
      }];
    })
    : null;
  if (
    rawSnapshot.version !== 1
    || typeof rawSnapshot.active !== "boolean"
    || typeof rawSnapshot.pid !== "number"
    || typeof rawSnapshot.updatedAt !== "string"
    || !entries
  ) {
    return null;
  }
  return {
    version: 1,
    active: rawSnapshot.active,
    pid: rawSnapshot.pid,
    updatedAt: rawSnapshot.updatedAt,
    paused: rawSnapshot.paused === true ? true : undefined,
    entries,
  };
}

function buildUsageTopSnapshot(
  entries: UsageTopEntry[],
  states: Map<string, UsageTopState>,
  now: Date,
  active: boolean,
  paused = false,
): UsageTopSnapshot {
  return {
    version: 1,
    active,
    pid: process.pid,
    updatedAt: now.toISOString(),
    paused: paused || undefined,
    entries: entries.map((entry) => toUsageTopSnapshotEntry(entry, states.get(entry.name))),
  };
}

async function writeUsageTopSnapshot(snapshot: UsageTopSnapshot): Promise<void> {
  const path = usageTopSnapshotPath();
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeTextFile(tmpPath, stringifyJson(snapshot));
  await rename(tmpPath, path);
}

function parseUsageTopSnapshot(text: string | null): UsageTopSnapshot | null {
  if (!text) {
    return null;
  }

  try {
    return normalizeUsageTopSnapshot(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

async function readUsageTopSnapshot(): Promise<UsageTopSnapshot | null> {
  return parseUsageTopSnapshot(await readTextIfExists(usageTopSnapshotPath()));
}

function usageTopSnapshotTime(snapshot: UsageTopSnapshot): Date | null {
  const at = new Date(snapshot.updatedAt);
  return Number.isNaN(at.getTime()) ? null : at;
}

function filterUsageTopHistoryRecords(records: UsageTopSnapshot[], now: Date): UsageTopSnapshot[] {
  const cutoff = now.getTime() - usageTopHistoryRetentionMs;
  return records
    .filter((record) => {
      const at = usageTopSnapshotTime(record);
      return at && at.getTime() >= cutoff && at.getTime() <= now.getTime();
    })
    .sort((left, right) => {
      const leftAt = usageTopSnapshotTime(left)?.getTime() ?? 0;
      const rightAt = usageTopSnapshotTime(right)?.getTime() ?? 0;
      return leftAt - rightAt;
    });
}

function parseUsageTopHistoryRecords(text: string | null): UsageTopSnapshot[] {
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !!line)
    .flatMap((line) => {
      const snapshot = parseUsageTopSnapshot(line);
      return snapshot ? [snapshot] : [];
    });
}

async function readUsageTopHistoryRecords(now = new Date()): Promise<UsageTopSnapshot[]> {
  return filterUsageTopHistoryRecords(
    parseUsageTopHistoryRecords(await readTextIfExists(usageTopHistoryPath())),
    now,
  );
}

async function writeUsageTopHistoryRecords(records: UsageTopSnapshot[]): Promise<void> {
  await writeTextFile(
    usageTopHistoryPath(),
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""),
  );
}

async function recordUsageTopHistorySnapshot(snapshot: UsageTopSnapshot): Promise<void> {
  if (!snapshot.active) {
    return;
  }
  const at = usageTopSnapshotTime(snapshot);
  if (!at) {
    return;
  }
  const records = filterUsageTopHistoryRecords([
    ...parseUsageTopHistoryRecords(await readTextIfExists(usageTopHistoryPath())),
    snapshot,
  ], at);
  await writeUsageTopHistoryRecords(records);
}

function buildUsageTopHistory(records: UsageTopSnapshot[], now: Date): UsageTopHistory {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    windowHours: usageTopHistoryWindowHours,
    bucketMinutes: usageTopHistoryBucketMinutes,
    records: filterUsageTopHistoryRecords(records, now),
  };
}

function normalizeUsageTopHistory(value: unknown): UsageTopHistory | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<UsageTopHistory>;
  if (
    raw.version !== 1
    || typeof raw.updatedAt !== "string"
    || typeof raw.windowHours !== "number"
    || typeof raw.bucketMinutes !== "number"
    || !Array.isArray(raw.records)
  ) {
    return null;
  }
  return {
    version: 1,
    updatedAt: raw.updatedAt,
    windowHours: raw.windowHours,
    bucketMinutes: raw.bucketMinutes,
    records: raw.records.flatMap((record) => {
      const snapshot = normalizeUsageTopSnapshot(record);
      return snapshot ? [snapshot] : [];
    }),
  };
}

function parseUsageTopHistory(text: string | null): UsageTopHistory | null {
  if (!text) {
    return null;
  }
  try {
    return normalizeUsageTopHistory(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

async function fetchUsageTopSnapshot(url: string): Promise<UsageTopSnapshot | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return parseUsageTopSnapshot(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUsageTopHistory(url: string): Promise<UsageTopHistory | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return parseUsageTopHistory(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function usageTopHistoryUrl(stateUrl: string): string {
  const url = new URL(stateUrl);
  url.pathname = url.pathname.endsWith("/ccs/top/state")
    ? url.pathname.replace(/\/ccs\/top\/state$/, "/ccs/top/history")
    : "/ccs/top/history";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function usageTopControlUrl(stateUrl: string, action: UsageTopControlAction): string {
  const url = new URL(stateUrl);
  url.pathname = url.pathname.endsWith("/ccs/top/state")
    ? url.pathname.replace(/\/ccs\/top\/state$/, `/ccs/top/${action}`)
    : `/ccs/top/${action}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function postUsageTopControl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function readUsageTopStateUrls(profiles: ProfilesFile): Promise<string[]> {
  const urls = (profiles.top?.stateUrls ?? [])
    .map((url) => url.trim())
    .filter((url) => !!url);
  return [...new Set(urls)];
}

function formatUsageTopControlAction(action: UsageTopControlAction): string {
  if (action === "pause") {
    return "paused";
  }
  if (action === "resume") {
    return "resumed";
  }
  return "reset";
}

async function controlUsageTopServer(profiles: ProfilesFile, action: UsageTopControlAction): Promise<void> {
  const urls = await readUsageTopStateUrls(profiles);
  if (urls.length === 0) {
    throw new Error("ccs s pause/resume/reset requires top.stateUrls");
  }
  for (const url of urls) {
    const controlUrl = usageTopControlUrl(url, action);
    if (await postUsageTopControl(controlUrl)) {
      console.log(`server ${formatUsageTopControlAction(action)}: ${textGreen(controlUrl)}`);
      return;
    }
  }
  throw new Error(`no configured ccs top server accepted ${action}`);
}

async function readUsageTopStatusSnapshot(profiles: ProfilesFile): Promise<UsageTopSnapshotSource | null> {
  for (const url of await readUsageTopStateUrls(profiles)) {
    const remote = await fetchUsageTopSnapshot(url);
    if (remote) {
      return { snapshot: remote, remote: true };
    }
  }
  const local = await readUsageTopSnapshot();
  return local ? { snapshot: local, remote: false } : null;
}

async function readUsageTopHistorySource(profiles: ProfilesFile): Promise<UsageTopHistorySource | null> {
  for (const url of await readUsageTopStateUrls(profiles)) {
    const historyUrl = usageTopHistoryUrl(url);
    const remote = await fetchUsageTopHistory(historyUrl);
    if (remote) {
      return { history: remote, source: historyUrl, remote: true };
    }
  }

  const now = new Date();
  const local = buildUsageTopHistory(await readUsageTopHistoryRecords(now), now);
  return local.records.length > 0
    ? { history: local, source: usageTopHistoryPath(), remote: false }
    : null;
}

function isUsageTopSnapshotActive(snapshot: UsageTopSnapshot, now: Date): boolean {
  if (!snapshot.active) {
    return false;
  }
  const updatedAt = new Date(snapshot.updatedAt);
  return !Number.isNaN(updatedAt.getTime()) && now.getTime() - updatedAt.getTime() < usageTopSnapshotActiveTtlMs;
}

async function readActiveUsageTopStatusSource(
  profiles: ProfilesFile,
  now: Date,
): Promise<{ snapshot: UsageTopSnapshot; stateNow: Date } | null> {
  const source = await readUsageTopStatusSnapshot(profiles);
  if (!source || (!source.remote && !isUsageTopSnapshotActive(source.snapshot, now)) || !source.snapshot.active) {
    return null;
  }

  const remoteUpdatedAt = new Date(source.snapshot.updatedAt);
  const stateNow = source.remote && !Number.isNaN(remoteUpdatedAt.getTime()) ? remoteUpdatedAt : now;
  return { snapshot: source.snapshot, stateNow };
}

async function renderCurrentUsageTopStatusSuffix(
  profiles: ProfilesFile,
  now: Date,
  inactiveLabel = "ccs top inactive",
): Promise<string> {
  const source = await readActiveUsageTopStatusSource(profiles, now);
  return source ? renderUsageTopStatusSuffix(source.snapshot, source.stateNow) : ` | ${inactiveLabel}`;
}

async function printUsageTopStatusLine(profiles: ProfilesFile): Promise<void> {
  const now = new Date();
  console.log(`${formatStatusLineClock(now)}${await renderCurrentUsageTopStatusSuffix(profiles, now)}`);
}

function formatHistoryTime(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatHistoryBucketWindow(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

function startOfHistoryDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatHistoryCost(value: number): string {
  return `$${value.toFixed(1)}`;
}

function formatHistorySignedCost(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatHistoryCost(Math.abs(value))}`;
}

function formatHistoryDeltaValue(value: number): string {
  const formatted = formatHistorySignedCost(Math.abs(value) < usageTopHistoryEpsilon ? 0 : value);
  if (Math.abs(value) < usageTopHistoryEpsilon) {
    return textDim(formatted);
  }
  return value >= 0 ? textRed(formatted) : textGreen(formatted);
}

function formatHistoryValue(value: number | undefined): string {
  return value === undefined ? textDim("n/a") : colorCost(formatHistoryCost(value));
}

function formatHistoryDeltaCell(delta: number | undefined, reset = false): string {
  if (reset) {
    return textDim("reset");
  }
  return delta === undefined ? textDim("n/a") : formatHistoryDeltaValue(delta);
}

function buildUsageTopPointMap(records: UsageTopSnapshot[]): Map<string, UsageTopPoint[]> {
  const map = new Map<string, UsageTopPoint[]>();
  for (const record of records) {
    const at = usageTopSnapshotTime(record);
    if (!at) {
      continue;
    }
    for (const entry of record.entries) {
      if (entry.used === undefined) {
        continue;
      }
      const points = map.get(entry.name) ?? [];
      points.push({ at, value: entry.used });
      map.set(entry.name, points);
    }
  }
  for (const points of map.values()) {
    points.sort((left, right) => left.at.getTime() - right.at.getTime());
  }
  return map;
}

function summarizeUsageTopHistory(name: string, points: UsageTopPoint[], windowStart: Date, now: Date): UsageTopSummary {
  const windowStartMs = windowStart.getTime();
  const windowPoints = [
    { at: windowStart, value: 0 },
    ...points.filter((point) => (
      point.at.getTime() > windowStartMs && point.at.getTime() <= now.getTime()
    )),
  ];
  if (windowPoints.length === 0) {
    return { name, reset: false, changes: 0 };
  }

  let reset = false;
  let changes = 0;
  let lastChangeAt: Date | undefined;
  let lastChangeDelta: number | undefined;
  let lastResetAt: Date | undefined;
  for (let index = 1; index < windowPoints.length; index += 1) {
    const delta = windowPoints[index].value - windowPoints[index - 1].value;
    if (delta < -usageTopHistoryEpsilon) {
      reset = true;
      lastResetAt = windowPoints[index].at;
      lastChangeAt = windowPoints[index].at;
      lastChangeDelta = undefined;
      continue;
    }
    if (delta > usageTopHistoryEpsilon) {
      changes += 1;
      lastChangeAt = windowPoints[index].at;
      lastChangeDelta = delta;
    }
  }

  const first = windowPoints[0]?.value;
  const latest = windowPoints[windowPoints.length - 1]?.value;
  return {
    name,
    first,
    latest,
    delta: first !== undefined && latest !== undefined && !reset ? latest - first : undefined,
    reset,
    changes,
    lastChangeAt,
    lastChangeDelta,
    lastResetAt,
  };
}

function findUsageTopPointAtOrBefore(points: UsageTopPoint[], atMs: number): UsageTopPoint | undefined {
  let found: UsageTopPoint | undefined;
  for (const point of points) {
    if (point.at.getTime() > atMs) {
      break;
    }
    found = point;
  }
  return found;
}

function findUsageTopDayPointAtOrBefore(points: UsageTopPoint[], atMs: number, windowStart: Date): UsageTopPoint | undefined {
  const found = findUsageTopPointAtOrBefore(points, atMs);
  if (found && found.at.getTime() >= windowStart.getTime()) {
    return found;
  }
  if (atMs >= windowStart.getTime()) {
    return { at: windowStart, value: 0 };
  }
  return found;
}

function buildUsageTopHistoryBuckets(
  pointMap: Map<string, UsageTopPoint[]>,
  names: string[],
  windowStart: Date,
  now: Date,
): UsageTopBucket[] {
  const nowMs = now.getTime();
  const windowStartMs = windowStart.getTime();
  const firstBucketStart = Math.floor(windowStartMs / usageTopHistoryBucketMs) * usageTopHistoryBucketMs;
  const buckets: UsageTopBucket[] = [];

  for (let startMs = firstBucketStart; startMs < nowMs; startMs += usageTopHistoryBucketMs) {
    const endMs = Math.min(startMs + usageTopHistoryBucketMs, nowMs);
    const deltas = new Map<string, UsageTopBucketDelta>();
    let total = 0;
    let hasTotal = false;
    let reset = false;
    for (const name of names) {
      const points = pointMap.get(name) ?? [];
      const startPoint = findUsageTopDayPointAtOrBefore(points, startMs, windowStart);
      const endPoint = findUsageTopDayPointAtOrBefore(points, endMs, windowStart);
      if (!startPoint || !endPoint) {
        deltas.set(name, { reset: false });
        continue;
      }
      const delta = endPoint.value - startPoint.value;
      if (delta < -usageTopHistoryEpsilon) {
        reset = true;
        deltas.set(name, { reset: true });
        continue;
      }
      const normalized = Math.abs(delta) < usageTopHistoryEpsilon ? 0 : delta;
      deltas.set(name, { delta: normalized, reset: false });
      total += normalized;
      hasTotal = true;
    }
    buckets.push({
      start: new Date(startMs),
      end: new Date(endMs),
      deltas,
      total: reset || !hasTotal ? undefined : total,
      reset,
    });
  }

  return buckets;
}

function formatHistoryLastChange(summary: UsageTopSummary): string {
  if (summary.lastChangeAt && summary.lastChangeDelta !== undefined) {
    return `${formatHistoryTime(summary.lastChangeAt)} ${formatHistorySignedCost(summary.lastChangeDelta)}`;
  }
  if (summary.lastResetAt) {
    return `${formatHistoryTime(summary.lastResetAt)} reset`;
  }
  return textDim("-");
}

function printUsageTopHistorySummary(summaries: UsageTopSummary[]): void {
  console.log();
  console.log(textBold("summary"));
  printTable([
    ["provider", "first", "now", "delta", "changes", "last change"],
    ...summaries.map((summary) => [
      colorName(summary.name),
      formatHistoryValue(summary.first),
      formatHistoryValue(summary.latest),
      formatHistoryDeltaCell(summary.delta, summary.reset),
      summary.changes.toString(),
      formatHistoryLastChange(summary),
    ]),
  ], ["left", "right", "right", "right", "right", "right"]);
}

function isUsageTopHistoryBucketEmpty(bucket: UsageTopBucket): boolean {
  if (bucket.reset || (bucket.total !== undefined && Math.abs(bucket.total) >= usageTopHistoryEpsilon)) {
    return false;
  }
  for (const delta of bucket.deltas.values()) {
    if (delta.reset || (delta.delta !== undefined && Math.abs(delta.delta) >= usageTopHistoryEpsilon)) {
      return false;
    }
  }
  return true;
}

function printUsageTopHistoryBuckets(buckets: UsageTopBucket[], names: string[]): void {
  console.log();
  console.log(textBold("bucket changes"));
  const firstVisibleBucketIndex = buckets.findIndex((bucket) => !isUsageTopHistoryBucketEmpty(bucket));
  if (firstVisibleBucketIndex < 0) {
    console.log(textDim("no bucket changes yet"));
    return;
  }
  const visibleBuckets = buckets.slice(firstVisibleBucketIndex);
  printTable([
    ["time", "total", ...names],
    ...visibleBuckets.map((bucket) => [
      `${formatHistoryTime(bucket.start)}-${formatHistoryTime(bucket.end)}`,
      formatHistoryDeltaCell(bucket.total, bucket.reset),
      ...names.map((name) => {
        const delta = bucket.deltas.get(name);
        return formatHistoryDeltaCell(delta?.delta, delta?.reset);
      }),
    ]),
  ], ["left", "right", ...names.map(() => "right" as TableAlign)]);
}

function printUsageTopHistoryPeakBuckets(buckets: UsageTopBucket[], names: string[]): void {
  const peaks = buckets
    .filter((bucket) => bucket.total !== undefined && bucket.total > usageTopHistoryEpsilon)
    .sort((left, right) => (right.total ?? 0) - (left.total ?? 0))
    .slice(0, usageTopHistoryPeakLimit);
  if (peaks.length === 0) {
    return;
  }

  console.log();
  console.log(textBold("peak buckets"));
  printTable([
    ["time", "total", "top contributors"],
    ...peaks.map((bucket) => {
      const contributors = names
        .map((name) => ({ name, delta: bucket.deltas.get(name)?.delta ?? 0 }))
        .filter((entry) => entry.delta > usageTopHistoryEpsilon)
        .sort((left, right) => right.delta - left.delta)
        .slice(0, 3)
        .map((entry) => `${entry.name} ${formatHistorySignedCost(entry.delta)}`)
        .join(", ");
      return [
        `${formatHistoryTime(bucket.start)}-${formatHistoryTime(bucket.end)}`,
        formatHistoryDeltaCell(bucket.total),
        contributors || textDim("-"),
      ];
    }),
  ], ["left", "right", "left"]);
}

function readUsageTopHistoryTotalAt(
  pointMap: Map<string, UsageTopPoint[]>,
  names: string[],
  atMs: number,
  windowStart: Date,
): number | null {
  let total = 0;
  let count = 0;
  for (const name of names) {
    const point = findUsageTopDayPointAtOrBefore(pointMap.get(name) ?? [], atMs, windowStart);
    if (!point) {
      continue;
    }
    total += point.value;
    count += 1;
  }
  return count > 0 ? total : null;
}

function buildUsageTopHistoryRawTotals(
  pointMap: Map<string, UsageTopPoint[]>,
  names: string[],
  windowStart: Date,
): UsageTopPoint[] {
  const times = [...new Set(names.flatMap((name) => (
    (pointMap.get(name) ?? []).map((point) => point.at.getTime())
  )))].filter((time) => time >= windowStart.getTime()).sort((left, right) => left - right);
  return [windowStart.getTime(), ...times].flatMap((time) => {
    const total = readUsageTopHistoryTotalAt(pointMap, names, time, windowStart);
    return total === null ? [] : [{ at: new Date(time), value: total }];
  });
}

function printUsageTopHistoryChart(
  pointMap: Map<string, UsageTopPoint[]>,
  names: string[],
  buckets: UsageTopBucket[],
  windowStart: Date,
  now: Date,
): void {
  const values = buckets.map((bucket) => readUsageTopHistoryTotalAt(pointMap, names, bucket.end.getTime(), windowStart));
  const firstValueIndex = values.findIndex((value) => value !== null);
  console.log();
  console.log(textBold("total trend"));
  const rawTotals = buildUsageTopHistoryRawTotals(pointMap, names, windowStart)
    .filter((point) => point.at.getTime() >= windowStart.getTime() && point.at.getTime() <= now.getTime());
  if ((firstValueIndex < 0 || values.length - firstValueIndex < 2) && rawTotals.length < 2) {
    console.log(textDim("not enough history yet"));
    return;
  }

  const useRawTotals = firstValueIndex < 0 || values.length - firstValueIndex < 2;
  let start: Date | undefined;
  let mid: Date | undefined;
  let end = now;
  const series = useRawTotals
    ? rawTotals.map((point, index) => {
      if (index === 0) {
        start = point.at;
      }
      if (index === Math.floor(rawTotals.length / 2)) {
        mid = point.at;
      }
      end = point.at;
      return point.value;
    })
    : (() => {
      let previous = values[firstValueIndex] ?? 0;
      start = buckets[firstValueIndex]?.start;
      mid = buckets[Math.floor((firstValueIndex + buckets.length - 1) / 2)]?.start;
      return values.slice(firstValueIndex).map((value) => {
        if (value !== null) {
          previous = value;
        }
        return previous;
      });
    })();
  console.log(asciichart.plot(series, {
    height: 8,
    format: (value) => `${formatHistoryCost(value).padStart(7)} `,
  }));
  console.log(textDim(`         ${start ? formatHistoryTime(start) : ""}     ${mid ? formatHistoryTime(mid) : ""}     ${formatHistoryTime(end)}`));
}

async function printUsageTopHistoryUnavailable(profiles: ProfilesFile): Promise<void> {
  const urls = await readUsageTopStateUrls(profiles);
  if (urls.length > 0) {
    console.log(textDim("ccs top history unavailable"));
    printKeyValue("source:", colorUrl(usageTopHistoryUrl(urls[0])), 7);
    if (urls.length > 1) {
      printKeyValue("also:", urls.slice(1).map((url) => colorUrl(usageTopHistoryUrl(url))).join("  "), 7);
    }
    printKeyValue("note:", "restart ccs s server with a version that serves /ccs/top/history", 5);
    return;
  }

  console.log(textDim("ccs top history inactive"));
  printKeyValue("source:", colorPath(usageTopHistoryPath()), 7);
  printKeyValue("note:", "start ccs s server to collect history; ccs s agent does not record history", 5);
}

function printUsageTopHistoryEmpty(source: UsageTopHistorySource, profileName: string | undefined, availableNames: string[]): void {
  if (profileName) {
    console.log(textDim(`no history for ${profileName}`));
    printKeyValue("source:", source.remote ? colorUrl(source.source) : colorPath(source.source), 7);
    if (availableNames.length > 0) {
      printKeyValue("profiles:", availableNames.join(", "), 9);
    }
    return;
  }

  console.log(textDim("ccs top history empty"));
  printKeyValue("source:", source.remote ? colorUrl(source.source) : colorPath(source.source), 7);
  printKeyValue("note:", "wait for ccs s server to write the first usage snapshot", 5);
}

async function printUsageTopHistory(profiles: ProfilesFile, profileName?: string): Promise<void> {
  const source = await readUsageTopHistorySource(profiles);
  if (!source) {
    await printUsageTopHistoryUnavailable(profiles);
    return;
  }

  const updatedAt = new Date(source.history.updatedAt);
  const now = Number.isNaN(updatedAt.getTime()) ? new Date() : updatedAt;
  const windowStart = startOfHistoryDay(now);
  const records = filterUsageTopHistoryRecords(source.history.records, now);
  const pointMap = buildUsageTopPointMap(records);
  const availableNames = [...pointMap.keys()].sort();
  const names = profileName ? availableNames.filter((name) => name === profileName) : availableNames;
  if (names.length === 0) {
    printUsageTopHistoryEmpty(source, profileName, availableNames);
    return;
  }

  const summaries = names
    .map((name) => summarizeUsageTopHistory(name, pointMap.get(name) ?? [], windowStart, now))
    .sort((left, right) => (right.delta ?? 0) - (left.delta ?? 0));
  const sortedNames = summaries.map((summary) => summary.name);
  const buckets = buildUsageTopHistoryBuckets(pointMap, sortedNames, windowStart, now);
  console.log(`ccs usage history  today  bucket ${formatHistoryBucketWindow(usageTopHistoryBucketMinutes)}`);
  printKeyValue("source:", source.remote ? colorUrl(source.source) : colorPath(source.source), 7);
  printUsageTopHistorySummary(summaries);
  printUsageTopHistoryChart(pointMap, sortedNames, buckets, windowStart, now);
  printUsageTopHistoryPeakBuckets(buckets, sortedNames);
  printUsageTopHistoryBuckets(buckets, sortedNames);
}

async function writeUsageTopStatusText(value: string): Promise<void> {
  const path = usageTopStatusTextPath();
  usageTopStatusWriteSequence += 1;
  const tmpPath = `${path}.${process.pid}.${usageTopStatusWriteSequence}.tmp`;
  try {
    await writeTextFile(tmpPath, value);
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function runUsageTopStatusAgent(profiles: ProfilesFile): Promise<void> {
  let stopped = false;

  const writeStatus = async (): Promise<void> => {
    const now = new Date();
    let line = `${formatStatusLineClock(now)} | ccs top unavailable`;
    try {
      line = `${formatStatusLineClock(now)}${await renderCurrentUsageTopStatusSuffix(profiles, now, "ccs top unavailable")}`;
      if (!stopped) {
        await writeUsageTopStatusText(line);
      }
    } catch {
      if (!stopped) {
        await writeUsageTopStatusText(line).catch(() => undefined);
      }
    }
    if (process.stdout.isTTY) {
      process.stdout.write(`\r\u001b[2K${line}`);
      return;
    }
    console.log(line);
  };

  await writeStatus();
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cleanedUp = false;
    const schedule = (): void => {
      if (cleanedUp) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        void (async () => {
          await writeStatus();
          schedule();
        })();
      }, usageTopTickMs);
    };
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      await writeUsageTopStatusText(`${formatStatusLineClock(new Date())} | ccs top inactive`).catch(() => undefined);
      if (process.stdout.isTTY) {
        process.stdout.write("\n");
      }
      resolve();
    };

    schedule();
    process.once("SIGINT", () => void cleanup());
    process.once("SIGTERM", () => void cleanup());
  });
}

function parseUsageTopServerPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid server port: ${value}`);
  }
  return port;
}

function sendUsageTopJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function serveUsageTop(profiles: ProfilesFile, portValue: string): Promise<void> {
  const host = "0.0.0.0";
  const port = parseUsageTopServerPort(portValue);
  const targets = collectUsageTopTargets(profiles);
  if (targets.length === 0) {
    throw new Error("ccs s server requires profiles");
  }

  const runtime = await createUsageTopRuntime(targets, false);
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cleanedUp = false;
  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const publish = async (active = true): Promise<void> => {
    snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), active, paused);
    await writeUsageTopSnapshot(snapshot);
    await recordUsageTopHistorySnapshot(snapshot);
  };
  const resetPolling = async (): Promise<void> => {
    clearTimer();
    await refreshAllUsageTopRuntime(runtime, false, "server");
    await publish();
    schedule();
  };
  const schedule = (): void => {
    if (cleanedUp || paused) {
      return;
    }
    clearTimer();
    const delay = nextUsageTopRuntimeDelayMs(runtime, new Date());
    if (delay === null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void (async () => {
        await refreshDueUsageTopRuntime(runtime, new Date(), false, "server");
        await publish();
        schedule();
      })();
    }, delay);
  };

  let snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), true, paused);
  await writeUsageTopSnapshot(snapshot);
  await recordUsageTopHistorySnapshot(snapshot);

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/health") {
      sendUsageTopJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && request.url === "/ccs/top/state") {
      snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), true, paused);
      sendUsageTopJson(response, 200, snapshot);
      return;
    }
    if (request.method === "GET" && request.url === "/ccs/top/history") {
      void (async () => {
        try {
          const now = new Date();
          sendUsageTopJson(response, 200, buildUsageTopHistory(await readUsageTopHistoryRecords(now), now));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendUsageTopJson(response, 500, { error: message });
        }
      })();
      return;
    }
    if (request.method === "POST" && request.url === "/ccs/top/pause") {
      void (async () => {
        paused = true;
        clearTimer();
        await publish();
        sendUsageTopJson(response, 200, { ok: true, paused });
      })();
      return;
    }
    if (request.method === "POST" && request.url === "/ccs/top/resume") {
      void (async () => {
        paused = false;
        await resetPolling();
        sendUsageTopJson(response, 200, { ok: true, paused });
      })();
      return;
    }
    if (request.method === "POST" && request.url === "/ccs/top/reset") {
      void (async () => {
        await resetPolling();
        sendUsageTopJson(response, 200, { ok: true, paused });
      })();
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      sendUsageTopJson(response, 405, { error: "method not allowed" });
      return;
    }
    sendUsageTopJson(response, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(`ccs top server: http://${host}:${port}/ccs/top/state`);

  await new Promise<void>((resolve) => {
    schedule();

    const cleanup = async (): Promise<void> => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      clearTimer();
      await publish(false);
      server.close(() => resolve());
    };

    process.once("SIGINT", () => void cleanup());
    process.once("SIGTERM", () => void cleanup());
  });
}

function parseUsageTopOptions(args: string[]): UsageTopOptions {
  const options: UsageTopOptions = {
    once: false,
    markIntervalMs: usageTopDefaultMarkIntervalMs,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--mark") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("usage: ccs top [--once] [--mark DURATION]");
      }
      options.markIntervalMs = parseDurationMs(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument for ccs top: ${arg}`);
  }

  return options;
}

async function printUsageTop(profiles: ProfilesFile, options: UsageTopOptions): Promise<void> {
  const targets = collectUsageTopTargets(profiles);
  if (targets.length === 0) {
    console.log(textDim("no profiles"));
    return;
  }

  const runtime = await createUsageTopRuntime(targets, options.once);
  let lastMarkAt = Date.now();
  let nextMarkAt = nextAlignedTimeMs(lastMarkAt, options.markIntervalMs);
  let lastMarkCosts = readUsageTopCosts(runtime.entries);

  const writeLine = async (): Promise<void> => {
    const now = new Date();
    const line = buildUsageTopLine(runtime.entries, runtime.states, now);
    if (options.once || !process.stdout.isTTY) {
      console.log(line);
      return;
    }
    process.stdout.write(`\r\u001b[2K${line}`);
    await writeUsageTopSnapshot(buildUsageTopSnapshot(runtime.entries, runtime.states, now, true));
  };

  const printMarkLine = (): void => {
    const now = new Date();
    const line = formatUsageTopMarkLine(runtime.entries, lastMarkCosts, now);
    lastMarkAt = now.getTime();
    nextMarkAt = nextAlignedTimeMs(lastMarkAt, options.markIntervalMs);
    lastMarkCosts = readUsageTopCosts(runtime.entries);
    if (process.stdout.isTTY) {
      process.stdout.write(`\r\u001b[2K${line}\n`);
      return;
    }
    console.log(line);
  };

  await writeLine();
  if (options.once) {
    return;
  }

  if (!process.stdout.isTTY) {
    throw new Error("ccs top requires a terminal unless --once is used");
  }

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void (async () => {
        const now = new Date();
        await refreshDueUsageTopRuntime(runtime, now, true, "top");
        if (now.getTime() >= nextMarkAt) {
          printMarkLine();
        }
        await writeLine();
      })();
    }, usageTopTickMs);

    const refreshAll = async (): Promise<void> => {
      await refreshAllUsageTopRuntime(runtime, true, "top");
      await writeLine();
    };

    let cleanedUp = false;
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      clearInterval(timer);
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      await writeUsageTopSnapshot(buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), false));
      process.stdout.write("\n");
      resolve();
    };

    const onData = (chunk: Buffer): void => {
      const value = chunk.toString("utf8");
      if (value === "r") {
        void refreshAll();
        return;
      }
      if (value === "q" || value === "\u0003") {
        void cleanup();
      }
    };

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    }

    process.once("SIGINT", () => void cleanup());
    process.once("SIGTERM", () => void cleanup());
  });
}

async function runCcsStatus(profiles: ProfilesFile, args: string[]): Promise<void> {
  const subcommand = args[0] ?? "";
  const subargs = args.slice(1);

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    assertExactArgs(subargs, "s help", 0);
    printHelp();
    return;
  }

  if (!subcommand) {
    assertExactArgs(subargs, "s", 0);
    await printUsageTopStatusLine(profiles);
    printStatusUsageHelp();
    return;
  }

  if (subcommand === "line") {
    assertExactArgs(subargs, "s line", 0);
    await printUsageTopStatusLine(profiles);
    return;
  }

  if (subcommand === "agent") {
    assertExactArgs(subargs, "s agent", 0);
    await runUsageTopStatusAgent(profiles);
    return;
  }

  if (subcommand === "server") {
    assertMaxArgs(subargs, "s server [PORT]", 1);
    await serveUsageTop(profiles, subargs[0] ?? "8765");
    return;
  }

  if (subcommand === "history") {
    assertMaxArgs(subargs, "s history [PROFILE]", 1);
    await printUsageTopHistory(profiles, subargs[0]);
    return;
  }

  if (subcommand === "pause" || subcommand === "resume" || subcommand === "reset") {
    assertExactArgs(subargs, `s ${subcommand}`, 0);
    await controlUsageTopServer(profiles, subcommand);
    return;
  }

  if (subcommand === "wezterm") {
    const options = parseWeztermArgs(subargs);
    const previewPlan = options.remove
      ? await buildWeztermRemovePreviewPlan()
      : await buildWeztermPreviewPlan();
    printPreviewPlan(previewPlan, true);
    if (!(await confirmApply())) {
      return;
    }

    const backupDir = await backupCcsFiles(previewPlan.backupFiles);
    const nextConfigText = previewPlan.previewFiles[0]?.next;
    if (nextConfigText !== undefined) {
      await writeTextFile(weztermConfigPath(), nextConfigText);
    }
    if (backupDir) {
      console.log(`backup: ${textBlue(backupDir)}`);
    }
    console.log(`wezterm config ${options.remove ? "updated" : "written"}: ${textGreen(weztermConfigPath())}`);
    return;
  }

  throw new Error(`unknown argument for ccs s: ${subcommand}`);
}

function usageLines(): string[] {
  return [
    "  ccs                                  # show current profile and usage",
    "  ccs PROFILE                          # show profile details and usage",
    "  ccs toggle [PROFILE]                 # switch profile",
    "  ccs top [--once] [--mark DURATION]   # show all usage costs with checkpoint lines",
    "  ccs config [push|pull]                # preview, confirm, and sync profiles.json with LAN server",
    "  ccs s [line]                         # print compact status from configured top state",
    "  ccs s agent                          # write local status text for WezTerm",
    "  ccs s server [PORT]                  # serve top state on 0.0.0.0",
    "  ccs s history [PROFILE]              # show today's usage history with hourly buckets",
    "  ccs s pause                          # pause first reachable configured top server",
    "  ccs s resume                         # resume first reachable configured top server",
    "  ccs s reset                          # refresh server now and reset polling to 25s",
    "  ccs s wezterm                        # preview, confirm, and install WezTerm status integration",
    "  ccs s wezterm remove                 # preview, confirm, and remove WezTerm status integration",
    "  ccs list | l [-u|--usage]             # list profiles; -u also shows usage profiles",
    "  ccs usage                            # list usage-only profiles",
    "  ccs usage add [PROFILE]               # add or update a usage-only profile",
    "  ccs usage remove | rm | delete PROFILE # remove a usage-only profile",
    "  ccs init                             # preview, confirm, and create config",
    "  ccs sync                             # preview, confirm, and sync config",
    "  ccs add [PROFILE]                     # add or update a profile",
    "  ccs remove | rm | delete PROFILE      # remove a profile",
  ];
}

function printHelp(): void {
  console.log([
    textBold("Usage:"),
    ...usageLines(),
  ].join("\n"));
}

function isHelpArgument(value: string | undefined): boolean {
  return value === "help" || value === "--help" || value === "-h";
}

function parseWeztermArgs(args: string[]): WeztermOptions {
  rejectRemovedYesFlags(args, "ccs s wezterm");
  let remove = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "remove") {
      remove = true;
      continue;
    }
    throw new Error(`unknown argument for ccs s wezterm: ${arg}`);
  }
  return { remove };
}

function printUsageHelp(): void {
  console.log(textDim("commands: ccs | PROFILE | [toggle|add|rm] [PROFILE] | top | config [push|pull] | s [line|agent|server|history|pause|resume|reset|wezterm] | list [-u] | usage | init | sync"));
}

function printStatusUsageHelp(): void {
  console.log(textDim("commands: ccs s [line|agent|server|history|pause|resume|reset|wezterm]"));
}

export async function runCcs(argv: string[]): Promise<void> {
  const command = argv[0] ?? "";
  const args = argv.slice(1);

  if (isHelpArgument(command)) {
    printHelp();
    return;
  }

  if (command === "config") {
    await runConfigSync(args);
    return;
  }

  const profiles = await readProfiles();

  if (!command) {
    const profile = await printStatus();
    await printUsageLine(profile);
    printUsageHelp();
    return;
  }

  if (command === "init") {
    rejectRemovedYesFlags(args, "ccs init");
    assertExactArgs(args, "init", 0);
    const previewPlan = await buildInitPreviewPlan();
    printPreviewPlan(previewPlan, true);
    if (!(await confirmApply())) {
      return;
    }
    const backupDir = await backupCcsFiles(previewPlan.backupFiles);
    const initialized = await initProfilesFromCurrent();
    await syncCodexConfigFromTemplate();
    await syncCodexAgentsFromTemplate();
    const profile = initialized.profiles?.[initialized.current ?? ""];
    if (profile?.apiKey) {
      await writeTextFile(codexAuthPath(), stringifyJson({ OPENAI_API_KEY: profile.apiKey }), 0o600);
    }
    if (backupDir) {
      console.log(`backup: ${textBlue(backupDir)}`);
    }
    console.log(`profiles written: ${textGreen(profilesPath())}`);
    console.log(`codex config synced: ${textGreen(codexConfigPath())}`);
    console.log(`codex agents synced: ${textGreen(codexAgentsPath())}`);
    return;
  }

  if (command === "sync") {
    rejectRemovedYesFlags(args, "ccs sync");
    assertExactArgs(args, "sync", 0);
    const previewPlan = await buildSyncPreviewPlan();
    printPreviewPlan(previewPlan, true);
    if (!(await confirmApply())) {
      return;
    }
    const backupDir = await backupCcsFiles(previewPlan.backupFiles);
    const synced = await syncProfiles();
    await syncCodexConfigFromTemplate();
    await syncCodexAgentsFromTemplate();
    if (backupDir) {
      console.log(`backup: ${textBlue(backupDir)}`);
    }
    console.log(`profiles synced: ${textGreen(profilesPath())}`);
    console.log(`codex config synced: ${textGreen(codexConfigPath())}`);
    console.log(`codex agents synced: ${textGreen(codexAgentsPath())}`);
    for (const name of Object.keys(synced.profiles ?? {})) {
      console.log(`  ${textBlue(name)}`);
    }
    return;
  }

  if (command === "list" || command === "l") {
    const unknown = args.find((arg) => arg !== "--usage" && arg !== "-u");
    if (unknown) {
      throw new Error(`unknown argument for ccs list: ${unknown}`);
    }
    await printProfileList(profiles, args.some((arg) => arg === "--usage" || arg === "-u"));
    return;
  }

  if (command === "top") {
    if (isHelpArgument(args[0])) {
      assertExactArgs(args.slice(1), "top help", 0);
      printHelp();
      return;
    }
    await printUsageTop(profiles, parseUsageTopOptions(args));
    return;
  }

  if (command === "s") {
    await runCcsStatus(profiles, args);
    return;
  }

  if (command === "add") {
    assertMaxArgs(args, "add [PROFILE]", 1);
    if (args[0]?.startsWith("-")) {
      throw new Error(`unknown argument for ccs add: ${args[0]}`);
    }
    await addProfile(args[0]);
    return;
  }

  if (command === "usage") {
    const subcommand = args[0] ?? "";
    const subargs = args.slice(1);

    if (!subcommand) {
      await printUsageTargets(profiles);
      return;
    }

    if (subcommand === "add") {
      assertMaxArgs(subargs, "usage add [PROFILE]", 1);
      if (subargs[0]?.startsWith("-")) {
        throw new Error(`unknown argument for ccs usage add: ${subargs[0]}`);
      }
      await addUsageProfile(subargs[0]);
      return;
    }

    if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
      assertExactArgs(subargs, `usage ${subcommand} PROFILE`, 1);
      await removeUsageProfile(subargs[0]);
      return;
    }

    throw new Error(`unknown argument for ccs usage: ${subcommand}`);
  }

  if (command === "remove" || command === "rm" || command === "delete") {
    assertExactArgs(args, `${command} PROFILE`, 1);
    await removeProfile(args[0]);
    return;
  }

  if (command === "toggle") {
    assertMaxArgs(args, "toggle [PROFILE]", 1);
    if (args[0]) {
      if (args[0].startsWith("-")) {
        throw new Error(`unknown argument for ccs toggle: ${args[0]}`);
      }
      const profile = await switchProfile(args[0]);
      await printUsageLine(profile);
      return;
    }

    const toggle = profiles.toggle ?? [];
    if (toggle.length < 2) {
      throw new Error("toggle requires at least two profile names in profiles.json toggle");
    }
    const index = Math.max(0, toggle.indexOf(profiles.current ?? ""));
    const next = toggle[(index + 1) % toggle.length];
    const profile = await switchProfile(next);
    await printUsageLine(profile);
    return;
  }

  if (profiles.profiles?.[command]) {
    assertExactArgs(args, command, 0);
    printProfile(command, profiles);
    await printUsageLine(assertProfile(profiles.profiles[command], command));
    return;
  }

  console.error(`${textRed("unknown command:")} ${basename(command)}`);
  process.exitCode = 1;
}
