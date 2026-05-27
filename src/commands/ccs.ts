import { rename } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createTwoFilesPatch } from "diff";
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
    stateUrl?: string;
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
  entries: UsageTopSnapshotEntry[];
};

type UsageTopSnapshotSource = {
  snapshot: UsageTopSnapshot;
  remote: boolean;
};

type WeztermOptions = {
  yes: boolean;
  remove: boolean;
};

const usageTopMinIntervalMs = 25_000;
const usageTopStepIntervalMs = 30_000;
const usageTopMaxIntervalMs = 300_000;
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
  };
  return next;
}

async function syncProfiles(): Promise<ProfilesFile> {
  const next = await planSyncProfiles();
  await writeProfiles(next);
  return next;
}

function assertNameAvailable(name: string, profiles: ProfilesFile, target: "profiles" | "usage"): void {
  const other = target === "profiles" ? profiles.usage : profiles.profiles;
  if (other?.[name]) {
    throw new Error(`${name} already exists in ${target === "profiles" ? "usage" : "profiles"}`);
  }
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function hasYesFlag(argv: string[]): boolean {
  return hasFlag(argv, "-y") || hasFlag(argv, "--yes");
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
    console.log(textDim("preview only. Re-run with -y or --yes to apply changes."));
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
    "\t\tvalue = \" | ccs status inactive\"",
    "\tend",
    "\treturn os.date(\"%H:%M:%S\") .. value",
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

async function printInitDryRun(): Promise<void> {
  printPreviewPlan(await buildInitPreviewPlan(), true);
}

async function printSyncDryRun(): Promise<void> {
  printPreviewPlan(await buildSyncPreviewPlan(), true);
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
  resetInterval: boolean,
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
    const interval = resetInterval
      ? usageTopMinIntervalMs
      : nextUsageTopInterval(entry.refreshIntervalMs, changed);
    const maxIntervalIdleCount = resetInterval
      ? 0
      : nextUsageTopMaxIdleCount(entry, changed, interval);
    const done = !resetInterval && maxIntervalIdleCount >= usageTopMaxIntervalIdleLimit;

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

async function refreshDueUsageTopRuntime(runtime: UsageTopRuntime, now: Date): Promise<void> {
  const due = runtime.entries.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (
      !entry.done && entry.nextRefreshAt && !entry.refreshing && now >= entry.nextRefreshAt
    ));
  for (const { index } of due) {
    runtime.entries[index] = { ...runtime.entries[index], refreshing: true };
  }
  const refreshed = await refreshUsageTopEntries(due.map(({ entry }) => entry), runtime.states, false);
  for (const [refreshedIndex, { index }] of due.entries()) {
    runtime.entries[index] = refreshed[refreshedIndex];
  }
}

async function refreshAllUsageTopRuntime(runtime: UsageTopRuntime): Promise<void> {
  runtime.entries = await refreshUsageTopEntries(runtime.entries, runtime.states, true);
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

function formatStatusLineRefresh(entries: UsageTopSnapshotEntry[], now: Date): string {
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
  const refresh = formatStatusLineRefresh(snapshot.entries, stateNow);
  return `${refresh ? ` ${refresh}` : ""} | ${parts.join(" | ")}`;
}

function renderUsageTopStatusLine(snapshot: UsageTopSnapshot, displayNow: Date, stateNow: Date): string {
  return `${formatStatusLineClock(displayNow)}${renderUsageTopStatusSuffix(snapshot, stateNow)}`;
}

function usageTopSnapshotPath(): string {
  return join(codexToolsCacheDir(), "ccs-top-state.json");
}

function usageTopStatusTextPath(): string {
  return join(codexToolsCacheDir(), "ccs-top-status.txt");
}

function usageTopStateUrlPath(): string {
  return join(codexToolsConfigDir(), "top-state-url");
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

function buildUsageTopSnapshot(
  entries: UsageTopEntry[],
  states: Map<string, UsageTopState>,
  now: Date,
  active: boolean,
): UsageTopSnapshot {
  return {
    version: 1,
    active,
    pid: process.pid,
    updatedAt: now.toISOString(),
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
    const value = JSON.parse(text) as Partial<UsageTopSnapshot>;
    const entries = Array.isArray(value.entries)
      ? value.entries.flatMap((entry) => {
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
      value.version === 1
      && typeof value.active === "boolean"
      && typeof value.pid === "number"
      && typeof value.updatedAt === "string"
      && entries
    ) {
      return {
        version: 1,
        active: value.active,
        pid: value.pid,
        updatedAt: value.updatedAt,
        entries,
      };
    }
  } catch {
    return null;
  }

  return null;
}

async function readUsageTopSnapshot(): Promise<UsageTopSnapshot | null> {
  return parseUsageTopSnapshot(await readTextIfExists(usageTopSnapshotPath()));
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

async function readUsageTopStateUrls(profiles: ProfilesFile): Promise<string[]> {
  const urls = [
    process.env.CCS_TOP_STATE_URL?.trim(),
    ...(profiles.top?.stateUrls ?? []).map((url) => url.trim()),
    profiles.top?.stateUrl?.trim(),
    (await readTextIfExists(usageTopStateUrlPath()))?.trim(),
  ].filter((url): url is string => !!url);
  return [...new Set(urls)];
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

async function renderCurrentUsageTopStatusSuffix(profiles: ProfilesFile, now: Date): Promise<string> {
  const source = await readActiveUsageTopStatusSource(profiles, now);
  return source ? renderUsageTopStatusSuffix(source.snapshot, source.stateNow) : " | ccs top inactive";
}

async function printUsageTopStatusLine(profiles: ProfilesFile): Promise<void> {
  const now = new Date();
  console.log(`${formatStatusLineClock(now)}${await renderCurrentUsageTopStatusSuffix(profiles, now)}`);
}

async function writeUsageTopStatusText(value: string): Promise<void> {
  const path = usageTopStatusTextPath();
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeTextFile(tmpPath, value);
  await rename(tmpPath, path);
}

async function runUsageTopStatusAgent(profiles: ProfilesFile): Promise<void> {
  const writeStatus = async (): Promise<void> => {
    const now = new Date();
    const suffix = await renderCurrentUsageTopStatusSuffix(profiles, now);
    await writeUsageTopStatusText(suffix);
    const line = `${formatStatusLineClock(now)}${suffix}`;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r\u001b[2K${line}`);
      return;
    }
    console.log(line);
  };

  await writeStatus();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void writeStatus();
    }, usageTopTickMs);

    let cleanedUp = false;
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      clearInterval(timer);
      await writeUsageTopStatusText(" | ccs top inactive");
      if (process.stdout.isTTY) {
        process.stdout.write("\n");
      }
      resolve();
    };

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
  let snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), true);
  await writeUsageTopSnapshot(snapshot);
  await writeUsageTopStatusText(renderUsageTopStatusSuffix(snapshot, new Date(snapshot.updatedAt)));

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "GET") {
      sendUsageTopJson(response, 405, { error: "method not allowed" });
      return;
    }
    if (request.url === "/health") {
      sendUsageTopJson(response, 200, { ok: true });
      return;
    }
    if (request.url === "/ccs/top/state") {
      sendUsageTopJson(response, 200, snapshot);
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
    const timer = setInterval(() => {
      void (async () => {
        await refreshDueUsageTopRuntime(runtime, new Date());
        snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), true);
        await writeUsageTopSnapshot(snapshot);
        await writeUsageTopStatusText(renderUsageTopStatusSuffix(snapshot, new Date(snapshot.updatedAt)));
      })();
    }, usageTopTickMs);

    let cleanedUp = false;
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      clearInterval(timer);
      snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), false);
      await writeUsageTopSnapshot(snapshot);
      await writeUsageTopStatusText(" | ccs top inactive");
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
        await refreshDueUsageTopRuntime(runtime, now);
        if (now.getTime() >= nextMarkAt) {
          printMarkLine();
        }
        await writeLine();
      })();
    }, usageTopTickMs);

    const refreshAll = async (): Promise<void> => {
      await refreshAllUsageTopRuntime(runtime);
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

  if (!subcommand || subcommand === "line") {
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

  if (subcommand === "wezterm") {
    const options = parseWeztermArgs(subargs);
    const previewPlan = options.remove
      ? await buildWeztermRemovePreviewPlan()
      : await buildWeztermPreviewPlan();
    if (!options.yes) {
      printPreviewPlan(previewPlan, true);
      return;
    }

    printPreviewPlan(previewPlan, false);
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
    "  ccs s [line]                         # print compact status from configured top state",
    "  ccs s agent                          # write local status text for WezTerm",
    "  ccs s server [PORT]                  # serve top state on 0.0.0.0",
    "  ccs s wezterm [-y|--yes]             # preview or install WezTerm status integration",
    "  ccs s wezterm remove [-y|--yes]      # preview or remove WezTerm status integration",
    "  ccs list | l [-u|--usage]             # list profiles; -u also shows usage profiles",
    "  ccs usage                            # list usage-only profiles",
    "  ccs usage add [PROFILE]               # add or update a usage-only profile",
    "  ccs usage remove | rm | delete PROFILE # remove a usage-only profile",
    "  ccs init [-y|--yes]                   # preview or create config",
    "  ccs sync [-y|--yes]                   # preview or sync config",
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

function parseWeztermArgs(args: string[]): WeztermOptions {
  let yes = false;
  let remove = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "remove") {
      remove = true;
      continue;
    }
    if (arg === "-y" || arg === "--yes") {
      yes = true;
      continue;
    }
    throw new Error(`unknown argument for ccs s wezterm: ${arg}`);
  }
  return { yes, remove };
}

function printUsageHelp(): void {
  console.log(textDim("commands: ccs | PROFILE | [toggle|add|rm] [PROFILE] | top | s [line|agent|server|wezterm] | list [-u] | usage | init [-y] | sync [-y]"));
}

export async function runCcs(argv: string[]): Promise<void> {
  const command = argv[0] ?? "";
  const args = argv.slice(1);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
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
    assertOnlyFlags(args, "init", ["-y", "--yes"]);
    if (!hasYesFlag(args)) {
      await printInitDryRun();
      return;
    }
    const previewPlan = await buildInitPreviewPlan();
    printPreviewPlan(previewPlan, false);
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
    assertOnlyFlags(args, "sync", ["-y", "--yes"]);
    if (!hasYesFlag(args)) {
      await printSyncDryRun();
      return;
    }
    const previewPlan = await buildSyncPreviewPlan();
    printPreviewPlan(previewPlan, false);
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
