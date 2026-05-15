import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, readTextIfExists, writeTextFile } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexAuthPath, codexConfigPath, codexDir, profilesPath } from "../lib/paths.js";
import { maskSecret } from "../lib/text.js";
import { readTomlBaseUrl, updateTomlBaseUrl } from "../lib/toml.js";

type Profile = {
  baseURL: string;
  apiKey: string;
};

type ProfilesFile = {
  profiles?: Record<string, Profile>;
  current?: string;
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

function profileNameForCurrent(defaults: ProfilesFile, current: Profile): string {
  const profiles = defaults.profiles ?? {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.baseURL === current.baseURL) {
      return name;
    }
  }
  return current.baseURL ? "current" : (defaults.current ?? "input");
}

async function initProfilesFromCurrent(): Promise<ProfilesFile> {
  const defaults = await readDefaultProfiles();
  const current = await readCurrentCodexProfile();
  const currentName = profileNameForCurrent(defaults, current);
  const profiles: Record<string, Profile> = { ...(defaults.profiles ?? {}) };

  if (current.baseURL) {
    profiles[currentName] = {
      baseURL: current.baseURL,
      apiKey: current.apiKey,
    };
  } else if (profiles[currentName]) {
    profiles[currentName] = {
      ...profiles[currentName],
      apiKey: current.apiKey,
    };
  }

  const next = {
    profiles,
    current: currentName,
  };
  await writeProfiles(next);
  return next;
}

async function overwriteCodexConfig(baseURL?: string): Promise<void> {
  await ensureDir(codexDir());
  const defaults = await readDefaultCodexConfig();
  const next = baseURL ? updateTomlBaseUrl(defaults, baseURL) : defaults;
  await writeTextFile(codexConfigPath(), next);
}

async function syncProfiles(): Promise<ProfilesFile> {
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
  };

  await writeProfiles(next);
  return next;
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
    "  ccs          Show current profile and usage",
    "  ccs init     Read current API/key, write profiles, and overwrite ~/.codex/config.toml from template",
    "  ccs sync     Sync profile template; keep local API keys",
    "  ccs status   Show current profile",
    "  ccs list     List profiles",
    "  ccs PROFILE  Switch profile",
    "  ccs toggle   Toggle input/ciii",
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
    const initialized = await initProfilesFromCurrent();
    const profile = initialized.profiles?.[initialized.current ?? ""];
    await overwriteCodexConfig(profile?.baseURL);
    if (profile?.apiKey) {
      await writeTextFile(codexAuthPath(), stringifyJson({ OPENAI_API_KEY: profile.apiKey }), 0o600);
    }
    console.log(`profiles written: ${profilesPath()}`);
    console.log(`codex config overwritten: ${codexConfigPath()}`);
    return;
  }

  if (command === "sync") {
    const synced = await syncProfiles();
    console.log(`profiles synced: ${profilesPath()}`);
    for (const name of Object.keys(synced.profiles ?? {})) {
      console.log(`  ${name}`);
    }
    return;
  }

  if (command === "list") {
    const entries = Object.entries(profiles.profiles ?? {});
    for (const [name, profile] of entries) {
      console.log(`${name}\t${profile.baseURL}`);
    }
    return;
  }

  if (command === "status") {
    await printStatus();
    return;
  }

  if (command === "toggle") {
    const current = profiles.current === "ciii" ? "ciii" : "input";
    const next = current === "input" ? "ciii" : "input";
    await switchProfile(next);
    return;
  }

  if (profiles.profiles?.[command]) {
    await switchProfile(command);
    return;
  }

  console.error(`unknown command: ${basename(command)}`);
  process.exitCode = 1;
}
