import { join } from "node:path";
import { readTextIfExists } from "./fs.js";
import { codexToolsCacheDir } from "./paths.js";
import { writeJsonStateAtomic } from "./runtime-log.js";

export type ProfileUsageEvent = "switched_at" | "launched_at" | "requested_at";

export type ProfileUsageEntry = Partial<Record<ProfileUsageEvent, string>>;

type ProfileUsageFile = {
  version: 1;
  profiles: Record<string, ProfileUsageEntry>;
};

const PROFILE_USAGE_EVENTS: ProfileUsageEvent[] = ["switched_at", "launched_at", "requested_at"];

export function profileUsagePath(): string {
  return join(codexToolsCacheDir(), "profile-usage.json");
}

// A missing or unreadable file is an empty history: these timestamps are display hints, not state.
export async function readProfileUsage(): Promise<Record<string, ProfileUsageEntry>> {
  const text = await readTextIfExists(profileUsagePath());
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Partial<ProfileUsageFile>;
    if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object") return {};
    const profiles: Record<string, ProfileUsageEntry> = {};
    for (const [name, entry] of Object.entries(parsed.profiles)) {
      if (!entry || typeof entry !== "object") continue;
      profiles[name] = Object.fromEntries(PROFILE_USAGE_EVENTS
        .filter((event) => typeof entry[event] === "string" && Number.isFinite(Date.parse(entry[event]!)))
        .map((event) => [event, entry[event]]));
    }
    return profiles;
  } catch {
    return {};
  }
}

export async function recordProfileUsage(name: string, event: ProfileUsageEvent, at: Date = new Date()): Promise<void> {
  const profiles = await readProfileUsage();
  profiles[name] = { ...profiles[name], [event]: at.toISOString() };
  await writeJsonStateAtomic(profileUsagePath(), { version: 1, profiles } satisfies ProfileUsageFile);
}

export function profileLastUsedMs(entry: ProfileUsageEntry | undefined): number | null {
  const times = [entry?.launched_at, entry?.requested_at]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

export function formatAgo(ms: number | null, nowMs: number = Date.now()): string {
  if (ms === null) return "-";
  const elapsed = Math.max(0, nowMs - ms);
  if (elapsed < 60_000) return "just now";
  const [unit, size] = elapsed >= 86_400_000 ? ["d", 86_400_000] : elapsed >= 3_600_000 ? ["h", 3_600_000] : ["m", 60_000];
  return `${Math.floor(elapsed / size)}${unit} ago`;
}
