import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setInterval } from "node:timers";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexConfigPath, profilesPath } from "../lib/paths.js";
import { readTextIfExists, writeTextFile, writeTextFileAtomic } from "../lib/fs.js";
import { colorPath, printKeyValue } from "../lib/output.js";
import { textBlue, textDim, textGreen } from "../lib/text.js";
import { readTomlBaseUrl, readTopLevelTomlString, updateTomlBaseUrl } from "../lib/toml.js";

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
  successful_requests: number;
  failed_requests: number;
  upstream_hit_counts: Record<string, number>;
  latency_ms: {
    count: number;
    sum: number;
    min: number | null;
    max: number | null;
    samples: number[];
  };
  recent_requests: ProxyRequestRecord[];
};

type ProxyRequestRecord = {
  at: string;
  method: string;
  path: string;
  status: number;
  upstream: string | null;
  attempts: number;
  latency_ms: number;
  error: string | null;
};

type ProxyInstallPlan = {
  backupPath: string;
  statePath: string;
  state: ProxyState;
};

type ProxyOptions = {
  codexConfigPath: string;
  listenHost: string;
  listenPort: number;
  stateRoot: string;
  once?: boolean;
};

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 4610;
const HEALTH_PATH = "/__codex_proxy/health";
const PROXY_STATE_FILE = "proxy.json";
const REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60 * 1000;
const NON_STREAM_STATUS_CODE = 502;
const REASONING_EQUALS = [516];
const PROXY_RECENT_REQUEST_LIMIT = 10;
const PROXY_LATENCY_SAMPLE_LIMIT = 120;
const PROXY_STATUS_RENDER_LINES = 12;
const REASONING_POINTERS = [
  "/usage/output_tokens_details/reasoning_tokens",
  "/usage/completion_tokens_details/reasoning_tokens",
  "/response/usage/output_tokens_details/reasoning_tokens",
  "/response/usage/completion_tokens_details/reasoning_tokens",
];

function statePath(stateRoot: string): string {
  return path.join(stateRoot, PROXY_STATE_FILE);
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
    successful_requests: 0,
    failed_requests: 0,
    upstream_hit_counts: {},
    latency_ms: {
      count: 0,
      sum: 0,
      min: null,
      max: null,
      samples: [],
    },
    recent_requests: [],
  };
}

