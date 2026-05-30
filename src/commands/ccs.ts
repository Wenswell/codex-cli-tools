import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as asciichart from "asciichart";
import { createTwoFilesPatch } from "diff";
import { DateTime } from "luxon";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import {
  aggregateDaily,
  aggregateDayProjects,
  aggregateDayTimeBuckets,
  aggregateMonthly,
  aggregateProjectDaily,
  aggregateProjects,
  aggregateWeekly,
  dateRangeForDay,
  filterCodexUsageEvents,
  formatProjectPath,
  loadCodexUsageEvents,
  resolveProjectPath,
  sortRowsByCost,
  systemTimezone,
  totalAggregate,
  type CodexUsageAggregate,
  type CodexUsageEvent,
  type CodexUsageRange,
  type CodexUsageRow,
} from "../lib/codex-usage.js";
import { ensureDir, readTextIfExists, writeTextFile } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import {
  codexAgentsPath,
  codexAuthPath,
  codexConfigPath,
  codexDir,
  codexToolsCacheDir,
  modelPricesCachePath,
  codexToolsConfigDir,
  profilesPath,
  weztermConfigPath,
} from "../lib/paths.js";
import {
  calculateCodexCostUSD,
  missingPricingModels,
  readModelPriceCache,
  resolveCodexCostSpeed,
  type CodexCostSpeed,
  type ModelPriceCache,
  type ResolvedCodexCostSpeed,
} from "../lib/pricing.js";
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

type UsageTopHistoryRequest = {
  windowStart: Date;
  windowEnd?: Date;
  bucketMinutes: number;
  profileName?: string;
};

type UsageTopHistorySummaryRecord = {
  name: string;
  first?: number;
  latest?: number;
  delta?: number;
  reset: boolean;
  changes: number;
  lastChangeAt?: string;
  lastChangeDelta?: number;
  lastResetAt?: string;
};

type UsageTopHistoryBucketDeltaRecord = {
  name: string;
  delta?: number;
  reset: boolean;
};

type UsageTopHistoryBucketRecord = {
  start: string;
  end: string;
  deltas: UsageTopHistoryBucketDeltaRecord[];
  total?: number;
  reset: boolean;
};

type UsageTopHistoryPointRecord = {
  at: string;
  value: number;
};

type UsageTopHistorySeriesRecord = {
  name: string;
  points: UsageTopHistoryPointRecord[];
};

