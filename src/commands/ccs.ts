import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
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

async function ensureProfilesFile(): Promise<ProfilesFile> {
  const existing = await readProfiles();
  if (existing.profiles && Object.keys(existing.profiles).length > 0) {
    return existing;
  }

  const initial = {
    profiles: {
      input: {
        baseURL: "https://ai.input.im",
        apiKey: "",
      },
      ciii: {
        baseURL: "https://codex.ciii.club",
        apiKey: "",
      },
    },
    current: "input",
  };

  await writeProfiles(initial);
  return initial;
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
    "ccs input",
    "ccs ciii",
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

  if (command === "input" || command === "ciii") {
    await switchProfile(command);
    return;
  }

  console.error(`unknown command: ${basename(command)}`);
  process.exitCode = 1;
}