function normalizeProxyMetrics(value: unknown): ProxyMetrics {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const latency = raw.latency_ms && typeof raw.latency_ms === "object" ? raw.latency_ms as Record<string, unknown> : {};
  return {
    total_requests: Number.isInteger(raw.total_requests) ? Number(raw.total_requests) : 0,
    successful_requests: Number.isInteger(raw.successful_requests) ? Number(raw.successful_requests) : 0,
    failed_requests: Number.isInteger(raw.failed_requests) ? Number(raw.failed_requests) : 0,
    upstream_hit_counts: raw.upstream_hit_counts && typeof raw.upstream_hit_counts === "object" && !Array.isArray(raw.upstream_hit_counts)
      ? Object.fromEntries(
          Object.entries(raw.upstream_hit_counts as Record<string, unknown>)
            .filter(([, count]) => Number.isInteger(count))
            .map(([name, count]) => [name, Number(count)]),
        )
      : {},
    latency_ms: {
      count: Number.isInteger(latency.count) ? Number(latency.count) : 0,
      sum: typeof latency.sum === "number" ? latency.sum : 0,
      min: typeof latency.min === "number" ? latency.min : null,
      max: typeof latency.max === "number" ? latency.max : null,
      samples: Array.isArray(latency.samples)
        ? latency.samples.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        : [],
    },
    recent_requests: Array.isArray(raw.recent_requests)
      ? raw.recent_requests.filter((item): item is ProxyRequestRecord => Boolean(item) && typeof item === "object")
        .map((item) => {
          const request = item as Record<string, unknown>;
          return {
            at: `${request.at ?? ""}`,
            method: `${request.method ?? ""}`,
            path: `${request.path ?? ""}`,
            status: Number.isInteger(request.status) ? Number(request.status) : 0,
            upstream: request.upstream === null ? null : `${request.upstream ?? ""}` || null,
            attempts: Number.isInteger(request.attempts) ? Number(request.attempts) : 0,
            latency_ms: typeof request.latency_ms === "number" ? request.latency_ms : 0,
            error: request.error === null ? null : `${request.error ?? ""}` || null,
          };
        })
      : [],
  };
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

function updateProxyLatencyStats(latency: ProxyMetrics["latency_ms"], latencyMs: number): void {
  latency.count += 1;
  latency.sum += latencyMs;
  latency.min = latency.min === null ? latencyMs : Math.min(latency.min, latencyMs);
  latency.max = latency.max === null ? latencyMs : Math.max(latency.max, latencyMs);
  latency.samples.push(latencyMs);
  if (latency.samples.length > PROXY_LATENCY_SAMPLE_LIMIT) {
    latency.samples.splice(0, latency.samples.length - PROXY_LATENCY_SAMPLE_LIMIT);
  }
}

function recordProxyRequestMetric(state: ProxyState, record: ProxyRequestRecord): void {
  const metrics = ensureProxyMetrics(state);
  metrics.total_requests += 1;
  if (record.status >= 500) {
    metrics.failed_requests += 1;
  } else {
    metrics.successful_requests += 1;
  }
  if (record.upstream) {
    metrics.upstream_hit_counts[record.upstream] = (metrics.upstream_hit_counts[record.upstream] ?? 0) + 1;
  }
  updateProxyLatencyStats(metrics.latency_ms, record.latency_ms);
  metrics.recent_requests.unshift(record);
  metrics.recent_requests = metrics.recent_requests.slice(0, PROXY_RECENT_REQUEST_LIMIT);
  state.metrics = metrics;
}

function averageLatency(latency: ProxyMetrics["latency_ms"]): number {
  return latency.count > 0 ? latency.sum / latency.count : 0;
}

function percentileLatency(samples: number[], percentile: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index];
}

function formatLatencyMs(value: number): string {
  return `${Math.round(value)}ms`;
}

function formatFailureRate(successful: number, failed: number): string {
  const total = successful + failed;
  const rate = total > 0 ? (failed / total) * 100 : 0;
  return `${rate.toFixed(1)}%`;
}

function formatProxyUpstreamHits(profileOrder: string[], metrics: ProxyMetrics): string {
  const knownNames = [
    ...profileOrder,
    ...Object.keys(metrics.upstream_hit_counts).filter((name) => !profileOrder.includes(name)),
  ];
  if (knownNames.length === 0) {
    return "upstreams: none";
  }
  return `upstreams: ${knownNames
    .map((name) => `${name}=${metrics.upstream_hit_counts[name] ?? 0}`)
    .join(" | ")}`;
}

function formatProxyRecentRequest(record: ProxyRequestRecord, index: number): string {
  const at = record.at ? new Date(record.at).toLocaleTimeString("en-GB", { hour12: false }) : "--:--:--";
  const error = record.error ? ` ${record.error}` : "";
  return `${index + 1}. ${at} ${record.method} ${truncateProxyPath(record.path)} ${record.status} ${record.upstream ?? "-"} ${formatLatencyMs(record.latency_ms)} x${record.attempts}${error}`;
}

function truncateProxyPath(value: string, max = 40): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
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

