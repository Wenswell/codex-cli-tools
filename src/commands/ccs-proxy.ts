import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setInterval } from "node:timers";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexConfigPath, profilesPath } from "../lib/paths.js";
import { readTextIfExists, writeTextFile, writeTextFileAtomic } from "../lib/fs.js";
import { colorCount, colorName, colorPath, colorUrl, printKeyValue } from "../lib/output.js";
import { textBlue, textBold, textDim, textGreen, textOrange, textRed, textYellow, truncateVisible, visibleLength } from "../lib/text.js";
import { readTomlBaseUrl, readTopLevelTomlString, updateTomlBaseUrl } from "../lib/toml.js";
import { renderTable, type TableColumn, type TableRow } from "../lib/table.js";

type Profile = {
  baseURL: string;
  apiKey: string;
};

type ProxyUpstream = {
  name: string;
  baseURL: string;
};

type ProfilesFile = {
  profiles?: Record<string, Profile>;
  current?: string;
  toggle?: string[];
};

type ProxyState = {
  installed_at: string;
  codex_config_path: string;
  provider_name: string;
  original_base_url: string;
  proxy_base_url: string;
  listen_host: string;
  listen_port: number;
  profile_order: string[];
  backup_path: string;
  metrics: ProxyMetrics;
};

type ProxyMetrics = {
  total_requests: number;
  active_requests: ProxyActiveRequestRecord[];
  status_counts: ProxyStatusCounts;
  upstream_hit_counts: Record<string, number>;
  latency_ms: {
    last: number | null;
    count: number;
    sum: number;
    min: number | null;
    max: number | null;
  };
  recent_requests: ProxyRequestRecord[];
};

type ProxyStatusCounts = {
  "2xx": number;
  "3xx": number;
  "4xx": number;
  "5xx": number;
};

type ProxyActiveRequestRecord = {
  id: string;
  started_at: string;
  method: string;
  path: string;
  request_bytes: number;
  session: string | null;
  request_model: string | null;
};

type ProxyRequestRecord = {
  id: string;
  started_at: string;
  completed_at: string;
  method: string;
  path: string;
  status: number | null;
  upstream: string | null;
  attempts: number;
  latency_ms: number;
  request_bytes: number;
  response_bytes: number;
  session: string | null;
  request_model: string | null;
  upstream_model: string | null;
  upstream_model_source: string | null;
  error: string | null;
};

type ProxyInstallPlan = {
  backupPath: string;
  statePath: string;
  state: ProxyState;
};

type ProxyRuntimeState = {
  state: ProxyState;
  pid: number | null;
  healthy: boolean;
  started: boolean;
  logPath: string;
};

type ProxyHealth = {
  healthy: boolean;
  pid: number | null;
};

type ProxyOptions = {
  codexConfigPath: string;
  listenHost: string;
  listenPort: number;
  stateRoot: string;
  once?: boolean;
};

type ProxyEndpointClass = "chat/completions" | "responses";

type ProxyModelExtraction = {
  model: string | null;
  source: string | null;
};

type ProxyWriteModelObserver = ProxyModelExtraction;

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 4610;
const HEALTH_PATH = "/__codex_proxy/health";
const PROXY_STATE_FILE = "proxy.json";
const REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60 * 1000;
const NON_STREAM_STATUS_CODE = 502;
const REASONING_EQUALS = [516];
const PROXY_RECENT_REQUEST_LIMIT = 10;
const PROXY_ACTIVE_REQUEST_LIMIT = 50;
const PROXY_RECENT_RENDER_COUNT = 5;
const PROXY_STATUS_RENDER_LINES = 11 + (PROXY_RECENT_RENDER_COUNT * 2);
const PROXY_TABLE_TIME_WIDTH = 8 + 1;
const PROXY_TABLE_CODE_WIDTH = 4;
const PROXY_TABLE_UPSTREAM_WIDTH = 6;
const PROXY_TABLE_LATENCY_WIDTH = 6;
const PROXY_TABLE_SIZE_WIDTH = 6;
const PROXY_TABLE_SESSION_WIDTH = 8 + 1;
const PROXY_TABLE_MODEL_WIDTH = 10;
const PROXY_TABLE_PATH_WIDTH = 18;
const PROXY_START_TIMEOUT_MS = 5000;
const PROXY_HEALTH_TIMEOUT_MS = 500;
const PROXY_HEALTH_POLL_MS = 100;
const PROXY_STATUS_REFRESH_SECONDS = 1;
const REASONING_POINTERS = [
  "/usage/output_tokens_details/reasoning_tokens",
  "/usage/completion_tokens_details/reasoning_tokens",
  "/response/usage/output_tokens_details/reasoning_tokens",
  "/response/usage/completion_tokens_details/reasoning_tokens",
];

const PROXY_REQUEST_TABLE_COLUMNS: TableColumn[] = [
  { key: "session", title: "session", width: PROXY_TABLE_SESSION_WIDTH, align: "right" },
  { key: "time", title: "time", width: PROXY_TABLE_TIME_WIDTH, align: "right" },
  { key: "up", title: "up", width: PROXY_TABLE_UPSTREAM_WIDTH, align: "right" },
  { key: "code", title: "code", width: PROXY_TABLE_CODE_WIDTH, align: "right" },
  { key: "ms", title: "ms", width: PROXY_TABLE_LATENCY_WIDTH, align: "right" },
  { key: "size", title: "size", width: PROXY_TABLE_SIZE_WIDTH, align: "right" },
  { key: "req_model", title: "req_model", width: PROXY_TABLE_MODEL_WIDTH, align: "right" },
  { key: "up_model", title: "up_model", width: PROXY_TABLE_MODEL_WIDTH, align: "right" },
  { key: "path", title: "path", width: PROXY_TABLE_PATH_WIDTH, align: "right" },
  { key: "error", title: "error", flex: true, minWidth: 12, align: "left", truncate: false },
];

function statePath(stateRoot: string): string {
  return path.join(stateRoot, PROXY_STATE_FILE);
}

function pidPath(stateRoot: string): string {
  return path.join(stateRoot, "proxy.pid");
}

function proxyBaseUrl(listenHost: string, listenPort: number): string {
  return `http://${listenHost}:${listenPort}`;
}

async function readProfiles(): Promise<ProfilesFile> {
  const text = await readTextIfExists(profilesPath());
  return text ? (parseJsonObject(text) as ProfilesFile) : {};
}

export async function readProxyState(stateRoot: string = process.env.CCS_PROXY_STATE_ROOT || `${process.env.HOME ?? ""}/.config/codex-tools`): Promise<ProxyState | null> {
  const text = await readTextIfExists(statePath(stateRoot));
  return text ? normalizeProxyState(parseJsonObject(text) as ProxyState) : null;
}

async function writeProxyState(stateRoot: string, state: ProxyState): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  await writeTextFileAtomic(statePath(stateRoot), stringifyJson(state), 0o600);
}

