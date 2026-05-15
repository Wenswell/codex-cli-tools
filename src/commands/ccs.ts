import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, readTextIfExists, writeTextFile } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexAuthPath, codexConfigPath, codexDir, profilesPath } from "../lib/paths.js";
import { maskSecret } from "../lib/text.js";
import { updateTomlBaseUrl } from "../lib/toml.js";

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

async function ensureProfilesFile(): Promise<ProfilesFile> {
  const existing = await readProfiles();
  if (existing.profiles && Object.keys(existing.profiles).length > 0) {
    return existing;
  }

  const initial = await readDefaultProfiles();
  await writeProfiles(initial);
  return initial;
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

function help(): void {
  console.log([
    "ccs",
    "ccs status",
    "ccs init",
    "ccs sync",
    "ccs input",
    "ccs ciii",
    "ccs PROFILE",
    "ccs toggle",
    "ccs list",
  ].join("\n"));
}

export async function runCcs(argv: string[]): Promise<void> {
  const command = argv[0] ?? "";
  const profiles = await readProfiles();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    help();
    return;
  }

  if (command === "init") {
    await ensureProfilesFile();
    console.log(`profiles written: ${profilesPath()}`);
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
    const current = profiles.current ?? "input";
    const profile = profiles.profiles?.[current];
    if (!profile) {
      console.log("no active profile");
      return;
    }
    const normalized = assertProfile(profile, current);
    console.log(`current: ${current}`);
    console.log(`baseURL: ${normalized.baseURL}`);
    console.log(`apiKey: ${maskSecret(normalized.apiKey)}`);
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
