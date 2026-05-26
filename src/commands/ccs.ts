import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createTwoFilesPatch } from "diff";
import { ensureDir, readTextIfExists, writeTextFile } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import {
  codexAuthPath,
  codexConfigPath,
  codexDir,
  codexToolsConfigDir,
  profilesPath,
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

const usageTopMinIntervalMs = 25_000;
const usageTopStepIntervalMs = 30_000;
const usageTopMaxIntervalMs = 300_000;
const usageTopMaxIntervalIdleLimit = 3;
const usageTopTickMs = 1000;
const usageTopChangeTtlMs = 60 * 60 * 1000;
const usageTopChangeColorTtlMs = 60 * 1000;
const usageTopStatusWidth = 24;

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
  const currentAuthText = (await readTextIfExists(codexAuthPath())) ?? "";
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
  ]);
  const backupFiles = await collectExistingBackupFilesForPaths(previewFiles.map((file) => file.path));

  return {
    title: "ccs sync",
    previewFiles,
    backupFiles,
    warnings: configSection.warnings,
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
  return `${sign}$${Math.abs(value).toFixed(1)}`;
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

async function printUsageTop(profiles: ProfilesFile, once: boolean): Promise<void> {
  const targets = collectUsageTopTargets(profiles);
  if (targets.length === 0) {
    console.log(textDim("no profiles"));
    return;
  }

  const states = new Map<string, UsageTopState>();
  let entries = await readInitialUsageTopEntries(targets, once);
  for (const entry of entries) {
    const state = states.get(entry.name) ?? {};
    updateUsageTopState(state, entry.usage, new Date());
    states.set(entry.name, state);
  }

  const writeLine = (): void => {
    const line = buildUsageTopLine(entries, states, new Date());
    if (once || !process.stdout.isTTY) {
      console.log(line);
      return;
    }
    process.stdout.write(`\r\u001b[2K${line}`);
  };

  writeLine();
  if (once) {
    return;
  }

  if (!process.stdout.isTTY) {
    throw new Error("ccs top requires a terminal unless --once is used");
  }

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void (async () => {
        const now = new Date();
        const due = entries.map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => (
            !entry.done && entry.nextRefreshAt && !entry.refreshing && now >= entry.nextRefreshAt
          ));
        for (const { index } of due) {
          entries[index] = { ...entries[index], refreshing: true };
        }
        const refreshed = await refreshUsageTopEntries(due.map(({ entry }) => entry), states, false);
        for (const [refreshedIndex, { index }] of due.entries()) {
          entries[index] = refreshed[refreshedIndex];
        }
        writeLine();
      })();
    }, usageTopTickMs);

    const refreshAll = async (): Promise<void> => {
      entries = await refreshUsageTopEntries(entries, states, true);
      writeLine();
    };

    const cleanup = (): void => {
      clearInterval(timer);
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
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
        cleanup();
      }
    };

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    }

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}

function usageLines(): string[] {
  return [
    "  ccs                                  # show current profile and usage",
    "  ccs PROFILE                          # show profile details and usage",
    "  ccs toggle [PROFILE]                 # switch profile",
    "  ccs top [--once]                     # show all usage costs in one refreshing line",
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

function printUsageHelp(): void {
  console.log(textDim("commands: ccs | PROFILE | toggle [PROFILE] | top | list [-u] | usage | init [-y] | sync [-y] | add [PROFILE] | rm PROFILE"));
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
    const profile = initialized.profiles?.[initialized.current ?? ""];
    if (profile?.apiKey) {
      await writeTextFile(codexAuthPath(), stringifyJson({ OPENAI_API_KEY: profile.apiKey }), 0o600);
    }
    if (backupDir) {
      console.log(`backup: ${textBlue(backupDir)}`);
    }
    console.log(`profiles written: ${textGreen(profilesPath())}`);
    console.log(`codex config synced: ${textGreen(codexConfigPath())}`);
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
    if (backupDir) {
      console.log(`backup: ${textBlue(backupDir)}`);
    }
    console.log(`profiles synced: ${textGreen(profilesPath())}`);
    console.log(`codex config synced: ${textGreen(codexConfigPath())}`);
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
    assertOnlyFlags(args, "top", ["--once"]);
    await printUsageTop(profiles, args.includes("--once"));
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