async function removeProxyState(stateRoot: string): Promise<void> {
  await rm(statePath(stateRoot), { force: true });
}

function proxyLogPath(stateRoot: string): string {
  return path.join(stateRoot, "proxy.log");
}

function proxyStartLockPath(stateRoot: string): string {
  return path.join(stateRoot, "proxy.start.lock");
}

function ccsBinPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/ccs.js");
}

function healthUrl(state: ProxyState): string {
  return new URL(HEALTH_PATH, state.proxy_base_url).toString();
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function readProxyHealth(state: ProxyState, timeoutMs = PROXY_HEALTH_TIMEOUT_MS): Promise<ProxyHealth> {
  try {
    const response = await fetch(healthUrl(state), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { healthy: false, pid: null };
    }
    const payload = await response.json().catch(() => null) as { status?: unknown } | null;
    return {
      healthy: payload?.status === "ok",
      pid: payload && Number.isInteger((payload as { pid?: unknown }).pid) ? Number((payload as { pid: number }).pid) : null,
    };
  } catch {
    return { healthy: false, pid: null };
  }
}

async function isProxyHealthy(state: ProxyState, timeoutMs = PROXY_HEALTH_TIMEOUT_MS): Promise<boolean> {
  return (await readProxyHealth(state, timeoutMs)).healthy;
}

async function waitForProxyHealth(state: ProxyState, stateRoot: string): Promise<void> {
  const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isProxyHealthy(state)) {
      return;
    }
    await sleep(PROXY_HEALTH_POLL_MS);
  }
  throw new Error(`proxy did not become healthy: ${healthUrl(state)}; log: ${proxyLogPath(stateRoot)}`);
}

async function waitForProxyStop(state: ProxyState): Promise<void> {
  const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isProxyHealthy(state))) {
      return;
    }
    await sleep(PROXY_HEALTH_POLL_MS);
  }
  throw new Error(`proxy did not stop: ${healthUrl(state)}`);
}

async function acquireProxyStartLock(stateRoot: string): Promise<number | null> {
  await mkdir(stateRoot, { recursive: true });
  const lockPath = proxyStartLockPath(stateRoot);
  const deadline = Date.now() + PROXY_START_TIMEOUT_MS;

  while (true) {
    try {
      return fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const state = await readProxyState(stateRoot);
      if (state && await isProxyHealthy(state)) {
        return null;
      }
      if (Date.now() >= deadline) {
        throw new Error(`proxy startup lock is still active: ${lockPath}`);
      }
      await sleep(PROXY_HEALTH_POLL_MS);
    }
  }
}

function startProxyBackgroundProcess(options: ProxyOptions, state: ProxyState): number {
  const scriptPath = ccsBinPath();
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`ccs proxy entry was not found: ${scriptPath}`);
  }

  fs.mkdirSync(options.stateRoot, { recursive: true });
  const logPath = proxyLogPath(options.stateRoot);
  const stdout = fs.openSync(logPath, "a");
  const stderr = fs.openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [scriptPath, "proxy", "serve"], {
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: {
        ...process.env,
        CCS_PROXY_STATE_ROOT: options.stateRoot,
        CCS_PROXY_LISTEN_HOST: state.listen_host,
        CCS_PROXY_LISTEN_PORT: String(state.listen_port),
      },
    });
    child.unref();
    if (!child.pid) {
      throw new Error("proxy background process did not report a PID");
    }
    return child.pid;
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

async function releaseProxyStartLock(stateRoot: string, lockFd: number): Promise<void> {
  fs.closeSync(lockFd);
  await rm(proxyStartLockPath(stateRoot), { force: true });
}

async function readProxyPid(stateRoot: string): Promise<{ pid: number | null; running: boolean }> {
  const file = pidPath(stateRoot);
  if (!fs.existsSync(file)) {
    return { pid: null, running: false };
  }
  const raw = (await readFile(file, "utf8")).trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid)) {
    return { pid: null, running: false };
  }
  try {
    process.kill(pid, 0);
    return { pid, running: true };
  } catch {
    return { pid, running: false };
  }
}

export async function ensureProxyRunning(options: ProxyOptions): Promise<ProxyRuntimeState | null> {
  const initialState = await readProxyState(options.stateRoot);
  if (!initialState) {
    return null;
  }
  const logPath = proxyLogPath(options.stateRoot);
  const initialPid = await readProxyPid(options.stateRoot);
  const initialHealth = await readProxyHealth(initialState);
  if (initialHealth.healthy) {
    const state = await readProxyState(options.stateRoot) ?? initialState;
    return {
      state,
      pid: initialHealth.pid ?? initialPid.pid,
      healthy: true,
      started: false,
      logPath,
    };
  }

  const lockFd = await acquireProxyStartLock(options.stateRoot);
  if (lockFd === null) {
    const state = await readProxyState(options.stateRoot);
    if (!state) {
      return null;
    }
    const pid = await readProxyPid(options.stateRoot);
    const health = await readProxyHealth(state);
    if (!health.healthy) {
      return ensureProxyRunning(options);
    }
    return {
      state,
      pid: health.pid ?? pid.pid,
      healthy: true,
      started: false,
      logPath,
    };
  }

  try {
    const state = await readProxyState(options.stateRoot);
    if (!state) {
      return null;
    }
    const health = await readProxyHealth(state);
    if (health.healthy) {
      const pid = await readProxyPid(options.stateRoot);
      return {
        state,
        pid: health.pid ?? pid.pid,
        healthy: true,
        started: false,
        logPath,
      };
    }

    await rm(pidPath(options.stateRoot), { force: true });
    const pid = startProxyBackgroundProcess(options, state);
    await waitForProxyHealth(state, options.stateRoot);
    return {
      state,
      pid,
      healthy: true,
      started: true,
      logPath,
    };
  } finally {
    await releaseProxyStartLock(options.stateRoot, lockFd);
  }
}

function currentProviderName(content: string): string {
  return readTopLevelTomlString(content, "model_provider") ?? "codex";
}

function currentProviderBaseUrl(content: string): string {
  return readTomlBaseUrl(content) ?? "";
}

function buildProfileOrder(profiles: ProfilesFile): string[] {
  const names = [
    ...(profiles.current ? [profiles.current] : []),
    ...(profiles.toggle ?? []),
    ...Object.keys(profiles.profiles ?? {}),
  ];
  return [...new Set(names.filter(Boolean))];
}

function buildProxyUpstreams(profiles: ProfilesFile): ProxyUpstream[] {
  const order = buildProfileOrder(profiles);
  return order
    .map((name) => ({
      name,
      baseURL: profiles.profiles?.[name]?.baseURL ?? "",
    }))
    .filter((upstream): upstream is ProxyUpstream => Boolean(upstream.baseURL));
}

