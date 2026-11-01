import { readTextIfExists, writeTextFileAtomic } from "./fs.js";
import { parseJsonObject, stringifyJson } from "./json.js";
import { profilesPath } from "./paths.js";
export function assertProfile(value, name) {
    if (!value || typeof value !== "object") {
        throw new Error(`profile ${name} is invalid`);
    }
    const profile = value;
    if (typeof profile.baseURL !== "string" || typeof profile.apiKey !== "string") {
        throw new Error(`profile ${name} is missing baseURL or apiKey`);
    }
    const result = {
        baseURL: profile.baseURL,
        apiKey: profile.apiKey,
    };
    if (profile.routeConversion !== undefined) {
        if (!profile.routeConversion
            || typeof profile.routeConversion !== "object"
            || !Object.hasOwn(profile.routeConversion, "enabled")
            || typeof profile.routeConversion.enabled !== "boolean") {
            throw new Error(`profile ${name} has invalid routeConversion`);
        }
        result.routeConversion = { enabled: profile.routeConversion.enabled };
    }
    return result;
}
export async function readProfiles() {
    const text = await readTextIfExists(profilesPath());
    if (!text) {
        return {};
    }
    return parseProfiles(text);
}
// Validates profiles.json text. The removed `toggle` field is dropped so the next write cleans it up.
// `strict` also checks every profile entry, for files arriving from another device.
export function parseProfiles(text, label = "profiles.json", strict = false) {
    try {
        const { toggle: _removedToggle, ...profiles } = parseJsonObject(text);
        if (strict) {
            if (profiles.profiles !== undefined && (!profiles.profiles || typeof profiles.profiles !== "object" || Array.isArray(profiles.profiles))) {
                throw new Error("profiles must be an object");
            }
            for (const [name, profile] of Object.entries(profiles.profiles ?? {})) {
                assertProfile(profile, name);
            }
        }
        assertProxyRoute(profiles.proxy?.search, "search");
        assertProxyRoute(profiles.proxy?.compact, "compact");
        assertCimgConfig(profiles.cimg);
        return profiles;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid ${label}: ${message.replace(/^invalid profiles\.json: /, "")}`);
    }
}
function assertProxyRoute(value, route) {
    if (value === undefined) {
        return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`invalid profiles.json: proxy.${route} must be an object`);
    }
    const search = value;
    if (typeof search.enabled !== "boolean") {
        throw new Error(`invalid profiles.json: proxy.${route}.enabled must be boolean`);
    }
    if (search.profile !== undefined && (typeof search.profile !== "string" || !search.profile.trim())) {
        throw new Error(`invalid profiles.json: proxy.${route}.profile must be a non-empty profile name`);
    }
    if (search.enabled && !search.profile) {
        throw new Error(`invalid profiles.json: proxy.${route}.profile is required when ${route} is enabled`);
    }
}
function assertCimgConfig(value) {
    if (value === undefined) {
        return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid profiles.json: cimg must be an object");
    }
    const config = value;
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
export async function writeProfiles(profiles) {
    await writeTextFileAtomic(profilesPath(), stringifyJson(profiles), 0o600);
}