async function proxyThroughUpstreams(request: IncomingMessage, upstreams: Profile[], body: Buffer): Promise<Response> {
  const contentType = `${request.headers["content-type"] || ""}`.toLowerCase();
  let lastStatus = 502;
  let lastError = "unknown";

  for (const upstream of upstreams) {
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
      return response;
    }

    if (isJsonContentType(`${response.headers.get("content-type") || ""}`)) {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as unknown;
        const reasoning = parseReasoningTokens(parsed);
        if (reasoning !== null && REASONING_EQUALS.includes(reasoning)) {
          return new Response(
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
          );
        }
      } catch {
        // keep original payload
      }
      return new Response(text, {
        status: response.status,
        headers: responseHeadersToObject(response.headers),
      });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return new Response(buffer, {
      status: response.status,
      headers: responseHeadersToObject(response.headers),
    });
  }

  return new Response(
    JSON.stringify({
      error: {
        message: `proxy upstreams failed: ${lastError}`,
        type: "codex_proxy",
        code: "upstream_failure",
        status_code: lastStatus,
      },
    }),
    { status: NON_STREAM_STATUS_CODE, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

type ProxyOutcome = {
  response: Response;
  upstream: string | null;
  attempts: number;
  error: string | null;
};

async function proxyThroughUpstreamsWithStats(request: IncomingMessage, upstreams: ProxyUpstream[], body: Buffer): Promise<ProxyOutcome> {
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
      return { response, upstream: upstream.name, attempts, error: null };
    }

    if (isJsonContentType(`${response.headers.get("content-type") || ""}`)) {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as unknown;
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
    error: lastError,
  };
}

function writeResponse(res: ServerResponse, response: Response): void {
  res.writeHead(response.status, responseHeadersToObject(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body as never).pipe(res);
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

export async function restoreProxy(options: ProxyOptions): Promise<void> {
  const state = await readProxyState(options.stateRoot);
  if (!state) {
    throw new Error(`proxy state file was not found: ${statePath(options.stateRoot)}`);
  }

  if (!state.backup_path || !fs.existsSync(state.backup_path)) {
    throw new Error(`backup file was not found: ${state.backup_path}`);
  }

  await copyFile(state.backup_path, options.codexConfigPath);
  await removeProxyState(options.stateRoot);
}

async function readProxyPid(stateRoot: string): Promise<{ pid: number | null; running: boolean }> {
  const pidPath = path.join(stateRoot, "proxy.pid");
  if (!fs.existsSync(pidPath)) {
    return { pid: null, running: false };
  }
  const raw = (await readFile(pidPath, "utf8")).trim();
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

function formatProxyRequestsSummary(metrics: ProxyMetrics): string {
  return [
    `requests: total ${metrics.total_requests}`,
    `ok ${metrics.successful_requests}`,
    `failed ${metrics.failed_requests}`,
    `rate ${formatFailureRate(metrics.successful_requests, metrics.failed_requests)}`,
  ].join(" | ");
}

function formatProxyLatencySummary(metrics: ProxyMetrics): string {
  return [
    `latency: avg ${formatLatencyMs(averageLatency(metrics.latency_ms))}`,
    `p50 ${formatLatencyMs(percentileLatency(metrics.latency_ms.samples, 50))}`,
    `p95 ${formatLatencyMs(percentileLatency(metrics.latency_ms.samples, 95))}`,
    `min ${formatLatencyMs(metrics.latency_ms.min ?? 0)}`,
    `max ${formatLatencyMs(metrics.latency_ms.max ?? 0)}`,
  ].join(" | ");
}

function formatProxyRecentHeader(metrics: ProxyMetrics): string {
  return `recent: ${metrics.recent_requests.length > 0 ? "" : "none"}`.trimEnd();
}

function formatProxyStateLine(now: Date, state: ProxyState | null, pidState: { pid: number | null; running: boolean }): string {
  return [
    `status: ${state ? "installed" : "missing"}`,
    `proxy ${state ? state.proxy_base_url : "unset"}`,
    `pid ${pidState.pid ? (pidState.running ? "running" : "stopped") : "none"}${pidState.pid ? ` ${pidState.pid}` : ""}`,
    `time ${now.toLocaleTimeString("en-GB", { hour12: false })}`,
  ].join(" | ");
}

function formatProxyFilesLine(options: ProxyOptions): string {
  return `files: ${colorPath(options.codexConfigPath)}  ${colorPath(options.stateRoot)}`;
}

function formatProxyRecentRows(metrics: ProxyMetrics, count = 5): string[] {
  const rows = metrics.recent_requests.slice(0, count).map((record, index) => textDim(formatProxyRecentRequest(record, index)));
  while (rows.length < count) {
    rows.push(textDim("-"));
  }
  return rows;
}

function buildProxyStatusLines(
  now: Date,
  state: ProxyState | null,
  profileOrder: string[],
  pidState: { pid: number | null; running: boolean },
  options: ProxyOptions,
): string[] {
  const metrics = state?.metrics ?? createProxyMetrics();
  return [
    formatProxyStateLine(now, state, pidState),
    formatProxyFilesLine(options),
    formatProxyRequestsSummary(metrics),
    formatProxyLatencySummary(metrics),
    formatProxyUpstreamHits(profileOrder, metrics),
    formatProxyRecentHeader(metrics),
    ...formatProxyRecentRows(metrics, 5),
    textDim("commands: ccs proxy [--once] | install | restore | stop | serve"),
  ];
}

async function runProxyStatusLoop(options: ProxyOptions): Promise<void> {
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
      const state = await readProxyState(options.stateRoot);
      const profiles = await readProfiles();
      const profileOrder = state?.profile_order?.length ? state.profile_order : buildProfileOrder(profiles);
      const pidState = await readProxyPid(options.stateRoot);
      const lines = buildProxyStatusLines(new Date(), state, profileOrder, pidState, options);
      if (process.stdout.isTTY) {
        if (firstFrame) {
          process.stdout.write(lines.join("\n"));
          firstFrame = false;
        } else {
          process.stdout.write(`\u001b[${Math.max(0, renderLineCount - 1)}A\r${lines.map((line) => `\u001b[2K${line}`).join("\n")}`);
        }
      } else {
        console.log(lines.join("\n"));
      }
    } finally {
      refreshing = false;
    }
  };

  await render();
  if (options.once || !process.stdout.isTTY) {
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
  const pidPath = path.join(options.stateRoot, "proxy.pid");
  if (!fs.existsSync(pidPath)) {
    return "No running proxy PID file was found.";
  }
  const raw = (await readFile(pidPath, "utf8")).trim();
  if (!raw) {
    await rm(pidPath, { force: true });
    return "Proxy PID file was empty and has been removed.";
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isInteger(pid)) {
    try {
      process.kill(pid);
    } catch {
      // ignore
    }
  }
  await rm(pidPath, { force: true });
  return `Proxy stopped. PID=${pid}`;
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
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        const profiles = await readProfiles();
        const upstreamProfiles = buildProxyUpstreams(profiles);
        const body = await readBody(req, REQUEST_BODY_LIMIT_BYTES);
        const requestStartedAt = performance.now();
        const outcome = await proxyThroughUpstreamsWithStats(req, upstreamProfiles, body);
        const latencyMs = Math.max(0, performance.now() - requestStartedAt);
        recordProxyRequestMetric(state, {
          at: new Date().toISOString(),
          method: req.method || "GET",
          path: url.pathname,
          status: outcome.response.status,
          upstream: outcome.upstream,
          attempts: outcome.attempts,
          latency_ms: latencyMs,
          error: outcome.error,
        });
        await writeProxyState(options.stateRoot, state);
        writeResponse(res, outcome.response);
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

  const pidPath = path.join(options.stateRoot, "proxy.pid");
  await writeTextFile(pidPath, `${process.pid}\n`);
  process.stdout.write(`proxy listening: ${state.proxy_base_url}\n`);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => server.close(() => resolve()));
    process.once("SIGTERM", () => server.close(() => resolve()));
  });
}

function usageHelpLines(): string[] {
  return [
    "Usage:",
    "  ccs proxy [--once]                  # print or watch proxy status and upstream order",
    "  ccs proxy install                   # back up config and install proxy routing",
    "  ccs proxy restore                   # restore config from the saved backup",
    "  ccs proxy stop                      # stop a running proxy process by PID file",
    "  ccs proxy serve                     # run the proxy server in the foreground",
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
    await runProxyStatusLoop(options);
    return;
  }
  if (command === "--once") {
    await runProxyStatusLoop({ ...options, once: true });
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
    printKeyValue("backup:", textBlue(plan.backupPath), 5);
    printKeyValue("state:", textGreen(plan.statePath), 5);
    printKeyValue("proxy:", textGreen(plan.state.proxy_base_url), 5);
    return;
  }
  if (command === "restore") {
    rejectRemovedYesFlags(rest, "ccs proxy restore");
    printKeyValue("plan:", `restore ${options.codexConfigPath} from proxy state`, 5);
    printKeyValue("note:", "no changes are written unless you type yes", 5);
    if (!(await confirmApply())) {
      return;
    }
    await restoreProxy(options);
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
