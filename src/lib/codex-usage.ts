import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { DateTime } from "luxon";
import { codexDir, homeDir } from "./paths.js";
import { sqlString, sqliteJson } from "./sqlite.js";
import type { CodexModelUsage, CodexTokenUsage } from "./pricing.js";

export type CodexUsageRange = {
  since?: string;
  until?: string;
  timezone: string;
};

export type CodexUsageLoadOptions = CodexUsageRange & {
  project?: string;
};

export type CodexUsageEvent = {
  timestampMs: number;
  project: string;
  model: string;
  usage: CodexTokenUsage;
};

export type CodexUsageAggregate = CodexTokenUsage & {
  modelUsage: Map<string, CodexModelUsage>;
};

export type CodexUsageRow = {
  key: string;
  aggregate: CodexUsageAggregate;
};

type CodexThreadRow = {
  id: string;
  cwd: string;
  rollout_path: string;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  model: string | null;
};

type RolloutIndex = {
  path: string;
  cwd: string;
  threadIds: string[];
  createdAtMs: number;
  threadModel?: string;
};

type TimeRangeMs = {
  startMs: number;
  endMs: number;
};

type ParsedLine = {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
};

type TokenCountPayload = {
  type?: unknown;
  info?: unknown;
  model?: unknown;
  model_name?: unknown;
  metadata?: unknown;
  started_at?: unknown;
  turn_id?: unknown;
};

type TokenInfo = {
  last_token_usage?: unknown;
  total_token_usage?: unknown;
  model?: unknown;
  model_name?: unknown;
  metadata?: unknown;
};

const usageFields = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;

const sqliteStatePattern = /^state.*\.sqlite$/;
const taskStartBoundaryToleranceMs = 1000;

export function systemTimezone(): string {
  return DateTime.local().zoneName || "UTC";
}

export function validateTimezone(timezone: string): void {
  if (!DateTime.now().setZone(timezone).isValid) {
    throw new Error(`invalid timezone: ${timezone}`);
  }
}

export function resolveProjectPath(value: string): string {
  if (value === "~") {
    return homeDir();
  }
  if (value.startsWith("~/")) {
    return resolve(homeDir(), value.slice(2));
  }
  return resolve(value);
}

export function formatProjectPath(path: string): string {
  const home = homeDir();
  if (path === home) {
    return "~";
  }
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function emptyAggregate(): CodexUsageAggregate {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    modelUsage: new Map(),
  };
}