function createProxyMetrics(): ProxyMetrics {
  return {
    total_requests: 0,
    active_requests: [],
    status_counts: createProxyStatusCounts(),
    upstream_hit_counts: {},
    latency_ms: {
      last: null,
      count: 0,
      sum: 0,
      min: null,
      max: null,
    },
    recent_requests: [],
  };
}

function createProxyStatusCounts(): ProxyStatusCounts {
  return {
    "2xx": 0,
    "3xx": 0,
    "4xx": 0,
    "5xx": 0,
  };
}

function normalizeProxyMetrics(value: unknown): ProxyMetrics {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const latency = raw.latency_ms && typeof raw.latency_ms === "object" ? raw.latency_ms as Record<string, unknown> : {};
  const recentRequests = Array.isArray(raw.recent_requests)
    ? raw.recent_requests.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map(normalizeProxyHistoryRecord)
    : [];
  const statusCounts = normalizeProxyStatusCounts(raw.status_counts, recentRequests, raw);
  return {
    total_requests: Number.isInteger(raw.total_requests) ? Number(raw.total_requests) : 0,
    active_requests: Array.isArray(raw.active_requests)
      ? raw.active_requests.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map(normalizeProxyActiveRecord)
        .slice(0, PROXY_ACTIVE_REQUEST_LIMIT)
      : [],
    status_counts: statusCounts,
    upstream_hit_counts: raw.upstream_hit_counts && typeof raw.upstream_hit_counts === "object" && !Array.isArray(raw.upstream_hit_counts)
      ? Object.fromEntries(
          Object.entries(raw.upstream_hit_counts as Record<string, unknown>)
            .filter(([, count]) => Number.isInteger(count))
            .map(([name, count]) => [name, Number(count)]),
        )
      : {},
    latency_ms: {
      last: typeof latency.last === "number" && Number.isFinite(latency.last)
        ? latency.last
        : recentRequests[0]?.latency_ms ?? null,
      count: Number.isInteger(latency.count) ? Number(latency.count) : 0,
      sum: typeof latency.sum === "number" ? latency.sum : 0,
      min: typeof latency.min === "number" ? latency.min : null,
      max: typeof latency.max === "number" ? latency.max : null,
    },
    recent_requests: recentRequests,
  };
}

function normalizeProxyStatusCounts(value: unknown, recentRequests: ProxyRequestRecord[], rawMetrics: Record<string, unknown>): ProxyStatusCounts {
  const successfulRequests = Number.isInteger(rawMetrics.successful_requests) ? Number(rawMetrics.successful_requests) : 0;
  const failedRequests = Number.isInteger(rawMetrics.failed_requests) ? Number(rawMetrics.failed_requests) : 0;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const counts = {
      "2xx": Number.isInteger(raw["2xx"]) ? Number(raw["2xx"]) : 0,
      "3xx": Number.isInteger(raw["3xx"]) ? Number(raw["3xx"]) : 0,
      "4xx": Number.isInteger(raw["4xx"]) ? Number(raw["4xx"]) : 0,
      "5xx": Number.isInteger(raw["5xx"]) ? Number(raw["5xx"]) : 0,
    };
    if (counts["2xx"] + counts["3xx"] + counts["4xx"] + counts["5xx"] > 0) {
      return counts;
    }
    if (successfulRequests > 0 || failedRequests > 0 || recentRequests.length > 0) {
      return buildProxyStatusCounts(recentRequests, successfulRequests, failedRequests);
    }
    return counts;
  }

  return buildProxyStatusCounts(recentRequests, successfulRequests, failedRequests);
}

function buildProxyStatusCounts(recentRequests: ProxyRequestRecord[], successfulRequests: number, failedRequests: number): ProxyStatusCounts {
  if (successfulRequests > 0 || failedRequests > 0) {
    return {
      "2xx": successfulRequests,
      "3xx": 0,
      "4xx": 0,
      "5xx": failedRequests,
    };
  }

  const counts = createProxyStatusCounts();
  for (const request of recentRequests) {
    incrementProxyStatusCount(counts, request.status);
  }
  return counts;
}

function normalizeProxyActiveRecord(request: Record<string, unknown>): ProxyActiveRequestRecord {
  const startedAt = stringField(request.started_at) || stringField(request.at) || "";
  return {
    id: stringField(request.id) || randomUUID(),
    started_at: startedAt,
    method: stringField(request.method),
    path: stringField(request.path),
    request_bytes: numberField(request.request_bytes),
    session: nullableStringField(request.session),
    request_model: nullableStringField(request.request_model),
  };
}

