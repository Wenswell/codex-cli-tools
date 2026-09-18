import { readTextIfExists, writeTextFileAtomic } from "./fs.js";
import { parseJsonObject, stringifyJson } from "./json.js";
import { profilesPath } from "./paths.js";
import type { ModelPriceOverride } from "./pricing.js";

export type Profile = {
  baseURL: string;
  apiKey: string;
  /** Convert Codex Responses traffic for a Chat Completions-only provider. */
  routeConversion?: {
    /** Convert Responses requests to Chat Completions and responses back. */
    enabled: boolean;
  };
};

export type ProxySearchConfig = {
  enabled: boolean;
  profile?: string;
};

export type CimgConfig = {
  profile?: string;
  model?: string;
  ratio?: string;
  size?: string;
  quality?: string;
  outputDir?: string;
};

export type ProfilesFile = {
  profiles?: Record<string, Profile>;
  proxy?: {
    /** Route Codex alpha search requests to this profile when enabled. */
    search?: ProxySearchConfig;
  };
  cimg?: CimgConfig;
  usage?: Record<string, Profile>;
  current?: string;
  toggle?: string[];
  pricing?: {
    overrides?: Record<string, ModelPriceOverride>;
  };
  top?: {
    stateUrls?: string[];
  };
};

export function assertProfile(value: unknown, name: string): Profile {
  if (!value || typeof value !== "object") {
    throw new Error(`profile ${name} is invalid`);
  }

  const profile = value as Partial<Profile>;
  if (typeof profile.baseURL !== "string" || typeof profile.apiKey !== "string") {
    throw new Error(`profile ${name} is missing baseURL or apiKey`);
  }

  const result: Profile = {
    baseURL: profile.baseURL,
    apiKey: profile.apiKey,
  };

  if (profile.routeConversion !== undefined) {
    if (
      !profile.routeConversion
      || typeof profile.routeConversion !== "object"
      || !Object.hasOwn(profile.routeConversion, "enabled")
      || typeof profile.routeConversion.enabled !== "boolean"
    ) {
      throw new Error(`profile ${name} has invalid routeConversion`);
    }
    result.routeConversion = { enabled: profile.routeConversion.enabled };
  }

  return result;
}

export async function readProfiles(): Promise<ProfilesFile> {
  const text = await readTextIfExists(profilesPath());
  if (!text) {
    return {};
  }

  try {
    const profiles = parseJsonObject(text) as ProfilesFile;
    assertProxySearch(profiles.proxy?.search);
    assertCimgConfig(profiles.cimg);
    return profiles;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid profiles.json: ${message}`);
  }
}

function assertProxySearch(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid profiles.json: proxy.search must be an object");
  }
  const search = value as Partial<ProxySearchConfig>;
  if (typeof search.enabled !== "boolean") {
    throw new Error("invalid profiles.json: proxy.search.enabled must be boolean");
  }
  if (search.profile !== undefined && (typeof search.profile !== "string" || !search.profile.trim())) {
    throw new Error("invalid profiles.json: proxy.search.profile must be a non-empty profile name");
  }
  if (search.enabled && !search.profile) {
    throw new Error("invalid profiles.json: proxy.search.profile is required when search is enabled");
  }
}

function assertCimgConfig(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid profiles.json: cimg must be an object");
  }
  const config = value as Record<string, unknown>;
  const allowedKeys = new Set(["profile", "model", "ratio", "size", "quality", "outputDir"]);
  for (const [key, val] of Object.entries(config)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`invalid profiles.json: cimg has unknown key: ${key}`);
    }
    if (val !== undefined && (typeof val !== "string" || !val.trim())) {
      throw new Error(`invalid profiles.json: cimg.${key} must be a non-empty string`);
    }
  }
}

export async function writeProfiles(profiles: ProfilesFile): Promise<void> {
  await writeTextFileAtomic(profilesPath(), stringifyJson(profiles), 0o600);
}
