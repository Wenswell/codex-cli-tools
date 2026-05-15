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
  maskSecret,
  textBlue,
  textBold,
  textDim,
  textGreen,
  textRed,
} from "../lib/text.js";
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

  return parseJsonObject(text) as ProfilesFile;
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

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function hasPreviewFlag(argv: string[]): boolean {
  return hasFlag(argv, "-n") || hasFlag(argv, "--dry-run");
}

function hasYesFlag(argv: string[]): boolean {
  return hasFlag(argv, "-y") || hasFlag(argv, "--yes");
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
): void {
  console.log(textBold(`Plan: ${title}`));
  console.log("Dry run only. Re-run with -y or --yes to apply changes.");
  console.log(`Will modify: ${formatList(modifiedFiles)}`);
  console.log(`Will back up: ${formatList(backupFiles)}`);
  console.log(`Warnings: ${warnings.length}`);
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

async function printInitDryRun(): Promise<void> {
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

  printPreviewSummary(
    "ccs init",
    previewFiles.map((file) => file.label),
    backupFiles.map((file) => file.target),
    warnings,
  );
  for (const file of previewFiles) {
    printDiffBlock(file);
  }
  printWarnings(warnings);
}

async function printSyncDryRun(): Promise<void> {
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

  printPreviewSummary(
    "ccs sync",
    previewFiles.map((file) => file.label),
    backupFiles.map((file) => file.target),
    configSection.warnings,
  );
  for (const file of previewFiles) {
    printDiffBlock(file);
  }
  printWarnings(configSection.warnings);
}

async function addProfile(defaultName?: string): Promise<void> {
  const data = await readProfiles();
  const profiles = data.profiles ?? {};
  const input = createPrompt();
  let name = "";

  try {
    name = await askRequired(input, "name", defaultName);
    const existing = profiles[name];
    const baseURL = await askRequired(input, "baseURL", existing?.baseURL);
    const apiKey = await askOptional(input, "apiKey", existing?.apiKey);

    profiles[name] = { baseURL, apiKey };
  } finally {
    input.close();
  }

  await writeProfiles({ ...data, profiles, current: data.current ?? name });
  console.log(`profile saved: ${name}`);
}

function printProfile(name: string, profiles: ProfilesFile): void {
  const profile = profiles.profiles?.[name];
  if (!profile) {
    throw new Error(`profile not found: ${name}`);
  }
  const normalized = assertProfile(profile, name);
  console.log(`profile: ${name}`);
  console.log(`baseURL: ${normalized.baseURL}`);
  console.log(`apiKey: ${normalized.apiKey ? maskSecret(normalized.apiKey) : "(empty)"}`);
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
  console.log(`profile removed: ${name}`);
}

async function switchProfile(name: string): Promise<void> {
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

  console.log(`profile: ${name}`);
  console.log(`baseURL: ${normalized.baseURL}`);
  console.log(`apiKey: ${maskSecret(normalized.apiKey)}`);
}

async function printStatus(): Promise<void> {
  const profiles = await readProfiles();
  const current = profiles.current ?? "input";
  const profile = profiles.profiles?.[current];
  if (!profile) {
    console.log("current: none");
    console.log(`profiles: ${profilesPath()}`);
    console.log(`codex config: ${codexConfigPath()}`);
    return;
  }
  const normalized = assertProfile(profile, current);
  console.log(`current: ${current}`);
  console.log(`baseURL: ${normalized.baseURL}`);
  console.log(`apiKey: ${normalized.apiKey ? maskSecret(normalized.apiKey) : "(empty)"}`);
  console.log(`profiles: ${profilesPath()}`);
  console.log(`codex config: ${codexConfigPath()}`);
}

function printHelp(): void {
  console.log([
    "Usage:",
    "  ccs                    # show current profile and usage",
    "  ccs init [-y]          # preview init, or apply with -y",
    "  ccs sync [-y]          # preview sync, or apply with -y",
    "  ccs status             # show current profile",
    "  ccs list               # list profiles with masked keys",
    "  ccs add [PROFILE]      # add or update a profile interactively",
    "  ccs remove PROFILE     # remove a profile",
    "  ccs PROFILE            # show profile details",
    "  ccs toggle [PROFILE]   # switch profile, or toggle configured profiles",
  ].join("\n"));
}

export async function runCcs(argv: string[]): Promise<void> {
  const command = argv[0] ?? "";
  const profiles = await readProfiles();

  if (!command) {
    await printStatus();
    console.log("");
    printHelp();
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    if (hasPreviewFlag(argv.slice(1)) || !hasYesFlag(argv.slice(1))) {
      await printInitDryRun();
      return;
    }
    const nextProfiles = await planInitProfilesFromCurrent();
    const configPlan = await planCodexConfigSync();
    const currentProfilesText = (await readTextIfExists(profilesPath())) ?? "";
    const currentConfigText = (await readTextIfExists(codexConfigPath())) ?? "";
    const currentAuthText = (await readTextIfExists(codexAuthPath())) ?? "";
    const nextCurrentProfile = nextProfiles.profiles?.[nextProfiles.current ?? ""];
    const nextAuthText = nextCurrentProfile?.apiKey
      ? stringifyJson({ OPENAI_API_KEY: nextCurrentProfile.apiKey })
      : currentAuthText;
    const backupFiles = await collectExistingBackupFilesForPaths(
      collectChangedPreviewFiles([
        { label: "profiles.json", path: profilesPath(), current: currentProfilesText, next: stringifyJson(nextProfiles) },
        { label: "config.toml", path: codexConfigPath(), current: currentConfigText, next: configPlan.nextContent },
        { label: "auth.json", path: codexAuthPath(), current: currentAuthText, next: nextAuthText },
      ]).map((file) => file.path),
    );
    const backupDir = await backupCcsFiles(backupFiles);
    const initialized = await initProfilesFromCurrent();
    await syncCodexConfigFromTemplate();
    const profile = initialized.profiles?.[initialized.current ?? ""];
    if (profile?.apiKey) {
      await writeTextFile(codexAuthPath(), stringifyJson({ OPENAI_API_KEY: profile.apiKey }), 0o600);
    }
    if (backupDir) {
      console.log(`backup: ${backupDir}`);
    }
    console.log(`profiles written: ${profilesPath()}`);
    console.log(`codex config synced: ${codexConfigPath()}`);
    return;
  }

  if (command === "sync") {
    if (hasPreviewFlag(argv.slice(1)) || !hasYesFlag(argv.slice(1))) {
      await printSyncDryRun();
      return;
    }
    const nextProfiles = await planSyncProfiles();
    const configPlan = await planCodexConfigSync();
    const backupFiles = await collectExistingBackupFilesForPaths(
      collectChangedPreviewFiles([
        {
          label: "profiles.json",
          path: profilesPath(),
          current: (await readTextIfExists(profilesPath())) ?? "",
          next: stringifyJson(nextProfiles),
        },
        {
          label: "config.toml",
          path: codexConfigPath(),
          current: (await readTextIfExists(codexConfigPath())) ?? "",
          next: configPlan.nextContent,
        },
      ]).map((file) => file.path),
    );
    const backupDir = await backupCcsFiles(backupFiles);
    const synced = await syncProfiles();
    await syncCodexConfigFromTemplate();
    if (backupDir) {
      console.log(`backup: ${backupDir}`);
    }
    console.log(`profiles synced: ${profilesPath()}`);
    console.log(`codex config synced: ${codexConfigPath()}`);
    for (const name of Object.keys(synced.profiles ?? {})) {
      console.log(`  ${name}`);
    }
    return;
  }

  if (command === "list") {
    const entries = Object.entries(profiles.profiles ?? {});
    for (const [name, profile] of entries) {
      console.log(`${name}\t${profile.baseURL}\t${profile.apiKey ? maskSecret(profile.apiKey) : "(empty)"}`);
    }
    return;
  }

  if (command === "add") {
    await addProfile(argv[1]);
    return;
  }

  if (command === "remove" || command === "rm" || command === "delete") {
    await removeProfile(argv[1]);
    return;
  }

  if (command === "status") {
    await printStatus();
    return;
  }

  if (command === "toggle") {
    if (argv[1]) {
      await switchProfile(argv[1]);
      return;
    }

    const toggle = profiles.toggle ?? [];
    if (toggle.length < 2) {
      throw new Error("toggle requires at least two profile names in profiles.json toggle");
    }
    const index = Math.max(0, toggle.indexOf(profiles.current ?? ""));
    const next = toggle[(index + 1) % toggle.length];
    await switchProfile(next);
    return;
  }

  if (profiles.profiles?.[command]) {
    printProfile(command, profiles);
    return;
  }

  console.error(`unknown command: ${basename(command)}`);
  process.exitCode = 1;
}