function normalizeProxyHistoryRecord(request: Record<string, unknown>): ProxyRequestRecord {
  const startedAt = stringField(request.started_at) || stringField(request.at) || "";
  const completedAt = stringField(request.completed_at) || stringField(request.at) || startedAt;
  return {
    id: stringField(request.id) || randomUUID(),
    started_at: startedAt,
    completed_at: completedAt,
    method: stringField(request.method),
    path: stringField(request.path),
    status: Number.isInteger(request.status) ? Number(request.status) : null,
    upstream: nullableStringField(request.upstream),
    attempts: Number.isInteger(request.attempts) ? Number(request.attempts) : 0,
    latency_ms: numberField(request.latency_ms),
    request_bytes: numberField(request.request_bytes),
    response_bytes: numberField(request.response_bytes),
    session: nullableStringField(request.session),
    request_model: nullableStringField(request.request_model),
    upstream_model: nullableStringField(request.upstream_model),
    upstream_model_source: nullableStringField(request.upstream_model_source),
    error: nullableStringField(request.error),
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStringField(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = `${value}`;
  return text.length > 0 ? text : null;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeProxyState(state: ProxyState | null): ProxyState | null {
  if (!state) {
    return null;
  }
  return {
    ...state,
    profile_order: Array.isArray(state.profile_order) ? state.profile_order.filter((value) => typeof value === "string" && value.length > 0) : [],
    metrics: normalizeProxyMetrics((state as Record<string, unknown>).metrics),
  };
}

function ensureProxyMetrics(state: ProxyState): ProxyMetrics {
  return state.metrics ?? createProxyMetrics();
}

let proxyStateMutationQueue: Promise<void> = Promise.resolve();

async function mutateProxyMetrics(
  state: ProxyState,
  stateRoot: string,
  mutate: (metrics: ProxyMetrics) => void,
): Promise<void> {
  const mutation = proxyStateMutationQueue.then(async () => {
    const currentState = await readProxyState(stateRoot) ?? state;
    const metrics = ensureProxyMetrics(currentState);
    mutate(metrics);
    currentState.metrics = metrics;
    await writeProxyState(stateRoot, currentState);
    state.metrics = metrics;
  });
  proxyStateMutationQueue = mutation.then(() => undefined, () => undefined);
  await mutation;
}

function updateProxyLatencyStats(latency: ProxyMetrics["latency_ms"], latencyMs: number): void {
  latency.last = latencyMs;
  latency.count += 1;
  latency.sum += latencyMs;
  latency.min = latency.min === null ? latencyMs : Math.min(latency.min, latencyMs);
  latency.max = latency.max === null ? latencyMs : Math.max(latency.max, latencyMs);
}

async function startProxyRequestMetric(
  state: ProxyState,
  stateRoot: string,
  record: ProxyActiveRequestRecord,
): Promise<void> {
  await mutateProxyMetrics(state, stateRoot, (metrics) => {
    metrics.active_requests = [
      record,
      ...metrics.active_requests.filter((request) => request.id !== record.id),
    ].slice(0, PROXY_ACTIVE_REQUEST_LIMIT);
  });
}

async function updateProxyActiveRequestMetric(
  state: ProxyState,
  stateRoot: string,
  record: ProxyActiveRequestRecord,
): Promise<void> {
  await mutateProxyMetrics(state, stateRoot, (metrics) => {
    metrics.active_requests = metrics.active_requests.map((request) => request.id === record.id ? record : request);
  });
}

async function completeProxyRequestMetric(state: ProxyState, stateRoot: string, record: ProxyRequestRecord): Promise<void> {
  await mutateProxyMetrics(state, stateRoot, (metrics) => {
    metrics.active_requests = metrics.active_requests.filter((request) => request.id !== record.id);
    metrics.total_requests += 1;
    incrementProxyStatusCount(metrics.status_counts, record.status);
    if (record.upstream) {
      metrics.upstream_hit_counts[record.upstream] = (metrics.upstream_hit_counts[record.upstream] ?? 0) + 1;
    }
    updateProxyLatencyStats(metrics.latency_ms, record.latency_ms);
    metrics.recent_requests.unshift(record);
    metrics.recent_requests = metrics.recent_requests.slice(0, PROXY_RECENT_REQUEST_LIMIT);
  });
}

function incrementProxyStatusCount(counts: ProxyStatusCounts, status: number | null): void {
  if (status === null) {
    counts["5xx"] += 1;
  } else if (status >= 500) {
    counts["5xx"] += 1;
  } else if (status >= 400) {
    counts["4xx"] += 1;
  } else if (status >= 300) {
    counts["3xx"] += 1;
  } else if (status >= 200) {
    counts["2xx"] += 1;
  }
}

function averageLatency(latency: ProxyMetrics["latency_ms"]): number {
  return latency.count > 0 ? latency.sum / latency.count : 0;
}

function formatLatencyMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return textDim("-");
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  if (value < 60_000) {
    return `${formatThreeSignificant(value / 1000)}s`;
  }
  return `${formatThreeSignificant(value / 60_000)}m`;
}

function formatProxyUpstreamHits(profileOrder: string[], metrics: ProxyMetrics): string {
  const knownNames = [
    ...profileOrder,
    ...Object.keys(metrics.upstream_hit_counts).filter((name) => !profileOrder.includes(name)),
  ];
  if (knownNames.length === 0) {
    return textDim("none");
  }
  return knownNames
    .map((name) => {
      const count = metrics.upstream_hit_counts[name] ?? 0;
      return `${colorName(truncateProxyText(name, 16))}=${count === 0 ? textDim("0") : colorCount(String(count))}`;
    })
    .join(",");
}

function formatProxyStatusCode(status: number | null): string {
  if (status === null) {
    return textDim("");
  }
  if (status >= 500) {
    return textRed(String(status));
  }
  if (status >= 400) {
    return textYellow(String(status));
  }
  if (status >= 300) {
    return textYellow(String(status));
  }
  if (status > 0) {
    return textGreen(String(status));
  }
  return textDim("");
}

function truncateProxyPath(value: string, max = 40): string {
  return truncateVisible(value, max);
}

function truncateProxyText(value: string, max = 40): string {
  return truncateVisible(value, max);
}

function fitProxyTerminalLine(line: string): string {
  const columns = process.stdout.columns;
  if (!process.stdout.isTTY || !columns || visibleLength(line) < columns) {
    return line;
  }

  return truncateVisible(line, columns - 1, "");
}

function formatProxyStatusLine(now: Date, state: ProxyState | null, runtime: ProxyRuntimeState | null): string {
  const runtimeLabel = state && runtime?.healthy ? textGreen("healthy") : state ? textYellow("starting") : textDim("none");
  const pid = runtime?.pid === null || runtime?.pid === undefined
    ? textDim("none")
    : runtime.healthy
      ? textGreen(String(runtime.pid))
      : textYellow(String(runtime.pid));
  return [
    textBold("ccs proxy"),
    `time: ${textDim(now.toLocaleTimeString("en-GB", { hour12: false }))}`,
    `runtime: ${state ? runtimeLabel : textRed("missing")}`,
    `pid: ${pid}`,
    `refresh: ${textDim(`${PROXY_STATUS_REFRESH_SECONDS}s`)}`,
  ].join("  ");
}

function formatProxyPathsLines(state: ProxyState | null, options: ProxyOptions): string[] {
  return [
    `proxy: ${state ? colorUrl(state.proxy_base_url) : textDim("unset")}`,
    `state: ${colorPath(statePath(options.stateRoot))}`,
    `log: ${colorPath(proxyLogPath(options.stateRoot))}`,
    `config: ${colorPath(options.codexConfigPath)}`,
  ];
}

function formatProxyHistoryRequest(record: ProxyRequestRecord): TableRow {
  const time = formatProxyTime(record.completed_at);
  const path = truncateProxyPath(record.path || "-", PROXY_TABLE_PATH_WIDTH);
  const upstream = formatProxyUpstream(record.upstream, record.attempts);
  return {
    time: textDim(time),
    code: formatProxyStatusCode(record.status),
    up: upstream,
    ms: textYellow(formatLatencyMs(record.latency_ms)),
    size: formatProxyBytes(record.response_bytes),
    session: formatProxySession(record.session),
    req_model: formatProxyRequestModel(record.request_model),
    up_model: formatProxyUpstreamModel(record.request_model, record.upstream_model),
    path: colorPath(path),
    error: formatProxyError(record.error),
  };
}

function formatProxyActiveRequest(record: ProxyActiveRequestRecord, nowMs: number): TableRow {
  const startedAt = Date.parse(record.started_at);
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : 0;
  const path = truncateProxyPath(record.path || "-", PROXY_TABLE_PATH_WIDTH);
  return {
    time: textDim(formatProxyTime(record.started_at)),
    code: textDim("…"),
    up: textDim("-"),
    ms: textYellow(formatLatencyMs(elapsedMs)),
    size: formatProxyBytes(record.request_bytes),
    session: formatProxySession(record.session),
    req_model: formatProxyRequestModel(record.request_model),
    up_model: textOrange("[unknown]"),
    path: colorPath(path),
    error: textDim(""),
  };
}

function formatProxyTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString("en-GB", { hour12: false });
}

function formatProxyBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return textDim("-");
  }
  if (value < 1024) {
    return `${Math.round(value)}B`;
  }
  if (value < 1024 * 1024) {
    return `${formatThreeSignificant(value / 1024)}K`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${formatThreeSignificant(value / 1024 / 1024)}M`;
  }
  return `${formatThreeSignificant(value / 1024 / 1024 / 1024)}G`;
}

function formatThreeSignificant(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value >= 100) {
    return Math.round(value).toString();
  }
  if (value >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function formatProxyRequestModel(model: string | null): string {
  if (!model) {
    return textRed("[unknown]");
  }
  return colorName(truncateProxyText(model, PROXY_TABLE_MODEL_WIDTH));
}

function formatProxyUpstreamModel(requestModel: string | null, upstreamModel: string | null): string {
  if (!upstreamModel) {
    return textOrange("[unknown]");
  }
  if (requestModel && upstreamModel === requestModel) {
    return textDim("[same]");
  }
  return textRed(truncateProxyText(upstreamModel, PROXY_TABLE_MODEL_WIDTH));
}

function formatProxyError(error: string | null): string {
  return error ? textRed(error) : textDim("");
}

function formatProxySession(value: string | null): string {
  return value ? truncateProxyText(value, PROXY_TABLE_SESSION_WIDTH) : textDim("-");
}

function formatProxyUpstream(upstream: string | null, attempts: number): string {
  if (!upstream) {
    return textDim("-");
  }
  const suffix = attempts > 1 ? textDim(`x${attempts}`) : "";
  return `${colorName(truncateProxyText(upstream, PROXY_TABLE_UPSTREAM_WIDTH - visibleLength(suffix)))}${suffix}`;
}

export function resolveProxySwitchBaseUrl(state: ProxyState | null): string | null {
  return state?.proxy_base_url ?? null;
}

function buildProxyStateFromProfiles(profiles: ProfilesFile, codexConfigText: string, listenHost: string, listenPort: number): ProxyState {
  const providerName = currentProviderName(codexConfigText);
  const originalBaseUrl = currentProviderBaseUrl(codexConfigText);
  if (!originalBaseUrl) {
    throw new Error(`base_url was not found in [model_providers.${providerName}]`);
  }
  return {
    installed_at: new Date().toISOString(),
    codex_config_path: codexConfigPath(),
    provider_name: providerName,
    original_base_url: originalBaseUrl,
    proxy_base_url: proxyBaseUrl(listenHost, listenPort),
    listen_host: listenHost,
    listen_port: listenPort,
    profile_order: buildProfileOrder(profiles),
    backup_path: "",
    metrics: createProxyMetrics(),
  };
}

function parseReasoningTokens(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  for (const pointer of REASONING_POINTERS) {
    const value = pointer
      .slice(1)
      .split("/")
      .reduce<unknown>((current, segment) => (current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined), payload);
    if (Number.isInteger(value)) {
      return value as number;
    }
  }
  return null;
}

function responseHeadersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}

function isStreamContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/json");
}

function rewriteUpstreamUrl(requestUrl: URL, upstreamBaseUrl: string): string {
  const upstream = new URL(upstreamBaseUrl);
  upstream.pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";
  upstream.search = requestUrl.search;
  upstream.hash = "";
  return upstream.toString();
}

async function readBody(request: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > limitBytes) {
      throw new Error("request body too large");
    }
    chunks.push(value);
  }
  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

function extractSessionShortId(body: Buffer): string | null {
  if (body.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    const sessionId = findJsonStringField(parsed, "session_id");
    return sessionId ? shortSessionId(sessionId) : null;
  } catch {
    return null;
  }
}

function proxyEndpointClass(pathname: string): ProxyEndpointClass | null {
  if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") {
    return "chat/completions";
  }
  if (pathname === "/v1/responses" || pathname === "/responses") {
    return "responses";
  }
  return null;
}

function parseJsonBody(body: Buffer): unknown | null {
  if (body.length === 0) {
    return null;
  }
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function extractRequestModel(body: Buffer, endpointClass: ProxyEndpointClass | null): string | null {
  if (!endpointClass) {
    return null;
  }
  const parsed = parseJsonBody(body);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? jsonStringAt(parsed, ["model"])
    : null;
}

function extractUpstreamModelFromJson(payload: unknown, endpointClass: ProxyEndpointClass | null): ProxyModelExtraction {
  if (!endpointClass || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { model: null, source: null };
  }
  if (endpointClass === "chat/completions") {
    const model = jsonStringAt(payload, ["model"]);
    return model ? { model, source: "json.model" } : { model: null, source: null };
  }

  const responseModel = jsonStringAt(payload, ["response", "model"]);
  if (responseModel) {
    return { model: responseModel, source: "json.response.model" };
  }
  const model = jsonStringAt(payload, ["model"]);
  return model ? { model, source: "json.model" } : { model: null, source: null };
}

function extractUpstreamModelFromSsePayload(payload: unknown, endpointClass: ProxyEndpointClass | null): ProxyModelExtraction {
  const extraction = extractUpstreamModelFromJson(payload, endpointClass);
  if (!extraction.model || !extraction.source) {
    return extraction;
  }
  return { model: extraction.model, source: `sse.data.${extraction.source.slice("json.".length)}` };
}

function jsonStringAt(value: unknown, pathSegments: string[]): string | null {
  let current = value;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

function findJsonStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonStringField(item, field);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw[field] === "string" && raw[field].length > 0) {
    return raw[field];
  }
  for (const item of Object.values(raw)) {
    const found = findJsonStringField(item, field);
    if (found) {
      return found;
    }
  }
  return null;
}

function shortSessionId(value: string): string {
  return value.length <= 10 ? value : value.slice(0, 8);
}

async function forwardRequest(
  request: IncomingMessage,
  upstreamBaseUrl: string,
  body: Buffer,
  timeoutMs: number,
): Promise<Response> {
  const requestUrl = new URL(request.url || "/", "http://localhost");
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "connection" || lower === "transfer-encoding") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  return fetch(rewriteUpstreamUrl(requestUrl, upstreamBaseUrl), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

type ProxyOutcome = {
  response: Response;
  upstream: string | null;
  attempts: number;
  upstreamModel: string | null;
  upstreamModelSource: string | null;
  error: string | null;
};

class ProxyResponseWriteError extends Error {
  constructor(message: string, readonly status: number, readonly responseBytes: number) {
    super(message);
    this.name = "ProxyResponseWriteError";
  }
}

class ProxySseModelScanner {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private modelValue: string | null = null;
  private modelSource: string | null = null;

  constructor(private readonly endpointClass: ProxyEndpointClass | null) {}

  push(chunk: Buffer): void {
    if (!this.endpointClass || this.modelValue) {
      return;
    }
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.consumeCompleteEvents();
  }

  finish(): ProxyModelExtraction {
    if (this.endpointClass && !this.modelValue) {
      this.buffer += this.decoder.decode();
      this.consumeEvent(this.buffer);
      this.buffer = "";
    }
    return { model: this.modelValue, source: this.modelSource };
  }

  current(): ProxyModelExtraction {
    return { model: this.modelValue, source: this.modelSource };
  }

  private consumeCompleteEvents(): void {
    while (!this.modelValue) {
      const separator = findSseEventSeparator(this.buffer);
      if (!separator) {
        return;
      }
      const event = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator.length);
      this.consumeEvent(event);
    }
  }

  private consumeEvent(event: string): void {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") {
      return;
    }
    try {
      const parsed = JSON.parse(data) as unknown;
      const extraction = extractUpstreamModelFromSsePayload(parsed, this.endpointClass);
      if (extraction.model) {
        this.modelValue = extraction.model;
        this.modelSource = extraction.source;
      }
    } catch {
      // SSE data frames can contain non-JSON control text.
    }
  }
}

function findSseEventSeparator(value: string): { index: number; length: number } | null {
  const separators = ["\r\n\r\n", "\n\n", "\r\r"];
  let match: { index: number; length: number } | null = null;
  for (const separator of separators) {
    const index = value.indexOf(separator);
    if (index >= 0 && (!match || index < match.index)) {
      match = { index, length: separator.length };
    }
  }
  return match;
}

async function proxyThroughUpstreamsWithStats(
  request: IncomingMessage,
  upstreams: ProxyUpstream[],
  body: Buffer,
  endpointClass: ProxyEndpointClass | null,
): Promise<ProxyOutcome> {
  const contentType = `${request.headers["content-type"] || ""}`.toLowerCase();
  let lastStatus = 502;
  let lastError = "unknown";
  let attempts = 0;

  for (const upstream of upstreams) {
    attempts += 1;
    let response: Response;
    try {
      response = await forwardRequest(request, upstream.baseURL, body, UPSTREAM_TIMEOUT_MS);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }

    lastStatus = response.status;
    if (!response.ok && (response.status >= 500 || [401, 403, 408, 429].includes(response.status))) {
      lastError = `${upstream.baseURL} returned ${response.status}`;
      continue;
    }

    if (isStreamContentType(contentType) || isStreamContentType(`${response.headers.get("content-type") || ""}`)) {
      return { response, upstream: upstream.name, attempts, upstreamModel: null, upstreamModelSource: null, error: null };
    }

    if (isJsonContentType(`${response.headers.get("content-type") || ""}`)) {
      const text = await response.text();
      let upstreamModel: ProxyModelExtraction = { model: null, source: null };
      try {
        const parsed = JSON.parse(text) as unknown;
        upstreamModel = extractUpstreamModelFromJson(parsed, endpointClass);
        const reasoning = parseReasoningTokens(parsed);
        if (reasoning !== null && REASONING_EQUALS.includes(reasoning)) {
          return {
            response: new Response(
              JSON.stringify({
                error: {
                  message: `codex proxy blocked suspicious reasoning response from ${upstream.baseURL}`,
                  type: "codex_proxy",
                  code: "reasoning_guard_triggered",
                  reasoning_tokens: reasoning,
                  status_code: NON_STREAM_STATUS_CODE,
                },
              }),
              { status: NON_STREAM_STATUS_CODE, headers: { "content-type": "application/json; charset=utf-8" } },
            ),
            upstream: upstream.name,
            attempts,
            upstreamModel: upstreamModel.model,
            upstreamModelSource: upstreamModel.source,
            error: null,
          };
        }
      } catch {
        // keep original payload
      }
      return {
        response: new Response(text, {
          status: response.status,
          headers: responseHeadersToObject(response.headers),
        }),
        upstream: upstream.name,
        attempts,
        upstreamModel: upstreamModel.model,
        upstreamModelSource: upstreamModel.source,
        error: null,
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      response: new Response(buffer, {
        status: response.status,
        headers: responseHeadersToObject(response.headers),
      }),
      upstream: upstream.name,
      attempts,
      upstreamModel: null,
      upstreamModelSource: null,
      error: null,
    };
  }

  return {
    response: new Response(
      JSON.stringify({
        error: {
          message: `proxy upstreams failed: ${lastError}`,
          type: "codex_proxy",
          code: "upstream_failure",
          status_code: lastStatus,
        },
      }),
      { status: NON_STREAM_STATUS_CODE, headers: { "content-type": "application/json; charset=utf-8" } },
    ),
    upstream: null,
    attempts,
    upstreamModel: null,
    upstreamModelSource: null,
    error: lastError,
  };
}

async function writeResponse(
  res: ServerResponse,
  response: Response,
  endpointClass: ProxyEndpointClass | null,
  modelObserver: ProxyWriteModelObserver,
): Promise<number> {
  res.writeHead(response.status, responseHeadersToObject(response.headers));
  if (!response.body) {
    return endEmptyResponse(res);
  }
  const scanner = isStreamContentType(`${response.headers.get("content-type") || ""}`)
    ? new ProxySseModelScanner(endpointClass)
    : null;
  return writeReadableResponse(res, Readable.fromWeb(response.body as never), scanner, modelObserver);
}

async function endEmptyResponse(res: ServerResponse): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null = null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(new ProxyResponseWriteError(error.message, 500, 0));
        return;
      }
      resolve(0);
    };
    res.once("finish", () => finish());
    res.once("error", (error) => finish(error));
    res.end();
  });
}

async function writeReadableResponse(
  res: ServerResponse,
  stream: Readable,
  scanner: ProxySseModelScanner | null,
  modelObserver: ProxyWriteModelObserver,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let responseBytes = 0;
    let settled = false;
    let finished = false;

    const finish = (error: ProxyResponseWriteError | null = null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        stream.destroy();
        reject(error);
        return;
      }
      resolve(responseBytes);
    };

    stream.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      responseBytes += value.length;
      if (scanner) {
        scanner.push(value);
        const extraction = scanner.current();
        modelObserver.model = extraction.model;
        modelObserver.source = extraction.source;
      }
    });
    stream.on("error", (error) => finish(new ProxyResponseWriteError(error.message, 502, responseBytes)));
    res.on("error", (error) => finish(new ProxyResponseWriteError(error.message, 500, responseBytes)));
    res.on("close", () => {
      if (!finished) {
        finish(new ProxyResponseWriteError("client closed response before upstream stream completed", 499, responseBytes));
      }
    });
    res.on("finish", () => {
      finished = true;
      if (scanner) {
        const extraction = scanner.finish();
        modelObserver.model = extraction.model;
        modelObserver.source = extraction.source;
      }
      finish();
    });
    stream.pipe(res);
  });
}

export async function installProxy(options: ProxyOptions): Promise<ProxyInstallPlan> {
  if (!fs.existsSync(options.codexConfigPath)) {
    throw new Error(`Codex config file was not found: ${options.codexConfigPath}`);
  }

  const codexConfigText = await readFile(options.codexConfigPath, "utf8");
  const profiles = await readProfiles();
  const backupPath = path.join(options.stateRoot, "backups", `config-${Date.now()}.toml`);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await copyFile(options.codexConfigPath, backupPath);
  const state = {
    ...buildProxyStateFromProfiles(profiles, codexConfigText, options.listenHost, options.listenPort),
    backup_path: backupPath,
  };
  await writeProxyState(options.stateRoot, state);
  await writeTextFile(options.codexConfigPath, updateTomlBaseUrl(codexConfigText, state.proxy_base_url));
  return {
    backupPath,
    statePath: statePath(options.stateRoot),
    state,
  };
}

export async function restoreProxy(options: ProxyOptions): Promise<string> {
  const state = await readProxyState(options.stateRoot);
  if (!state) {
    throw new Error(`proxy state file was not found: ${statePath(options.stateRoot)}`);
  }

  if (!state.backup_path || !fs.existsSync(state.backup_path)) {
    throw new Error(`backup file was not found: ${state.backup_path}`);
  }

  const stopped = await stopProxy(options);
  await copyFile(state.backup_path, options.codexConfigPath);
  await removeProxyState(options.stateRoot);
  return stopped;
}

function formatProxyRequestsSummary(metrics: ProxyMetrics, profileOrder: string[]): string {
  return [
    `status total=${colorCount(String(metrics.total_requests))}`,
    `active=${metrics.active_requests.length === 0 ? textDim("0") : textYellow(String(metrics.active_requests.length))}`,
    `2xx=${formatProxyStatusCount(metrics.status_counts["2xx"], textGreen)}`,
    `3xx=${formatProxyStatusCount(metrics.status_counts["3xx"], textYellow)}`,
    `4xx=${formatProxyStatusCount(metrics.status_counts["4xx"], textYellow)}`,
    `5xx=${formatProxyStatusCount(metrics.status_counts["5xx"], textRed)}`,
    `upstreams=${formatProxyUpstreamHits(profileOrder, metrics)}`,
  ].join(" ");
}

function formatProxyStatusCount(value: number, color: (text: string) => string): string {
  return value === 0 ? textDim("0") : color(String(value));
}

function formatProxyLatencySummary(metrics: ProxyMetrics): string {
  if (metrics.latency_ms.count === 0) {
    return `latency last=${textDim("-")} avg=${textDim("-")} min=${textDim("-")} max=${textDim("-")}`;
  }
  return [
    `latency last=${textYellow(formatLatencyMs(metrics.latency_ms.last ?? 0))}`,
    `avg=${textYellow(formatLatencyMs(averageLatency(metrics.latency_ms)))}`,
    `min=${textYellow(formatLatencyMs(metrics.latency_ms.min ?? 0))}`,
    `max=${textYellow(formatLatencyMs(metrics.latency_ms.max ?? 0))}`,
  ].join(" ");
}

function renderProxyRequestTable(rows: TableRow[]): string[] {
  return renderTable(PROXY_REQUEST_TABLE_COLUMNS, rows, {
    gap: 1,
    maxWidth: process.stdout.columns,
    boldHeader: false,
  }).map((line) => `  ${line}`);
}

function formatProxyActiveRows(metrics: ProxyMetrics, now: Date, count = PROXY_RECENT_RENDER_COUNT): string[] {
  if (metrics.active_requests.length === 0) {
    return [
      ...renderProxyRequestTable([]),
      `  ${textDim("no active requests")}`,
    ];
  }
  return renderProxyRequestTable(metrics.active_requests.slice(0, count).map((record) => formatProxyActiveRequest(record, now.getTime())));
}

function formatProxyHistoryRows(metrics: ProxyMetrics, count = PROXY_RECENT_RENDER_COUNT): string[] {
  if (metrics.recent_requests.length === 0) {
    return [
      ...renderProxyRequestTable([]),
      `  ${textDim("no historical requests")}`,
    ];
  }
  return renderProxyRequestTable(metrics.recent_requests.slice(0, count).map(formatProxyHistoryRequest));
}

async function renderProxyStatusLines(options: ProxyOptions): Promise<string[]> {
  const runtime = await ensureProxyRunning(options);
  const state = runtime?.state ?? await readProxyState(options.stateRoot);
  const profiles = await readProfiles();
  const profileOrder = state?.profile_order?.length ? state.profile_order : buildProfileOrder(profiles);
  return buildProxyStatusLines(new Date(), state, profileOrder, runtime, options);
}

export function buildProxyStatusLines(
  now: Date,
  state: ProxyState | null,
  profileOrder: string[],
  runtime: ProxyRuntimeState | null,
  options: ProxyOptions,
): string[] {
  const metrics = state?.metrics ?? createProxyMetrics();
  return [
    fitProxyTerminalLine(formatProxyStatusLine(now, state, runtime)),
    ...formatProxyPathsLines(state, options).map(fitProxyTerminalLine),
    fitProxyTerminalLine(formatProxyRequestsSummary(metrics, profileOrder)),
    fitProxyTerminalLine(formatProxyLatencySummary(metrics)),
    textBold("active"),
    ...formatProxyActiveRows(metrics, now),
    textBold("history"),
    ...formatProxyHistoryRows(metrics),
    fitProxyTerminalLine(textDim("commands: ccs proxy | watch | install | restore | stop | serve")),
  ];
}

async function runProxyStatusOnce(options: ProxyOptions): Promise<void> {
  console.log((await renderProxyStatusLines({ ...options, once: true })).join("\n"));
}

async function runProxyStatusWatch(options: ProxyOptions): Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let refreshing = false;
  let firstFrame = true;
  const renderLineCount = PROXY_STATUS_RENDER_LINES;

  const render = async (): Promise<void> => {
    if (refreshing || stopped) {
      return;
    }
    refreshing = true;
    try {
      const lines = await renderProxyStatusLines(options);
      if (firstFrame) {
        process.stdout.write(lines.join("\n"));
        firstFrame = false;
      } else {
        process.stdout.write(`\u001b[${Math.max(0, renderLineCount - 1)}A\r${lines.map((line) => `\u001b[2K${line}`).join("\n")}`);
      }
    } finally {
      refreshing = false;
    }
  };

  await render();
  if (!process.stdout.isTTY) {
    process.stdout.write("\n");
    return;
  }

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer) {
        clearInterval(timer);
      }
      process.stdout.write("\n");
      resolve();
    };

    timer = setInterval(() => {
      void render();
    }, 1000);

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}

export async function stopProxy(options: ProxyOptions): Promise<string> {
  const state = await readProxyState(options.stateRoot);
  const health = state ? await readProxyHealth(state) : { healthy: false, pid: null };
  const file = pidPath(options.stateRoot);
  if (!fs.existsSync(file)) {
    if (state && health.healthy && health.pid !== null) {
      try {
        process.kill(health.pid);
      } catch {
        // ignore
      }
      await waitForProxyStop(state);
      return `Proxy stopped. PID=${health.pid}`;
    }
    return "No running proxy PID file was found.";
  }
  const raw = (await readFile(file, "utf8")).trim();
  if (!raw) {
    await rm(file, { force: true });
    return "Proxy PID file was empty and has been removed.";
  }
  const pid = Number.parseInt(raw, 10);
  if (!state) {
    await rm(file, { force: true });
    return `Proxy state was missing and the PID file has been removed. PID=${pid}`;
  }
  if (!health.healthy) {
    await rm(file, { force: true });
    return `Proxy PID file was stale and has been removed. PID=${pid}`;
  }
  const targetPid = health.pid ?? pid;
  if (Number.isInteger(targetPid)) {
    try {
      process.kill(targetPid);
    } catch {
      // ignore
    }
  }
  await waitForProxyStop(state);
  await rm(file, { force: true });
  return `Proxy stopped. PID=${targetPid}`;
}

export async function serveProxy(options: ProxyOptions): Promise<void> {
  const state = await readProxyState(options.stateRoot);
  if (!state) {
    throw new Error(`proxy state file was not found: ${statePath(options.stateRoot)}`);
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || "/", "http://localhost");
        if (req.method === "GET" && url.pathname === HEALTH_PATH) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ status: "ok", pid: process.pid }));
          return;
        }
        const requestStartedAt = new Date();
        const requestStartedAtMs = performance.now();
        const activeRecord: ProxyActiveRequestRecord = {
          id: randomUUID(),
          started_at: requestStartedAt.toISOString(),
          method: req.method || "GET",
          path: url.pathname,
          request_bytes: 0,
          session: null,
          request_model: null,
        };
        await startProxyRequestMetric(state, options.stateRoot, activeRecord);

        let status: number | null = null;
        let upstream: string | null = null;
        let attempts = 0;
        let responseBytes = 0;
        let upstreamModel: string | null = null;
        let upstreamModelSource: string | null = null;
        let errorText: string | null = null;
        const endpointClass = proxyEndpointClass(url.pathname);
        try {
          const profiles = await readProfiles();
          const upstreamProfiles = buildProxyUpstreams(profiles);
          const body = await readBody(req, REQUEST_BODY_LIMIT_BYTES);
          activeRecord.request_bytes = body.length;
          activeRecord.session = extractSessionShortId(body);
          activeRecord.request_model = extractRequestModel(body, endpointClass);
          await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
          const outcome = await proxyThroughUpstreamsWithStats(req, upstreamProfiles, body, endpointClass);
          status = outcome.response.status;
          upstream = outcome.upstream;
          attempts = outcome.attempts;
          upstreamModel = outcome.upstreamModel;
          upstreamModelSource = outcome.upstreamModelSource;
          errorText = outcome.error;
          const streamModelObserver = { model: upstreamModel, source: upstreamModelSource };
          responseBytes = await writeResponse(res, outcome.response, endpointClass, streamModelObserver);
          upstreamModel = streamModelObserver.model;
          upstreamModelSource = streamModelObserver.source;
        } catch (error) {
          if (error instanceof ProxyResponseWriteError) {
            status = error.status;
            responseBytes = error.responseBytes;
            errorText = error.message;
          } else {
            status = status ?? 500;
            errorText = error instanceof Error ? error.message : String(error);
          }
          if (!res.headersSent) {
            const payload = JSON.stringify({ error: { message: errorText } });
            responseBytes = Buffer.byteLength(payload);
            res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
            res.end(payload);
          }
        }

        const latencyMs = Math.max(0, performance.now() - requestStartedAtMs);
        await completeProxyRequestMetric(state, options.stateRoot, {
          ...activeRecord,
          completed_at: new Date().toISOString(),
          status,
          upstream,
          attempts,
          latency_ms: latencyMs,
          response_bytes: responseBytes,
          request_model: activeRecord.request_model,
          upstream_model: upstreamModel,
          upstream_model_source: upstreamModelSource,
          error: errorText,
        });
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.listen_port, state.listen_host, () => resolve());
  });

  await writeTextFile(pidPath(options.stateRoot), `${process.pid}\n`);
  process.stdout.write(`proxy listening: ${state.proxy_base_url}\n`);

  await new Promise<void>((resolve) => {
    const close = (): void => {
      server.close(() => resolve());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  await rm(pidPath(options.stateRoot), { force: true });
}

function usageHelpLines(): string[] {
  return [
    "Usage:",
    "  ccs proxy                           # print proxy status and upstream order once",
    "  ccs proxy --once                    # print proxy status and upstream order once",
    "  ccs proxy watch                     # watch proxy status and upstream order",
    "  ccs proxy install                   # back up config, install routing, and start background proxy",
    "  ccs proxy restore                   # restore config from the saved backup",
    "  ccs proxy stop                      # stop the healthy background proxy",
    "  ccs proxy serve                     # run the proxy server in the foreground for debugging",
  ];
}

export async function runProxyCommand(args: string[], options: ProxyOptions): Promise<void> {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log(usageHelpLines().join("\n"));
    return;
  }

  const command = args[0] ?? "";
  const rest = args.slice(1);
  if (command === "") {
    await runProxyStatusOnce(options);
    return;
  }
  if (command === "--once") {
    await runProxyStatusOnce(options);
    return;
  }
  if (command === "watch") {
    await runProxyStatusWatch(options);
    return;
  }
  if (command === "install") {
    rejectRemovedYesFlags(rest, "ccs proxy install");
    printKeyValue("plan:", `proxy ${options.listenHost}:${options.listenPort} -> ${options.codexConfigPath}`, 5);
    printKeyValue("note:", "no changes are written unless you type yes", 5);
    if (!(await confirmApply())) {
      return;
    }
    const plan = await installProxy(options);
    const runtime = await ensureProxyRunning(options);
    printKeyValue("backup:", textBlue(plan.backupPath), 5);
    printKeyValue("state:", textGreen(plan.statePath), 5);
    printKeyValue("proxy:", textGreen(plan.state.proxy_base_url), 5);
    printKeyValue("runtime:", runtime?.started ? textGreen("started") : textGreen("healthy"), 8);
    printKeyValue("pid:", runtime?.pid === null || runtime?.pid === undefined ? textDim("none") : textGreen(String(runtime.pid)), 8);
    printKeyValue("log:", textBlue(proxyLogPath(options.stateRoot)), 8);
    return;
  }
  if (command === "restore") {
    rejectRemovedYesFlags(rest, "ccs proxy restore");
    printKeyValue("plan:", `restore ${options.codexConfigPath} from proxy state`, 5);
    printKeyValue("note:", "no changes are written unless you type yes", 5);
    if (!(await confirmApply())) {
      return;
    }
    const stopped = await restoreProxy(options);
    printKeyValue("runtime:", stopped, 8);
    printKeyValue("state:", textGreen("removed"), 5);
    return;
  }
  if (command === "stop") {
    console.log(await stopProxy(options));
    return;
  }
  if (command === "serve") {
    await serveProxy(options);
    return;
  }
  throw new Error(`unknown argument for ccs proxy: ${command}`);
}
