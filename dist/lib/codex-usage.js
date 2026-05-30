import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { DateTime } from "luxon";
import { codexDir, homeDir } from "./paths.js";
import { sqlString, sqliteJson } from "./sqlite.js";
const usageFields = [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
];
const sqliteStatePattern = /^state.*\.sqlite$/;
export function systemTimezone() {
    return DateTime.local().zoneName || "UTC";
}
export function validateTimezone(timezone) {
    if (!DateTime.now().setZone(timezone).isValid) {
        throw new Error(`invalid timezone: ${timezone}`);
    }
}
export function resolveProjectPath(value) {
    if (value === "~") {
        return homeDir();
    }
    if (value.startsWith("~/")) {
        return resolve(homeDir(), value.slice(2));
    }
    return resolve(value);
}
export function formatProjectPath(path) {
    const home = homeDir();
    if (path === home) {
        return "~";
    }
    return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
export function emptyAggregate() {
    return {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        modelUsage: new Map(),
    };
}
export function addUsage(target, model, usage) {
    target.inputTokens += usage.inputTokens;
    target.cachedInputTokens += usage.cachedInputTokens;
    target.outputTokens += usage.outputTokens;
    target.reasoningOutputTokens += usage.reasoningOutputTokens;
    target.totalTokens += usage.totalTokens;
    const modelUsage = target.modelUsage.get(model) ?? {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
    };
    modelUsage.inputTokens += usage.inputTokens;
    modelUsage.cachedInputTokens += usage.cachedInputTokens;
    modelUsage.outputTokens += usage.outputTokens;
    modelUsage.reasoningOutputTokens += usage.reasoningOutputTokens;
    modelUsage.totalTokens += usage.totalTokens;
    target.modelUsage.set(model, modelUsage);
}
export function totalAggregate(rows) {
    const total = emptyAggregate();
    for (const row of rows) {
        for (const [model, usage] of row.aggregate.modelUsage) {
            addUsage(total, model, usage);
        }
    }
    return total;
}
export async function loadCodexUsageEvents(options) {
    validateTimezone(options.timezone);
    const range = dateRangeMs(options);
    const dbPath = await newestCodexStateDb();
    const threads = await loadThreads(dbPath, range, options.project);
    const rollouts = collectRollouts(threads);
    const events = [];
    for (const rollout of rollouts) {
        events.push(...await readRolloutUsageEvents(rollout, range));
    }
    return events;
}
export function filterCodexUsageEvents(events, options) {
    validateTimezone(options.timezone);
    const range = dateRangeMs(options);
    return events.filter((event) => (event.timestampMs >= range.startMs
        && event.timestampMs < range.endMs
        && (!options.project || event.project === options.project)));
}
export function aggregateDaily(events, timezone) {
    return sortedRows(aggregateBy(events, (event) => localDateKey(event.timestampMs, timezone)), "key-asc");
}
export function aggregateWeekly(events, timezone) {
    return sortedRows(aggregateBy(events, (event) => mondayWeekKey(localDateKey(event.timestampMs, timezone))), "key-asc");
}
export function aggregateMonthly(events, timezone) {
    return sortedRows(aggregateBy(events, (event) => localDateKey(event.timestampMs, timezone).slice(0, 7)), "key-asc");
}
export function aggregateProjects(events) {
    return sortedRows(aggregateBy(events, (event) => event.project), "cost-placeholder");
}
export function aggregateProjectDaily(events, timezone, project) {
    return aggregateDaily(events.filter((event) => event.project === project), timezone);
}
export function aggregateDayTimeBuckets(events, timezone, date, bucketMinutes) {
    const dayEvents = events.filter((event) => localDateKey(event.timestampMs, timezone) === date);
    return sortedRows(aggregateBy(dayEvents, (event) => timeBucketKey(event.timestampMs, timezone, bucketMinutes)), "key-asc");
}
export function aggregateDayProjects(events, timezone, date) {
    const dayEvents = events.filter((event) => localDateKey(event.timestampMs, timezone) === date);
    return aggregateProjects(dayEvents);
}
export function sortRowsByCost(rows, costOf) {
    return [...rows].sort((left, right) => (costOf(right.aggregate) - costOf(left.aggregate) || left.key.localeCompare(right.key)));
}
export function dateRangeForDay(date, timezone) {
    return { since: date, until: date, timezone };
}
function aggregateBy(events, keyOf) {
    const groups = new Map();
    for (const event of events) {
        const key = keyOf(event);
        const aggregate = groups.get(key) ?? emptyAggregate();
        addUsage(aggregate, event.model, event.usage);
        groups.set(key, aggregate);
    }
    return [...groups.entries()].map(([key, aggregate]) => ({ key, aggregate }));
}
function sortedRows(rows, mode) {
    if (mode === "key-asc") {
        return [...rows].sort((left, right) => left.key.localeCompare(right.key));
    }
    return rows;
}
async function newestCodexStateDb() {
    const dir = codexDir();
    const entries = await readdir(dir);
    const candidates = await Promise.all(entries
        .filter((entry) => sqliteStatePattern.test(entry))
        .map(async (entry) => {
        const path = resolve(dir, entry);
        const stats = await stat(path);
        return { path, mtimeMs: stats.mtimeMs };
    }));
    const newest = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
    if (!newest) {
        throw new Error(`no Codex state sqlite found under ${dir}`);
    }
    return newest.path;
}
async function loadThreads(dbPath, range, project) {
    const conditions = ["rollout_path != ''", "cwd != ''"];
    if (Number.isFinite(range.endMs)) {
        conditions.push(`coalesce(created_at_ms, created_at * 1000) < ${Math.ceil(range.endMs)}`);
    }
    if (Number.isFinite(range.startMs)) {
        conditions.push(`coalesce(updated_at_ms, updated_at * 1000) >= ${Math.floor(range.startMs)}`);
    }
    if (project) {
        conditions.push(`cwd = ${sqlString(project)}`);
    }
    return sqliteJson(dbPath, `
select
  id,
  cwd,
  rollout_path,
  coalesce(created_at_ms, created_at * 1000) as created_at_ms,
  coalesce(updated_at_ms, updated_at * 1000) as updated_at_ms,
  model
from threads
where ${conditions.join(" and ")}
order by updated_at_ms asc, id asc
`.trim());
}
function collectRollouts(threads) {
    const byPath = new Map();
    for (const thread of threads) {
        const path = thread.rollout_path;
        const existing = byPath.get(path);
        if (!existing) {
            byPath.set(path, {
                path,
                cwd: thread.cwd,
                threadIds: [thread.id],
                threadModel: thread.model ?? undefined,
            });
            continue;
        }
        existing.threadIds.push(thread.id);
        if (existing.cwd !== thread.cwd) {
            throw new Error(`rollout has multiple cwd values: ${path} (${existing.threadIds.join(", ")})`);
        }
        if (existing.threadModel !== (thread.model ?? undefined)) {
            existing.threadModel = undefined;
        }
    }
    return [...byPath.values()];
}
async function readRolloutUsageEvents(rollout, range) {
    const events = [];
    const stream = createReadStream(rollout.path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    let currentModel = rollout.threadModel;
    let previousTotalUsage = null;
    let previousSignature = "";
    for await (const line of lines) {
        lineNumber += 1;
        if (!line.includes("turn_context") && !line.includes("token_count")) {
            continue;
        }
        const parsed = parseJsonLine(line, rollout.path, lineNumber);
        if (parsed.type === "turn_context") {
            const model = modelFromValue(parsed.payload);
            if (model) {
                currentModel = model;
            }
            continue;
        }
        if (parsed.type !== "event_msg") {
            continue;
        }
        const payload = asObject(parsed.payload);
        if (!payload || payload.type !== "token_count") {
            continue;
        }
        const info = asObject(payload.info);
        if (!info) {
            continue;
        }
        const totalUsage = parseTokenUsage(info.total_token_usage);
        const lastUsage = parseTokenUsage(info.last_token_usage);
        const usage = lastUsage ?? (totalUsage ? subtractUsage(totalUsage, previousTotalUsage, rollout.path, lineNumber) : null);
        if (totalUsage) {
            previousTotalUsage = totalUsage;
        }
        if (!usage || isZeroUsage(usage)) {
            continue;
        }
        assertNonNegativeUsage(usage, rollout.path, lineNumber);
        if (usage.cachedInputTokens > usage.inputTokens) {
            throw new Error(`${rollout.path}:${lineNumber}: cached_input_tokens exceeds input_tokens`);
        }
        const signature = `${JSON.stringify(usage)}|${JSON.stringify(totalUsage)}`;
        if (signature === previousSignature) {
            continue;
        }
        previousSignature = signature;
        const timestampMs = parseTimestampMs(parsed.timestamp, rollout.path, lineNumber);
        if (timestampMs < range.startMs || timestampMs >= range.endMs) {
            continue;
        }
        const model = modelFromValue(payload) ?? modelFromValue(info) ?? currentModel;
        if (!model) {
            throw new Error(`${rollout.path}:${lineNumber}: missing model for token_count`);
        }
        currentModel = model;
        events.push({
            timestampMs,
            project: rollout.cwd,
            model,
            usage,
        });
    }
    return events;
}
function parseJsonLine(line, path, lineNumber) {
    try {
        return JSON.parse(line);
    }
    catch (error) {
        throw new Error(`${path}:${lineNumber}: invalid JSON (${formatUnknownError(error)})`);
    }
}
function parseTimestampMs(value, path, lineNumber) {
    const timestampMs = typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : NaN;
    if (!Number.isFinite(timestampMs)) {
        throw new Error(`${path}:${lineNumber}: invalid timestamp`);
    }
    return timestampMs;
}
function parseTokenUsage(value) {
    const raw = asObject(value);
    if (!raw) {
        return null;
    }
    return {
        inputTokens: readNumberField(raw, "input_tokens"),
        cachedInputTokens: readNumberField(raw, "cached_input_tokens"),
        outputTokens: readNumberField(raw, "output_tokens"),
        reasoningOutputTokens: readNumberField(raw, "reasoning_output_tokens"),
        totalTokens: readNumberField(raw, "total_tokens"),
    };
}
function readNumberField(raw, field) {
    const value = raw[field];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function subtractUsage(current, previous, path, lineNumber) {
    const usage = {
        inputTokens: current.inputTokens - (previous?.inputTokens ?? 0),
        cachedInputTokens: current.cachedInputTokens - (previous?.cachedInputTokens ?? 0),
        outputTokens: current.outputTokens - (previous?.outputTokens ?? 0),
        reasoningOutputTokens: current.reasoningOutputTokens - (previous?.reasoningOutputTokens ?? 0),
        totalTokens: current.totalTokens - (previous?.totalTokens ?? 0),
    };
    for (const field of usageFields) {
        if (usage[field] < 0) {
            throw new Error(`${path}:${lineNumber}: negative token delta for ${field}`);
        }
    }
    return usage;
}
function assertNonNegativeUsage(usage, path, lineNumber) {
    for (const field of usageFields) {
        if (usage[field] < 0) {
            throw new Error(`${path}:${lineNumber}: negative token delta for ${field}`);
        }
    }
}
function isZeroUsage(usage) {
    return usage.inputTokens === 0 &&
        usage.cachedInputTokens === 0 &&
        usage.outputTokens === 0 &&
        usage.reasoningOutputTokens === 0;
}
function modelFromValue(value) {
    const raw = asObject(value);
    if (!raw) {
        return null;
    }
    const direct = readString(raw.model) ?? readString(raw.model_name);
    if (direct) {
        return direct;
    }
    const metadata = asObject(raw.metadata);
    if (!metadata) {
        return null;
    }
    return readString(metadata.model) ?? readString(metadata.model_name);
}
function readString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function asObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function dateRangeMs(range) {
    const startMs = range.since
        ? parseLocalDateStart(range.since, range.timezone).toMillis()
        : Number.NEGATIVE_INFINITY;
    const endMs = range.until
        ? parseLocalDateStart(range.until, range.timezone).plus({ days: 1 }).toMillis()
        : Number.POSITIVE_INFINITY;
    if (startMs > endMs) {
        throw new Error(`invalid date range: ${range.since}..${range.until}`);
    }
    return { startMs, endMs };
}
function localDateKey(timestampMs, timezone) {
    return DateTime.fromMillis(timestampMs, { zone: timezone }).toISODate() ?? "";
}
function mondayWeekKey(date) {
    return parseLocalDateStart(date, "UTC").startOf("week").toISODate() ?? date;
}
function timeBucketKey(timestampMs, timezone, bucketMinutes) {
    const local = DateTime.fromMillis(timestampMs, { zone: timezone });
    const minuteOfDay = local.hour * 60 + local.minute;
    const startMinute = Math.floor(minuteOfDay / bucketMinutes) * bucketMinutes;
    const endMinute = Math.min(24 * 60, startMinute + bucketMinutes);
    return `${formatMinuteOfDay(startMinute)}-${formatMinuteOfDay(endMinute)}`;
}
function formatMinuteOfDay(value) {
    const hour = Math.floor(value / 60);
    const minute = value % 60;
    return `${pad2(hour)}:${pad2(minute)}`;
}
function parseLocalDateStart(date, timezone) {
    const parsed = DateTime.fromISO(date, { zone: timezone }).startOf("day");
    if (!parsed.isValid || parsed.toISODate() !== date) {
        throw new Error(`invalid date: ${date}`);
    }
    return parsed;
}
function pad2(value) {
    return value.toString().padStart(2, "0");
}
function formatUnknownError(error) {
    return error instanceof Error ? error.message : String(error);
}