type UsageTopHistory = {
  version: 2;
  updatedAt: string;
  windowStart: string;
  windowEnd: string;
  bucketMinutes: number;
  names: string[];
  availableNames: string[];
  summaries: UsageTopHistorySummaryRecord[];
  series: UsageTopHistorySeriesRecord[];
  buckets: UsageTopHistoryBucketRecord[];
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

type UsageTopSeries = {
  name: string;
  points: UsageTopPoint[];
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

type UsageTopRecentDelta = {
  delta: number;
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
  900_000,
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
const usageTopHistoryBucketMs = 30 * 60 * 1000;
const usageTopHistoryRetentionMs = usageTopHistoryWindowMs + usageTopHistoryBucketMs;
const usageTopHistoryBucketMinutes = usageTopHistoryBucketMs / (60 * 1000);
const usageTopHistorySummaryDeltaMs = 5 * 60 * 60 * 1000;
const usageTopHistoryEpsilon = 0.05;
const usageTopHistoryChartMinWidth = 56;
const usageTopHistoryChartMinIntervals = 3;
const usageTopHistoryChartMaxIntervals = 6;
const usageTopHistoryChartTargetIntervals = 5;
const usageTopHistoryChartAxisPrefix = 9;
const usageTopHistoryChartSummaryGap = 4;
const usageTopHistoryChartNamedProviderLimit = 2;
const usageTopHistoryOtherName = "other";
const usageTopHttpTimeoutMs = 1_500;
const usageTopHistoryHttpTimeoutMs = 3_000;
const ccsCostReportHttpTimeoutMs = 30_000;
const ccsCostRefreshHttpTimeoutMs = 5_000;
const ccsCostRefreshDebounceMs = 5 * 60 * 1000;
let usageTopStatusWriteSequence = 0;
const configSyncUser = "ravvss";
const configSyncHost = "10.126.126.1";
const configSyncPort = "32753";
const configSyncRemotePath = "/home/ravvss/.config/codex-tools/profiles.json";
const configSyncRemoteDisplay = `${configSyncUser}@${configSyncHost}:${configSyncRemotePath}`;
const ccsCostRemoteDir = "/home/ravvss/.cache/codex-tools/ccs-cost";
const ccsCostRemoteDisplay = `${configSyncUser}@${configSyncHost}:${ccsCostRemoteDir}`;
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

async function runCodexWithProfile(profiles: ProfilesFile, name: string | undefined, codexArgs: string[]): Promise<void> {
  if (!name || name.startsWith("-")) {
    throw new Error("usage: ccs run PROFILE [CODEX_ARGS...]");
  }

  const profile = profiles.profiles?.[name];
  if (!profile) {
    throw new Error(`profile not found: ${name}`);
  }
  const normalized = assertProfile(profile, name);
  if (!normalized.apiKey) {
    throw new Error(`profile ${name} is missing apiKey`);
  }

  const currentConfig = (await readTextIfExists(codexConfigPath())) ?? "";
  const provider = readTopLevelTomlString(currentConfig, "model_provider") ?? "codex";
  const apiKeyEnv = "CCS_RUN_OPENAI_API_KEY";
  const args = [
    "-c",
    `model_providers.${provider}.base_url=${JSON.stringify(normalized.baseURL)}`,
    "-c",
    `model_providers.${provider}.env_key=${JSON.stringify(apiKeyEnv)}`,
    ...codexArgs,
  ];

  printProfileSummary("run", name, normalized);
  printKeyValue("mode:", "temporary codex launch; no files changed", 5);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("codex", args, {
      stdio: "inherit",
      env: {
        ...process.env,
        [apiKeyEnv]: normalized.apiKey,
      },
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.exitCode = 1;
        resolve();
        return;
      }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
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

function formatTableRows(rows: string[][], aligns: TableAlign[] = []): string[] {
  const widths = rows[0]?.map((_, index) => (
    Math.max(...rows.map((row) => visibleLength(row[index] ?? "")))
  )) ?? [];

  return rows.map((row) => (
    row.map((value, index) => (
      alignTableCell(value, widths[index] ?? 0, aligns[index] ?? "left")
    )).join("  ").trimEnd()
  ));
}

function printTable(rows: string[][], aligns: TableAlign[] = []): void {
  for (const row of formatTableRows(rows, aligns)) {
    console.log(row);
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

function ccsCostSnapshotDir(): string {
  return join(codexToolsCacheDir(), "ccs-cost");
}

function ccsCostDerivedPath(): string {
  return join(codexToolsCacheDir(), "ccs-cost-derived.json");
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

function buildUsageTopHistory(records: UsageTopSnapshot[], request: UsageTopHistoryRequest): UsageTopHistory {
  const windowEnd = request.windowEnd ?? new Date();
  const bucketMs = request.bucketMinutes * 60 * 1000;
  const filteredRecords = filterUsageTopHistoryRecords(records, windowEnd).filter((record) => {
    const at = usageTopSnapshotTime(record);
    return at && at.getTime() >= request.windowStart.getTime() && at.getTime() <= windowEnd.getTime();
  });
  const pointMap = buildUsageTopPointMap(filteredRecords);
  const availableNames = [...pointMap.keys()].sort();
  const names = request.profileName
    ? availableNames.filter((name) => name === request.profileName)
    : availableNames;
  const summaries = names
    .map((name) => summarizeUsageTopHistory(name, pointMap.get(name) ?? [], request.windowStart, windowEnd))
    .sort((left, right) => (right.delta ?? 0) - (left.delta ?? 0));
  const sortedNames = summaries.map((summary) => summary.name);
  const buckets = buildUsageTopHistoryBuckets(pointMap, sortedNames, request.windowStart, windowEnd, bucketMs);
  const series = buildUsageTopHistorySeries(pointMap, sortedNames, buckets, request.windowStart);

  return {
    version: 2,
    updatedAt: windowEnd.toISOString(),
    windowStart: request.windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    bucketMinutes: request.bucketMinutes,
    names: sortedNames,
    availableNames,
    summaries: summaries.map(toUsageTopHistorySummaryRecord),
    series: series.map(toUsageTopHistorySeriesRecord),
    buckets: buckets.map((bucket) => toUsageTopHistoryBucketRecord(bucket, sortedNames)),
  };
}

function isUsageTopNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInvalidOptionalUsageTopNumber(value: unknown): boolean {
  return value !== undefined && !isUsageTopNumber(value);
}

function isInvalidOptionalUsageTopString(value: unknown): boolean {
  return value !== undefined && typeof value !== "string";
}

function normalizeUsageTopStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return null;
  }
  return value;
}

function normalizeUsageTopHistorySummaryRecord(value: unknown): UsageTopHistorySummaryRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<UsageTopHistorySummaryRecord>;
  const changes = raw.changes;
  if (
    typeof raw.name !== "string"
    || typeof raw.reset !== "boolean"
    || changes === undefined
    || !Number.isInteger(changes)
    || changes < 0
    || isInvalidOptionalUsageTopNumber(raw.first)
    || isInvalidOptionalUsageTopNumber(raw.latest)
    || isInvalidOptionalUsageTopNumber(raw.delta)
    || isInvalidOptionalUsageTopNumber(raw.lastChangeDelta)
    || isInvalidOptionalUsageTopString(raw.lastChangeAt)
    || isInvalidOptionalUsageTopString(raw.lastResetAt)
  ) {
    return null;
  }
  return {
    name: raw.name,
    first: raw.first,
    latest: raw.latest,
    delta: raw.delta,
    reset: raw.reset,
    changes,
    lastChangeAt: raw.lastChangeAt,
    lastChangeDelta: raw.lastChangeDelta,
    lastResetAt: raw.lastResetAt,
  };
}

function normalizeUsageTopHistoryBucketDeltaRecord(value: unknown): UsageTopHistoryBucketDeltaRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<UsageTopHistoryBucketDeltaRecord>;
  if (
    typeof raw.name !== "string"
    || typeof raw.reset !== "boolean"
    || isInvalidOptionalUsageTopNumber(raw.delta)
  ) {
    return null;
  }
  return {
    name: raw.name,
    delta: raw.delta,
    reset: raw.reset,
  };
}

function normalizeUsageTopHistoryBucketRecord(value: unknown): UsageTopHistoryBucketRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<UsageTopHistoryBucketRecord>;
  if (
    typeof raw.start !== "string"
    || typeof raw.end !== "string"
    || typeof raw.reset !== "boolean"
    || isInvalidOptionalUsageTopNumber(raw.total)
    || !Array.isArray(raw.deltas)
  ) {
    return null;
  }
  const deltas = raw.deltas.map(normalizeUsageTopHistoryBucketDeltaRecord);
  if (deltas.some((delta) => !delta)) {
    return null;
  }
  return {
    start: raw.start,
    end: raw.end,
    deltas: deltas as UsageTopHistoryBucketDeltaRecord[],
    total: raw.total,
    reset: raw.reset,
  };
}

function normalizeUsageTopHistoryPointRecord(value: unknown): UsageTopHistoryPointRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<UsageTopHistoryPointRecord>;
  if (typeof raw.at !== "string" || !isUsageTopNumber(raw.value)) {
    return null;
  }
  return {
    at: raw.at,
    value: raw.value,
  };
}

function normalizeUsageTopHistorySeriesRecord(value: unknown): UsageTopHistorySeriesRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<UsageTopHistorySeriesRecord>;
  if (typeof raw.name !== "string" || !Array.isArray(raw.points)) {
    return null;
  }
  const points = raw.points.map(normalizeUsageTopHistoryPointRecord);
  if (points.some((point) => !point)) {
    return null;
  }
  return {
    name: raw.name,
    points: points as UsageTopHistoryPointRecord[],
  };
}

function normalizeUsageTopHistory(value: unknown): UsageTopHistory | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<UsageTopHistory>;
  const names = normalizeUsageTopStringArray(raw.names);
  const availableNames = normalizeUsageTopStringArray(raw.availableNames);
  if (
    raw.version !== 2
    || typeof raw.updatedAt !== "string"
    || typeof raw.windowStart !== "string"
    || typeof raw.windowEnd !== "string"
    || !isUsageTopNumber(raw.bucketMinutes)
    || !names
    || !availableNames
    || !Array.isArray(raw.summaries)
    || !Array.isArray(raw.series)
    || !Array.isArray(raw.buckets)
  ) {
    return null;
  }
  const summaries = raw.summaries.map(normalizeUsageTopHistorySummaryRecord);
  const series = raw.series.map(normalizeUsageTopHistorySeriesRecord);
  const buckets = raw.buckets.map(normalizeUsageTopHistoryBucketRecord);
  if (
    summaries.some((summary) => !summary)
    || series.some((item) => !item)
    || buckets.some((bucket) => !bucket)
  ) {
    return null;
  }
  return {
    version: 2,
    updatedAt: raw.updatedAt,
    windowStart: raw.windowStart,
    windowEnd: raw.windowEnd,
    bucketMinutes: raw.bucketMinutes,
    names,
    availableNames,
    summaries: summaries as UsageTopHistorySummaryRecord[],
    series: series as UsageTopHistorySeriesRecord[],
    buckets: buckets as UsageTopHistoryBucketRecord[],
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
  const timeout = setTimeout(() => controller.abort(), usageTopHttpTimeoutMs);
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
  const timeout = setTimeout(() => controller.abort(), usageTopHistoryHttpTimeoutMs);
  let text = "";
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    text = await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
  const history = parseUsageTopHistory(text);
  if (!history) {
    throw new Error(`invalid ccs top history response from ${url}; expected version 2 series payload`);
  }
  return history;
}

function buildUsageTopHistoryRequest(profileName?: string): UsageTopHistoryRequest {
  return {
    windowStart: startOfHistoryDay(new Date()),
    bucketMinutes: usageTopHistoryBucketMinutes,
    profileName,
  };
}

function usageTopHistoryUrl(stateUrl: string, request?: UsageTopHistoryRequest): string {
  const url = new URL(stateUrl);
  url.pathname = url.pathname.endsWith("/ccs/top/state")
    ? url.pathname.replace(/\/ccs\/top\/state$/, "/ccs/top/history")
    : "/ccs/top/history";
  url.search = "";
  url.hash = "";
  if (request) {
    url.searchParams.set("since", request.windowStart.toISOString());
    url.searchParams.set("bucketMinutes", request.bucketMinutes.toString());
    if (request.windowEnd) {
      url.searchParams.set("until", request.windowEnd.toISOString());
    }
    if (request.profileName) {
      url.searchParams.set("profile", request.profileName);
    }
  }
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
  const timeout = setTimeout(() => controller.abort(), usageTopHttpTimeoutMs);
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

async function readUsageTopHistorySource(
  profiles: ProfilesFile,
  request: UsageTopHistoryRequest,
): Promise<UsageTopHistorySource | null> {
  for (const url of await readUsageTopStateUrls(profiles)) {
    const historyUrl = usageTopHistoryUrl(url, request);
    const remote = await fetchUsageTopHistory(historyUrl);
    if (remote) {
      return { history: remote, source: historyUrl, remote: true };
    }
  }

  const windowEnd = request.windowEnd ?? new Date();
  const local = buildUsageTopHistory(await readUsageTopHistoryRecords(windowEnd), { ...request, windowEnd });
  return local.availableNames.length > 0
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

function endOfHistoryDay(date: Date): Date {
  const start = startOfHistoryDay(date);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
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
  bucketMs = usageTopHistoryBucketMs,
): UsageTopBucket[] {
  const nowMs = now.getTime();
  const windowStartMs = windowStart.getTime();
  const firstBucketStart = Math.floor(windowStartMs / bucketMs) * bucketMs;
  const buckets: UsageTopBucket[] = [];

  for (let startMs = firstBucketStart; startMs < nowMs; startMs += bucketMs) {
    const endMs = Math.min(startMs + bucketMs, nowMs);
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

function toUsageTopHistorySummaryRecord(summary: UsageTopSummary): UsageTopHistorySummaryRecord {
  return {
    name: summary.name,
    first: summary.first,
    latest: summary.latest,
    delta: summary.delta,
    reset: summary.reset,
    changes: summary.changes,
    lastChangeAt: summary.lastChangeAt?.toISOString(),
    lastChangeDelta: summary.lastChangeDelta,
    lastResetAt: summary.lastResetAt?.toISOString(),
  };
}

function toUsageTopHistoryBucketRecord(bucket: UsageTopBucket, names: string[]): UsageTopHistoryBucketRecord {
  return {
    start: bucket.start.toISOString(),
    end: bucket.end.toISOString(),
    total: bucket.total,
    reset: bucket.reset,
    deltas: names.map((name) => {
      const delta = bucket.deltas.get(name);
      return {
        name,
        delta: delta?.delta,
        reset: delta?.reset ?? false,
      };
    }),
  };
}

function toUsageTopHistoryPointRecord(point: UsageTopPoint): UsageTopHistoryPointRecord {
  return {
    at: point.at.toISOString(),
    value: point.value,
  };
}

function toUsageTopHistorySeriesRecord(series: UsageTopSeries): UsageTopHistorySeriesRecord {
  return {
    name: series.name,
    points: series.points.map(toUsageTopHistoryPointRecord),
  };
}

function formatHistoryLastChangeTime(summary: UsageTopSummary): string {
  const at = summary.lastChangeAt ?? summary.lastResetAt;
  return at ? formatHistoryTime(at) : textDim("-");
}

function formatHistoryLastChangeDelta(summary: UsageTopSummary): string {
  if (summary.lastChangeDelta !== undefined) {
    return formatHistorySignedCost(summary.lastChangeDelta);
  }
  if (summary.lastResetAt) {
    return textDim("reset");
  }
  return textDim("-");
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

function formatUsageTopHistoryBucketRow(bucket: UsageTopBucket, names: string[]): string[] {
  return [
    `${formatHistoryTime(bucket.start)}-${formatHistoryTime(bucket.end)}`,
    formatHistoryDeltaCell(bucket.total, bucket.reset),
    ...names.map((name) => {
      const delta = bucket.deltas.get(name);
      return formatHistoryDeltaCell(delta?.delta, delta?.reset);
    }),
  ];
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
  const columns = ["time", "total", ...names];
  const emptyColumns = columns.map(() => "");
  const rows: string[][] = [];
  for (let index = 0; index < visibleBuckets.length; index += 2) {
    const left = formatUsageTopHistoryBucketRow(visibleBuckets[index], names);
    const right = visibleBuckets[index + 1]
      ? formatUsageTopHistoryBucketRow(visibleBuckets[index + 1], names)
      : emptyColumns;
    rows.push([...left, "|", ...right]);
  }
  printTable([
    [...columns, "|", ...columns],
    ...rows,
  ], [
    "left",
    "right",
    ...names.map(() => "right" as TableAlign),
    "left",
    "left",
    "right",
    ...names.map(() => "right" as TableAlign),
  ]);
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

function usageTopHistoryChartGroups(names: string[]): { name: string; names: string[] }[] {
  const primary = names.slice(0, usageTopHistoryChartNamedProviderLimit)
    .map((name) => ({ name, names: [name] }));
  const otherNames = names.slice(usageTopHistoryChartNamedProviderLimit);
  return otherNames.length > 0
    ? [...primary, { name: usageTopHistoryOtherName, names: otherNames }]
    : primary;
}

function buildUsageTopHistorySeries(
  pointMap: Map<string, UsageTopPoint[]>,
  names: string[],
  buckets: UsageTopBucket[],
  windowStart: Date,
): UsageTopSeries[] {
  return usageTopHistoryChartGroups(names).map((group) => ({
    name: group.name,
    points: [
      { at: windowStart, value: 0 },
      ...buckets.flatMap((bucket) => {
        const total = readUsageTopHistoryTotalAt(pointMap, group.names, bucket.end.getTime(), windowStart);
        return total === null ? [] : [{ at: bucket.end, value: total }];
      }),
    ],
  }));
}

type UsageTopHistoryChartTick = {
  index: number;
  label: string;
};

function expandUsageTopHistoryChartPoints(points: UsageTopPoint[], width: number): UsageTopPoint[] {
  if (points.length >= width) {
    return points;
  }
  return Array.from({ length: width }, (_, index) => {
    const sourceIndex = Math.round(index * (points.length - 1) / (width - 1));
    return points[sourceIndex];
  });
}

function placeHistoryAxisLabel(chars: string[], label: string, index: number): void {
  const start = Math.max(0, Math.min(index, chars.length - label.length));
  for (let offset = 0; offset < label.length; offset += 1) {
    chars[start + offset] = label[offset];
  }
}

function usageTopHistoryChartTickIntervalMs(axisStart: Date, axisEnd: Date): number {
  const rangeMs = axisEnd.getTime() - axisStart.getTime();
  if (rangeMs > 12 * 60 * 60 * 1000) {
    return 6 * 60 * 60 * 1000;
  }
  if (rangeMs > 6 * 60 * 60 * 1000) {
    return 3 * 60 * 60 * 1000;
  }
  if (rangeMs > 2 * 60 * 60 * 1000) {
    return 60 * 60 * 1000;
  }
  if (rangeMs > 60 * 60 * 1000) {
    return 30 * 60 * 1000;
  }
  return 15 * 60 * 1000;
}

function ceilHistoryTimeToInterval(axisStart: Date, intervalMs: number): number {
  const dayStartMs = startOfHistoryDay(axisStart).getTime();
  return dayStartMs + Math.ceil((axisStart.getTime() - dayStartMs) / intervalMs) * intervalMs;
}

function formatUsageTopHistoryChartTickLabel(tickMs: number, axisEnd: Date): string {
  if (tickMs === axisEnd.getTime()) {
    return "24:00";
  }
  return formatHistoryTime(new Date(tickMs));
}

function buildUsageTopHistoryChartTicks(axisStart: Date, axisEnd: Date, width: number): UsageTopHistoryChartTick[] {
  const axisStartMs = axisStart.getTime();
  const axisEndMs = axisEnd.getTime();
  if (axisEndMs <= axisStartMs || width <= 1) {
    return [{ index: 0, label: formatHistoryTime(axisStart) }];
  }
  const intervalMs = usageTopHistoryChartTickIntervalMs(axisStart, axisEnd);
  const ticks: UsageTopHistoryChartTick[] = [];
  for (let tickMs = ceilHistoryTimeToInterval(axisStart, intervalMs); tickMs <= axisEndMs; tickMs += intervalMs) {
    ticks.push({
      index: Math.round((tickMs - axisStartMs) / (axisEndMs - axisStartMs) * (width - 1)),
      label: formatUsageTopHistoryChartTickLabel(tickMs, axisEnd),
    });
  }
  return ticks;
}

function usageTopHistoryVisibleCells(line: string): { cells: string[]; trailing: string } {
  const cells: string[] = [];
  let pending = "";
  for (let index = 0; index < line.length;) {
    const ansi = /^\u001b\[[0-9;]*m/.exec(line.slice(index));
    if (ansi) {
      pending += ansi[0];
      index += ansi[0].length;
      continue;
    }
    cells.push(`${pending}${line[index]}`);
    pending = "";
    index += 1;
  }
  return { cells, trailing: pending };
}

function usageTopHistoryCellChar(cell: string): string {
  return cell.replace(/\u001b\[[0-9;]*m/g, "") || " ";
}

function usageTopHistoryCellAnsi(cell: string): string {
  return cell.match(/\u001b\[[0-9;]*m/g)?.join("") ?? "";
}

function replaceUsageTopHistoryCellChar(cell: string, char: string): string {
  return `${usageTopHistoryCellAnsi(cell)}${char}`;
}

function joinUsageTopHistoryVisibleCells(cells: string[], trailing: string): string {
  let suffix = trailing;
  while (cells.length > 0 && usageTopHistoryCellChar(cells[cells.length - 1]) === " ") {
    suffix = `${usageTopHistoryCellAnsi(cells.pop() ?? "")}${suffix}`;
  }
  return `${cells.join("")}${suffix}`;
}

function formatUsageTopHistoryChartZeroAxis(line: string, ticks: UsageTopHistoryChartTick[], width: number): string {
  const { cells, trailing } = usageTopHistoryVisibleCells(line);
  const endColumn = usageTopHistoryChartAxisPrefix + width - 1;
  while (cells.length <= endColumn) {
    cells.push(" ");
  }
  for (let column = usageTopHistoryChartAxisPrefix + 1; column <= endColumn; column += 1) {
    if (usageTopHistoryCellChar(cells[column]) === " ") {
      cells[column] = replaceUsageTopHistoryCellChar(cells[column], "─");
    }
  }
  for (const tick of ticks) {
    const column = usageTopHistoryChartAxisPrefix + tick.index;
    if (column === usageTopHistoryChartAxisPrefix) {
      cells[column] = replaceUsageTopHistoryCellChar(cells[column], "┼");
    } else if ([" ", "─"].includes(usageTopHistoryCellChar(cells[column]))) {
      cells[column] = replaceUsageTopHistoryCellChar(cells[column], "┬");
    }
  }
  return joinUsageTopHistoryVisibleCells(cells, trailing);
}

function formatUsageTopHistoryChartAxis(ticks: UsageTopHistoryChartTick[], width: number): string {
  const chars = Array.from({ length: width }, () => " ");
  for (const tick of ticks) {
    placeHistoryAxisLabel(chars, tick.label, tick.index - Math.floor(tick.label.length / 2));
  }
  return `${" ".repeat(usageTopHistoryChartAxisPrefix)}${chars.join("")}`;
}

type UsageTopHistoryChartScale = {
  max: number;
  height: number;
};

function usageTopHistoryChartStepCandidates(max: number): number[] {
  if (max <= 0) {
    return [1];
  }

  const baseExponent = Math.floor(Math.log10(max));
  const steps: number[] = [];
  for (let exponent = baseExponent - 2; exponent <= baseExponent + 1; exponent += 1) {
    const magnitude = 10 ** exponent;
    steps.push(magnitude, 2 * magnitude, 5 * magnitude);
  }
  return [...new Set(steps)].filter((step) => step > 0).sort((left, right) => left - right);
}

function usageTopHistoryChartScale(series: number[]): UsageTopHistoryChartScale {
  const max = Math.max(0, ...series);
  if (max <= 0) {
    return {
      max: usageTopHistoryChartTargetIntervals,
      height: usageTopHistoryChartTargetIntervals,
    };
  }

  const candidates = usageTopHistoryChartStepCandidates(max)
    .map((step) => {
      const height = Math.ceil(max / step);
      return {
        max: step * height,
        height,
      };
    })
    .filter((scale) => (
      scale.height >= usageTopHistoryChartMinIntervals
      && scale.height <= usageTopHistoryChartMaxIntervals
    ))
    .sort((left, right) => (
      left.max - right.max
      || Math.abs(left.height - usageTopHistoryChartTargetIntervals)
        - Math.abs(right.height - usageTopHistoryChartTargetIntervals)
    ));

  return candidates[0] ?? {
    max,
    height: usageTopHistoryChartTargetIntervals,
  };
}

function formatHistoryChartCost(value: number): string {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < usageTopHistoryEpsilon ? `$${rounded}` : formatHistoryCost(value);
}

function usageTopHistoryChartDataWidth(start: Date, end: Date, axisStart: Date, axisEnd: Date): number {
  const axisStartMs = axisStart.getTime();
  const axisEndMs = axisEnd.getTime();
  const endMs = Math.max(axisStartMs, Math.min(end.getTime(), axisEndMs));
  if (axisEndMs <= axisStartMs) {
    return usageTopHistoryChartMinWidth;
  }
  const ratio = (endMs - axisStartMs) / (axisEndMs - axisStartMs);
  return Math.max(2, Math.round((usageTopHistoryChartMinWidth - 1) * ratio) + 1);
}

function canColorizeUsageTopHistoryChart(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function usageTopHistoryChartColor(index: number): string | undefined {
  if (!canColorizeUsageTopHistoryChart()) {
    return undefined;
  }
  const colors = [
    asciichart.cyan,
    asciichart.green,
    asciichart.yellow,
  ];
  return colors[index % colors.length];
}

function colorUsageTopHistorySeriesName(name: string, index: number): string {
  const color = usageTopHistoryChartColor(index);
  return color ? asciichart.colored(name, color) : name;
}

function stackUsageTopHistoryChartSeries(series: number[][]): number[][] {
  const cumulative = Array.from({ length: Math.max(0, ...series.map((values) => values.length)) }, () => 0);
  return series.map((values) => values.map((value, index) => {
    cumulative[index] += value;
    return cumulative[index];
  }));
}

function formatUsageTopHistoryChartLegend(series: UsageTopSeries[]): string {
  return `${textDim("stack:")} ${series
    .map((item, index) => colorUsageTopHistorySeriesName(item.name, index))
    .join(textDim(" / "))}`;
}

function formatUsageTopHistoryChartPlot(series: number[][], ticks: UsageTopHistoryChartTick[]): string {
  const scale = usageTopHistoryChartScale(series.flat());
  const config: asciichart.PlotConfig = {
    min: 0,
    max: scale.max,
    height: scale.height,
    format: (value) => `${formatHistoryChartCost(value).padStart(7)} `,
  };
  if (canColorizeUsageTopHistoryChart()) {
    config.colors = series.map((_, index) => usageTopHistoryChartColor(index));
  }
  const lines = asciichart.plot(series, config).split("\n");
  lines[lines.length - 1] = formatUsageTopHistoryChartZeroAxis(
    lines[lines.length - 1],
    ticks,
    usageTopHistoryChartMinWidth,
  );
  return lines.join("\n");
}

function formatUsageTopHistoryChartLines(series: UsageTopSeries[]): string[] {
  const chartSeries = series.map((item) => ({
    name: item.name,
    points: item.points
      .filter((point) => Number.isFinite(point.value) && !Number.isNaN(point.at.getTime()))
      .sort((left, right) => left.at.getTime() - right.at.getTime()),
  })).filter((item) => item.points.length >= 2);
  const lines = [textBold("stacked trend")];
  if (chartSeries.length === 0) {
    return [...lines, textDim("not enough history yet")];
  }

  const allPoints = chartSeries.flatMap((item) => item.points);
  const start = new Date(Math.min(...allPoints.map((point) => point.at.getTime())));
  const end = new Date(Math.max(...allPoints.map((point) => point.at.getTime())));
  const axisEnd = endOfHistoryDay(start);
  const dataWidth = usageTopHistoryChartDataWidth(start, end, start, axisEnd);
  const rawSeries = chartSeries.map((item) => expandUsageTopHistoryChartPoints(item.points, dataWidth)
    .map((point) => point.value));
  const stackedSeries = stackUsageTopHistoryChartSeries(rawSeries);
  const ticks = buildUsageTopHistoryChartTicks(start, axisEnd, usageTopHistoryChartMinWidth);
  return [
    ...lines,
    formatUsageTopHistoryChartLegend(chartSeries),
    ...formatUsageTopHistoryChartPlot(stackedSeries, ticks).split("\n"),
    textDim(formatUsageTopHistoryChartAxis(ticks, usageTopHistoryChartMinWidth)),
  ];
}

function usageTopHistoryRecentDelta(name: string, buckets: UsageTopBucket[], windowEnd: Date): UsageTopRecentDelta {
  const sinceMs = windowEnd.getTime() - usageTopHistorySummaryDeltaMs;
  let total = 0;
  let reset = false;
  for (const bucket of buckets) {
    if (bucket.end.getTime() <= sinceMs || bucket.start.getTime() >= windowEnd.getTime()) {
      continue;
    }
    const delta = bucket.deltas.get(name);
    if (delta?.reset) {
      reset = true;
    }
    total += delta?.delta ?? 0;
  }
  return {
    delta: Math.abs(total) < usageTopHistoryEpsilon ? 0 : total,
    reset,
  };
}

function formatUsageTopHistorySummaryLines(
  summaries: UsageTopSummary[],
  buckets: UsageTopBucket[],
  windowEnd: Date,
): string[] {
  return [
    textBold("summary"),
    ...formatTableRows([
      ["provider", "now", "5h delta", "last", "change"],
      ...summaries.map((summary) => {
        const recentDelta = usageTopHistoryRecentDelta(summary.name, buckets, windowEnd);
        return [
          colorName(summary.name),
          formatHistoryValue(summary.latest),
          formatHistoryDeltaCell(recentDelta.delta, recentDelta.reset),
          formatHistoryLastChangeTime(summary),
          formatHistoryLastChangeDelta(summary),
        ];
      }),
    ], ["left", "right", "right", "right", "right"]),
  ];
}

function printUsageTopHistoryChartWithSummary(
  series: UsageTopSeries[],
  summaries: UsageTopSummary[],
  buckets: UsageTopBucket[],
  windowEnd: Date,
): void {
  const chartLines = formatUsageTopHistoryChartLines(series);
  const summaryLines = formatUsageTopHistorySummaryLines(summaries, buckets, windowEnd);
  const chartWidth = Math.max(...chartLines.map(visibleLength));
  const lineCount = Math.max(chartLines.length, summaryLines.length);
  console.log();
  for (let index = 0; index < lineCount; index += 1) {
    const chartLine = chartLines[index] ?? "";
    const summaryLine = summaryLines[index] ?? "";
    console.log(`${padVisibleRight(chartLine, chartWidth)}${" ".repeat(usageTopHistoryChartSummaryGap)}${summaryLine}`.trimEnd());
  }
}

async function printUsageTopHistoryUnavailable(profiles: ProfilesFile, request: UsageTopHistoryRequest): Promise<void> {
  const urls = await readUsageTopStateUrls(profiles);
  if (urls.length > 0) {
    console.log(textDim("ccs top history unavailable"));
    printKeyValue("source:", colorUrl(usageTopHistoryUrl(urls[0], request)), 7);
    if (urls.length > 1) {
      printKeyValue("also:", urls.slice(1).map((url) => colorUrl(usageTopHistoryUrl(url, request))).join("  "), 7);
    }
    printKeyValue("note:", "restart ccs s server with a version that serves compact /ccs/top/history", 5);
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

function parseUsageTopHistoryDate(value: string): Date {
  return new Date(value);
}

function parseOptionalUsageTopHistoryDate(value: string | undefined): Date | undefined {
  return value ? parseUsageTopHistoryDate(value) : undefined;
}

function toUsageTopSummary(record: UsageTopHistorySummaryRecord): UsageTopSummary {
  return {
    name: record.name,
    first: record.first,
    latest: record.latest,
    delta: record.delta,
    reset: record.reset,
    changes: record.changes,
    lastChangeAt: parseOptionalUsageTopHistoryDate(record.lastChangeAt),
    lastChangeDelta: record.lastChangeDelta,
    lastResetAt: parseOptionalUsageTopHistoryDate(record.lastResetAt),
  };
}

function toUsageTopBucket(record: UsageTopHistoryBucketRecord): UsageTopBucket {
  return {
    start: parseUsageTopHistoryDate(record.start),
    end: parseUsageTopHistoryDate(record.end),
    deltas: new Map(record.deltas.map((delta) => [
      delta.name,
      { delta: delta.delta, reset: delta.reset },
    ])),
    total: record.total,
    reset: record.reset,
  };
}

function toUsageTopPoint(record: UsageTopHistoryPointRecord): UsageTopPoint {
  return {
    at: parseUsageTopHistoryDate(record.at),
    value: record.value,
  };
}

function toUsageTopSeries(record: UsageTopHistorySeriesRecord): UsageTopSeries {
  return {
    name: record.name,
    points: record.points.map(toUsageTopPoint),
  };
}

async function printUsageTopHistory(profiles: ProfilesFile, profileName?: string): Promise<void> {
  const request = buildUsageTopHistoryRequest(profileName);
  const source = await readUsageTopHistorySource(profiles, request);
  if (!source) {
    await printUsageTopHistoryUnavailable(profiles, request);
    return;
  }

  const names = source.history.names;
  if (names.length === 0) {
    printUsageTopHistoryEmpty(source, profileName, source.history.availableNames);
    return;
  }

  const summaries = source.history.summaries.map(toUsageTopSummary);
  const buckets = source.history.buckets.map(toUsageTopBucket);
  const series = source.history.series.map(toUsageTopSeries);
  const windowEnd = parseUsageTopHistoryDate(source.history.windowEnd);
  console.log(`ccs usage history  today  bucket ${formatHistoryBucketWindow(source.history.bucketMinutes)}`);
  printKeyValue("source:", source.remote ? colorUrl(source.source) : colorPath(source.source), 7);
  printUsageTopHistoryChartWithSummary(series, summaries, buckets, windowEnd);
  printUsageTopHistoryBuckets(buckets, names);
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

function parseUsageTopHistoryDateParam(params: URLSearchParams, name: string): Date | undefined {
  const value = params.get(name);
  if (value === null) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return date;
}

function parseUsageTopHistoryBucketMinutes(params: URLSearchParams): number {
  const value = params.get("bucketMinutes");
  if (value === null) {
    return usageTopHistoryBucketMinutes;
  }
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new Error(`invalid bucketMinutes: ${value}`);
  }
  return minutes;
}

function parseUsageTopHistoryRequestFromUrl(url: URL, now = new Date()): UsageTopHistoryRequest {
  const windowStart = parseUsageTopHistoryDateParam(url.searchParams, "since") ?? startOfHistoryDay(now);
  const windowEnd = parseUsageTopHistoryDateParam(url.searchParams, "until") ?? now;
  if (windowStart.getTime() > windowEnd.getTime()) {
    throw new Error("since must be before until");
  }
  return {
    windowStart,
    windowEnd,
    bucketMinutes: parseUsageTopHistoryBucketMinutes(url.searchParams),
    profileName: url.searchParams.get("profile")?.trim() || undefined,
  };
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
  let ccsCostRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanedUp = false;
  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const clearCcsCostRefreshTimer = (): void => {
    if (ccsCostRefreshTimer) {
      clearTimeout(ccsCostRefreshTimer);
      ccsCostRefreshTimer = null;
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
  const runCcsCostRefresh = async (): Promise<void> => {
    try {
      await refreshCentralCcsCostDerivedStore();
    } catch (error) {
      console.error(`ccs cost refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const scheduleCcsCostRefresh = (): string => {
    clearCcsCostRefreshTimer();
    const scheduledAt = new Date(Date.now() + ccsCostRefreshDebounceMs).toISOString();
    ccsCostRefreshTimer = setTimeout(() => {
      ccsCostRefreshTimer = null;
      void runCcsCostRefresh();
    }, ccsCostRefreshDebounceMs);
    return scheduledAt;
  };

  let snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), true, paused);
  await writeUsageTopSnapshot(snapshot);
  await recordUsageTopHistorySnapshot(snapshot);
  await refreshCentralCcsCostDerivedStore();

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendUsageTopJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/ccs/top/state") {
      snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), true, paused);
      sendUsageTopJson(response, 200, snapshot);
      return;
    }
    if (request.method === "GET" && url.pathname === "/ccs/top/history") {
      let historyRequest: UsageTopHistoryRequest;
      try {
        historyRequest = parseUsageTopHistoryRequestFromUrl(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendUsageTopJson(response, 400, { error: message });
        return;
      }
      void (async () => {
        try {
          const windowEnd = historyRequest.windowEnd ?? new Date();
          sendUsageTopJson(response, 200, buildUsageTopHistory(
            await readUsageTopHistoryRecords(windowEnd),
            { ...historyRequest, windowEnd },
          ));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendUsageTopJson(response, 500, { error: message });
        }
      })();
      return;
    }
    if (request.method === "GET" && url.pathname === "/ccs/cost/status") {
      void (async () => {
        try {
          sendUsageTopJson(response, 200, await buildCcsCostStatus());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendUsageTopJson(response, 500, { error: message });
        }
      })();
      return;
    }
    if (request.method === "GET" && url.pathname === "/ccs/cost/report") {
      let costOptions: CcsCostOptions;
      try {
        costOptions = parseCcsCostOptionsFromUrl(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendUsageTopJson(response, 400, { error: message });
        return;
      }
      void (async () => {
        try {
          sendUsageTopJson(response, 200, await buildCentralCcsCostReport(costOptions));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendUsageTopJson(response, 500, { error: message });
        }
      })();
      return;
    }
    if (request.method === "POST" && url.pathname === "/ccs/cost/refresh") {
      const scheduledAt = scheduleCcsCostRefresh();
      sendUsageTopJson(response, 200, {
        ok: true,
        debounceMs: ccsCostRefreshDebounceMs,
        scheduledAt,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/ccs/top/pause") {
      void (async () => {
        paused = true;
        clearTimer();
        await publish();
        sendUsageTopJson(response, 200, { ok: true, paused });
      })();
      return;
    }
    if (request.method === "POST" && url.pathname === "/ccs/top/resume") {
      void (async () => {
        paused = false;
        await resetPolling();
        sendUsageTopJson(response, 200, { ok: true, paused });
      })();
      return;
    }
    if (request.method === "POST" && url.pathname === "/ccs/top/reset") {
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
      clearCcsCostRefreshTimer();
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
    "  ccs run PROFILE [CODEX_ARGS...]       # launch codex once with a profile",
    "  ccs cost                             # show cost data source and commands",
    "  ccs cost daily                       # show Codex session daily cost totals",
    "  ccs cost weekly                      # show Codex session weekly cost totals",
    "  ccs cost monthly                     # show Codex session monthly cost totals",
    "  ccs cost projects                    # show Codex session project cost totals",
    "  ccs cost project PROJECT             # show one Codex project by day",
    "  ccs cost day YYYY-MM-DD              # show one Codex day by time and project",
    "  ccs cost push                        # upload this machine's cost events to the LAN server",
    "  ccs cost central [REPORT]            # show central cost status or report from the LAN server",
    "  ccs toggle [PROFILE]                 # switch profile",
    "  ccs top [--once] [--mark DURATION]   # show all usage costs with checkpoint lines",
    "  ccs config [push|pull]                # preview, confirm, and sync profiles.json with LAN server",
    "  ccs s [line]                         # print compact status from configured top state",
    "  ccs s agent                          # write local status text for WezTerm",
    "  ccs s server [PORT]                  # serve top state on 0.0.0.0",
    "  ccs s history [PROFILE]              # show today's usage history with 30-minute buckets",
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

type CcsCostReport = "daily" | "weekly" | "monthly" | "projects" | "project" | "day";

type CcsCostOptions = CodexUsageRange & {
  report: CcsCostReport;
  json: boolean;
  raw: boolean;
  speed: CodexCostSpeed;
  bucket: "15m" | "30m" | "1h" | "2h";
  bucketMinutes: number;
  project?: string;
  day?: string;
};

type CcsCostContext = {
  priceCache: ModelPriceCache;
  speed: ResolvedCodexCostSpeed;
};

type CcsCostCommand = "status" | "report" | "push" | "central";
type CcsCostParsedCommand = CcsCostCommand | "help";

type CcsCostParsedArgs = {
  command: CcsCostParsedCommand;
  options?: CcsCostOptions;
};

type CcsCostMetricsRecord = {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
};

type CcsCostTokenUsageRecord = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

type CcsCostReportRowRecord = CcsCostMetricsRecord & {
  key: string;
};

type CcsCostReportPayload = {
  version: 1;
  report: CcsCostReport;
  range?: {
    since: string | null;
    until: string | null;
    timezone: string;
  };
  date?: string;
  timezone: string;
  bucket?: CcsCostOptions["bucket"];
  rows?: CcsCostReportRowRecord[];
  timeBuckets?: CcsCostReportRowRecord[];
  projects?: CcsCostReportRowRecord[];
  totals: CcsCostMetricsRecord;
  source: "local" | "central";
  generatedAt: string;
};

type CcsCostSnapshotEvent = {
  timestampMs: number;
  project: string;
  model: string;
  usage: CcsCostTokenUsageRecord;
};

type CcsCostSnapshot = {
  version: 1;
  machine: string;
  sourceHost: string;
  sourceUser: string;
  sourceCodexDir: string;
  generatedAt: string;
  timezone: string;
  speed: ResolvedCodexCostSpeed;
  events: CcsCostSnapshotEvent[];
};

type CcsCostSnapshotSummary = {
  machine: string;
  generatedAt: string;
  speed: ResolvedCodexCostSpeed;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
};

type CcsCostStatus = {
  version: 1;
  updatedAt: string;
  snapshotCount: number;
  machines: CcsCostSnapshotSummary[];
};

type CcsCostSnapshotFile = {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
};

type CcsCostSnapshotCache = {
  fingerprint: string;
  snapshots: CcsCostSnapshot[];
};

type CcsCostAggregateRecord = CcsCostTokenUsageRecord & {
  modelUsage: Record<string, CcsCostTokenUsageRecord>;
};

type CcsCostDerivedAggregate = {
  standard: CcsCostAggregateRecord;
  fast: CcsCostAggregateRecord;
};

type CcsCostDerivedMachine = {
  machine: string;
  generatedAt: string;
  speed: ResolvedCodexCostSpeed;
  events: number;
  aggregate: CcsCostDerivedAggregate;
};

type CcsCostDerivedStore = {
  version: 1;
  snapshotFingerprint: string;
  timezone: string;
  generatedAt: string;
  machines: CcsCostDerivedMachine[];
  daily: Record<string, CcsCostDerivedAggregate>;
  projects: Record<string, CcsCostDerivedAggregate>;
  projectDaily: Record<string, Record<string, CcsCostDerivedAggregate>>;
  dayBuckets15m: Record<string, Record<string, CcsCostDerivedAggregate>>;
  dayProjects: Record<string, Record<string, CcsCostDerivedAggregate>>;
};

type CentralCcsCostReportFetchResult = {
  report: CcsCostReportPayload | null;
  error?: string;
};

let ccsCostSnapshotCache: CcsCostSnapshotCache | null = null;
let ccsCostDerivedCache: CcsCostDerivedStore | null = null;
let ccsCostReportCache = new Map<string, CcsCostReportPayload>();

const ccsCostReports = new Set<string>(["daily", "weekly", "monthly", "projects", "project", "day"]);
const ccsCostBucketMinutes = new Map<CcsCostOptions["bucket"], number>([
  ["15m", 15],
  ["30m", 30],
  ["1h", 60],
  ["2h", 120],
]);

function printCcsCostHelp(): void {
  console.log([
    textBold("Usage:"),
    "  ccs cost                                           # show cost data source and commands",
    "  ccs cost daily                                     # show daily totals",
    "  ccs cost weekly                                    # show weekly totals",
    "  ccs cost monthly                                   # show monthly totals",
    "  ccs cost projects                                  # show project totals",
    "  ccs cost project PROJECT                           # show one project by day",
    "  ccs cost day YYYY-MM-DD                            # show one day by time and project",
    "  ccs cost push                                      # upload this machine's cost events to the LAN server",
    "  ccs cost central daily                             # show central daily totals from the LAN server",
    "  ccs cost central weekly                            # show central weekly totals from the LAN server",
    "  ccs cost central monthly                           # show central monthly totals from the LAN server",
    "  ccs cost central projects                          # show central project totals from the LAN server",
    "  ccs cost central project PROJECT                   # show one central project by day",
    "  ccs cost central day YYYY-MM-DD                    # show one central day by time and project",
    "",
    textBold("Options:"),
    "  --since YYYY-MM-DD      inclusive start date",
    "  --until YYYY-MM-DD      inclusive end date",
    "  --timezone IANA_NAME    date grouping timezone; defaults to the system timezone",
    "  --bucket 15m|30m|1h|2h  time bucket for ccs cost day; default 1h",
    "  --json                  print stable JSON",
    "  --raw                   print full token counts and decimal costs",
    "  --speed auto|standard|fast",
  ].join("\n"));
}

async function printCcsCostStatus(profiles: ProfilesFile): Promise<void> {
  const speed = await resolveCodexCostSpeed("auto");
  const urls = await readUsageTopStateUrls(profiles);
  printKeyValue("sessions:", colorPath(formatDisplayPath(codexDir())), 9);
  printKeyValue("pricing:", colorPath(formatDisplayPath(modelPricesCachePath())), 9);
  printKeyValue("remote:", urls[0] ? colorUrl(ccsCostStatusUrl(urls[0])) : textDim("none"), 9);
  printKeyValue("upload:", colorPath(ccsCostRemoteDisplay), 9);
  printKeyValue("timezone:", systemTimezone(), 9);
  printKeyValue("speed:", `auto -> ${speed}`, 9);
  console.log(textDim("commands: ccs cost | ccs cost push | ccs cost [daily|weekly|monthly|projects|project PROJECT|day YYYY-MM-DD] | ccs cost central [daily|weekly|monthly|projects|project PROJECT|day YYYY-MM-DD]"));
  console.log(textDim("options: --since YYYY-MM-DD | --until YYYY-MM-DD | --timezone IANA_NAME | --bucket 15m|30m|1h|2h | --json | --raw | --speed auto|standard|fast"));
}

async function runCcsCost(args: string[], profiles: ProfilesFile): Promise<void> {
  const parsed = parseCcsCostCommandArgs(args);
  if (parsed.command === "status") {
    await printCcsCostStatus(profiles);
    return;
  }

  if (parsed.command === "help") {
    printCcsCostHelp();
    return;
  }

  if (parsed.command === "push") {
    await pushCcsCostSnapshot(profiles, parsed.options);
    return;
  }

  if (parsed.command === "central") {
    if (!parsed.options) {
      await printCentralCcsCostStatus(profiles);
      return;
    }
    await printCentralCcsCost(profiles, parsed.options);
    return;
  }

  if (!parsed.options) {
    printCcsCostHelp();
    return;
  }

  await printLocalCcsCost(parsed.options);
}

async function printLocalCcsCost(options: CcsCostOptions): Promise<void> {
  const context: CcsCostContext = {
    priceCache: await readModelPriceCache(),
    speed: await resolveCodexCostSpeed(options.speed),
  };
  const events = await loadCodexUsageEvents({
    ...(options.report === "day" && options.day ? dateRangeForDay(options.day, options.timezone) : {
      since: options.since,
      until: options.until,
      timezone: options.timezone,
    }),
    project: options.project,
  });
  printCcsCostReport(buildCcsCostReport(options, events, context, "local"), options);
}

function parseCcsCostCommandArgs(args: string[]): CcsCostParsedArgs {
  if (args.length === 0) {
    return { command: "status" };
  }

  if (args.some(isHelpArgument)) {
    return { command: "help" };
  }

  const first = args[0];
  if (first === "push") {
    const reportArgs = args.slice(1);
    return {
      command: "push",
      options: reportArgs.length > 0 ? parseCcsCostReportArgs(reportArgs) : undefined,
    };
  }

  if (first === "central") {
    return {
      command: "central",
      options: args.length > 1 ? parseCcsCostReportArgs(args.slice(1)) : undefined,
    };
  }

  return {
    command: "report",
    options: parseCcsCostReportArgs(args),
  };
}

function buildCcsCostReport(
  options: CcsCostOptions,
  events: CodexUsageEvent[],
  context: CcsCostContext,
  source: CcsCostReportPayload["source"],
): CcsCostReportPayload {
  const selectedEvents = filterCodexUsageEvents(events, {
    ...(options.report === "day" && options.day ? dateRangeForDay(options.day, options.timezone) : {
      since: options.since,
      until: options.until,
      timezone: options.timezone,
    }),
    project: options.project,
  });

  if (options.report === "daily") {
    const rows = aggregateDaily(selectedEvents, options.timezone);
    return buildCcsCostRowsReport(options, rows, context, source);
  }

  if (options.report === "weekly") {
    const rows = aggregateWeekly(selectedEvents, options.timezone);
    return buildCcsCostRowsReport(options, rows, context, source);
  }

  if (options.report === "monthly") {
    const rows = aggregateMonthly(selectedEvents, options.timezone);
    return buildCcsCostRowsReport(options, rows, context, source);
  }

  if (options.report === "projects") {
    const unsortedRows = aggregateProjects(selectedEvents);
    const rows = sortRowsByCost(unsortedRows, (aggregate) => ccsCostOf(aggregate, context));
    return buildCcsCostRowsReport(options, rows, context, source);
  }

  if (options.report === "project") {
    const project = options.project;
    if (!project) {
      throw new Error("usage: ccs cost project PROJECT");
    }
    const rows = aggregateProjectDaily(selectedEvents, options.timezone, project);
    return buildCcsCostRowsReport(options, rows, context, source);
  }

  const day = options.day;
  if (!day) {
    throw new Error("usage: ccs cost day YYYY-MM-DD");
  }
  const timeRows = aggregateDayTimeBuckets(selectedEvents, options.timezone, day, options.bucketMinutes);
  const unsortedProjectRows = aggregateDayProjects(selectedEvents, options.timezone, day);
  const total = totalAggregate(unsortedProjectRows);
  assertCcsCostPricing(total, context);
  const projectRows = sortRowsByCost(
    unsortedProjectRows,
    (aggregate) => ccsCostOf(aggregate, context),
  );
  return {
    version: 1,
    report: "day",
    date: day,
    timezone: options.timezone,
    bucket: options.bucket,
    totals: ccsCostMetricsJson(total, context),
    timeBuckets: timeRows.map((row) => ({ key: row.key, ...ccsCostMetricsJson(row.aggregate, context) })),
    projects: projectRows.map((row) => ({ key: row.key, ...ccsCostMetricsJson(row.aggregate, context) })),
    source,
    generatedAt: new Date().toISOString(),
  };
}

function buildCcsCostRowsReport(
  options: CcsCostOptions,
  rows: CodexUsageRow[],
  context: CcsCostContext,
  source: CcsCostReportPayload["source"],
): CcsCostReportPayload {
  const total = totalAggregate(rows);
  assertCcsCostPricing(total, context);
  return {
    version: 1,
    report: options.report,
    range: {
      since: options.since ?? null,
      until: options.until ?? null,
      timezone: options.timezone,
    },
    timezone: options.timezone,
    rows: rows.map((row) => ({ key: row.key, ...ccsCostMetricsJson(row.aggregate, context) })),
    totals: ccsCostMetricsJson(total, context),
    source,
    generatedAt: new Date().toISOString(),
  };
}

function parseCcsCostReportArgs(args: string[]): CcsCostOptions {
  let index = 1;
  let project: string | undefined;
  let day: string | undefined;

  const first = args[0];
  if (!first || first.startsWith("-")) {
    throw new Error("usage: ccs cost daily|weekly|monthly|projects|project|day [OPTIONS]");
  }
  if (!ccsCostReports.has(first)) {
    throw new Error(`unknown argument for ccs cost: ${first}`);
  }
  const report = first as CcsCostReport;

  if (report === "project") {
    const value = args[index];
    if (!value || value.startsWith("-")) {
      throw new Error("usage: ccs cost project PROJECT");
    }
    project = resolveProjectPath(value);
    index += 1;
  }

  if (report === "day") {
    const value = args[index];
    if (!value || value.startsWith("-")) {
      throw new Error("usage: ccs cost day YYYY-MM-DD");
    }
    day = value;
    index += 1;
  }

  let since: string | undefined;
  let until: string | undefined;
  let timezone = systemTimezone();
  let json = false;
  let raw = false;
  let speed: CodexCostSpeed = "auto";
  let bucket: CcsCostOptions["bucket"] = "1h";
  let bucketProvided = false;

  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--raw") {
      raw = true;
      continue;
    }
    if (arg === "--since") {
      since = readCcsCostOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--until") {
      until = readCcsCostOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--timezone") {
      timezone = readCcsCostOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--bucket") {
      const value = readCcsCostOptionValue(args, index, arg);
      if (!ccsCostBucketMinutes.has(value as CcsCostOptions["bucket"])) {
        throw new Error(`invalid ccs cost bucket: ${value}`);
      }
      bucket = value as CcsCostOptions["bucket"];
      bucketProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--speed") {
      const value = readCcsCostOptionValue(args, index, arg);
      if (value !== "auto" && value !== "standard" && value !== "fast") {
        throw new Error(`invalid ccs cost speed: ${value}`);
      }
      speed = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument for ccs cost ${report}: ${arg}`);
  }

  if (report === "day" && (since || until)) {
    throw new Error("ccs cost day uses YYYY-MM-DD instead of --since or --until");
  }
  if (report !== "day" && bucketProvided) {
    throw new Error("--bucket is only valid for ccs cost day");
  }

  return {
    report,
    since,
    until,
    timezone,
    json,
    raw,
    speed,
    bucket,
    bucketMinutes: ccsCostBucketMinutes.get(bucket) ?? 60,
    project,
    day,
  };
}

function readCcsCostOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${option}`);
  }
  return value;
}

function parseCcsCostOptionsFromUrl(url: URL): CcsCostOptions {
  const report = url.searchParams.get("report") ?? "";
  if (!ccsCostReports.has(report)) {
    throw new Error(`invalid report: ${report}`);
  }
  const args = [report];
  if (report === "project") {
    const project = url.searchParams.get("project");
    if (!project) {
      throw new Error("missing project");
    }
    args.push(project);
  }
  if (report === "day") {
    const day = url.searchParams.get("day");
    if (!day) {
      throw new Error("missing day");
    }
    args.push(day);
  }
  for (const option of ["since", "until", "timezone", "bucket", "speed"]) {
    const value = url.searchParams.get(option);
    if (value !== null) {
      args.push(`--${option}`, value);
    }
  }
  return parseCcsCostReportArgs(args);
}

function printCcsCostReport(report: CcsCostReportPayload, options: CcsCostOptions): void {
  if (options.json) {
    console.log(stringifyJson(ccsCostReportJson(report)).trimEnd());
    return;
  }

  if (report.report === "day") {
    printCcsCostDayReport(report, options);
    return;
  }

  const rows = report.rows ?? [];
  console.log(ccsCostReportTitle(report, options));
  printCcsCostRecordTable(ccsCostReportKey(options.report), rows, report.totals, options.raw, (value) => (
    options.report === "projects" ? formatCcsCostProjectPath(value) : value
  ));
}

function ccsCostReportJson(report: CcsCostReportPayload): unknown {
  if (report.report === "day") {
    return {
      report: "day",
      date: report.date,
      timezone: report.timezone,
      bucket: report.bucket,
      totals: report.totals,
      timeBuckets: (report.timeBuckets ?? []).map((row) => {
        const [start, end] = row.key.split("-");
        return {
          start,
          end,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costUSD: row.costUSD,
        };
      }),
      projects: (report.projects ?? []).map((row) => ({
        project: row.key,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUSD: row.costUSD,
      })),
    };
  }

  const key = ccsCostReportKey(report.report);
  return {
    report: report.report,
    range: report.range,
    rows: (report.rows ?? []).map((row) => ({
      [key]: row.key,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUSD: row.costUSD,
    })),
    totals: report.totals,
  };
}

function ccsCostReportKey(report: CcsCostReport): "date" | "week" | "month" | "project" {
  if (report === "weekly") {
    return "week";
  }
  if (report === "monthly") {
    return "month";
  }
  if (report === "projects") {
    return "project";
  }
  return "date";
}

function ccsCostReportTitle(report: CcsCostReportPayload, options: CcsCostOptions): string {
  if (report.report === "project" && options.project) {
    return `ccs cost ${report.source === "central" ? "central project" : "project"}  ${formatProjectPath(options.project)}`;
  }
  const command = report.source === "central" ? `ccs cost central ${report.report}` : `ccs cost ${report.report}`;
  return `${command}  ${formatCcsCostRange(options)}  timezone ${options.timezone}`;
}

function printCcsCostDayReport(report: CcsCostReportPayload, options: CcsCostOptions): void {
  const day = report.date;
  if (!day) {
    throw new Error("invalid ccs cost day report");
  }
  const title = report.source === "central" ? "ccs cost central day" : "ccs cost day";
  console.log(`${title}  ${day}  bucket ${options.bucket}  timezone ${options.timezone}`);
  console.log(textBold(`total  input ${colorInput(formatCcsCostTokens(report.totals.inputTokens, options.raw))}  output ${colorOutput(formatCcsCostTokens(report.totals.outputTokens, options.raw))}  cost ${colorCost(formatCcsCostUSD(report.totals.costUSD, options.raw))}`));
  console.log("");
  console.log("by time");
  printCcsCostRecordTable("time", report.timeBuckets ?? [], null, options.raw);
  console.log("");
  console.log("by project");
  printCcsCostRecordTable("project", report.projects ?? [], null, options.raw, formatCcsCostProjectPath);
}

function printCcsCostRecordTable(
  firstHeader: string,
  rows: CcsCostReportRowRecord[],
  total: CcsCostMetricsRecord | null,
  raw: boolean,
  formatKey: (value: string) => string = (value) => value,
): void {
  const header = [firstHeader, "input", "output", "cost"].map(textBold);
  const bodyRows = rows.map((row) => ccsCostRecordTableRow(formatKey(row.key), row, raw, false));
  const totalRow = total ? ccsCostRecordTableRow("total", total, raw, true) : null;
  const tableRows = [
    header,
    ...bodyRows,
  ];
  if (totalRow) {
    tableRows.push(totalRow);
  }
  const formatted = formatTableRows(tableRows, ["left", "right", "right", "right"]);
  const separatorIndex = totalRow ? formatted.length - 1 : -1;
  const width = Math.max(0, ...formatted.map(visibleLength));
  for (let index = 0; index < formatted.length; index += 1) {
    if (index === separatorIndex) {
      console.log(textDim("-".repeat(width)));
    }
    console.log(formatted[index]);
  }
}

function ccsCostRecordTableRow(
  label: string,
  record: CcsCostMetricsRecord,
  raw: boolean,
  emphasize: boolean,
): string[] {
  const row = [
    label,
    colorInput(formatCcsCostTokens(record.inputTokens, raw)),
    colorOutput(formatCcsCostTokens(record.outputTokens, raw)),
    colorCost(formatCcsCostUSD(record.costUSD, raw)),
  ];
  return emphasize ? row.map(textBold) : row;
}

function ccsCostMetricsJson(aggregate: CodexUsageAggregate, context: CcsCostContext): {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
} {
  return {
    inputTokens: aggregate.inputTokens,
    outputTokens: aggregate.outputTokens,
    costUSD: roundCostUSD(ccsCostOf(aggregate, context)),
  };
}

function ccsCostTokenUsageRecord(usage: CcsCostTokenUsageRecord): CcsCostTokenUsageRecord {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
  };
}

function ccsCostEventRecord(event: CodexUsageEvent): CcsCostSnapshotEvent {
  return {
    timestampMs: event.timestampMs,
    project: event.project,
    model: event.model,
    usage: ccsCostTokenUsageRecord(event.usage),
  };
}

function ccsCostMachineName(): string {
  return `${formatSystemLabel().replace(/[^A-Za-z0-9._-]+/g, "_")}`;
}

async function buildCcsCostSnapshot(options?: CcsCostOptions): Promise<CcsCostSnapshot> {
  const timezone = options?.timezone ?? systemTimezone();
  const speed = await resolveCodexCostSpeed("auto");
  const events = await loadCodexUsageEvents({
    ...(options?.report === "day" && options.day ? dateRangeForDay(options.day, timezone) : {
      since: options?.since,
      until: options?.until,
      timezone,
    }),
    project: options?.project,
  });
  const systemLabel = formatSystemLabel();
  const [sourceUser, sourceHost] = systemLabel.split("@");
  return {
    version: 1,
    machine: ccsCostMachineName(),
    sourceHost: sourceHost || hostname(),
    sourceUser: sourceUser || userInfo().username,
    sourceCodexDir: codexDir(),
    generatedAt: new Date().toISOString(),
    timezone,
    speed,
    events: events.map(ccsCostEventRecord),
  };
}

function ccsCostSnapshotFileName(snapshot: CcsCostSnapshot): string {
  return `${snapshot.machine}.json`;
}

async function pushCcsCostSnapshot(profiles: ProfilesFile, options?: CcsCostOptions): Promise<void> {
  const snapshot = await buildCcsCostSnapshot(options);
  const tempDir = await mkdtemp(join(tmpdir(), "ccs-cost-"));
  const tempPath = join(tempDir, ccsCostSnapshotFileName(snapshot));
  const remotePath = `${ccsCostRemoteDir}/${ccsCostSnapshotFileName(snapshot)}`;
  const remoteTempPath = `${remotePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeTextFile(tempPath, stringifyJson(snapshot), 0o600);
    await configSyncSsh(`mkdir -p ${JSON.stringify(ccsCostRemoteDir)}`);
    await configSyncScp(tempPath, `${configSyncUser}@${configSyncHost}:${remoteTempPath}`);
    await configSyncSsh(`mv -f ${JSON.stringify(remoteTempPath)} ${JSON.stringify(remotePath)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
  const refreshUrl = await triggerCcsCostRefresh(profiles);
  const totals = snapshot.events.reduce((aggregate, event) => {
    aggregate.inputTokens += event.usage.inputTokens;
    aggregate.outputTokens += event.usage.outputTokens;
    return aggregate;
  }, { inputTokens: 0, outputTokens: 0 });
  console.log(`uploaded: ${textGreen(`${configSyncUser}@${configSyncHost}:${remotePath}`)}`);
  printKeyValue("machine:", snapshot.machine, 9);
  printKeyValue("events:", formatInteger(snapshot.events.length), 9);
  printKeyValue("input:", formatCcsCostTokens(totals.inputTokens, false), 9);
  printKeyValue("output:", formatCcsCostTokens(totals.outputTokens, false), 9);
  printKeyValue("refresh:", colorUrl(refreshUrl), 9);
}

async function triggerCcsCostRefresh(profiles: ProfilesFile): Promise<string> {
  const errors: string[] = [];
  const stateUrls = await readUsageTopStateUrls(profiles);
  if (stateUrls.length === 0) {
    throw new Error("ccs cost push requires top.stateUrls for refresh trigger");
  }
  for (const stateUrl of stateUrls) {
    const url = ccsCostRefreshUrl(stateUrl);
    const error = await postCcsCostRefresh(url);
    if (!error) {
      return url;
    }
    errors.push(`${url}: ${error}`);
  }
  throw new Error(`central ccs cost refresh trigger failed: ${errors.join("; ")}`);
}

async function postCcsCostRefresh(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ccsCostRefreshHttpTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    return response.ok ? null : `HTTP ${response.status}${formatCcsCostFetchBody(text)}`;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return `timeout after ${ccsCostRefreshHttpTimeoutMs / 1000}s`;
    }
    return error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }
}

async function readCcsCostSnapshotFiles(): Promise<CcsCostSnapshotFile[]> {
  const dir = ccsCostSnapshotDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: CcsCostSnapshotFile[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(dir, name);
    const file = await stat(path);
    if (file.isFile()) {
      files.push({ name, path, size: file.size, mtimeMs: file.mtimeMs });
    }
  }
  return files;
}

function ccsCostSnapshotFingerprint(files: CcsCostSnapshotFile[]): string {
  return files.map((file) => `${file.name}:${file.size}:${file.mtimeMs}`).join("|");
}

async function getCcsCostSnapshotCache(): Promise<CcsCostSnapshotCache> {
  const files = await readCcsCostSnapshotFiles();
  const fingerprint = ccsCostSnapshotFingerprint(files);
  if (ccsCostSnapshotCache?.fingerprint === fingerprint) {
    return ccsCostSnapshotCache;
  }

  const snapshots: CcsCostSnapshot[] = [];
  for (const file of files) {
    snapshots.push(parseCcsCostSnapshot(file.name, await readTextIfExists(file.path)));
  }
  ccsCostSnapshotCache = { fingerprint, snapshots };
  ccsCostReportCache = new Map();
  return ccsCostSnapshotCache;
}

function parseCcsCostSnapshot(name: string, text: string | null): CcsCostSnapshot {
  if (!text) {
    throw new Error(`empty ccs cost snapshot: ${name}`);
  }
  try {
    const snapshot = normalizeCcsCostSnapshot(JSON.parse(text) as unknown);
    if (!snapshot) {
      throw new Error(`invalid ccs cost snapshot: ${name}`);
    }
    return snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid ccs cost snapshot ${name}: ${message}`);
  }
}

function normalizeCcsCostSnapshot(value: unknown): CcsCostSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<CcsCostSnapshot>;
  if (
    raw.version !== 1
    || typeof raw.machine !== "string"
    || typeof raw.sourceHost !== "string"
    || typeof raw.sourceUser !== "string"
    || typeof raw.sourceCodexDir !== "string"
    || typeof raw.generatedAt !== "string"
    || typeof raw.timezone !== "string"
    || (raw.speed !== "standard" && raw.speed !== "fast")
    || !Array.isArray(raw.events)
  ) {
    return null;
  }
  const events = raw.events.map(normalizeCcsCostSnapshotEvent);
  if (events.some((event) => !event)) {
    return null;
  }
  return {
    version: 1,
    machine: raw.machine,
    sourceHost: raw.sourceHost,
    sourceUser: raw.sourceUser,
    sourceCodexDir: raw.sourceCodexDir,
    generatedAt: raw.generatedAt,
    timezone: raw.timezone,
    speed: raw.speed,
    events: events as CcsCostSnapshotEvent[],
  };
}

function normalizeCcsCostSnapshotEvent(value: unknown): CcsCostSnapshotEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<CcsCostSnapshotEvent>;
  if (
    typeof raw.timestampMs !== "number"
    || !Number.isFinite(raw.timestampMs)
    || typeof raw.project !== "string"
    || typeof raw.model !== "string"
    || !raw.usage
  ) {
    return null;
  }
  const usage = normalizeCcsCostTokenUsageRecord(raw.usage);
  return usage ? {
    timestampMs: raw.timestampMs,
    project: raw.project,
    model: raw.model,
    usage,
  } : null;
}

function normalizeCcsCostTokenUsageRecord(value: unknown): CcsCostTokenUsageRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<CcsCostTokenUsageRecord>;
  if (
    typeof raw.inputTokens !== "number"
    || typeof raw.cachedInputTokens !== "number"
    || typeof raw.outputTokens !== "number"
    || typeof raw.reasoningOutputTokens !== "number"
    || typeof raw.totalTokens !== "number"
    || !Number.isFinite(raw.inputTokens)
    || !Number.isFinite(raw.cachedInputTokens)
    || !Number.isFinite(raw.outputTokens)
    || !Number.isFinite(raw.reasoningOutputTokens)
    || !Number.isFinite(raw.totalTokens)
  ) {
    return null;
  }
  return ccsCostTokenUsageRecord(raw as CcsCostTokenUsageRecord);
}

async function buildCentralCcsCostReport(options: CcsCostOptions): Promise<CcsCostReportPayload> {
  const derived = await readCcsCostDerivedStore();
  const priceCache = await readModelPriceCache();
  const priceFingerprint = await ccsCostPriceFingerprint();
  const cacheKey = ccsCostReportCacheKey(derived.snapshotFingerprint, priceFingerprint, options);
  const cached = ccsCostReportCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const report = buildCcsCostReportFromDerived(derived, options, priceCache);
  ccsCostReportCache.set(cacheKey, report);
  return report;
}

async function buildCcsCostStatus(): Promise<CcsCostStatus> {
  const derived = await readCcsCostDerivedStore();
  const priceCache = await readModelPriceCache();
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    snapshotCount: derived.machines.length,
    machines: derived.machines.map((machine) => {
      const metrics = ccsCostMetricsFromDerivedAggregate(machine.aggregate, priceCache, "auto");
      return {
        machine: machine.machine,
        generatedAt: machine.generatedAt,
        speed: machine.speed,
        events: machine.events,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        costUSD: metrics.costUSD,
      };
    }).sort((left, right) => left.machine.localeCompare(right.machine)),
  };
}

async function refreshCentralCcsCostDerivedStore(): Promise<{ fingerprint: string; reports: number }> {
  const derived = await buildCcsCostDerivedStore();
  await writeTextFile(ccsCostDerivedPath(), stringifyJson(derived), 0o600);
  ccsCostDerivedCache = derived;
  ccsCostReportCache = new Map();
  const options = ["daily", "weekly", "monthly", "projects"]
    .map((report) => defaultCentralCcsCostOptions(report as CcsCostReport));
  for (const option of options) {
    await buildCentralCcsCostReport(option);
  }
  return { fingerprint: derived.snapshotFingerprint, reports: options.length };
}

function defaultCentralCcsCostOptions(report: CcsCostReport): CcsCostOptions {
  return {
    report,
    timezone: systemTimezone(),
    json: false,
    raw: false,
    speed: "auto",
    bucket: "1h",
    bucketMinutes: 60,
  };
}

async function ccsCostPriceFingerprint(): Promise<string> {
  try {
    const file = await stat(modelPricesCachePath());
    return `${file.size}:${file.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function ccsCostReportCacheKey(snapshotFingerprint: string, priceFingerprint: string, options: CcsCostOptions): string {
  return JSON.stringify({
    snapshotFingerprint,
    priceFingerprint,
    report: options.report,
    since: options.since ?? null,
    until: options.until ?? null,
    timezone: options.timezone,
    bucket: options.bucket,
    speed: options.speed,
    project: options.project ?? null,
    day: options.day ?? null,
  });
}

async function readCcsCostDerivedStore(): Promise<CcsCostDerivedStore> {
  const snapshotFingerprint = ccsCostSnapshotFingerprint(await readCcsCostSnapshotFiles());
  if (ccsCostDerivedCache?.snapshotFingerprint === snapshotFingerprint) {
    return ccsCostDerivedCache;
  }
  const text = await readTextIfExists(ccsCostDerivedPath());
  if (text === null) {
    throw new Error(`central ccs cost derived cache missing: ${ccsCostDerivedPath()}`);
  }
  const derived = normalizeCcsCostDerivedStore(JSON.parse(text) as unknown);
  if (!derived) {
    throw new Error(`invalid central ccs cost derived cache: ${ccsCostDerivedPath()}`);
  }
  if (derived.snapshotFingerprint !== snapshotFingerprint) {
    throw new Error(`stale central ccs cost derived cache: ${ccsCostDerivedPath()}`);
  }
  ccsCostDerivedCache = derived;
  return derived;
}

async function buildCcsCostDerivedStore(): Promise<CcsCostDerivedStore> {
  const snapshotCache = await getCcsCostSnapshotCache();
  const timezone = ccsCostDerivedTimezone(snapshotCache.snapshots);
  const derived: CcsCostDerivedStore = {
    version: 1,
    snapshotFingerprint: snapshotCache.fingerprint,
    timezone,
    generatedAt: new Date().toISOString(),
    machines: [],
    daily: {},
    projects: {},
    projectDaily: {},
    dayBuckets15m: {},
    dayProjects: {},
  };

  for (const snapshot of snapshotCache.snapshots) {
    const machineAggregate = emptyCcsCostDerivedAggregate();
    for (const event of snapshot.events) {
      addCcsCostDerivedEvent(machineAggregate, snapshot.speed, event);
      const date = ccsCostLocalDateKey(event.timestampMs, timezone);
      const bucket = ccsCostTimeBucketKey(event.timestampMs, timezone, 15);
      addCcsCostDerivedEvent(ensureCcsCostDerivedAggregate(derived.daily, date), snapshot.speed, event);
      addCcsCostDerivedEvent(ensureCcsCostDerivedAggregate(derived.projects, event.project), snapshot.speed, event);
      addCcsCostDerivedEvent(ensureCcsCostNestedDerivedAggregate(derived.projectDaily, event.project, date), snapshot.speed, event);
      addCcsCostDerivedEvent(ensureCcsCostNestedDerivedAggregate(derived.dayBuckets15m, date, bucket), snapshot.speed, event);
      addCcsCostDerivedEvent(ensureCcsCostNestedDerivedAggregate(derived.dayProjects, date, event.project), snapshot.speed, event);
    }
    derived.machines.push({
      machine: snapshot.machine,
      generatedAt: snapshot.generatedAt,
      speed: snapshot.speed,
      events: snapshot.events.length,
      aggregate: machineAggregate,
    });
  }

  derived.machines.sort((left, right) => left.machine.localeCompare(right.machine));
  return derived;
}

function ccsCostDerivedTimezone(snapshots: CcsCostSnapshot[]): string {
  const timezones = [...new Set(snapshots.map((snapshot) => snapshot.timezone).filter((timezone) => !!timezone))];
  return timezones.length === 1 ? timezones[0] : systemTimezone();
}

function buildCcsCostReportFromDerived(
  derived: CcsCostDerivedStore,
  options: CcsCostOptions,
  priceCache: ModelPriceCache,
): CcsCostReportPayload {
  if (options.timezone !== derived.timezone) {
    throw new Error(`central ccs cost derived timezone is ${derived.timezone}; requested ${options.timezone}`);
  }
  if (options.report === "daily") {
    return buildCcsCostDerivedRowsReport(options, filteredCcsCostDerivedMap(derived.daily, options), priceCache);
  }
  if (options.report === "weekly") {
    return buildCcsCostDerivedRowsReport(options, groupCcsCostDerivedDates(derived.daily, options, ccsCostWeekKey), priceCache);
  }
  if (options.report === "monthly") {
    return buildCcsCostDerivedRowsReport(options, groupCcsCostDerivedDates(derived.daily, options, (date) => date.slice(0, 7)), priceCache);
  }
  if (options.report === "projects") {
    const projects: Record<string, CcsCostDerivedAggregate> = {};
    for (const [project, dates] of Object.entries(derived.projectDaily)) {
      const aggregate = sumCcsCostDerivedAggregates(Object.entries(dates)
        .filter(([date]) => ccsCostDateInRange(date, options))
        .map(([, value]) => value));
      if (!isEmptyCcsCostDerivedAggregate(aggregate)) {
        projects[project] = aggregate;
      }
    }
    return buildCcsCostDerivedRowsReport(options, projects, priceCache, "cost-desc");
  }
  if (options.report === "project") {
    const project = options.project;
    if (!project) {
      throw new Error("usage: ccs cost project PROJECT");
    }
    return buildCcsCostDerivedRowsReport(options, filteredCcsCostDerivedMap(derived.projectDaily[project] ?? {}, options), priceCache);
  }

  const day = options.day;
  if (!day) {
    throw new Error("usage: ccs cost day YYYY-MM-DD");
  }
  const timeBuckets = groupCcsCostTimeBuckets(derived.dayBuckets15m[day] ?? {}, options.bucketMinutes);
  const projects = derived.dayProjects[day] ?? {};
  const timeRows = ccsCostRowsFromDerivedMap(timeBuckets, priceCache, options.speed);
  const projectRows = ccsCostRowsFromDerivedMap(projects, priceCache, options.speed, "cost-desc");
  return {
    version: 1,
    report: "day",
    date: day,
    timezone: options.timezone,
    bucket: options.bucket,
    totals: ccsCostMetricsFromDerivedAggregate(sumCcsCostDerivedAggregates(Object.values(projects)), priceCache, options.speed),
    timeBuckets: timeRows,
    projects: projectRows,
    source: "central",
    generatedAt: derived.generatedAt,
  };
}

function buildCcsCostDerivedRowsReport(
  options: CcsCostOptions,
  values: Record<string, CcsCostDerivedAggregate>,
  priceCache: ModelPriceCache,
  sortMode: "key-asc" | "cost-desc" = "key-asc",
): CcsCostReportPayload {
  const rows = ccsCostRowsFromDerivedMap(values, priceCache, options.speed, sortMode);
  return {
    version: 1,
    report: options.report,
    range: {
      since: options.since ?? null,
      until: options.until ?? null,
      timezone: options.timezone,
    },
    timezone: options.timezone,
    rows,
    totals: ccsCostMetricsFromDerivedAggregate(sumCcsCostDerivedAggregates(Object.values(values)), priceCache, options.speed),
    source: "central",
    generatedAt: new Date().toISOString(),
  };
}

function ccsCostRowsFromDerivedMap(
  values: Record<string, CcsCostDerivedAggregate>,
  priceCache: ModelPriceCache,
  speed: CodexCostSpeed,
  sortMode: "key-asc" | "cost-desc" = "key-asc",
): CcsCostReportRowRecord[] {
  const rows = Object.entries(values).map(([key, aggregate]) => ({
    key,
    ...ccsCostMetricsFromDerivedAggregate(aggregate, priceCache, speed),
  }));
  if (sortMode === "cost-desc") {
    return rows.sort((left, right) => right.costUSD - left.costUSD || left.key.localeCompare(right.key));
  }
  return rows.sort((left, right) => left.key.localeCompare(right.key));
}

function filteredCcsCostDerivedMap(
  values: Record<string, CcsCostDerivedAggregate>,
  options: CcsCostOptions,
): Record<string, CcsCostDerivedAggregate> {
  return Object.fromEntries(Object.entries(values).filter(([date]) => ccsCostDateInRange(date, options)));
}

function groupCcsCostDerivedDates(
  values: Record<string, CcsCostDerivedAggregate>,
  options: CcsCostOptions,
  keyOf: (date: string) => string,
): Record<string, CcsCostDerivedAggregate> {
  const grouped: Record<string, CcsCostDerivedAggregate> = {};
  for (const [date, aggregate] of Object.entries(values)) {
    if (!ccsCostDateInRange(date, options)) {
      continue;
    }
    mergeCcsCostDerivedAggregate(ensureCcsCostDerivedAggregate(grouped, keyOf(date)), aggregate);
  }
  return grouped;
}

function groupCcsCostTimeBuckets(
  values: Record<string, CcsCostDerivedAggregate>,
  bucketMinutes: number,
): Record<string, CcsCostDerivedAggregate> {
  const grouped: Record<string, CcsCostDerivedAggregate> = {};
  for (const [bucket, aggregate] of Object.entries(values)) {
    mergeCcsCostDerivedAggregate(ensureCcsCostDerivedAggregate(grouped, ccsCostMergedBucketKey(bucket, bucketMinutes)), aggregate);
  }
  return grouped;
}

function ccsCostDateInRange(date: string, options: CcsCostOptions): boolean {
  return (!options.since || date >= options.since) && (!options.until || date <= options.until);
}

function ccsCostMetricsFromDerivedAggregate(
  aggregate: CcsCostDerivedAggregate,
  priceCache: ModelPriceCache,
  speed: CodexCostSpeed,
): CcsCostMetricsRecord {
  const standard = ccsCostRecordToAggregate(aggregate.standard);
  const fast = ccsCostRecordToAggregate(aggregate.fast);
  const total = ccsCostRecordToAggregate(sumCcsCostAggregateRecords([aggregate.standard, aggregate.fast]));
  let costUSD: number;
  if (speed === "auto") {
    assertCcsCostPricing(standard, { priceCache, speed: "standard" });
    assertCcsCostPricing(fast, { priceCache, speed: "fast" });
    costUSD = ccsCostOf(standard, { priceCache, speed: "standard" }) + ccsCostOf(fast, { priceCache, speed: "fast" });
  } else {
    assertCcsCostPricing(total, { priceCache, speed });
    costUSD = ccsCostOf(total, { priceCache, speed });
  }
  return {
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    costUSD: roundCostUSD(costUSD),
  };
}

function ensureCcsCostDerivedAggregate(
  values: Record<string, CcsCostDerivedAggregate>,
  key: string,
): CcsCostDerivedAggregate {
  values[key] ??= emptyCcsCostDerivedAggregate();
  return values[key];
}

function ensureCcsCostNestedDerivedAggregate(
  values: Record<string, Record<string, CcsCostDerivedAggregate>>,
  first: string,
  second: string,
): CcsCostDerivedAggregate {
  values[first] ??= {};
  return ensureCcsCostDerivedAggregate(values[first], second);
}

function emptyCcsCostDerivedAggregate(): CcsCostDerivedAggregate {
  return {
    standard: emptyCcsCostAggregateRecord(),
    fast: emptyCcsCostAggregateRecord(),
  };
}

function emptyCcsCostAggregateRecord(): CcsCostAggregateRecord {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    modelUsage: {},
  };
}

function addCcsCostDerivedEvent(
  aggregate: CcsCostDerivedAggregate,
  speed: ResolvedCodexCostSpeed,
  event: CcsCostSnapshotEvent,
): void {
  addCcsCostAggregateRecordUsage(aggregate[speed], event.model, event.usage);
}

function addCcsCostAggregateRecordUsage(
  aggregate: CcsCostAggregateRecord,
  model: string,
  usage: CcsCostTokenUsageRecord,
): void {
  aggregate.inputTokens += usage.inputTokens;
  aggregate.cachedInputTokens += usage.cachedInputTokens;
  aggregate.outputTokens += usage.outputTokens;
  aggregate.reasoningOutputTokens += usage.reasoningOutputTokens;
  aggregate.totalTokens += usage.totalTokens;
  const modelUsage = aggregate.modelUsage[model] ?? {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  modelUsage.inputTokens += usage.inputTokens;
  modelUsage.cachedInputTokens += usage.cachedInputTokens;
  modelUsage.outputTokens += usage.outputTokens;
  modelUsage.reasoningOutputTokens += usage.reasoningOutputTokens;
  modelUsage.totalTokens += usage.totalTokens;
  aggregate.modelUsage[model] = modelUsage;
}

function mergeCcsCostDerivedAggregate(target: CcsCostDerivedAggregate, source: CcsCostDerivedAggregate): void {
  mergeCcsCostAggregateRecord(target.standard, source.standard);
  mergeCcsCostAggregateRecord(target.fast, source.fast);
}

function mergeCcsCostAggregateRecord(target: CcsCostAggregateRecord, source: CcsCostAggregateRecord): void {
  for (const [model, usage] of Object.entries(source.modelUsage)) {
    addCcsCostAggregateRecordUsage(target, model, usage);
  }
}

function sumCcsCostDerivedAggregates(values: CcsCostDerivedAggregate[]): CcsCostDerivedAggregate {
  const total = emptyCcsCostDerivedAggregate();
  for (const value of values) {
    mergeCcsCostDerivedAggregate(total, value);
  }
  return total;
}

function sumCcsCostAggregateRecords(values: CcsCostAggregateRecord[]): CcsCostAggregateRecord {
  const total = emptyCcsCostAggregateRecord();
  for (const value of values) {
    mergeCcsCostAggregateRecord(total, value);
  }
  return total;
}

function isEmptyCcsCostDerivedAggregate(value: CcsCostDerivedAggregate): boolean {
  return value.standard.totalTokens === 0 && value.fast.totalTokens === 0;
}

function ccsCostRecordToAggregate(record: CcsCostAggregateRecord): CodexUsageAggregate {
  return {
    inputTokens: record.inputTokens,
    cachedInputTokens: record.cachedInputTokens,
    outputTokens: record.outputTokens,
    reasoningOutputTokens: record.reasoningOutputTokens,
    totalTokens: record.totalTokens,
    modelUsage: new Map(Object.entries(record.modelUsage)),
  };
}

function ccsCostLocalDateKey(timestampMs: number, timezone: string): string {
  return DateTime.fromMillis(timestampMs, { zone: timezone }).toISODate() ?? "";
}

function ccsCostWeekKey(date: string): string {
  return DateTime.fromISO(date, { zone: "UTC" }).startOf("week").toISODate() ?? date;
}

function ccsCostTimeBucketKey(timestampMs: number, timezone: string, bucketMinutes: number): string {
  const local = DateTime.fromMillis(timestampMs, { zone: timezone });
  const minuteOfDay = local.hour * 60 + local.minute;
  const startMinute = Math.floor(minuteOfDay / bucketMinutes) * bucketMinutes;
  const endMinute = Math.min(24 * 60, startMinute + bucketMinutes);
  return `${formatCcsCostMinuteOfDay(startMinute)}-${formatCcsCostMinuteOfDay(endMinute)}`;
}

function ccsCostMergedBucketKey(bucket: string, bucketMinutes: number): string {
  const match = /^(\d\d):(\d\d)-/.exec(bucket);
  if (!match) {
    throw new Error(`invalid ccs cost bucket: ${bucket}`);
  }
  const minuteOfDay = Number(match[1]) * 60 + Number(match[2]);
  const startMinute = Math.floor(minuteOfDay / bucketMinutes) * bucketMinutes;
  const endMinute = Math.min(24 * 60, startMinute + bucketMinutes);
  return `${formatCcsCostMinuteOfDay(startMinute)}-${formatCcsCostMinuteOfDay(endMinute)}`;
}

function formatCcsCostMinuteOfDay(value: number): string {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

function normalizeCcsCostDerivedStore(value: unknown): CcsCostDerivedStore | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<CcsCostDerivedStore>;
  if (
    raw.version !== 1
    || typeof raw.snapshotFingerprint !== "string"
    || typeof raw.timezone !== "string"
    || typeof raw.generatedAt !== "string"
    || !Array.isArray(raw.machines)
    || !raw.daily
    || !raw.projects
    || !raw.projectDaily
    || !raw.dayBuckets15m
    || !raw.dayProjects
  ) {
    return null;
  }
  return raw as CcsCostDerivedStore;
}

function ccsCostStatusUrl(stateUrl: string): string {
  const url = new URL(stateUrl);
  url.pathname = url.pathname.endsWith("/ccs/top/state")
    ? url.pathname.replace(/\/ccs\/top\/state$/, "/ccs/cost/status")
    : "/ccs/cost/status";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function ccsCostRefreshUrl(stateUrl: string): string {
  const url = new URL(stateUrl);
  url.pathname = url.pathname.endsWith("/ccs/top/state")
    ? url.pathname.replace(/\/ccs\/top\/state$/, "/ccs/cost/refresh")
    : "/ccs/cost/refresh";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function ccsCostReportUrl(stateUrl: string, options: CcsCostOptions): string {
  const url = new URL(stateUrl);
  url.pathname = url.pathname.endsWith("/ccs/top/state")
    ? url.pathname.replace(/\/ccs\/top\/state$/, "/ccs/cost/report")
    : "/ccs/cost/report";
  url.search = "";
  url.hash = "";
  url.searchParams.set("report", options.report);
  url.searchParams.set("timezone", options.timezone);
  url.searchParams.set("speed", options.speed);
  if (options.since) {
    url.searchParams.set("since", options.since);
  }
  if (options.until) {
    url.searchParams.set("until", options.until);
  }
  if (options.project) {
    url.searchParams.set("project", options.project);
  }
  if (options.day) {
    url.searchParams.set("day", options.day);
  }
  if (options.report === "day") {
    url.searchParams.set("bucket", options.bucket);
  }
  return url.toString();
}

async function fetchCentralCcsCostReport(url: string): Promise<CentralCcsCostReportFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ccsCostReportHttpTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return { report: null, error: `HTTP ${response.status}${formatCcsCostFetchBody(text)}` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { report: null, error: `invalid JSON: ${message}` };
    }
    const report = normalizeCcsCostReportPayload(raw);
    return report ? { report } : { report: null, error: "invalid report response shape" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { report: null, error: `timeout after ${ccsCostReportHttpTimeoutMs / 1000}s` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { report: null, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

function formatCcsCostFetchBody(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  return compact ? `: ${compact.slice(0, 200)}` : "";
}

async function fetchCentralCcsCostStatus(url: string): Promise<CcsCostStatus | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), usageTopHistoryHttpTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return normalizeCcsCostStatus(await response.json() as unknown);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function printCentralCcsCostStatus(profiles: ProfilesFile): Promise<void> {
  for (const stateUrl of await readUsageTopStateUrls(profiles)) {
    const url = ccsCostStatusUrl(stateUrl);
    const status = await fetchCentralCcsCostStatus(url);
    if (status) {
      console.log(textBold("ccs cost central"));
      printKeyValue("source:", colorUrl(url), 9);
      printKeyValue("machines:", status.snapshotCount.toString(), 9);
      if (status.machines.length === 0) {
        console.log(textDim("no uploaded cost snapshots"));
        return;
      }
      printTable([
        ["machine", "speed", "events", "input", "output", "cost", "updated"],
        ...status.machines.map((machine) => [
          colorName(machine.machine),
          machine.speed,
          formatInteger(machine.events),
          colorInput(formatCcsCostTokens(machine.inputTokens, false)),
          colorOutput(formatCcsCostTokens(machine.outputTokens, false)),
          colorCost(formatCcsCostUSD(machine.costUSD, false)),
          textDim(formatClockTime(new Date(machine.generatedAt))),
        ]),
      ], ["left", "left", "right", "right", "right", "right", "right"]);
      return;
    }
  }
  throw new Error("central ccs cost status unavailable");
}

async function printCentralCcsCost(profiles: ProfilesFile, options: CcsCostOptions): Promise<void> {
  const errors: string[] = [];
  for (const stateUrl of await readUsageTopStateUrls(profiles)) {
    const url = ccsCostReportUrl(stateUrl, options);
    const { report, error } = await fetchCentralCcsCostReport(url);
    if (report) {
      printCcsCostReport(report, options);
      if (!options.json) {
        printKeyValue("source:", colorUrl(url), 7);
      }
      return;
    }
    errors.push(`${url}: ${error ?? "unknown error"}`);
  }
  throw new Error(`central ccs cost report unavailable: ${errors.join("; ")}`);
}

function normalizeCcsCostStatus(value: unknown): CcsCostStatus | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<CcsCostStatus>;
  if (
    raw.version !== 1
    || typeof raw.updatedAt !== "string"
    || typeof raw.snapshotCount !== "number"
    || !Array.isArray(raw.machines)
  ) {
    return null;
  }
  const machines = raw.machines.map(normalizeCcsCostSnapshotSummary);
  if (machines.some((machine) => !machine)) {
    return null;
  }
  return {
    version: 1,
    updatedAt: raw.updatedAt,
    snapshotCount: raw.snapshotCount,
    machines: machines as CcsCostSnapshotSummary[],
  };
}

function normalizeCcsCostSnapshotSummary(value: unknown): CcsCostSnapshotSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<CcsCostSnapshotSummary>;
  if (
    typeof raw.machine !== "string"
    || typeof raw.generatedAt !== "string"
    || (raw.speed !== "standard" && raw.speed !== "fast")
    || typeof raw.events !== "number"
    || typeof raw.inputTokens !== "number"
    || typeof raw.outputTokens !== "number"
    || typeof raw.costUSD !== "number"
    || !Number.isFinite(raw.events)
    || !Number.isFinite(raw.inputTokens)
    || !Number.isFinite(raw.outputTokens)
    || !Number.isFinite(raw.costUSD)
  ) {
    return null;
  }
  return {
    machine: raw.machine,
    generatedAt: raw.generatedAt,
    speed: raw.speed,
    events: raw.events,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    costUSD: raw.costUSD,
  };
}

function normalizeCcsCostReportPayload(value: unknown): CcsCostReportPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<CcsCostReportPayload>;
  if (
    raw.version !== 1
    || typeof raw.report !== "string"
    || !ccsCostReports.has(raw.report)
    || typeof raw.timezone !== "string"
    || !raw.totals
    || typeof raw.source !== "string"
    || typeof raw.generatedAt !== "string"
  ) {
    return null;
  }
  const totals = normalizeCcsCostMetricsRecord(raw.totals);
  if (!totals) {
    return null;
  }
  if (raw.report === "day") {
    const timeBuckets = Array.isArray(raw.timeBuckets)
      ? raw.timeBuckets.map(normalizeCcsCostReportRowRecord)
      : null;
    const projects = Array.isArray(raw.projects)
      ? raw.projects.map(normalizeCcsCostReportRowRecord)
      : null;
    if (!timeBuckets || !projects || timeBuckets.some((row) => !row) || projects.some((row) => !row)) {
      return null;
    }
    return {
      version: 1,
      report: "day",
      date: typeof raw.date === "string" ? raw.date : undefined,
      timezone: raw.timezone,
      bucket: raw.bucket,
      totals,
      timeBuckets: timeBuckets as CcsCostReportRowRecord[],
      projects: projects as CcsCostReportRowRecord[],
      source: raw.source === "central" ? "central" : "local",
      generatedAt: raw.generatedAt,
    };
  }
  const rows = Array.isArray(raw.rows)
    ? raw.rows.map(normalizeCcsCostReportRowRecord)
    : null;
  if (!rows || rows.some((row) => !row)) {
    return null;
  }
  return {
    version: 1,
    report: raw.report as CcsCostReport,
    range: raw.range,
    timezone: raw.timezone,
    rows: rows as CcsCostReportRowRecord[],
    totals,
    source: raw.source === "central" ? "central" : "local",
    generatedAt: raw.generatedAt,
  };
}

function normalizeCcsCostReportRowRecord(value: unknown): CcsCostReportRowRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<CcsCostReportRowRecord>;
  const metrics = normalizeCcsCostMetricsRecord(raw);
  return metrics && typeof raw.key === "string" ? { key: raw.key, ...metrics } : null;
}

function normalizeCcsCostMetricsRecord(value: unknown): CcsCostMetricsRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<CcsCostMetricsRecord>;
  if (
    typeof raw.inputTokens !== "number"
    || typeof raw.outputTokens !== "number"
    || typeof raw.costUSD !== "number"
    || !Number.isFinite(raw.inputTokens)
    || !Number.isFinite(raw.outputTokens)
    || !Number.isFinite(raw.costUSD)
  ) {
    return null;
  }
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    costUSD: raw.costUSD,
  };
}

function assertCcsCostPricing(aggregate: CodexUsageAggregate, context: CcsCostContext): void {
  const missing = missingPricingModels(aggregate.modelUsage, context.priceCache, context.speed);
  if (missing.length > 0) {
    throw new Error(`missing pricing models: ${missing.join(", ")}; cache: ${modelPricesCachePath()}`);
  }
}

function ccsCostOf(aggregate: CodexUsageAggregate, context: CcsCostContext): number {
  return calculateCodexCostUSD(aggregate.modelUsage, context.priceCache, context.speed);
}

function formatCcsCostRange(options: CcsCostOptions): string {
  if (options.since && options.until) {
    return `${options.since}..${options.until}`;
  }
  if (options.since) {
    return `${options.since}..`;
  }
  if (options.until) {
    return `..${options.until}`;
  }
  return "all";
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCcsCostTokens(value: number, raw: boolean): string {
  return raw ? formatInteger(value) : prettifyBigNum(value);
}

function formatCcsCostUSD(value: number, raw: boolean): string {
  return raw ? formatCost(value) : `$${Math.round(value).toLocaleString("en-US")}`;
}

function formatCcsCostProjectPath(value: string): string {
  return colorPath(formatProjectPath(value));
}

function roundCostUSD(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function printUsageHelp(): void {
  console.log(textDim("commands: ccs | PROFILE | run PROFILE [ARGS] | cost [push|central|daily|weekly|monthly|projects|project|day] | [toggle|add|rm] [PROFILE] | top | config [push|pull] | s [line|agent|server|history|pause|resume|reset|wezterm] | list [-u] | usage | init | sync"));
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

  if (command === "cost") {
    await runCcsCost(args, profiles);
    return;
  }

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

  if (command === "run") {
    if (isHelpArgument(args[0])) {
      assertExactArgs(args.slice(1), "run help", 0);
      printHelp();
      return;
    }
    await runCodexWithProfile(profiles, args[0], args.slice(1));
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
