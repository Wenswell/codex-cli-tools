import { join } from "node:path";
import { readTextIfExists } from "./fs.js";
import { codexToolsCacheDir } from "./paths.js";
import { writeJsonStateAtomic } from "./runtime-log.js";
const PROFILE_USAGE_EVENTS = ["switched_at", "launched_at", "requested_at"];
export function profileUsagePath() {
    return join(codexToolsCacheDir(), "profile-usage.json");
}
// A missing or unreadable file is an empty history: these timestamps are display hints, not state.
export async function readProfileUsage() {
    const text = await readTextIfExists(profileUsagePath());
    if (!text)
        return {};
    try {
        const parsed = JSON.parse(text);
        if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object")
            return {};
        const profiles = {};
        for (const [name, entry] of Object.entries(parsed.profiles)) {
            if (!entry || typeof entry !== "object")
                continue;
            profiles[name] = Object.fromEntries(PROFILE_USAGE_EVENTS
                .filter((event) => typeof entry[event] === "string" && Number.isFinite(Date.parse(entry[event])))
                .map((event) => [event, entry[event]]));
        }
        return profiles;
    }
    catch {
        return {};
    }
}
export async function recordProfileUsage(name, event, at = new Date()) {
    const profiles = await readProfileUsage();
    profiles[name] = { ...profiles[name], [event]: at.toISOString() };
    await writeJsonStateAtomic(profileUsagePath(), { version: 1, profiles });
}
export function profileLastUsedMs(entry) {
    const times = [entry?.launched_at, entry?.requested_at]
        .map((value) => value ? Date.parse(value) : Number.NaN)
        .filter(Number.isFinite);
    return times.length > 0 ? Math.max(...times) : null;
}
export function formatAgo(ms, nowMs = Date.now()) {
    if (ms === null)
        return "-";
    const elapsed = Math.max(0, nowMs - ms);
    if (elapsed < 60_000)
        return "just now";
    const [unit, size] = elapsed >= 86_400_000 ? ["d", 86_400_000] : elapsed >= 3_600_000 ? ["h", 3_600_000] : ["m", 60_000];
    return `${Math.floor(elapsed / size)}${unit} ago`;
}