export function addUsage(target: CodexUsageAggregate, model: string, usage: CodexTokenUsage): void {
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

export function totalAggregate(rows: CodexUsageRow[]): CodexUsageAggregate {
  const total = emptyAggregate();
  for (const row of rows) {
    for (const [model, usage] of row.aggregate.modelUsage) {
      addUsage(total, model, usage);
    }
  }
  return total;
}

export async function loadCodexUsageEvents(options: CodexUsageLoadOptions): Promise<CodexUsageEvent[]> {
  validateTimezone(options.timezone);
  const range = dateRangeMs(options);
  const dbPath = await newestCodexStateDb();
  const threads = await loadThreads(dbPath, range, options.project);
  const rollouts = collectRollouts(threads);
  const events: CodexUsageEvent[] = [];

  for (const rollout of rollouts) {
    events.push(...await readRolloutUsageEvents(rollout, range));
  }

  return events;
}

export function filterCodexUsageEvents(events: CodexUsageEvent[], options: CodexUsageLoadOptions): CodexUsageEvent[] {
  validateTimezone(options.timezone);
  const range = dateRangeMs(options);
  return events.filter((event) => (
    event.timestampMs >= range.startMs
    && event.timestampMs < range.endMs
    && (!options.project || event.project === options.project)
  ));
}

export function aggregateDaily(events: CodexUsageEvent[], timezone: string): CodexUsageRow[] {
  return sortedRows(aggregateBy(events, (event) => localDateKey(event.timestampMs, timezone)), "key-asc");
}

export function aggregateWeekly(events: CodexUsageEvent[], timezone: string): CodexUsageRow[] {
  return sortedRows(aggregateBy(events, (event) => mondayWeekKey(localDateKey(event.timestampMs, timezone))), "key-asc");
}

export function aggregateMonthly(events: CodexUsageEvent[], timezone: string): CodexUsageRow[] {
  return sortedRows(aggregateBy(events, (event) => localDateKey(event.timestampMs, timezone).slice(0, 7)), "key-asc");
}

export function aggregateProjects(events: CodexUsageEvent[]): CodexUsageRow[] {
  return sortedRows(aggregateBy(events, (event) => event.project), "cost-placeholder");
}

export function aggregateProjectDaily(events: CodexUsageEvent[], timezone: string, project: string): CodexUsageRow[] {
  return aggregateDaily(events.filter((event) => event.project === project), timezone);
}

export function aggregateDayTimeBuckets(
  events: CodexUsageEvent[],
  timezone: string,
  date: string,
  bucketMinutes: number,
): CodexUsageRow[] {
  const dayEvents = events.filter((event) => localDateKey(event.timestampMs, timezone) === date);
  return sortedRows(aggregateBy(dayEvents, (event) => timeBucketKey(event.timestampMs, timezone, bucketMinutes)), "key-asc");
}

export function aggregateDayProjects(events: CodexUsageEvent[], timezone: string, date: string): CodexUsageRow[] {
  const dayEvents = events.filter((event) => localDateKey(event.timestampMs, timezone) === date);
  return aggregateProjects(dayEvents);
}

export function sortRowsByCost(rows: CodexUsageRow[], costOf: (aggregate: CodexUsageAggregate) => number): CodexUsageRow[] {
  return [...rows].sort((left, right) => (
    costOf(right.aggregate) - costOf(left.aggregate) || left.key.localeCompare(right.key)
  ));
}

export function dateRangeForDay(date: string, timezone: string): CodexUsageRange {
  return { since: date, until: date, timezone };
}

function aggregateBy(events: CodexUsageEvent[], keyOf: (event: CodexUsageEvent) => string): CodexUsageRow[] {
  const groups = new Map<string, CodexUsageAggregate>();
  for (const event of events) {
    const key = keyOf(event);
    const aggregate = groups.get(key) ?? emptyAggregate();
    addUsage(aggregate, event.model, event.usage);
    groups.set(key, aggregate);
  }
  return [...groups.entries()].map(([key, aggregate]) => ({ key, aggregate }));
}

function sortedRows(rows: CodexUsageRow[], mode: "key-asc" | "cost-placeholder"): CodexUsageRow[] {
  if (mode === "key-asc") {
    return [...rows].sort((left, right) => left.key.localeCompare(right.key));
  }
  return rows;
}

async function newestCodexStateDb(): Promise<string> {
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

async function loadThreads(dbPath: string, range: TimeRangeMs, project: string | undefined): Promise<CodexThreadRow[]> {
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

  return sqliteJson<CodexThreadRow>(
    dbPath,
    `
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
`.trim(),
  );
}

function collectRollouts(threads: CodexThreadRow[]): RolloutIndex[] {
  const byPath = new Map<string, RolloutIndex>();
  for (const thread of threads) {
    const path = thread.rollout_path;
    const existing = byPath.get(path);
    if (!existing) {
      byPath.set(path, {
        path,
        cwd: thread.cwd,
        threadIds: [thread.id],
        createdAtMs: thread.created_at_ms ?? 0,
        threadModel: thread.model ?? undefined,
      });
      continue;
    }

    existing.threadIds.push(thread.id);
    existing.createdAtMs = Math.min(existing.createdAtMs, thread.created_at_ms ?? existing.createdAtMs);
    if (existing.cwd !== thread.cwd) {
      throw new Error(`rollout has multiple cwd values: ${path} (${existing.threadIds.join(", ")})`);
    }
    if (existing.threadModel !== (thread.model ?? undefined)) {
      existing.threadModel = undefined;
    }
  }
  return [...byPath.values()];
}

async function readRolloutUsageEvents(rollout: RolloutIndex, range: TimeRangeMs): Promise<CodexUsageEvent[]> {
  const events: CodexUsageEvent[] = [];
  const stream = createReadStream(rollout.path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let currentModel = rollout.threadModel;
  let previousTotalUsage: CodexTokenUsage | null = null;
  let previousSignature = "";
  let countCurrentTask = false;
  let reachedCurrentTask = false;

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.includes("turn_context")
      && !line.includes("task_started")
      && !line.includes("thread_rolled_back")
      && !line.includes("token_count")) {
      continue;
    }

    const parsed = parseJsonLine(line, rollout.path, lineNumber);
    if (parsed.type === "turn_context") {
      if (!countCurrentTask) {
        continue;
      }
      const model = modelFromValue(parsed.payload);
      if (model) {
        currentModel = model;
      }
      continue;
    }
    if (parsed.type !== "event_msg") {
      continue;
    }

    const payload = asObject<TokenCountPayload>(parsed.payload);
    if (!payload) {
      continue;
    }

    if (payload.type === "task_started") {
      countCurrentTask = isCurrentRolloutTask(payload, rollout, rollout.path, lineNumber);
      if (countCurrentTask && !reachedCurrentTask) {
        reachedCurrentTask = true;
        previousTotalUsage = null;
        previousSignature = "";
        currentModel = rollout.threadModel;
      }
      continue;
    }

    if (payload.type === "thread_rolled_back") {
      previousSignature = "";
      continue;
    }

    if (payload.type !== "token_count" || !countCurrentTask) {
      continue;
    }

    const info = asObject<TokenInfo>(payload.info);
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

function isCurrentRolloutTask(payload: TokenCountPayload, rollout: RolloutIndex, path: string, lineNumber: number): boolean {
  const startedAtMs = readTaskStartedAtMs(payload, path, lineNumber);
  if (startedAtMs === null) {
    return true;
  }
  return startedAtMs >= rollout.createdAtMs - taskStartBoundaryToleranceMs;
}

function readTaskStartedAtMs(payload: TokenCountPayload, path: string, lineNumber: number): number | null {
  const turnIdTimestampMs = uuidV7TimestampMs(readString(payload.turn_id));
  if (turnIdTimestampMs !== null) {
    return turnIdTimestampMs;
  }
  if (payload.started_at !== undefined) {
    const startedAtMs = readUnixSecondsMs(payload.started_at, path, lineNumber);
    if (startedAtMs !== null) {
      return startedAtMs;
    }
  }
  return null;
}

function readUnixSecondsMs(value: unknown, path: string, lineNumber: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path}:${lineNumber}: invalid task_started started_at`);
  }
  return Math.floor(value * 1000);
}

function uuidV7TimestampMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const hex = value.replaceAll("-", "").slice(0, 12);
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) {
    return null;
  }
  const timestampMs = Number.parseInt(hex, 16);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function parseJsonLine(line: string, path: string, lineNumber: number): ParsedLine {
  try {
    return JSON.parse(line) as ParsedLine;
  } catch (error) {
    throw new Error(`${path}:${lineNumber}: invalid JSON (${formatUnknownError(error)})`);
  }
}

function parseTimestampMs(value: unknown, path: string, lineNumber: number): number {
  const timestampMs = typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`${path}:${lineNumber}: invalid timestamp`);
  }
  return timestampMs;
}

function parseTokenUsage(value: unknown): CodexTokenUsage | null {
  const raw = asObject<Record<string, unknown>>(value);
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

function readNumberField(raw: Record<string, unknown>, field: string): number {
  const value = raw[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function subtractUsage(
  current: CodexTokenUsage,
  previous: CodexTokenUsage | null,
  path: string,
  lineNumber: number,
): CodexTokenUsage {
  const usage: CodexTokenUsage = {
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

function assertNonNegativeUsage(usage: CodexTokenUsage, path: string, lineNumber: number): void {
  for (const field of usageFields) {
    if (usage[field] < 0) {
      throw new Error(`${path}:${lineNumber}: negative token delta for ${field}`);
    }
  }
}

function isZeroUsage(usage: CodexTokenUsage): boolean {
  return usage.inputTokens === 0 &&
    usage.cachedInputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.reasoningOutputTokens === 0;
}

function modelFromValue(value: unknown): string | null {
  const raw = asObject<Record<string, unknown>>(value);
  if (!raw) {
    return null;
  }

  const direct = readString(raw.model) ?? readString(raw.model_name);
  if (direct) {
    return direct;
  }

  const metadata = asObject<Record<string, unknown>>(raw.metadata);
  if (!metadata) {
    return null;
  }
  return readString(metadata.model) ?? readString(metadata.model_name);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asObject<T extends object>(value: unknown): T | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as T : null;
}

function dateRangeMs(range: CodexUsageRange): TimeRangeMs {
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

function localDateKey(timestampMs: number, timezone: string): string {
  return DateTime.fromMillis(timestampMs, { zone: timezone }).toISODate() ?? "";
}

function mondayWeekKey(date: string): string {
  return parseLocalDateStart(date, "UTC").startOf("week").toISODate() ?? date;
}

function timeBucketKey(timestampMs: number, timezone: string, bucketMinutes: number): string {
  const local = DateTime.fromMillis(timestampMs, { zone: timezone });
  const minuteOfDay = local.hour * 60 + local.minute;
  const startMinute = Math.floor(minuteOfDay / bucketMinutes) * bucketMinutes;
  const endMinute = Math.min(24 * 60, startMinute + bucketMinutes);
  return `${formatMinuteOfDay(startMinute)}-${formatMinuteOfDay(endMinute)}`;
}

function formatMinuteOfDay(value: number): string {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function parseLocalDateStart(date: string, timezone: string): DateTime {
  const parsed = DateTime.fromISO(date, { zone: timezone }).startOf("day");
  if (!parsed.isValid || parsed.toISODate() !== date) {
    throw new Error(`invalid date: ${date}`);
  }
  return parsed;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
