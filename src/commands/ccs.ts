import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ensureDir, readTextIfExists, writeTextFile } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import {
  codexAuthPath,
  codexConfigPath,
  codexDir,
  codexToolsConfigDir,
  profilesPath,
} from "../lib/paths.js";
import { maskSecret } from "../lib/text.js";
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
  existingContent: string;
  nextContent: string;
  existingProvider: string | null;
  nextProvider: string;
  existingBaseURL: string | null;
  nextBaseURL: string | null;
  extraProviders: string[];
  addedSections: string[];
  removedSections: string[];
  changedTopLevelKeys: Array<{ key: string; before: string | null; after: string | null }>;
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

async function backupCcsFiles(): Promise<string | null> {
  const files = await getExistingBackupFiles();
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
  const existingProvider = readTopLevelTomlString(existing, "model_provider");
  const provider = existingProvider
    ?? readTopLevelTomlString(defaults, "model_provider")
    ?? "codex";
  const baseURL = readTomlBaseUrl(existing);
  const templateSections = new Set(listTomlSectionNames(defaults));
  const existingSections = listTomlSectionNames(existing);
  const extraProviders = existingSections
    .filter((name) => name.startsWith("model_providers.") && !templateSections.has(name))
    .map((name) => name.slice("model_providers.".length));

  let next = mergeTomlModelProviderSections(defaults, existing);
  next = updateTopLevelTomlString(next, "model_provider", provider);
  if (baseURL !== null) {
    next = updateTomlBaseUrl(next, baseURL);
  }

  const nextSections = listTomlSectionNames(next);
  const existingTopLevel = parseTopLevelAssignments(existing);
  const nextTopLevel = parseTopLevelAssignments(next);
  const topLevelKeys = new Set([...Object.keys(existingTopLevel), ...Object.keys(nextTopLevel)]);
  const changedTopLevelKeys = [...topLevelKeys]
    .filter((key) => existingTopLevel[key] !== nextTopLevel[key])
    .map((key) => ({
      key,
      before: existingTopLevel[key] ?? null,
      after: nextTopLevel[key] ?? null,
    }));

  return {
    existingContent: existing,
    nextContent: next,
    existingProvider,
    nextProvider: provider,
    existingBaseURL: baseURL,
    nextBaseURL: readTomlBaseUrl(next),
    extraProviders,
    addedSections: nextSections.filter((name) => !existingSections.includes(name)),
    removedSections: existingSections.filter((name) => !nextSections.includes(name)),
    changedTopLevelKeys,
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
  const current = await readCurrentCodexProfile();
  const profiles: Record<string, Profile> = { ...(defaults.profiles ?? {}) };

  profiles.current = {
    baseURL: current.baseURL,
    apiKey: current.apiKey,
  };

  const next = {
    ...defaults,
    profiles,
    current: "current",
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

function summarizeProfileNames(profiles: ProfilesFile): string[] {
  return Object.keys(profiles.profiles ?? {});
}

function diffProfiles(before: ProfilesFile, after: ProfilesFile): {
  added: string[];
  removed: string[];
  updated: Array<{ name: string; before: Profile; after: Profile }>;
  currentChanged: { before: string | null; after: string | null } | null;
  toggleChanged: { before: string[]; after: string[] } | null;
} {
  const beforeProfiles = before.profiles ?? {};
  const afterProfiles = after.profiles ?? {};
  const beforeNames = new Set(Object.keys(beforeProfiles));
  const afterNames = new Set(Object.keys(afterProfiles));
  const added = [...afterNames].filter((name) => !beforeNames.has(name));
  const removed = [...beforeNames].filter((name) => !afterNames.has(name));
  const updated = [...afterNames].filter((name) => {
    if (!beforeNames.has(name)) {
      return false;
    }
    const prev = beforeProfiles[name];
    const next = afterProfiles[name];
    return prev?.baseURL !== next?.baseURL || prev?.apiKey !== next?.apiKey;
  }).map((name) => ({
    name,
    before: beforeProfiles[name],
    after: afterProfiles[name],
  }));

  const beforeCurrent = before.current ?? null;
  const afterCurrent = after.current ?? null;
  const currentChanged = beforeCurrent !== afterCurrent
    ? { before: beforeCurrent, after: afterCurrent }
    : null;

  const beforeToggle = before.toggle ?? [];
  const afterToggle = after.toggle ?? [];
  const toggleChanged = beforeToggle.join("\0") !== afterToggle.join("\0")
    ? { before: beforeToggle, after: afterToggle }
    : null;

  return { added, removed, updated, currentChanged, toggleChanged };
}

function parseTopLevelAssignments(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      break;
    }
    const match = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}

function formatValue(value: string | null): string {
  return value === null || value === "" ? "(none)" : value;
}

function formatProfileSummary(profile: Profile): string {
  return `baseURL=${profile.baseURL} apiKey=${profile.apiKey ? maskSecret(profile.apiKey) : "(empty)"}`;
}

function printProfileChanges(before: ProfilesFile, after: ProfilesFile): void {
  const diff = diffProfiles(before, after);
  console.log(`profiles current: ${before.current ?? "(none)"} -> ${after.current ?? "(none)"}`);
  if (diff.toggleChanged) {
    console.log(`profiles toggle: ${diff.toggleChanged.before.join(", ") || "(none)"} -> ${diff.toggleChanged.after.join(", ") || "(none)"}`);
  }
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.updated.length === 0) {
    console.log("profiles changes: (none)");
    return;
  }
  for (const name of diff.added) {
    const profile = after.profiles?.[name];
    if (profile) {
      console.log(`+ profile ${name}: ${formatProfileSummary(profile)}`);
    }
  }
  for (const change of diff.updated) {
    console.log(`~ profile ${change.name}: ${formatProfileSummary(change.before)} -> ${formatProfileSummary(change.after)}`);
  }
  for (const name of diff.removed) {
    const profile = before.profiles?.[name];
    if (profile) {
      console.log(`- profile ${name}: ${formatProfileSummary(profile)}`);
    }
  }
}

function printConfigChanges(plan: ConfigSyncPlan): void {
  console.log(`config model_provider: ${formatValue(plan.existingProvider)} -> ${formatValue(plan.nextProvider)}`);
  console.log(`config active base_url: ${formatValue(plan.existingBaseURL)} -> ${formatValue(plan.nextBaseURL)}`);
  if (plan.changedTopLevelKeys.length === 0) {
    console.log("config top-level changes: (none)");
  } else {
    for (const change of plan.changedTopLevelKeys) {
      console.log(`~ config ${change.key}: ${formatValue(change.before)} -> ${formatValue(change.after)}`);
    }
  }
  console.log(`config added sections: ${plan.addedSections.join(", ") || "(none)"}`);
  console.log(`config removed sections: ${plan.removedSections.join(", ") || "(none)"}`);
  console.log(`config preserved extra providers: ${plan.extraProviders.join(", ") || "(none)"}`);
}

async function printInitDryRun(): Promise<void> {
  const existingProfiles = await readProfiles();
  const backupFiles = await getExistingBackupFiles();
  const nextProfiles = await planInitProfilesFromCurrent();
  const configPlan = await planCodexConfigSync();

  console.log("preview: ccs init");
  console.log(`backup dir: ${join(codexToolsConfigDir(), "backups", "ccs-YYYYMMDD-HHMMSS-mmm")}`);
  console.log(`backup files: ${backupFiles.length > 0 ? backupFiles.map((file) => file.target).join(", ") : "(none)"}`);
  console.log(`profiles target: ${profilesPath()}`);
  printProfileChanges(existingProfiles, nextProfiles);
  console.log(`config target: ${codexConfigPath()}`);
  printConfigChanges(configPlan);
  console.log("files changed: profiles.json, config.toml, auth.json(if current apiKey exists)");
}

async function printSyncDryRun(): Promise<void> {
  const existingProfiles = await readProfiles();
  const backupFiles = await getExistingBackupFiles();
  const nextProfiles = await planSyncProfiles();
  const configPlan = await planCodexConfigSync();

  console.log("preview: ccs sync");
  console.log(`backup dir: ${join(codexToolsConfigDir(), "backups", "ccs-YYYYMMDD-HHMMSS-mmm")}`);
  console.log(`backup files: ${backupFiles.length > 0 ? backupFiles.map((file) => file.target).join(", ") : "(none)"}`);
  console.log(`profiles target: ${profilesPath()}`);
  printProfileChanges(existingProfiles, nextProfiles);
  console.log(`config target: ${codexConfigPath()}`);
  printConfigChanges(configPlan);
  console.log("files changed: profiles.json, config.toml");
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
    "  ccs init [-n]          # preview or run init",
    "  ccs sync [-n]          # preview or run sync",
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
    if (hasPreviewFlag(argv.slice(1))) {
      await printInitDryRun();
      return;
    }
    const backupDir = await backupCcsFiles();
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
    if (hasPreviewFlag(argv.slice(1))) {
      await printSyncDryRun();
      return;
    }
    const backupDir = await backupCcsFiles();
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
