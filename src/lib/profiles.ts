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

export type ProfilesFile = {
  profiles?: Record<string, Profile>;
  proxy?: {
    /** Exact upstream API path to switching-profile routing. */
    pathProfiles?: Record<string, string>;
  };
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
    assertProxyPathProfiles(profiles.proxy?.pathProfiles);
    return profiles;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid profiles.json: ${message}`);
  }
}

function assertProxyPathProfiles(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid profiles.json: proxy.pathProfiles must be an object");
  }
  for (const [pathname, profile] of Object.entries(value)) {
    if (!pathname.startsWith("/") || typeof profile !== "string" || !profile.trim()) {
      throw new Error(`invalid profiles.json: proxy.pathProfiles.${pathname} must map an absolute path to a non-empty profile name`);
    }
  }
}

export async function writeProfiles(profiles: ProfilesFile): Promise<void> {
  await writeTextFileAtomic(profilesPath(), stringifyJson(profiles), 0o600);
}
