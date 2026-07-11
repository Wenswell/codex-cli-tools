import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexConfigPath, codexToolsCacheDir, formatHomePath, profilesPath } from "../lib/paths.js";
import { readTextIfExists, writeTextFile, writeTextFileAtomic } from "../lib/fs.js";
import { formatCompactBytes, formatDurationMs } from "../lib/format.js";
import { colorCost, colorCount, colorName, colorPath, colorUrl, printKeyValue } from "../lib/output.js";
import { appendBoundedJsonLine } from "../lib/runtime-log.js";
import { runLiveView } from "../lib/live-view.js";
import { modelPriceParts, readModelPriceCache, type ModelPriceCache, type ModelPriceOverride } from "../lib/pricing.js";
import { bgDarkBlue, textBlue, textBold, textCyan, textDim, textGreen, textMagenta, textOrange, textRed, textYellow, truncateVisible, visibleLength } from "../lib/text.js";
import { readTomlBaseUrl, readTomlProviderBaseUrl, readTopLevelTomlString, updateTomlProviderBaseUrl } from "../lib/toml.js";
import { renderTable, type TableColumn, type TableRow } from "../lib/table.js";
import { fitTerminalLine } from "../lib/terminal.js";
import { packageVersion } from "../lib/version.js";

type Profile = {
  baseURL: string;
  apiKey: string;
};

type ProxyUpstream = {
  name: string;
  baseURL: string;
  apiKey: string;
};

type ProfilesFile = {
  profiles?: Record<string, Profile>;
  current?: string;
  toggle?: string[];
  pricing?: { overrides?: Record<string, ModelPriceOverride> };
};

type ProxyView = "overview" | "tokens" | "cost";

type ProxyUsageAttempt = {
  attempt: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  pricing_model: string | null;
  pricing_model_source: "upstream_model" | "request_model" | null;
  pricing_tier: string | null;
  pricing_tier_source: "response" | "request" | "config" | null;
};

type ProxyState = {
  installed_at: string;
  codex_config_path: string;
  provider_name: string;
  original_base_url: string;
  proxy_base_url: string;
  mode: ProxyMode;
  listen_host: string;
  listen_port: number;
  profile_order: string[];
  backup_path: string;
  metrics: ProxyMetrics;
};

type ProxyMetrics = {
  total_requests: number;
  active_requests: ProxyRequestRecord[];
  status_counts: ProxyStatusCounts;
  reasoning_token_counts: ProxyReasoningTokenCounts;
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

type ProxyStatusCounts = Record<string, number>;
type ProxyReasoningTokenCounts = Record<string, number>;
type ProxyMode = "passthrough" | "intercept" | "recovery";
type ProxyRequestKind = "normal" | "context_compaction";
type ProxyContinuationRecoveryCounts = {
  attempts: number;
  recovered: number;
  exhausted: number;
};

type ProxyRequestRecord = {
  schema_version: number;
  id: string;
  started_at: string;
  completed_at: string | null;
  mode: ProxyMode;
  method: string;
  path: string;
  status: number | null;
  upstream_status: number | null;
  client_status: number | null;
  final_action: string;
  failure_summary: ProxyFailureSummary | null;
  upstream: string | null;
  attempts: number;
  latency_ms: number;
  client_ttfb_ms: number | null;
  upstream_wait_ms: number | null;
  time_to_first_chunk_ms: number | null;
  stream_duration_ms: number | null;
  request_bytes: number;
  response_bytes: number;
  session: string | null;
  client_turn_id: string | null;
  client_request_attempt: number;
  request_kind: ProxyRequestKind;
  request_model: string | null;
  request_reasoning_effort: string | null;
  request_body_sha256: string | null;
  upstream_model: string | null;
  upstream_model_source: string | null;
  stream_model: string | null;
  final_response_model: string | null;
  system_fingerprint: string | null;
  service_tier: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  reasoning_tokens_source: string | null;
  output_tokens: number | null;
  total_tokens: number | null;
  usage_attempts: ProxyUsageAttempt[];
  reasoning_text_observed: boolean;
  reasoning_text_source: string | null;
  has_commentary: boolean;
  has_final_answer: boolean;
  final_answer_only: boolean;
  has_tool_call: boolean;
  has_reasoning_item: boolean;
  guard_actions: ProxyGuardActionRecord[];
  retry_summary: ProxyRetrySummary;
  error: string | null;
};

type ProxyFailureSummary = {
  type: string | null;
  code: string | null;
  message: string | null;
};

type ProxyAttemptRecord = {
  attempt: number;
  started_at: string;
  headers_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  upstream: string | null;
  upstream_status: number | null;
  upstream_wait_ms: number | null;
  time_to_first_chunk_ms: number | null;
  stream_duration_ms: number | null;
  upstream_model: string | null;
  upstream_model_source: string | null;
  stream_model: string | null;
  final_response_model: string | null;
  system_fingerprint: string | null;
  service_tier: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  reasoning_tokens_source: string | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_text_observed: boolean;
  reasoning_text_source: string | null;
  has_commentary: boolean;
  has_final_answer: boolean;
  final_answer_only: boolean;
  has_tool_call: boolean;
  has_reasoning_item: boolean;
  final_action: string;
  failure_summary: ProxyFailureSummary | null;
  remaining_retries: number | null;
};

type ProxyCompleteRequestRecord = ProxyRequestRecord & {
  request_headers: Record<string, string>;
  attempt_records: ProxyAttemptRecord[];
};

type ProxyRetrySummary = {
  total: number;
  reasoning_guard: number;
  upstream_capacity: number;
  transport: number;
};

type ProxyGuardAction = "internal_retry" | "continuation_recovery" | "return_status_502" | "upstream_error";

type ProxyGuardActionRecord = {
  at: string;
  action: ProxyGuardAction;
  upstream: string | null;
  attempt: number;
  status: number | null;
  reasoning_tokens: number | null;
  error: string | null;
};

type ProxyInstallPlan = {
  backupPath: string;
  statePath: string;
  state: ProxyState;
  currentBaseUrl: string;
  targetBaseUrl: string;
  sourceConfig: string;
  targetConfig: string;
  runtime?: ProxyRuntimeState | null;
};

type ProxyRestorePlan = {
  backupPath: string;
  state: ProxyState;
  profileName: string;
  currentBaseUrl: string;
  targetBaseUrl: string;
  sourceConfig: string;
  targetConfig: string;
};

type ProxyRuntimeState = {
  state: ProxyState;
  pid: number | null;
  healthy: boolean;
  started: boolean;
  logPath: string;
  version: string | null;
  protocol: number | null;
};

type ProxyHealth = {
  healthy: boolean;
  pid: number | null;
  version: string | null;
  protocol: number | null;
  mode: ProxyMode | null;
};

type ProxyOptions = {
  codexConfigPath: string;
  listenHost: string;
  listenPort: number;
  stateRoot: string;
  historyCount?: number;
  once?: boolean;
  watch?: boolean;
  view?: ProxyView;
};

type ProxyEndpointClass = "chat/completions" | "responses";

type ProxyRoute =
  | { kind: "control"; endpoint: "health" }
  | { kind: "model_api"; endpointClass: ProxyEndpointClass }
  | { kind: "invalid" };

type ProxyModelExtraction = {
  model: string | null;
  source: string | null;
};

type ProxyReasoningMetadata = {
  reasoningTokens: number | null;
  reasoningTokensSource: string | null;
  reasoningTextObserved: boolean;
  reasoningTextSource: string | null;
};

type ProxyUsageMetadata = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

type ProxyUpstreamMetadata = {
  systemFingerprint: string | null;
  serviceTier: string | null;
};

type ProxyResponseShape = {
  hasCommentary: boolean;
  hasFinalAnswer: boolean;
  hasToolCall: boolean;
  hasReasoningItem: boolean;
};

type ProxyBodyTiming = {
  timeToFirstChunkMs: number | null;
  streamDurationMs: number | null;
};

type ProxyContinuationReasoningItem = Record<string, unknown>;

type ProxyWriteModelObserver = ProxyModelExtraction & {
  update?: (extraction: ProxyModelExtraction) => void | Promise<void>;
};

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 4610;
const HEALTH_PATH = "/__codex_proxy/health";
const PROXY_HEALTH_PROTOCOL = 4;
const PROXY_STATE_FILE = "proxy.json";
const PROXY_MODE_PASSTHROUGH = "passthrough";
const PROXY_MODE_INTERCEPT = "intercept";
const PROXY_MODE_RECOVERY = "recovery";
const PROXY_DEFAULT_MODE: ProxyMode = PROXY_MODE_RECOVERY;
const PROXY_INSTALL_MODE: ProxyMode = PROXY_MODE_PASSTHROUGH;
const NON_STREAM_STATUS_CODE = 502;
const REASONING_EQUALS = [516, 1034, 1552];
const REASONING_SUMMARY_VALUES = [0, ...REASONING_EQUALS];
const GUARD_RETRY_ATTEMPTS = 3;
const FETCH_FAILED_TRANSPORT_RETRIES = 1;
const UPSTREAM_CAPACITY_ERROR_MESSAGE = "Selected model is at capacity. Please try a different model.";
const REQUEST_KIND_NORMAL: ProxyRequestKind = "normal";
const REQUEST_KIND_CONTEXT_COMPACTION: ProxyRequestKind = "context_compaction";
const CONTEXT_COMPACTION_MARKERS = ["remote_compaction", "context_compaction"];
const CONTINUATION_ENCRYPTED_INCLUDE = "reasoning.encrypted_content";
const CONTINUATION_MARKER_TEXT = "Continue thinking...";
const PROXY_RECENT_REQUEST_LIMIT = 100;
const PROXY_ACTIVE_REQUEST_LIMIT = 50;
const PROXY_RECENT_RENDER_COUNT = 5;
const PROXY_JSONL_TAIL_BLOCK_BYTES = 64 * 1024;
const PROXY_REQUEST_LOG_MAX_BYTES = 64 * 1024 * 1024;
const PROXY_EVENT_LOG_MAX_BYTES = 16 * 1024 * 1024;
const PROXY_RUNTIME_LOG_MAX_BYTES = 16 * 1024 * 1024;
const PROXY_RUNTIME_LOG_TRIM_BYTES = 12 * 1024 * 1024;
const PROXY_REQUEST_SCHEMA_VERSION = 5;
const PROXY_TABLE_TIME_WIDTH = 8 + 1;
const PROXY_TABLE_UPSTREAM_WIDTH = 6;
const PROXY_TABLE_LATENCY_WIDTH = 6;
const PROXY_TABLE_SIZE_WIDTH = 6;
const PROXY_TABLE_SESSION_WIDTH = 8 + 1;
const PROXY_TABLE_REASONING_STATUS_WIDTH = 10;
const PROXY_TABLE_MODEL_WIDTH = 10;
const PROXY_REQUEST_TABLE_INDENT = "  ";
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
const REASONING_TEXT_POINTERS = [
  "/choices/0/delta/reasoning_content",
  "/choices/0/message/reasoning_content",
  "/choices/0/delta/reasoning",
  "/choices/0/message/reasoning",
  "/delta/reasoning_content",
  "/message/reasoning_content",
  "/delta/reasoning",
  "/message/reasoning",
  "/output/0/content/0/reasoning",
  "/response/output/0/content/0/reasoning",
];
const REQUEST_HEADER_ALLOWLIST = [
  "content-type",
  "accept",
  "user-agent",
  "x-codex-request-kind",
  "x-codex-purpose",
  "x-codex-turn-metadata",
  "x-codex-beta-features",
  "openai-organization",
  "openai-project",
];

const PROXY_OVERVIEW_TABLE_COLUMNS: TableColumn[] = [
  { key: "session", title: "session", width: PROXY_TABLE_SESSION_WIDTH, align: "right" },
  { key: "time", title: "time", width: PROXY_TABLE_TIME_WIDTH, align: "right" },
  { key: "up", title: "up", width: PROXY_TABLE_UPSTREAM_WIDTH, align: "right" },
  { key: "model", title: "model", width: PROXY_TABLE_MODEL_WIDTH, align: "right" },
  { key: "reasoning_status", title: "reas./code", width: PROXY_TABLE_REASONING_STATUS_WIDTH, align: "right" },
  { key: "ms", title: "lat.", width: PROXY_TABLE_LATENCY_WIDTH, align: "right" },
  { key: "size", title: "size", width: PROXY_TABLE_SIZE_WIDTH, align: "right" },
  { key: "error", title: "error", flex: true, minWidth: 12, align: "left" },
];
const PROXY_TOKEN_TABLE_COLUMNS: TableColumn[] = [
  ...PROXY_OVERVIEW_TABLE_COLUMNS.slice(0, 4),
  { key: "input_tokens", title: "input", width: 9, align: "right" },
  { key: "output_tokens", title: "output", width: 9, align: "right" },
  { key: "cached_input_tokens", title: "cached", width: 9, align: "right" },
  PROXY_OVERVIEW_TABLE_COLUMNS.at(-1)!,
];
const PROXY_COST_TABLE_COLUMNS: TableColumn[] = [
  ...PROXY_OVERVIEW_TABLE_COLUMNS.slice(0, 4),
  { key: "input_cost", title: "input$", width: 9, align: "right" },
  { key: "output_cost", title: "output$", width: 9, align: "right" },
  { key: "cached_cost", title: "cached$", width: 9, align: "right" },
  { key: "total_cost", title: "total$", width: 9, align: "right" },
  PROXY_OVERVIEW_TABLE_COLUMNS.at(-1)!,
];
const PROXY_SESSION_COLORS = [textBlue, textCyan, textGreen, textMagenta, textOrange, textYellow];

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

export async function readProxyState(stateRoot: string = process.env.CCS_PROXY_STATE_ROOT || path.join(codexToolsCacheDir(), "proxy")): Promise<ProxyState | null> {
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

function proxyRequestsPath(stateRoot: string): string {
  return path.join(stateRoot, "proxy-requests.jsonl");
}

function proxyRuntimeLogPath(stateRoot: string): string {
  return path.join(stateRoot, "proxy-runtime.log");
}

async function appendProxyJsonLine(filePath: string, value: Record<string, unknown>): Promise<void> {
  await appendBoundedJsonLine(filePath, { at: new Date().toISOString(), ...value }, { maxBytes: PROXY_EVENT_LOG_MAX_BYTES, mode: 0o600 });
}

async function appendProxyRequestRecord(stateRoot: string, record: ProxyCompleteRequestRecord): Promise<void> {
  await appendBoundedJsonLine(proxyRequestsPath(stateRoot), record, { maxBytes: PROXY_REQUEST_LOG_MAX_BYTES, mode: 0o600 });
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
      return { healthy: false, pid: null, version: null, protocol: null, mode: null };
    }
    const payload = await response.json().catch(() => null) as { status?: unknown; pid?: unknown; version?: unknown; protocol?: unknown; mode?: unknown } | null;
    return {
      healthy: payload?.status === "ok",
      pid: payload && Number.isInteger(payload.pid) ? Number(payload.pid) : null,
      version: typeof payload?.version === "string" ? payload.version : null,
      protocol: payload && Number.isInteger(payload.protocol) ? Number(payload.protocol) : null,
      mode: normalizeProxyMode(payload?.mode),
    };
  } catch {
    return { healthy: false, pid: null, version: null, protocol: null, mode: null };
  }
}

function assertProxyHealthProtocol(health: ProxyHealth): void {
  if (!health.healthy) {
    return;
  }
  if (health.protocol !== PROXY_HEALTH_PROTOCOL) {
    const current = health.protocol === null ? "unknown" : String(health.protocol);
    throw new Error(`proxy protocol mismatch: server=${current} client=${PROXY_HEALTH_PROTOCOL}; restart ccs proxy`);
  }
}

function proxyHealthProtocolMatches(health: ProxyHealth): boolean {
  return health.healthy && health.protocol === PROXY_HEALTH_PROTOCOL;
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
  throw new Error(`proxy did not become healthy: ${healthUrl(state)}; runtime log: ${proxyRuntimeLogPath(stateRoot)}`);
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
      if (state) {
        const health = await readProxyHealth(state);
        if (proxyHealthProtocolMatches(health)) {
          return null;
        }
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
  const logPath = proxyRuntimeLogPath(options.stateRoot);
  trimProxyRuntimeLog(logPath);
  const stdout = fs.openSync(logPath, "a", 0o600);
  const stderr = fs.openSync(logPath, "a", 0o600);
  fs.chmodSync(logPath, 0o600);
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

function trimProxyRuntimeLog(logPath: string): void {
  let fileStat;
  try {
    fileStat = fs.statSync(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (fileStat.size <= PROXY_RUNTIME_LOG_MAX_BYTES) {
    return;
  }

  const fd = fs.openSync(logPath, "r+");
  try {
    const buffer = Buffer.allocUnsafe(PROXY_RUNTIME_LOG_TRIM_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, PROXY_RUNTIME_LOG_TRIM_BYTES, fileStat.size - PROXY_RUNTIME_LOG_TRIM_BYTES);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, buffer, 0, bytesRead, 0);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(logPath, 0o600);
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
  const logPath = proxyRuntimeLogPath(options.stateRoot);
  const initialPid = await readProxyPid(options.stateRoot);
  const initialHealth = await readProxyHealth(initialState);
  if (proxyHealthProtocolMatches(initialHealth)) {
    assertProxyHealthProtocol(initialHealth);
    const state = await readProxyState(options.stateRoot) ?? initialState;
    return {
      state,
      pid: initialHealth.pid ?? initialPid.pid,
      healthy: true,
      started: false,
      logPath,
      version: initialHealth.version,
      protocol: initialHealth.protocol,
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
    assertProxyHealthProtocol(health);
    return {
      state,
      pid: health.pid ?? pid.pid,
      healthy: true,
      started: false,
      logPath,
      version: health.version,
      protocol: health.protocol,
    };
  }

  try {
    const state = await readProxyState(options.stateRoot);
    if (!state) {
      return null;
    }
    const health = await readProxyHealth(state);
    if (proxyHealthProtocolMatches(health)) {
      assertProxyHealthProtocol(health);
      const pid = await readProxyPid(options.stateRoot);
      return {
        state,
        pid: health.pid ?? pid.pid,
        healthy: true,
        started: false,
        logPath,
        version: health.version,
        protocol: health.protocol,
      };
    }
    if (health.healthy) {
      await appendProxyJsonLine(proxyLogPath(options.stateRoot), {
        event: "ccs_proxy_protocol_restart",
        server_protocol: health.protocol,
        client_protocol: PROXY_HEALTH_PROTOCOL,
        pid: health.pid,
      });
      await shutdownProxyRuntime(options);
    }

    await rm(pidPath(options.stateRoot), { force: true });
    const pid = startProxyBackgroundProcess(options, state);
    await waitForProxyHealth(state, options.stateRoot);
    const startedHealth = await readProxyHealth(state);
    assertProxyHealthProtocol(startedHealth);
    return {
      state,
      pid,
      healthy: true,
      started: true,
      logPath,
      version: startedHealth.version,
      protocol: startedHealth.protocol,
    };
  } finally {
    await releaseProxyStartLock(options.stateRoot, lockFd);
  }
}

function currentProviderName(content: string): string {
  const provider = readTopLevelTomlString(content, "model_provider");
  if (!provider) {
    throw new Error("model_provider was not found in Codex config");
  }
  return provider;
}

function currentProviderBaseUrl(content: string): string {
  return readTomlBaseUrl(content) ?? "";
}

function buildProfileOrder(profiles: ProfilesFile): string[] {
  return profiles.current ? [profiles.current] : [];
}

function resolveProxyUpstream(profiles: ProfilesFile): ProxyUpstream {
  const current = profiles.current;
  if (!current) {
    throw new Error("profiles.current was not found");
  }
  const profile = profiles.profiles?.[current];
  const baseURL = profile?.baseURL;
  if (!baseURL) {
    throw new Error(`profiles.current ${current} has no baseURL`);
  }
  if (!profile.apiKey) {
    throw new Error(`profiles.current ${current} has no apiKey`);
  }
  return { name: current, baseURL, apiKey: profile.apiKey };
}

function createProxyMetrics(): ProxyMetrics {
  return {
    total_requests: 0,
    active_requests: [],
    status_counts: createProxyStatusCounts(),
    reasoning_token_counts: createProxyReasoningTokenCounts(),
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
  return {};
}

function createProxyReasoningTokenCounts(): ProxyReasoningTokenCounts {
  return {};
}

function proxyMetricsFromRecentRequests(recentRequests: ProxyRequestRecord[]): Omit<ProxyMetrics, "active_requests" | "recent_requests"> {
  const statusCounts = createProxyStatusCounts();
  const reasoningTokenCounts = createProxyReasoningTokenCounts();
  const upstreamHitCounts: Record<string, number> = {};
  const latency = {
    last: recentRequests[0]?.latency_ms ?? null,
    count: recentRequests.length,
    sum: 0,
    min: null as number | null,
    max: null as number | null,
  };

  for (const record of recentRequests) {
    incrementProxyStatusCountsForRecord(statusCounts, record);
    incrementProxyReasoningTokenCountsForRecord(reasoningTokenCounts, record);
    incrementProxyUpstreamHitCountsForRecord(upstreamHitCounts, record);
    latency.sum += record.latency_ms;
    latency.min = latency.min === null ? record.latency_ms : Math.min(latency.min, record.latency_ms);
    latency.max = latency.max === null ? record.latency_ms : Math.max(latency.max, record.latency_ms);
  }

  return {
    total_requests: recentRequests.length,
    status_counts: statusCounts,
    reasoning_token_counts: reasoningTokenCounts,
    upstream_hit_counts: upstreamHitCounts,
    latency_ms: latency,
  };
}

function normalizeProxyMetrics(value: unknown): ProxyMetrics {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const recentRequests = Array.isArray(raw.recent_requests)
    ? raw.recent_requests.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map(normalizeProxyHistoryRecord)
      .slice(0, PROXY_RECENT_REQUEST_LIMIT)
    : [];
  const activeRequests = Array.isArray(raw.active_requests)
    ? raw.active_requests.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((request) => normalizeProxyRequestRecord(request, "active"))
      .slice(0, PROXY_ACTIVE_REQUEST_LIMIT)
    : [];
  const windowMetrics = proxyMetricsFromRecentRequests(recentRequests);
  return {
    ...windowMetrics,
    active_requests: activeRequests,
    recent_requests: recentRequests,
  };
}

function normalizeProxyHistoryRecord(request: Record<string, unknown>): ProxyRequestRecord {
  return normalizeProxyRequestRecord(request, "history");
}

function normalizeProxyRequestRecord(request: Record<string, unknown>, collection: "active" | "history"): ProxyRequestRecord {
  const startedAt = stringField(request.started_at) || stringField(request.at) || "";
  const completedAt = nullableStringField(request.completed_at)
    ?? (collection === "history" ? nullableStringField(request.at) ?? startedAt : null);
  const status = Number.isInteger(request.status) ? Number(request.status) : null;
  return {
    schema_version: PROXY_REQUEST_SCHEMA_VERSION,
    id: stringField(request.id) || randomUUID(),
    started_at: startedAt,
    completed_at: completedAt,
    mode: normalizeProxyMode(request.mode) ?? PROXY_DEFAULT_MODE,
    method: stringField(request.method),
    path: stringField(request.path),
    status,
    upstream_status: Number.isInteger(request.upstream_status) ? Number(request.upstream_status) : status,
    client_status: Number.isInteger(request.client_status) ? Number(request.client_status) : (collection === "history" ? status : null),
    final_action: stringField(request.final_action) || (collection === "history" ? inferProxyFinalAction(status, nullableStringField(request.error)) : "pending"),
    failure_summary: normalizeProxyFailureSummary(request.failure_summary),
    upstream: nullableStringField(request.upstream),
    attempts: Number.isInteger(request.attempts) ? Number(request.attempts) : 0,
    latency_ms: numberField(request.latency_ms),
    client_ttfb_ms: nullableNumberField(request.client_ttfb_ms),
    upstream_wait_ms: nullableNumberField(request.upstream_wait_ms),
    time_to_first_chunk_ms: nullableNumberField(request.time_to_first_chunk_ms),
    stream_duration_ms: nullableNumberField(request.stream_duration_ms),
    request_bytes: numberField(request.request_bytes),
    response_bytes: numberField(request.response_bytes),
    session: nullableStringField(request.session),
    client_turn_id: nullableStringField(request.client_turn_id),
    client_request_attempt: positiveIntegerField(request.client_request_attempt),
    request_kind: normalizeProxyRequestKind(request.request_kind),
    request_model: nullableStringField(request.request_model),
    request_reasoning_effort: nullableStringField(request.request_reasoning_effort),
    request_body_sha256: nullableStringField(request.request_body_sha256),
    upstream_model: nullableStringField(request.upstream_model),
    upstream_model_source: nullableStringField(request.upstream_model_source),
    stream_model: nullableStringField(request.stream_model),
    final_response_model: nullableStringField(request.final_response_model),
    system_fingerprint: nullableStringField(request.system_fingerprint),
    service_tier: nullableStringField(request.service_tier),
    input_tokens: isProxyTokenCount(request.input_tokens) ? Number(request.input_tokens) : null,
    cached_input_tokens: isProxyTokenCount(request.cached_input_tokens) ? Number(request.cached_input_tokens) : null,
    reasoning_tokens: isReasoningTokenCount(request.reasoning_tokens) ? Number(request.reasoning_tokens) : null,
    reasoning_tokens_source: nullableStringField(request.reasoning_tokens_source),
    output_tokens: isProxyTokenCount(request.output_tokens) ? Number(request.output_tokens) : null,
    total_tokens: isProxyTokenCount(request.total_tokens) ? Number(request.total_tokens) : null,
    usage_attempts: normalizeProxyUsageAttempts(request.usage_attempts),
    reasoning_text_observed: request.reasoning_text_observed === true,
    reasoning_text_source: nullableStringField(request.reasoning_text_source),
    has_commentary: request.has_commentary === true,
    has_final_answer: request.has_final_answer === true,
    final_answer_only: request.final_answer_only === true,
    has_tool_call: request.has_tool_call === true,
    has_reasoning_item: request.has_reasoning_item === true,
    guard_actions: normalizeProxyGuardActions(request.guard_actions),
    retry_summary: normalizeProxyRetrySummary(request.retry_summary),
    error: nullableStringField(request.error),
  };
}

function normalizeProxyUsageAttempts(value: unknown): ProxyUsageAttempt[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid proxy request usage_attempts");
  }
  return value.map((entry) => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const modelSource = item.pricing_model_source === "upstream_model" || item.pricing_model_source === "request_model"
      ? item.pricing_model_source
      : null;
    const tierSource = item.pricing_tier_source === "response" || item.pricing_tier_source === "request" || item.pricing_tier_source === "config"
      ? item.pricing_tier_source
      : null;
    return {
      attempt: positiveIntegerField(item.attempt),
      input_tokens: isProxyTokenCount(item.input_tokens) ? Number(item.input_tokens) : null,
      output_tokens: isProxyTokenCount(item.output_tokens) ? Number(item.output_tokens) : null,
      cached_input_tokens: isProxyTokenCount(item.cached_input_tokens) ? Number(item.cached_input_tokens) : null,
      pricing_model: nullableStringField(item.pricing_model),
      pricing_model_source: modelSource,
      pricing_tier: nullableStringField(item.pricing_tier),
      pricing_tier_source: tierSource,
    };
  });
}

function normalizeProxyFailureSummary(value: unknown): ProxyFailureSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  return {
    type: nullableStringField(raw.type),
    code: nullableStringField(raw.code),
    message: nullableStringField(raw.message),
  };
}

function normalizeProxyRetrySummary(value: unknown): ProxyRetrySummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createEmptyProxyRetrySummary();
  }
  const raw = value as Record<string, unknown>;
  return {
    total: nonNegativeIntegerField(raw.total),
    reasoning_guard: nonNegativeIntegerField(raw.reasoning_guard),
    upstream_capacity: nonNegativeIntegerField(raw.upstream_capacity),
    transport: nonNegativeIntegerField(raw.transport),
  };
}

function normalizeProxyGuardActions(value: unknown): ProxyGuardActionRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      at: stringField(item.at) || new Date(0).toISOString(),
      action: normalizeProxyGuardAction(item.action),
      upstream: nullableStringField(item.upstream),
      attempt: Number.isInteger(item.attempt) ? Number(item.attempt) : 0,
      status: Number.isInteger(item.status) ? Number(item.status) : null,
      reasoning_tokens: isReasoningTokenCount(item.reasoning_tokens) ? Number(item.reasoning_tokens) : null,
      error: nullableStringField(item.error),
    }));
}

function normalizeProxyGuardAction(value: unknown): ProxyGuardAction {
  return value === "internal_retry" || value === "continuation_recovery" || value === "return_status_502" || value === "upstream_error"
    ? value
    : "upstream_error";
}

function normalizeProxyRequestKind(value: unknown): ProxyRequestKind {
  return value === REQUEST_KIND_CONTEXT_COMPACTION ? REQUEST_KIND_CONTEXT_COMPACTION : REQUEST_KIND_NORMAL;
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

function nullableNumberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeIntegerField(value: unknown): number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : 0;
}

function positiveIntegerField(value: unknown): number {
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : 1;
}

function inferProxyFinalAction(status: number | null, error: string | null): string {
  if (status === 499) {
    return "client_aborted";
  }
  if (error?.includes("reasoning_guard_triggered")) {
    return "blocked";
  }
  if (error?.includes("upstream_fetch_failed")) {
    return "upstream_fetch_failed";
  }
  if (error) {
    return "gateway_error";
  }
  if (status !== null && status >= 400) {
    return "upstream_error";
  }
  return "passed";
}

function normalizeProxyState(state: ProxyState | null): ProxyState | null {
  if (!state) {
    return null;
  }
  return {
    ...state,
    mode: normalizeProxyMode((state as Record<string, unknown>).mode) ?? PROXY_DEFAULT_MODE,
    profile_order: Array.isArray(state.profile_order) ? state.profile_order.filter((value) => typeof value === "string" && value.length > 0) : [],
    metrics: normalizeProxyMetrics((state as Record<string, unknown>).metrics),
  };
}

function normalizeProxyMode(value: unknown): ProxyMode | null {
  if (value === PROXY_MODE_PASSTHROUGH) {
    return PROXY_MODE_PASSTHROUGH;
  }
  if (value === PROXY_MODE_INTERCEPT) {
    return PROXY_MODE_INTERCEPT;
  }
  if (value === PROXY_MODE_RECOVERY) {
    return PROXY_MODE_RECOVERY;
  }
  return null;
}

function ensureProxyMetrics(state: ProxyState): ProxyMetrics {
  return state.metrics ?? createProxyMetrics();
}

let proxyStateMutationQueue: Promise<void> = Promise.resolve();

async function mutateProxyMetrics(
  state: ProxyState,
  stateRoot: string,
  mutate: (metrics: ProxyMetrics) => void | Promise<void>,
): Promise<void> {
  const mutation = proxyStateMutationQueue.then(async () => {
    const currentState = await readProxyState(stateRoot) ?? state;
    const metrics = ensureProxyMetrics(currentState);
    await mutate(metrics);
    currentState.metrics = metrics;
    await writeProxyState(stateRoot, currentState);
    state.metrics = metrics;
  });
  proxyStateMutationQueue = mutation.then(() => undefined, () => undefined);
  await mutation;
}

async function startProxyRequestMetric(
  state: ProxyState,
  stateRoot: string,
  record: ProxyRequestRecord,
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
  record: ProxyRequestRecord,
): Promise<void> {
  await mutateProxyMetrics(state, stateRoot, (metrics) => {
    metrics.active_requests = metrics.active_requests.map((request) => request.id === record.id ? record : request);
  });
}

async function completeProxyRequestMetric(state: ProxyState, stateRoot: string, record: ProxyCompleteRequestRecord): Promise<void> {
  let completedRecord: ProxyCompleteRequestRecord | null = null;
  await mutateProxyMetrics(state, stateRoot, (metrics) => {
    completedRecord = {
      ...record,
      client_request_attempt: resolveClientRequestAttempt(record, metrics.recent_requests),
    };
    const compactRecord = compactProxyRequestRecord(completedRecord);
    metrics.active_requests = metrics.active_requests.filter((request) => request.id !== record.id);
    metrics.recent_requests.unshift(compactRecord);
    metrics.recent_requests = metrics.recent_requests.slice(0, PROXY_RECENT_REQUEST_LIMIT);
    const windowMetrics = proxyMetricsFromRecentRequests(metrics.recent_requests);
    metrics.total_requests = windowMetrics.total_requests;
    metrics.status_counts = windowMetrics.status_counts;
    metrics.reasoning_token_counts = windowMetrics.reasoning_token_counts;
    metrics.upstream_hit_counts = windowMetrics.upstream_hit_counts;
    metrics.latency_ms = windowMetrics.latency_ms;
  });
  await appendProxyRequestRecord(stateRoot, completedRecord ?? record);
}

function compactProxyRequestRecord(record: ProxyCompleteRequestRecord): ProxyRequestRecord {
  const { attempt_records: _attemptRecords, request_headers: _requestHeaders, ...compactRecord } = record;
  return compactRecord;
}

export function projectProxyUsageAttempts(
  attempts: ProxyAttemptRecord[],
  requestModel: string | null,
  requestTier: string | null,
  configTier: string | null,
): ProxyUsageAttempt[] {
  return attempts.map((attempt) => {
    const pricingModel = attempt.upstream_model ?? requestModel;
    const pricingModelSource = attempt.upstream_model
      ? "upstream_model" as const
      : requestModel ? "request_model" as const : null;
    const pricingTier = attempt.service_tier ?? requestTier ?? configTier;
    const pricingTierSource = attempt.service_tier
      ? "response" as const
      : requestTier ? "request" as const : configTier ? "config" as const : null;
    return {
      attempt: attempt.attempt,
      input_tokens: attempt.input_tokens,
      output_tokens: attempt.output_tokens,
      cached_input_tokens: attempt.cached_input_tokens,
      pricing_model: pricingModel,
      pricing_model_source: pricingModelSource,
      pricing_tier: pricingTier,
      pricing_tier_source: pricingTierSource,
    };
  });
}

function resolveClientRequestAttempt(record: ProxyRequestRecord, recentRequests: ProxyRequestRecord[]): number {
  if (!record.client_turn_id || !record.request_body_sha256) {
    return 1;
  }
  return 1 + recentRequests.filter((candidate) => (
    candidate.client_turn_id === record.client_turn_id
    && candidate.request_body_sha256 === record.request_body_sha256
  )).length;
}

async function resetProxyActiveRequestsOnStart(state: ProxyState, stateRoot: string): Promise<void> {
  const metrics = ensureProxyMetrics(state);
  if (metrics.active_requests.length === 0) {
    return;
  }
  await mutateProxyMetrics(state, stateRoot, (currentMetrics) => {
    currentMetrics.active_requests = [];
  });
}

function incrementProxyStatusCount(counts: ProxyStatusCounts, status: number | null): void {
  const key = String(status ?? 500);
  counts[key] = (counts[key] ?? 0) + 1;
}

function incrementProxyStatusCountsForRecord(counts: ProxyStatusCounts, record: ProxyRequestRecord): void {
  for (const action of record.guard_actions) {
    incrementProxyStatusCount(counts, action.status);
  }
  if (!finalStatusDuplicatesGuardFailure(record)) {
    incrementProxyStatusCount(counts, record.status);
  }
}

function incrementProxyUpstreamHitCountsForRecord(counts: Record<string, number>, record: ProxyRequestRecord): void {
  for (const action of record.guard_actions) {
    incrementProxyUpstreamHitCount(counts, action.upstream);
  }
  if (!finalStatusDuplicatesGuardFailure(record)) {
    incrementProxyUpstreamHitCount(counts, record.upstream);
  }
}

function incrementProxyUpstreamHitCount(counts: Record<string, number>, upstream: string | null): void {
  if (!upstream) {
    return;
  }
  counts[upstream] = (counts[upstream] ?? 0) + 1;
}

function incrementProxyReasoningTokenCount(counts: ProxyReasoningTokenCounts, reasoningTokens: number | null): void {
  if (reasoningTokens === null) {
    return;
  }
  const key = String(reasoningTokens);
  counts[key] = (counts[key] ?? 0) + 1;
}

function incrementProxyReasoningTokenCountsForRecord(counts: ProxyReasoningTokenCounts, record: ProxyRequestRecord): void {
  for (const action of record.guard_actions) {
    incrementProxyReasoningTokenCount(counts, action.reasoning_tokens);
  }
  if (!finalReasoningTokenDuplicatesGuardFailure(record)) {
    incrementProxyReasoningTokenCount(counts, record.reasoning_tokens);
  }
}

function finalStatusDuplicatesGuardFailure(record: ProxyRequestRecord): boolean {
  const lastStatusAction = [...record.guard_actions]
    .reverse()
    .find((action) => action.status !== null);
  return lastStatusAction?.action === "return_status_502"
    && lastStatusAction.status === record.status;
}

function finalReasoningTokenDuplicatesGuardFailure(record: ProxyRequestRecord): boolean {
  if (record.reasoning_tokens === null) {
    return false;
  }
  const lastReasoningAction = [...record.guard_actions]
    .reverse()
    .find((action) => action.reasoning_tokens !== null);
  return lastReasoningAction?.action === "return_status_502"
    && lastReasoningAction.reasoning_tokens === record.reasoning_tokens;
}

function averageLatency(latency: ProxyMetrics["latency_ms"]): number {
  return latency.count > 0 ? latency.sum / latency.count : 0;
}

function formatLatencyMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return textDim("-");
  }
  return formatDurationMs(value, { maxUnit: "m" });
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
    return textDim("-");
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

function truncateProxyText(value: string, max = 40): string {
  return truncateVisible(value, max);
}

function formatProxyStatusLine(now: Date, state: ProxyState | null, runtime: ProxyRuntimeState | null): string {
  const runtimeLabel = state && runtime?.healthy ? textGreen("healthy") : state ? textYellow("starting") : textDim("none");
  const pid = runtime?.pid === null || runtime?.pid === undefined
    ? textDim("none")
    : runtime.healthy
      ? textGreen(String(runtime.pid))
      : textYellow(String(runtime.pid));
  const version = runtime?.version ? colorName(runtime.version) : textDim("none");
  const protocol = runtime?.protocol === null || runtime?.protocol === undefined
    ? textDim("none")
    : colorCount(String(runtime.protocol));
  const proxy = state ? colorUrl(state.proxy_base_url) : textDim("unset");
  const mode = state ? colorName(state.mode) : textDim("unset");
  return [
    bgDarkBlue(" ccs proxy "),
    textDim(now.toLocaleTimeString("en-GB", { hour12: false })),
    `runtime: ${state ? runtimeLabel : textRed("missing")}`,
    `mode: ${mode}`,
    `pid: ${pid}`,
    `server: ${version}`,
    `protocol: ${protocol}`,
    `proxy: ${proxy}`,
    `refresh: ${textDim(`${PROXY_STATUS_REFRESH_SECONDS}s`)}`,
  ].join(" ");
}

function formatProxyPathsLines(options: ProxyOptions): string[] {
  if (options.watch) {
    return [];
  }
  return [
    `state: ${colorPath(formatProxyFilePath(statePath(options.stateRoot)))}`,
    `requests: ${colorPath(formatProxyFilePath(proxyRequestsPath(options.stateRoot)))}`,
    `events: ${colorPath(formatProxyFilePath(proxyLogPath(options.stateRoot)))}`,
    `runtime: ${colorPath(formatProxyFilePath(proxyRuntimeLogPath(options.stateRoot)))}`,
    `config: ${colorPath(formatProxyFilePath(options.codexConfigPath))}`,
  ];
}

function formatProxyFilePath(value: string): string {
  return formatHomePath(value);
}

function formatProxyRequest(record: ProxyRequestRecord, nowMs: number, priceCache?: ModelPriceCache): TableRow {
  const completed = record.completed_at !== null;
  const startedAt = Date.parse(record.started_at);
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : 0;
  const time = formatProxyTime(record.completed_at ?? record.started_at);
  const latencyMs = completed ? record.latency_ms : elapsedMs;
  const size = completed ? record.response_bytes : record.request_bytes;
  const upstream = formatProxyUpstream(record.upstream, record.attempts);
  return {
    time: textDim(time),
    reasoning_status: formatProxyReasoningStatus(record.reasoning_tokens, record.reasoning_text_observed, record.status),
    up: upstream,
    ms: textYellow(formatLatencyMs(latencyMs)),
    size: formatProxyBytes(size),
    session: formatProxySession(record.session),
    model: formatProxyModel(record.request_model, record.upstream_model),
    input_tokens: formatProxyAttemptTokens(record.usage_attempts, "uncached_input_tokens"),
    output_tokens: formatProxyAttemptTokens(record.usage_attempts, "output_tokens"),
    cached_input_tokens: formatProxyAttemptTokens(record.usage_attempts, "cached_input_tokens"),
    ...formatProxyAttemptCosts(record.usage_attempts, priceCache),
    error: formatProxyError(record),
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
  return formatCompactBytes(value);
}

function formatProxyModelDisplayName(model: string): string {
  return model.startsWith("gpt-") ? `o${model.slice(4)}` : model;
}

function formatProxyReasoningTokens(reasoningTokens: number | null): string {
  return reasoningTokens === null ? textDim("-") : textYellow(String(reasoningTokens));
}

function formatProxyReasoningStatus(reasoningTokens: number | null, reasoningTextObserved: boolean, status: number | null): string {
  const reasoning = reasoningTokens === null && reasoningTextObserved
    ? textBlue("text")
    : formatProxyReasoningTokens(reasoningTokens);
  return `${reasoning}${textDim("/")}${formatProxyStatusCode(status)}`;
}

export function formatProxyModel(requestModel: string | null, upstreamModel: string | null): string {
  const model = upstreamModel ?? requestModel;
  if (!model) {
    return textDim("-");
  }
  const display = truncateProxyText(formatProxyModelDisplayName(model), PROXY_TABLE_MODEL_WIDTH);
  if (requestModel && upstreamModel === requestModel) {
    return textGreen(display);
  }
  if (requestModel && upstreamModel) {
    return textRed(display);
  }
  return colorName(display);
}

export function formatProxyAttemptTokens(
  attempts: ProxyUsageAttempt[],
  field: "uncached_input_tokens" | "input_tokens" | "output_tokens" | "cached_input_tokens",
): string {
  if (attempts.length === 0) {
    return textDim("-");
  }
  if (field === "uncached_input_tokens") {
    if (attempts.some((attempt) => attempt.input_tokens === null || attempt.cached_input_tokens === null)) {
      return textDim("-");
    }
    if (attempts.some((attempt) => (attempt.cached_input_tokens ?? 0) > (attempt.input_tokens ?? 0))) {
      return textRed("invalid");
    }
    return colorCount(formatProxyTokenCount(attempts.reduce(
      (sum, attempt) => sum + (attempt.input_tokens ?? 0) - (attempt.cached_input_tokens ?? 0),
      0,
    )));
  }
  if (attempts.some((attempt) => attempt[field] === null)) {
    return textDim("-");
  }
  return colorCount(formatProxyTokenCount(attempts.reduce((sum, attempt) => sum + (attempt[field] ?? 0), 0)));
}

export function formatProxyTokenCount(value: number): string {
  if (value < 1000) return String(value);
  const compact = Math.round(value / 100) / 10;
  return `${Number.isInteger(compact) ? compact.toFixed(0) : compact.toFixed(1)}K`;
}

function normalizeProxyPricingTier(value: string | null): "standard" | "fast" | null {
  if (value === "default" || value === "standard") return "standard";
  if (value === "fast" || value === "priority") return "fast";
  return null;
}

export function formatProxyAttemptCosts(attempts: ProxyUsageAttempt[], cache?: ModelPriceCache): Record<string, string> {
  if (!cache || attempts.length === 0) {
    return missingProxyCosts();
  }
  let input = 0;
  let output = 0;
  let cached = 0;
  let inputMissing = false;
  let outputMissing = false;
  let cachedMissing = false;
  let invalid = false;
  for (const attempt of attempts) {
    const tier = normalizeProxyPricingTier(attempt.pricing_tier);
    const prices = attempt.pricing_model && tier ? modelPriceParts(cache, attempt.pricing_model, tier) : null;
    if (attempt.input_tokens !== null && attempt.cached_input_tokens !== null && attempt.cached_input_tokens > attempt.input_tokens) {
      invalid = true;
    } else if (attempt.input_tokens === null || attempt.cached_input_tokens === null || !prices) {
      inputMissing = true;
    } else {
      const uncachedTokens = attempt.input_tokens - attempt.cached_input_tokens;
      if (uncachedTokens > 0 && prices.input === null) inputMissing = true;
      else input += uncachedTokens * (prices.input ?? 0);
    }
    if (attempt.output_tokens === null || !prices) outputMissing = true;
    else if (attempt.output_tokens > 0 && prices.output === null) outputMissing = true;
    else output += attempt.output_tokens * (prices.output ?? 0);
    if (attempt.cached_input_tokens === null || !prices) cachedMissing = true;
    else if (attempt.cached_input_tokens > 0 && prices.cacheRead === null) cachedMissing = true;
    else cached += attempt.cached_input_tokens * (prices.cacheRead ?? 0);
  }
  const totalMissing = inputMissing || outputMissing || cachedMissing;
  return {
    input_cost: invalid ? textRed("invalid") : inputMissing ? textDim("-") : colorCost(formatProxyUsd(input)),
    output_cost: outputMissing ? textDim("-") : colorCost(formatProxyUsd(output)),
    cached_cost: cachedMissing ? textDim("-") : colorCost(formatProxyUsd(cached)),
    total_cost: invalid ? textRed("invalid") : totalMissing ? textDim("-") : colorCost(formatProxyUsd(input + output + cached)),
  };
}

function missingProxyCosts(): Record<string, string> {
  return { input_cost: textDim("-"), output_cost: textDim("-"), cached_cost: textDim("-"), total_cost: textDim("-") };
}

export function formatProxyUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.0001) return "<$0.0001";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatProxyError(record: ProxyRequestRecord): string {
  const prefix = formatProxyErrorPrefix(record);
  const displayError = proxyDisplayError(record);
  const error = displayError ? textRed(displayError) : textDim("");
  if (prefix && error) {
    return `${prefix} ${error}`;
  }
  return prefix || error;
}

function proxyDisplayError(record: ProxyRequestRecord): string | null {
  return record.error ?? proxyFailureSummaryDisplay(record.failure_summary);
}

function proxyFailureSummaryDisplay(summary: ProxyFailureSummary | null): string | null {
  if (!summary) {
    return null;
  }
  if (summary.code && summary.message) {
    return `${summary.code}: ${summary.message}`;
  }
  return summary.message ?? summary.code;
}

function formatProxyErrorPrefix(record: ProxyRequestRecord): string {
  const values = [
    formatProxyClientRequestAttemptPrefixValue(record.client_request_attempt),
    ...record.guard_actions
      .map((action) => formatProxyGuardActionPrefixValue(action, record.status)),
  ].filter((value) => value.length > 0);
  return values.length === 0 ? "" : `[${values.join(" ")}]`;
}

function formatProxyClientRequestAttemptPrefixValue(attempt: number): string {
  return attempt > 1 ? textYellow(`client:${attempt}`) : "";
}

function formatProxyGuardActionPrefixValue(action: ProxyGuardActionRecord, requestStatus: number | null): string {
  const label = formatProxyGuardActionLabel(action);
  if (action.reasoning_tokens !== null) {
    return textRed(`${label}:${action.reasoning_tokens}`);
  }
  const status = action.status ?? proxyGuardActionDisplayStatus(action, requestStatus);
  if (status !== null) {
    return textYellow(`${label}:${status}`);
  }
  return textDim(`${label}:-`);
}

function proxyGuardActionDisplayStatus(action: ProxyGuardActionRecord, requestStatus: number | null): number | null {
  if (action.action !== "upstream_error" || requestStatus === null || requestStatus < 400) {
    return null;
  }
  return requestStatus;
}

function formatProxyGuardActionLabel(action: ProxyGuardActionRecord): string {
  if (action.action === "continuation_recovery") {
    return "rec";
  }
  if (action.action === "return_status_502") {
    return "block";
  }
  if (action.action === "upstream_error") {
    return "err";
  }
  if (action.error?.startsWith("upstream_capacity:")) {
    return "cap";
  }
  return action.reasoning_tokens === null ? "retry" : "guard";
}

async function logProxyGuardAction(stateRoot: string, request: ProxyRequestRecord, action: ProxyGuardActionRecord): Promise<void> {
  await appendProxyJsonLine(proxyLogPath(stateRoot), {
    event: "ccs_proxy_guard_action",
    request_id: request.id,
    method: request.method,
    path: request.path,
    action: action.action,
    upstream: action.upstream,
    attempt: action.attempt,
    status: action.status,
    reasoning_tokens: action.reasoning_tokens,
    error: action.error,
  });
}

async function logProxyRequestError(stateRoot: string, request: ProxyRequestRecord, status: number | null, error: string): Promise<void> {
  await appendProxyJsonLine(proxyLogPath(stateRoot), {
    event: "ccs_proxy_request_error",
    request_id: request.id,
    method: request.method,
    path: request.path,
    upstream: request.upstream,
    attempts: request.attempts,
    status,
    error,
  });
}

async function logProxyUnsupportedPath(stateRoot: string, method: string, path: string): Promise<void> {
  await appendProxyJsonLine(proxyLogPath(stateRoot), {
    event: "ccs_proxy_unsupported_path",
    method,
    path,
    status: 404,
  });
}

function formatProxySession(value: string | null): string {
  if (!value) {
    return textDim("-");
  }
  const text = truncateProxyText(value, PROXY_TABLE_SESSION_WIDTH);
  return proxySessionColor(value)(text);
}

function proxySessionColor(value: string): (text: string) => string {
  return PROXY_SESSION_COLORS[stableProxySessionColorIndex(value)];
}

function stableProxySessionColorIndex(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 31) + value.charCodeAt(index)) >>> 0;
  }
  return hash % PROXY_SESSION_COLORS.length;
}

function formatProxyUpstream(upstream: string | null, attempts: number): string {
  if (!upstream) {
    return textDim("-");
  }
  const suffix = attempts > 1 ? textYellow(String(attempts)) : "";
  return `${colorName(truncateProxyText(upstream, PROXY_TABLE_UPSTREAM_WIDTH - visibleLength(suffix)))}${suffix}`;
}

export function resolveProxySwitchBaseUrl(state: ProxyState | null): string | null {
  return state?.proxy_base_url ?? null;
}

function buildProxyStateFromProfiles(
  profiles: ProfilesFile,
  codexConfigText: string,
  codexConfigFile: string,
  listenHost: string,
  listenPort: number,
): ProxyState {
  const providerName = currentProviderName(codexConfigText);
  const originalBaseUrl = currentProviderBaseUrl(codexConfigText);
  if (!originalBaseUrl) {
    throw new Error(`base_url was not found in [model_providers.${providerName}]`);
  }
  return {
    installed_at: new Date().toISOString(),
    codex_config_path: codexConfigFile,
    provider_name: providerName,
    original_base_url: originalBaseUrl,
    proxy_base_url: proxyBaseUrl(listenHost, listenPort),
    mode: PROXY_INSTALL_MODE,
    listen_host: listenHost,
    listen_port: listenPort,
    profile_order: buildProfileOrder(profiles),
    backup_path: "",
    metrics: createProxyMetrics(),
  };
}

function createEmptyReasoningMetadata(): ProxyReasoningMetadata {
  return {
    reasoningTokens: null,
    reasoningTokensSource: null,
    reasoningTextObserved: false,
    reasoningTextSource: null,
  };
}

function createEmptyProxyUsageMetadata(): ProxyUsageMetadata {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };
}

function createEmptyProxyUpstreamMetadata(): ProxyUpstreamMetadata {
  return {
    systemFingerprint: null,
    serviceTier: null,
  };
}

function createEmptyProxyResponseShape(): ProxyResponseShape {
  return {
    hasCommentary: false,
    hasFinalAnswer: false,
    hasToolCall: false,
    hasReasoningItem: false,
  };
}

function createEmptyProxyRetrySummary(): ProxyRetrySummary {
  return {
    total: 0,
    reasoning_guard: 0,
    upstream_capacity: 0,
    transport: 0,
  };
}

function parseReasoningMetadata(payload: unknown, sourcePrefix = ""): ProxyReasoningMetadata {
  const metadata = createEmptyReasoningMetadata();
  if (!payload || typeof payload !== "object") {
    return metadata;
  }
  for (const pointer of REASONING_POINTERS) {
    const value = jsonPointerGet(payload, pointer);
    if (isReasoningTokenCount(value)) {
      metadata.reasoningTokens = value;
      metadata.reasoningTokensSource = reasoningSource(sourcePrefix, pointer);
      break;
    }
  }
  for (const pointer of REASONING_TEXT_POINTERS) {
    const value = jsonPointerGet(payload, pointer);
    if (typeof value === "string" && value.length > 0) {
      metadata.reasoningTextObserved = true;
      metadata.reasoningTextSource = reasoningSource(sourcePrefix, pointer);
      break;
    }
  }
  return metadata;
}

function parseProxyUsageMetadata(payload: unknown): ProxyUsageMetadata {
  const usage = createEmptyProxyUsageMetadata();
  if (!payload || typeof payload !== "object") {
    return usage;
  }
  usage.inputTokens = firstProxyTokenAt(payload, [
    "/usage/input_tokens",
    "/usage/prompt_tokens",
    "/response/usage/input_tokens",
    "/response/usage/prompt_tokens",
  ]);
  usage.cachedInputTokens = firstProxyTokenAt(payload, [
    "/usage/input_tokens_details/cached_tokens",
    "/usage/prompt_tokens_details/cached_tokens",
    "/response/usage/input_tokens_details/cached_tokens",
    "/response/usage/prompt_tokens_details/cached_tokens",
  ]);
  usage.outputTokens = firstProxyTokenAt(payload, [
    "/usage/output_tokens",
    "/usage/completion_tokens",
    "/response/usage/output_tokens",
    "/response/usage/completion_tokens",
  ]);
  usage.totalTokens = firstProxyTokenAt(payload, [
    "/usage/total_tokens",
    "/response/usage/total_tokens",
  ]);
  return usage;
}

function firstProxyTokenAt(payload: unknown, pointers: string[]): number | null {
  for (const pointer of pointers) {
    const value = jsonPointerGet(payload, pointer);
    if (isProxyTokenCount(value)) {
      return value;
    }
  }
  return null;
}

function parseProxyUpstreamMetadata(payload: unknown): ProxyUpstreamMetadata {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return createEmptyProxyUpstreamMetadata();
  }
  return {
    systemFingerprint: jsonStringAt(payload, ["system_fingerprint"]) ?? jsonStringAt(payload, ["response", "system_fingerprint"]),
    serviceTier: jsonStringAt(payload, ["service_tier"]) ?? jsonStringAt(payload, ["response", "service_tier"]),
  };
}

function parseProxyResponseShape(payload: unknown): ProxyResponseShape {
  const shape = createEmptyProxyResponseShape();
  visitProxyResponseShape(payload, shape, {});
  return shape;
}

function visitProxyResponseShape(
  value: unknown,
  shape: ProxyResponseShape,
  context: { phase?: string | null; role?: string | null },
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitProxyResponseShape(item, shape, context);
    }
    return;
  }

  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type : null;
  const phase = nullableStringField(raw.phase) ?? nullableStringField(raw.channel) ?? context.phase ?? null;
  const role = nullableStringField(raw.role) ?? context.role ?? null;
  if (phase === "commentary") {
    shape.hasCommentary = true;
  }
  if (phase === "final") {
    shape.hasFinalAnswer = true;
  }
  if (type === "reasoning") {
    shape.hasReasoningItem = true;
  }
  if (isProxyToolCallObject(raw, type)) {
    shape.hasToolCall = true;
  }
  if (isProxyFinalAnswerObject(raw, type, phase, role)) {
    shape.hasFinalAnswer = true;
  }

  for (const item of Object.values(raw)) {
    visitProxyResponseShape(item, shape, { phase, role });
  }
}

function isProxyToolCallObject(raw: Record<string, unknown>, type: string | null): boolean {
  if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
    return true;
  }
  if (raw.function_call && typeof raw.function_call === "object") {
    return true;
  }
  return Boolean(type && (
    type.includes("tool_call")
    || type === "function_call"
    || type === "mcp_call"
    || type === "local_shell_call"
    || type === "custom_tool_call"
  ));
}

function isProxyFinalAnswerObject(
  raw: Record<string, unknown>,
  type: string | null,
  phase: string | null,
  role: string | null,
): boolean {
  if (phase === "commentary") {
    return false;
  }
  if (phase === "final") {
    return true;
  }
  if (type === "output_text") {
    return typeof raw.text === "string" && raw.text.length > 0;
  }
  if (type === "message" && role === "assistant") {
    return typeof raw.content === "string"
      ? raw.content.length > 0
      : Array.isArray(raw.content) && raw.content.length > 0;
  }
  if (raw.message && typeof raw.message === "object" && !Array.isArray(raw.message)) {
    const message = raw.message as Record<string, unknown>;
    return nullableStringField(message.role) === "assistant"
      && typeof message.content === "string"
      && message.content.length > 0;
  }
  return false;
}

function mergeProxyUsageMetadata(current: ProxyUsageMetadata, next: ProxyUsageMetadata): ProxyUsageMetadata {
  return {
    inputTokens: next.inputTokens ?? current.inputTokens,
    cachedInputTokens: next.cachedInputTokens ?? current.cachedInputTokens,
    outputTokens: next.outputTokens ?? current.outputTokens,
    totalTokens: next.totalTokens ?? current.totalTokens,
  };
}

function mergeProxyUpstreamMetadata(current: ProxyUpstreamMetadata, next: ProxyUpstreamMetadata): ProxyUpstreamMetadata {
  return {
    systemFingerprint: next.systemFingerprint ?? current.systemFingerprint,
    serviceTier: next.serviceTier ?? current.serviceTier,
  };
}

function mergeProxyResponseShape(current: ProxyResponseShape, next: ProxyResponseShape): ProxyResponseShape {
  return {
    hasCommentary: current.hasCommentary || next.hasCommentary,
    hasFinalAnswer: current.hasFinalAnswer || next.hasFinalAnswer,
    hasToolCall: current.hasToolCall || next.hasToolCall,
    hasReasoningItem: current.hasReasoningItem || next.hasReasoningItem,
  };
}

function isProxyFinalAnswerOnly(shape: ProxyResponseShape): boolean {
  return shape.hasFinalAnswer
    && !shape.hasCommentary
    && !shape.hasToolCall
    && !shape.hasReasoningItem;
}

function createProxyOutcome(input: {
  response: Response;
  upstream: string | null;
  upstreamStatus: number | null;
  attempts: number;
  attemptRecords: ProxyAttemptRecord[];
  inspection?: ProxyPayloadInspection;
  upstreamModel?: ProxyModelExtraction;
  reasoningTokens?: number | null;
  reasoningTokensSource?: string | null;
  failureSummary?: ProxyFailureSummary | null;
  error?: string | null;
}): ProxyOutcome {
  const reasoning = input.inspection?.reasoning ?? createEmptyReasoningMetadata();
  const upstreamModel = input.upstreamModel ?? input.inspection?.upstreamModel ?? { model: null, source: null };
  const usage = input.inspection?.usage ?? createEmptyProxyUsageMetadata();
  const upstreamMetadata = input.inspection?.upstreamMetadata ?? createEmptyProxyUpstreamMetadata();
  const responseShape = input.inspection?.responseShape ?? createEmptyProxyResponseShape();
  return {
    response: input.response,
    upstream: input.upstream,
    upstreamStatus: input.upstreamStatus,
    attempts: input.attempts,
    attemptRecords: input.attemptRecords,
    upstreamModel: upstreamModel.model,
    upstreamModelSource: upstreamModel.source,
    streamModel: upstreamModel.source?.startsWith("sse.") ? upstreamModel.model : null,
    finalResponseModel: upstreamModel.model,
    systemFingerprint: upstreamMetadata.systemFingerprint,
    serviceTier: upstreamMetadata.serviceTier,
    usage,
    reasoningTokens: input.reasoningTokens ?? reasoning.reasoningTokens,
    reasoningTokensSource: input.reasoningTokensSource ?? reasoning.reasoningTokensSource,
    reasoningTextObserved: reasoning.reasoningTextObserved,
    reasoningTextSource: reasoning.reasoningTextSource,
    responseShape,
    failureSummary: input.failureSummary ?? null,
    error: input.error ?? null,
  };
}

function jsonPointerGet(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((current, segment) => {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, value);
}

function isReasoningTokenCount(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isProxyTokenCount(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function reasoningSource(sourcePrefix: string, pointer: string): string {
  return sourcePrefix ? `${sourcePrefix}${pointer}` : pointer;
}

function mergeReasoningMetadata(current: ProxyReasoningMetadata, next: ProxyReasoningMetadata): ProxyReasoningMetadata {
  return {
    reasoningTokens: next.reasoningTokens ?? current.reasoningTokens,
    reasoningTokensSource: next.reasoningTokens !== null ? next.reasoningTokensSource : current.reasoningTokensSource,
    reasoningTextObserved: current.reasoningTextObserved || next.reasoningTextObserved,
    reasoningTextSource: current.reasoningTextSource ?? next.reasoningTextSource,
  };
}

function reasoningMetadataKey(metadata: ProxyReasoningMetadata): string {
  return [
    metadata.reasoningTokens ?? "",
    metadata.reasoningTokensSource ?? "",
    metadata.reasoningTextObserved ? "1" : "0",
    metadata.reasoningTextSource ?? "",
  ].join("\n");
}

function cloneJsonValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function cloneContinuationReasoningItem(item: unknown): ProxyContinuationReasoningItem | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const raw = item as Record<string, unknown>;
  return raw.type === "reasoning"
    && typeof raw.encrypted_content === "string"
    && raw.encrypted_content.trim().length > 0
    ? cloneJsonValue(raw)
    : null;
}

function collectContinuationReasoningItems(payload: unknown): ProxyContinuationReasoningItem[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const raw = payload as Record<string, unknown>;
  const items: ProxyContinuationReasoningItem[] = [];
  const directItem = cloneContinuationReasoningItem(raw.item);
  if (directItem) {
    items.push(directItem);
  }
  for (const outputItems of [raw.output, jsonObjectField(raw.response)?.output]) {
    if (!Array.isArray(outputItems)) {
      continue;
    }
    for (const item of outputItems) {
      const reasoningItem = cloneContinuationReasoningItem(item);
      if (reasoningItem) {
        items.push(reasoningItem);
      }
    }
  }
  return items;
}

function jsonObjectField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mergeContinuationInclude(include: unknown): string[] {
  const items = Array.isArray(include) ? include.map((item) => `${item}`) : [];
  if (!items.includes(CONTINUATION_ENCRYPTED_INCLUDE)) {
    items.push(CONTINUATION_ENCRYPTED_INCLUDE);
  }
  return items;
}

function requestIncludesEncryptedReasoning(requestJson: unknown): boolean {
  const raw = jsonObjectField(requestJson);
  return Array.isArray(raw?.include)
    && raw.include.some((item) => `${item}` === CONTINUATION_ENCRYPTED_INCLUDE);
}

function prepareContinuationRecoveryRequestBody(input: {
  endpointClass: ProxyEndpointClass | null;
  requestKind: ProxyRequestKind;
  requestJson: unknown;
  requestBody: Buffer;
}): { requestJson: unknown; requestBody: Buffer; autoAddedEncryptedReasoning: boolean } {
  const raw = jsonObjectField(input.requestJson);
  const shouldAutoInclude = input.endpointClass === "responses"
    && input.requestKind !== REQUEST_KIND_CONTEXT_COMPACTION
    && raw?.stream === true
    && !requestIncludesEncryptedReasoning(raw);
  if (!shouldAutoInclude) {
    return {
      requestJson: input.requestJson,
      requestBody: input.requestBody,
      autoAddedEncryptedReasoning: false,
    };
  }
  const nextBody = cloneJsonValue(raw) as Record<string, unknown>;
  nextBody.include = mergeContinuationInclude(nextBody.include);
  return {
    requestJson: nextBody,
    requestBody: Buffer.from(JSON.stringify(nextBody), "utf8"),
    autoAddedEncryptedReasoning: true,
  };
}

function normalizeResponsesInputItemForContinuation(item: unknown): unknown {
  if (typeof item === "string") {
    return {
      type: "message",
      role: "user",
      content: item,
    };
  }
  return cloneJsonValue(item);
}

function normalizeResponsesInputForContinuation(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input.map(normalizeResponsesInputItemForContinuation);
  }
  if (input === undefined || input === null) {
    return [];
  }
  return [normalizeResponsesInputItemForContinuation(input)];
}

function buildContinuationMarkerItem(): Record<string, unknown> {
  return {
    type: "message",
    role: "assistant",
    phase: "commentary",
    content: [
      {
        type: "output_text",
        text: CONTINUATION_MARKER_TEXT,
      },
    ],
  };
}

function buildContinuationRecoveryRequestBody(
  baseRequestJson: unknown,
  continuationReasoningItems: ProxyContinuationReasoningItem[],
): { requestJson: Record<string, unknown>; requestBody: Buffer } {
  const base = cloneJsonValue(jsonObjectField(baseRequestJson) ?? {}) as Record<string, unknown>;
  base.stream = true;
  base.include = mergeContinuationInclude(base.include);
  base.input = [
    ...normalizeResponsesInputForContinuation(base.input),
    ...continuationReasoningItems.map(cloneJsonValue),
    buildContinuationMarkerItem(),
  ];
  return {
    requestJson: base,
    requestBody: Buffer.from(JSON.stringify(base), "utf8"),
  };
}

function stripEncryptedContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripEncryptedContent);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const stripped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "encrypted_content") {
      stripped[key] = stripEncryptedContent(entry);
    }
  }
  return stripped;
}

function stripEncryptedContentFromJsonBuffer(buffer: Buffer): Buffer {
  if (!buffer.toString("utf8").includes("encrypted_content")) {
    return buffer;
  }
  try {
    return Buffer.from(JSON.stringify(stripEncryptedContent(JSON.parse(buffer.toString("utf8")))), "utf8");
  } catch {
    return buffer;
  }
}

function stripEncryptedContentFromSseBody(buffer: Buffer): Buffer {
  const text = buffer.toString("utf8");
  if (!text.includes("encrypted_content")) {
    return buffer;
  }
  const transformed = text.split(/\r?\n\r?\n/).map((block) => {
    if (!block) {
      return block;
    }
    const lines = block.split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (dataLines.length === 0) {
      return block;
    }
    const payloadText = dataLines.join("\n").trim();
    if (!payloadText || payloadText === "[DONE]") {
      return block;
    }
    try {
      return [
        ...lines.filter((line) => !line.startsWith("data:")),
        `data: ${JSON.stringify(stripEncryptedContent(JSON.parse(payloadText)))}`,
      ].join("\n");
    } catch {
      return block;
    }
  }).join("\n\n");
  return Buffer.from(transformed, "utf8");
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
  const mediaType = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return mediaType === "application/json"
    || (mediaType.startsWith("application/") && mediaType.endsWith("+json"));
}

function isUpstreamCapacityError(status: number, body: Buffer): boolean {
  if (status < 400 || body.length === 0) {
    return false;
  }
  const text = body.toString("utf8").toLowerCase();
  const exactMessage = UPSTREAM_CAPACITY_ERROR_MESSAGE.toLowerCase();
  return text.includes(exactMessage)
    || (text.includes("selected model is at capacity") && text.includes("try a different model"));
}

function rewriteUpstreamUrl(requestUrl: URL, upstreamBaseUrl: string): string {
  const upstream = new URL(upstreamBaseUrl);
  upstream.pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";
  upstream.search = requestUrl.search;
  upstream.hash = "";
  return upstream.toString();
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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

function classifyProxyRoute(method: string, pathname: string): ProxyRoute {
  if (method === "GET" && pathname === HEALTH_PATH) {
    return { kind: "control", endpoint: "health" };
  }
  const endpointClass = proxyEndpointClass(pathname);
  return endpointClass ? { kind: "model_api", endpointClass } : { kind: "invalid" };
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
  return extractRequestModelFromJson(parsed, endpointClass);
}

function extractRequestModelFromJson(parsed: unknown, endpointClass: ProxyEndpointClass | null): string | null {
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? jsonStringAt(parsed, ["model"])
    : null;
}

function extractRequestReasoningEffortFromJson(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return jsonStringAt(parsed, ["reasoning", "effort"]) ?? jsonStringAt(parsed, ["reasoning_effort"]);
}

function extractCodexTurnId(headers: IncomingMessage["headers"]): string | null {
  const metadata = headerSignal(headers, "x-codex-turn-metadata");
  if (!metadata) {
    return null;
  }
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? nullableStringField((parsed as Record<string, unknown>).turn_id)
      : null;
  } catch {
    return null;
  }
}

function hashRequestBody(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function sanitizeWhitelistedRequestHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const key of REQUEST_HEADER_ALLOWLIST) {
    const value = headers[key];
    if (value === undefined) {
      continue;
    }
    sanitized[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return sanitized;
}

function detectProxyRequestKind(headers: IncomingMessage["headers"], requestJson: unknown): ProxyRequestKind {
  const headerSignals = [
    headerSignal(headers, "x-codex-request-kind"),
    headerSignal(headers, "x-codex-purpose"),
    headerSignal(headers, "x-codex-turn-metadata"),
  ].join(" ");
  if (includesContextCompactionMarker(headerSignals)) {
    return REQUEST_KIND_CONTEXT_COMPACTION;
  }
  const raw = requestJson && typeof requestJson === "object" && !Array.isArray(requestJson)
    ? requestJson as Record<string, unknown>
    : {};
  const metadataSignals = [
    raw.metadata,
    raw.codex_request_kind,
    raw.request_kind,
    raw.purpose,
  ].map(stringifyRequestKindSignal).join(" ");
  return includesContextCompactionMarker(metadataSignals)
    ? REQUEST_KIND_CONTEXT_COMPACTION
    : REQUEST_KIND_NORMAL;
}

function headerSignal(headers: IncomingMessage["headers"], key: string): string {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) {
    return value.join(" ");
  }
  return typeof value === "string" ? value : "";
}

function stringifyRequestKindSignal(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "object" ? JSON.stringify(value) : `${value}`;
}

function includesContextCompactionMarker(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && CONTEXT_COMPACTION_MARKERS.some((marker) => normalized.includes(marker));
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
  upstream: ProxyUpstream,
  body: Buffer,
  signal?: AbortSignal,
): Promise<Response> {
  const requestUrl = new URL(request.url || "/", "http://localhost");
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    const lower = key.toLowerCase();
    if (
      lower === "host"
      || lower === "content-length"
      || lower === "connection"
      || lower === "transfer-encoding"
      || lower === "authorization"
      || lower === "api-key"
      || lower === "x-api-key"
    ) {
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
  headers.set("authorization", `Bearer ${upstream.apiKey}`);

  return fetch(rewriteUpstreamUrl(requestUrl, upstream.baseURL), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    signal,
  });
}

type ProxyOutcome = {
  response: Response;
  upstream: string | null;
  upstreamStatus: number | null;
  attempts: number;
  attemptRecords: ProxyAttemptRecord[];
  upstreamModel: string | null;
  upstreamModelSource: string | null;
  streamModel: string | null;
  finalResponseModel: string | null;
  systemFingerprint: string | null;
  serviceTier: string | null;
  usage: ProxyUsageMetadata;
  reasoningTokens: number | null;
  reasoningTokensSource: string | null;
  reasoningTextObserved: boolean;
  reasoningTextSource: string | null;
  responseShape: ProxyResponseShape;
  failureSummary: ProxyFailureSummary | null;
  error: string | null;
  deferredInspection?: Promise<ProxyPayloadInspection>;
};

type ProxyForwardCallbacks = {
  signal?: AbortSignal;
  onAttempt?: (attempts: number, upstream: string) => void | Promise<void>;
  onResponseStart?: (status: number, upstream: string) => void | Promise<void>;
  onUpstreamModel?: (extraction: ProxyModelExtraction) => void | Promise<void>;
  onReasoningMetadata?: (metadata: ProxyReasoningMetadata) => void | Promise<void>;
  onGuardAction?: (action: ProxyGuardActionRecord) => void | Promise<void>;
};

type ProxyAttemptState = {
  attempts: number;
  attemptRecords: ProxyAttemptRecord[];
  attemptStartedAtMs: number[];
};

type ProxyPayloadInspection = {
  upstreamModel: ProxyModelExtraction;
  reasoning: ProxyReasoningMetadata;
  usage: ProxyUsageMetadata;
  upstreamMetadata: ProxyUpstreamMetadata;
  responseShape: ProxyResponseShape;
  guardReasoningTokens: number | null;
  continuationReasoningItems: ProxyContinuationReasoningItem[];
};

type ProxyBufferedBody = ProxyBodyTiming & {
  buffer: Buffer;
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
  private reasoning = createEmptyReasoningMetadata();

  constructor(private readonly endpointClass: ProxyEndpointClass | null) {}

  push(chunk: Buffer): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.consumeCompleteEvents();
  }

  finish(): ProxyModelExtraction {
    this.buffer += this.decoder.decode();
    this.consumeEvent(this.buffer);
    this.buffer = "";
    return { model: this.modelValue, source: this.modelSource };
  }

  current(): ProxyModelExtraction {
    return { model: this.modelValue, source: this.modelSource };
  }

  currentReasoningMetadata(): ProxyReasoningMetadata {
    return { ...this.reasoning };
  }

  private consumeCompleteEvents(): void {
    while (true) {
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
      if (this.endpointClass && !this.modelValue) {
        const extraction = extractUpstreamModelFromSsePayload(parsed, this.endpointClass);
        if (extraction.model) {
          this.modelValue = extraction.model;
          this.modelSource = extraction.source;
        }
      }
      this.reasoning = mergeReasoningMetadata(this.reasoning, parseReasoningMetadata(parsed, "sse.data"));
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

async function proxyThroughActiveUpstreamWithStats(
  request: IncomingMessage,
  upstream: ProxyUpstream,
  body: Buffer,
  endpointClass: ProxyEndpointClass | null,
  requestKind: ProxyRequestKind,
  requestJson: unknown,
  attemptRecords: ProxyAttemptRecord[],
  mode: Exclude<ProxyMode, "passthrough">,
  callbacks: ProxyForwardCallbacks = {},
): Promise<ProxyOutcome> {
  const recoveryMode = mode === PROXY_MODE_RECOVERY;
  const preparedRequest = recoveryMode
    ? prepareContinuationRecoveryRequestBody({
      endpointClass,
      requestKind,
      requestJson,
      requestBody: body,
    })
    : {
      requestJson,
      requestBody: body,
      autoAddedEncryptedReasoning: false,
    };
  const attemptState: ProxyAttemptState = { attempts: 0, attemptRecords, attemptStartedAtMs: [] };
  let guardRetries = 0;
  let currentBody = preparedRequest.requestBody;
  let currentRequestJson = preparedRequest.requestJson;
  const stripAutoEncryptedReasoning = preparedRequest.autoAddedEncryptedReasoning;

  while (true) {
    const response = await fetchUpstreamWithTransportRetry(request, upstream, currentBody, attemptState, callbacks);
    if (!(response instanceof Response)) {
      return response;
    }

    const status = response.status;
    await callbacks.onResponseStart?.(status, upstream.name);
    const headers = responseHeadersToObject(response.headers);
    const responseContentType = `${response.headers.get("content-type") || ""}`;
    const body = await readProxyResponseBody(response, responseContentType, endpointClass, currentProxyAttemptStartedAtMs(attemptState), callbacks);
    const buffer = body.buffer;
    updateProxyAttemptBodyTiming(attemptState, body);
    const inspection = inspectProxyPayload(buffer, responseContentType, endpointClass);
    updateProxyAttemptInspection(attemptState, inspection);
    const upstreamModel = inspection.upstreamModel;
    if (upstreamModel.model) {
      await callbacks.onUpstreamModel?.(upstreamModel);
    }
    await callbacks.onReasoningMetadata?.(inspection.reasoning);

    if (isUpstreamCapacityError(status, buffer)) {
      if (guardRetries < GUARD_RETRY_ATTEMPTS) {
        guardRetries += 1;
        completeProxyAttemptRecord(attemptState, "upstream_capacity_internal_retry", {
          failureSummary: proxyFailureSummary("upstream_error", "model_at_capacity", UPSTREAM_CAPACITY_ERROR_MESSAGE),
          remainingRetries: Math.max(0, GUARD_RETRY_ATTEMPTS - guardRetries),
        });
        await callbacks.onGuardAction?.(createProxyGuardAction({
          action: "internal_retry",
          upstream: upstream.name,
          attempt: attemptState.attempts,
          status,
          reasoningTokens: null,
          error: `upstream_capacity: ${UPSTREAM_CAPACITY_ERROR_MESSAGE}`,
        }));
        continue;
      }

      const failureSummary = proxyFailureSummary("upstream_error", "model_at_capacity", UPSTREAM_CAPACITY_ERROR_MESSAGE);
      completeProxyAttemptRecord(attemptState, proxyUpstreamFinalAction(status), { failureSummary });
      return createProxyOutcome({
        response: createBufferedResponse(buffer, status, headers, responseContentType, stripAutoEncryptedReasoning),
        upstream: upstream.name,
        upstreamStatus: status,
        attempts: attemptState.attempts,
        attemptRecords: attemptState.attemptRecords,
        inspection,
        upstreamModel,
        failureSummary,
        error: null,
      });
    }

    if (inspection.guardReasoningTokens !== null) {
      const canContinuationRecover = isStreamContentType(responseContentType)
        && recoveryMode
        && endpointClass === "responses"
        && requestKind !== REQUEST_KIND_CONTEXT_COMPACTION
        && inspection.continuationReasoningItems.length > 0
        && guardRetries < GUARD_RETRY_ATTEMPTS;
      if (canContinuationRecover) {
        guardRetries += 1;
        completeProxyAttemptRecord(attemptState, "continuation_recovery", {
          remainingRetries: Math.max(0, GUARD_RETRY_ATTEMPTS - guardRetries),
        });
        await callbacks.onGuardAction?.(createProxyGuardAction({
          action: "continuation_recovery",
          upstream: upstream.name,
          attempt: attemptState.attempts,
          status,
          reasoningTokens: inspection.guardReasoningTokens,
          error: null,
        }));
        const continuationRequest = buildContinuationRecoveryRequestBody(
          currentRequestJson,
          inspection.continuationReasoningItems,
        );
        currentBody = continuationRequest.requestBody;
        currentRequestJson = continuationRequest.requestJson;
        continue;
      }
      if (guardRetries < GUARD_RETRY_ATTEMPTS) {
        guardRetries += 1;
        completeProxyAttemptRecord(attemptState, "internal_retry", {
          remainingRetries: Math.max(0, GUARD_RETRY_ATTEMPTS - guardRetries),
        });
        await callbacks.onGuardAction?.(createProxyGuardAction({
          action: "internal_retry",
          upstream: upstream.name,
          attempt: attemptState.attempts,
          status,
          reasoningTokens: inspection.guardReasoningTokens,
          error: null,
        }));
        continue;
      }

      const error = `reasoning_guard_triggered reasoning_tokens=${inspection.guardReasoningTokens}`;
      completeProxyAttemptRecord(attemptState, "blocked", {
        failureSummary: proxyFailureSummary("codex_proxy", "reasoning_guard_triggered", error),
        remainingRetries: 0,
      });
      await callbacks.onGuardAction?.(createProxyGuardAction({
        action: "return_status_502",
        upstream: upstream.name,
        attempt: attemptState.attempts,
        status: NON_STREAM_STATUS_CODE,
        reasoningTokens: inspection.guardReasoningTokens,
        error,
      }));
      return createProxyOutcome({
        response: createReasoningGuardResponse(upstream, inspection.guardReasoningTokens),
        upstream: upstream.name,
        upstreamStatus: status,
        attempts: attemptState.attempts,
        attemptRecords: attemptState.attemptRecords,
        inspection,
        upstreamModel,
        reasoningTokens: inspection.guardReasoningTokens,
        reasoningTokensSource: inspection.reasoning.reasoningTokensSource,
        failureSummary: proxyFailureSummary("codex_proxy", "reasoning_guard_triggered", error),
        error,
      });
    }

    const failureSummary = proxyFailureSummaryFromBufferedPayload(status, buffer, responseContentType);
    completeProxyAttemptRecord(attemptState, proxyUpstreamFinalAction(status), { failureSummary });
    return createProxyOutcome({
      response: createBufferedResponse(buffer, status, headers, responseContentType, stripAutoEncryptedReasoning),
      upstream: upstream.name,
      upstreamStatus: status,
      attempts: attemptState.attempts,
      attemptRecords: attemptState.attemptRecords,
      inspection,
      upstreamModel,
      failureSummary,
      error: null,
    });
  }
}

async function proxyThroughActiveUpstreamPassthrough(
  request: IncomingMessage,
  upstream: ProxyUpstream,
  body: Buffer,
  attemptRecords: ProxyAttemptRecord[],
  endpointClass: ProxyEndpointClass,
  callbacks: ProxyForwardCallbacks = {},
): Promise<ProxyOutcome> {
  const attemptState: ProxyAttemptState = { attempts: 0, attemptRecords, attemptStartedAtMs: [] };
  if (callbacks.signal?.aborted) {
    throw new ProxyResponseWriteError("client closed response before upstream stream completed", 499, 0);
  }
  attemptState.attempts += 1;
  attemptState.attemptRecords.push(createProxyAttemptRecord(attemptState.attempts, upstream.name));
  attemptState.attemptStartedAtMs.push(performance.now());
  await callbacks.onAttempt?.(attemptState.attempts, upstream.name);

  try {
    const response = await forwardRequest(request, upstream, body, callbacks.signal);
    markProxyAttemptHeaders(attemptState, response.status);
    await callbacks.onResponseStart?.(response.status, upstream.name);
    const contentType = response.headers.get("content-type") ?? "";
    const deferredInspection = response.clone().arrayBuffer().then((buffer) => {
      const inspection = inspectProxyPayload(Buffer.from(buffer), contentType, endpointClass);
      updateProxyAttemptInspection(attemptState, inspection);
      return inspection;
    });
    const failureSummary = response.status >= 400 ? proxyHttpFailureSummary(response.status) : null;
    completeProxyAttemptRecord(attemptState, proxyUpstreamFinalAction(response.status), { failureSummary });
    return {
      ...createProxyOutcome({
      response,
      upstream: upstream.name,
      upstreamStatus: response.status,
      attempts: attemptState.attempts,
      attemptRecords: attemptState.attemptRecords,
      failureSummary,
      }),
      deferredInspection,
    };
  } catch (error) {
    if (isClientAbortError(error, callbacks.signal)) {
      throw new ProxyResponseWriteError("client closed response before upstream stream completed", 499, 0);
    }
    const fetchFailed = isFetchFailedError(error);
    const message = error instanceof Error ? error.message : String(error);
    const code = fetchFailed ? "upstream_fetch_failed" : "upstream_error";
    const failureSummary = proxyFailureSummaryFromError(code, error);
    completeProxyAttemptRecord(attemptState, code, {
      failureSummary,
      remainingRetries: 0,
    });
    return createProxyOutcome({
      response: createUpstreamErrorResponse(message, code),
      upstream: upstream.name,
      upstreamStatus: null,
      attempts: attemptState.attempts,
      attemptRecords: attemptState.attemptRecords,
      failureSummary,
      error: `${code}: ${message}`,
    });
  }
}

async function readProxyResponseBody(
  response: Response,
  contentType: string,
  endpointClass: ProxyEndpointClass | null,
  attemptStartedAtMs: number | null,
  callbacks: ProxyForwardCallbacks,
): Promise<ProxyBufferedBody> {
  if (!response.body) {
    return { buffer: Buffer.alloc(0), timeToFirstChunkMs: null, streamDurationMs: null };
  }
  if (!isStreamContentType(contentType)) {
    try {
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        timeToFirstChunkMs: null,
        streamDurationMs: null,
      };
    } catch (error) {
      throw proxyResponseBodyReadError(error, callbacks.signal, 0);
    }
  }

  const chunks: Buffer[] = [];
  const scanner = new ProxySseModelScanner(endpointClass);
  let responseBytes = 0;
  let firstChunkAtMs: number | null = null;
  let lastChunkAtMs: number | null = null;
  let emittedModelKey = "";
  let emittedReasoningKey = reasoningMetadataKey(createEmptyReasoningMetadata());
  const emitModelIfChanged = async (extraction: ProxyModelExtraction): Promise<void> => {
    const key = `${extraction.model ?? ""}\n${extraction.source ?? ""}`;
    if (!extraction.model || key === emittedModelKey) {
      return;
    }
    emittedModelKey = key;
    await callbacks.onUpstreamModel?.(extraction);
  };
  const emitReasoningIfChanged = async (metadata: ProxyReasoningMetadata): Promise<void> => {
    const key = reasoningMetadataKey(metadata);
    if (key === emittedReasoningKey) {
      return;
    }
    emittedReasoningKey = key;
    await callbacks.onReasoningMetadata?.(metadata);
  };

  try {
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nowMs = performance.now();
      firstChunkAtMs ??= nowMs;
      lastChunkAtMs = nowMs;
      chunks.push(value);
      responseBytes += value.length;
      scanner.push(value);
      await emitModelIfChanged(scanner.current());
      await emitReasoningIfChanged(scanner.currentReasoningMetadata());
    }
    scanner.finish();
  } catch (error) {
    throw proxyResponseBodyReadError(error, callbacks.signal, responseBytes);
  }
  await emitModelIfChanged(scanner.current());
  await emitReasoningIfChanged(scanner.currentReasoningMetadata());
  const buffer = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
  return {
    buffer,
    timeToFirstChunkMs: firstChunkAtMs === null || attemptStartedAtMs === null ? null : Math.max(0, firstChunkAtMs - attemptStartedAtMs),
    streamDurationMs: firstChunkAtMs === null || lastChunkAtMs === null ? null : Math.max(0, lastChunkAtMs - firstChunkAtMs),
  };
}

function proxyResponseBodyReadError(error: unknown, signal: AbortSignal | undefined, responseBytes: number): ProxyResponseWriteError {
  const message = error instanceof Error ? error.message : String(error);
  if (isClientAbortError(error, signal)) {
    return new ProxyResponseWriteError("client closed response before upstream stream completed", 499, 0);
  }
  return new ProxyResponseWriteError(message, 502, responseBytes);
}

async function fetchUpstreamWithTransportRetry(
  request: IncomingMessage,
  upstream: ProxyUpstream,
  body: Buffer,
  attemptState: ProxyAttemptState,
  callbacks: ProxyForwardCallbacks,
): Promise<Response | ProxyOutcome> {
  let fetchFailedRetries = 0;

  while (true) {
    if (callbacks.signal?.aborted) {
      throw new ProxyResponseWriteError("client closed response before upstream stream completed", 499, 0);
    }
    attemptState.attempts += 1;
    attemptState.attemptRecords.push(createProxyAttemptRecord(attemptState.attempts, upstream.name));
    attemptState.attemptStartedAtMs.push(performance.now());
    await callbacks.onAttempt?.(attemptState.attempts, upstream.name);
    try {
      const response = await forwardRequest(request, upstream, body, callbacks.signal);
      markProxyAttemptHeaders(attemptState, response.status);
      return response;
    } catch (error) {
      if (isClientAbortError(error, callbacks.signal)) {
        throw new ProxyResponseWriteError("client closed response before upstream stream completed", 499, 0);
      }
      const fetchFailed = isFetchFailedError(error);
      const message = error instanceof Error ? error.message : String(error);
      const code = fetchFailed ? "upstream_fetch_failed" : "upstream_error";
      const failureSummary = proxyFailureSummaryFromError(code, error);
      await callbacks.onGuardAction?.(createProxyGuardAction({
        action: "upstream_error",
        upstream: upstream.name,
        attempt: attemptState.attempts,
        status: null,
        reasoningTokens: null,
        error: `${code}: ${message}`,
      }));
      if (fetchFailed && fetchFailedRetries < FETCH_FAILED_TRANSPORT_RETRIES) {
        fetchFailedRetries += 1;
        completeProxyAttemptRecord(attemptState, "transport_retry", {
          failureSummary,
          remainingRetries: Math.max(0, FETCH_FAILED_TRANSPORT_RETRIES - fetchFailedRetries),
        });
        continue;
      }
      completeProxyAttemptRecord(attemptState, code, {
        failureSummary,
        remainingRetries: 0,
      });
      return createProxyOutcome({
        response: createUpstreamErrorResponse(message, code),
        upstream: upstream.name,
        upstreamStatus: null,
        attempts: attemptState.attempts,
        attemptRecords: attemptState.attemptRecords,
        failureSummary,
        error: `${code}: ${message}`,
      });
    }
  }
}

function isFetchFailedError(error: unknown): boolean {
  return error instanceof TypeError && error.message === "fetch failed";
}

function isClientAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) {
    return true;
  }
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

function inspectProxyPayload(
  buffer: Buffer,
  contentType: string,
  endpointClass: ProxyEndpointClass | null,
): ProxyPayloadInspection {
  if (isStreamContentType(contentType)) {
    return inspectSsePayload(buffer, endpointClass);
  }
  if (isJsonContentType(contentType)) {
    return inspectJsonPayload(buffer, endpointClass);
  }
  return {
    upstreamModel: { model: null, source: null },
    reasoning: createEmptyReasoningMetadata(),
    usage: createEmptyProxyUsageMetadata(),
    upstreamMetadata: createEmptyProxyUpstreamMetadata(),
    responseShape: createEmptyProxyResponseShape(),
    guardReasoningTokens: null,
    continuationReasoningItems: [],
  };
}

function inspectJsonPayload(buffer: Buffer, endpointClass: ProxyEndpointClass | null): ProxyPayloadInspection {
  try {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    const reasoning = parseReasoningMetadata(parsed);
    return {
      upstreamModel: extractUpstreamModelFromJson(parsed, endpointClass),
      reasoning,
      usage: parseProxyUsageMetadata(parsed),
      upstreamMetadata: parseProxyUpstreamMetadata(parsed),
      responseShape: parseProxyResponseShape(parsed),
      guardReasoningTokens: reasoning.reasoningTokens !== null && REASONING_EQUALS.includes(reasoning.reasoningTokens) ? reasoning.reasoningTokens : null,
      continuationReasoningItems: [],
    };
  } catch {
    return {
      upstreamModel: { model: null, source: null },
      reasoning: createEmptyReasoningMetadata(),
      usage: createEmptyProxyUsageMetadata(),
      upstreamMetadata: createEmptyProxyUpstreamMetadata(),
      responseShape: createEmptyProxyResponseShape(),
      guardReasoningTokens: null,
      continuationReasoningItems: [],
    };
  }
}

function inspectSsePayload(buffer: Buffer, endpointClass: ProxyEndpointClass | null): ProxyPayloadInspection {
  let upstreamModel: ProxyModelExtraction = { model: null, source: null };
  let reasoning = createEmptyReasoningMetadata();
  let usage = createEmptyProxyUsageMetadata();
  let upstreamMetadata = createEmptyProxyUpstreamMetadata();
  let responseShape = createEmptyProxyResponseShape();
  let guardReasoningTokens: number | null = null;
  const continuationReasoningItems: ProxyContinuationReasoningItem[] = [];

  for (const event of splitSseEvents(buffer.toString("utf8"))) {
    const data = sseEventData(event);
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!upstreamModel.model) {
        upstreamModel = extractUpstreamModelFromSsePayload(parsed, endpointClass);
      }
      const eventReasoning = parseReasoningMetadata(parsed, "sse.data");
      reasoning = mergeReasoningMetadata(reasoning, eventReasoning);
      usage = mergeProxyUsageMetadata(usage, parseProxyUsageMetadata(parsed));
      upstreamMetadata = mergeProxyUpstreamMetadata(upstreamMetadata, parseProxyUpstreamMetadata(parsed));
      responseShape = mergeProxyResponseShape(responseShape, parseProxyResponseShape(parsed));
      continuationReasoningItems.push(...collectContinuationReasoningItems(parsed));
      if (eventReasoning.reasoningTokens !== null) {
        if (REASONING_EQUALS.includes(eventReasoning.reasoningTokens)) {
          guardReasoningTokens = eventReasoning.reasoningTokens;
        }
      }
    } catch {
      // SSE data frames can contain non-JSON control text.
    }
  }

  return { upstreamModel, reasoning, usage, upstreamMetadata, responseShape, guardReasoningTokens, continuationReasoningItems };
}

function splitSseEvents(value: string): string[] {
  const events: string[] = [];
  let rest = value;
  while (rest.length > 0) {
    const separator = findSseEventSeparator(rest);
    if (!separator) {
      if (rest.length > 0) {
        events.push(rest);
      }
      break;
    }
    events.push(rest.slice(0, separator.index));
    rest = rest.slice(separator.index + separator.length);
  }
  return events;
}

function sseEventData(event: string): string {
  return event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
}

function createProxyAttemptRecord(attempt: number, upstream: string | null): ProxyAttemptRecord {
  return {
    attempt,
    started_at: new Date().toISOString(),
    headers_at: null,
    completed_at: null,
    duration_ms: null,
    upstream,
    upstream_status: null,
    upstream_wait_ms: null,
    time_to_first_chunk_ms: null,
    stream_duration_ms: null,
    upstream_model: null,
    upstream_model_source: null,
    stream_model: null,
    final_response_model: null,
    system_fingerprint: null,
    service_tier: null,
    input_tokens: null,
    cached_input_tokens: null,
    reasoning_tokens: null,
    reasoning_tokens_source: null,
    output_tokens: null,
    total_tokens: null,
    reasoning_text_observed: false,
    reasoning_text_source: null,
    has_commentary: false,
    has_final_answer: false,
    final_answer_only: false,
    has_tool_call: false,
    has_reasoning_item: false,
    final_action: "pending",
    failure_summary: null,
    remaining_retries: null,
  };
}

function currentProxyAttemptRecord(attemptState: ProxyAttemptState): ProxyAttemptRecord | null {
  return attemptState.attemptRecords.at(-1) ?? null;
}

function markProxyAttemptHeaders(attemptState: ProxyAttemptState, status: number): void {
  const attempt = currentProxyAttemptRecord(attemptState);
  if (!attempt) {
    return;
  }
  attempt.headers_at = new Date().toISOString();
  attempt.upstream_status = status;
  const startedAtMs = currentProxyAttemptStartedAtMs(attemptState);
  attempt.upstream_wait_ms = startedAtMs === null ? null : Math.max(0, performance.now() - startedAtMs);
}

function updateProxyAttemptInspection(attemptState: ProxyAttemptState, inspection: ProxyPayloadInspection): void {
  const attempt = currentProxyAttemptRecord(attemptState);
  if (!attempt) {
    return;
  }
  attempt.upstream_model = inspection.upstreamModel.model;
  attempt.upstream_model_source = inspection.upstreamModel.source;
  attempt.stream_model = inspection.upstreamModel.source?.startsWith("sse.") ? inspection.upstreamModel.model : null;
  attempt.final_response_model = inspection.upstreamModel.model;
  attempt.system_fingerprint = inspection.upstreamMetadata.systemFingerprint;
  attempt.service_tier = inspection.upstreamMetadata.serviceTier;
  attempt.input_tokens = inspection.usage.inputTokens;
  attempt.cached_input_tokens = inspection.usage.cachedInputTokens;
  attempt.reasoning_tokens = inspection.reasoning.reasoningTokens;
  attempt.reasoning_tokens_source = inspection.reasoning.reasoningTokensSource;
  attempt.output_tokens = inspection.usage.outputTokens;
  attempt.total_tokens = inspection.usage.totalTokens;
  attempt.reasoning_text_observed = inspection.reasoning.reasoningTextObserved;
  attempt.reasoning_text_source = inspection.reasoning.reasoningTextSource;
  attempt.has_commentary = inspection.responseShape.hasCommentary;
  attempt.has_final_answer = inspection.responseShape.hasFinalAnswer;
  attempt.final_answer_only = isProxyFinalAnswerOnly(inspection.responseShape);
  attempt.has_tool_call = inspection.responseShape.hasToolCall;
  attempt.has_reasoning_item = inspection.responseShape.hasReasoningItem;
}

function updateProxyAttemptBodyTiming(attemptState: ProxyAttemptState, timing: ProxyBodyTiming): void {
  const attempt = currentProxyAttemptRecord(attemptState);
  if (!attempt) {
    return;
  }
  attempt.time_to_first_chunk_ms = timing.timeToFirstChunkMs;
  attempt.stream_duration_ms = timing.streamDurationMs;
}

function currentProxyAttemptStartedAtMs(attemptState: ProxyAttemptState): number | null {
  const startedAtMs = attemptState.attemptStartedAtMs.at(-1);
  return typeof startedAtMs === "number" && Number.isFinite(startedAtMs) ? startedAtMs : null;
}

function completeProxyAttemptRecord(
  attemptState: ProxyAttemptState,
  finalAction: string,
  input: {
    failureSummary?: ProxyFailureSummary | null;
    remainingRetries?: number | null;
  } = {},
): void {
  const attempt = currentProxyAttemptRecord(attemptState);
  if (!attempt || attempt.final_action !== "pending") {
    return;
  }
  const completedAt = new Date();
  attempt.completed_at = completedAt.toISOString();
  const startedAtMs = Date.parse(attempt.started_at);
  attempt.duration_ms = Number.isFinite(startedAtMs)
    ? Math.max(0, completedAt.getTime() - startedAtMs)
    : null;
  attempt.final_action = finalAction;
  attempt.failure_summary = input.failureSummary ?? attempt.failure_summary;
  attempt.remaining_retries = input.remainingRetries ?? attempt.remaining_retries;
}

function completeLastPendingProxyAttemptRecord(
  attemptRecords: ProxyAttemptRecord[],
  finalAction: string,
  input: {
    failureSummary?: ProxyFailureSummary | null;
    remainingRetries?: number | null;
  } = {},
): void {
  completeProxyAttemptRecord({ attempts: attemptRecords.length, attemptRecords, attemptStartedAtMs: [] }, finalAction, input);
}

function proxyFailureSummary(type: string | null, code: string | null, message: string | null): ProxyFailureSummary {
  return { type, code, message };
}

function proxyFailureSummaryFromError(code: string, error: unknown): ProxyFailureSummary {
  const message = error instanceof Error ? error.message : String(error);
  return proxyFailureSummary("upstream_error", code, message);
}

function proxyFailureSummaryFromBufferedPayload(status: number, buffer: Buffer, contentType: string): ProxyFailureSummary | null {
  if (status < 400) {
    return null;
  }
  if (isJsonContentType(contentType) && buffer.length > 0) {
    try {
      const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
      const summary = proxyFailureSummaryFromJsonPayload(parsed);
      if (summary) {
        return summary;
      }
    } catch {
      return proxyHttpFailureSummary(status);
    }
  }
  return proxyHttpFailureSummary(status);
}

function proxyFailureSummaryFromJsonPayload(parsed: unknown): ProxyFailureSummary | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const error = raw.error;
  if (typeof error === "string" && error.length > 0) {
    return proxyFailureSummary("upstream_error", null, error);
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const errorRaw = error as Record<string, unknown>;
    return proxyFailureSummary(
      nullableStringField(errorRaw.type) ?? "upstream_error",
      nullableStringField(errorRaw.code),
      nullableStringField(errorRaw.message),
    );
  }
  return null;
}

function proxyHttpFailureSummary(status: number): ProxyFailureSummary {
  return proxyFailureSummary("upstream_error", `upstream_http_${status}`, `upstream returned HTTP ${status}`);
}

function proxyUpstreamFinalAction(status: number): string {
  return status >= 400 ? "upstream_error" : "passed";
}

function createRetrySummary(attemptRecords: ProxyAttemptRecord[]): ProxyRetrySummary {
  const summary = createEmptyProxyRetrySummary();
  for (const attempt of attemptRecords) {
    if (attempt.final_action === "internal_retry" || attempt.final_action === "continuation_recovery") {
      summary.reasoning_guard += 1;
    } else if (attempt.final_action === "upstream_capacity_internal_retry") {
      summary.upstream_capacity += 1;
    } else if (attempt.final_action === "transport_retry") {
      summary.transport += 1;
    }
  }
  summary.total = summary.reasoning_guard + summary.upstream_capacity + summary.transport;
  return summary;
}

function lastProxyAttemptRecord(attemptRecords: ProxyAttemptRecord[]): ProxyAttemptRecord | null {
  return attemptRecords.at(-1) ?? null;
}

function requestTimingFromAttempt(attempt: ProxyAttemptRecord | null): Pick<ProxyRequestRecord, "upstream_wait_ms" | "time_to_first_chunk_ms" | "stream_duration_ms"> {
  return {
    upstream_wait_ms: attempt?.upstream_wait_ms ?? null,
    time_to_first_chunk_ms: attempt?.time_to_first_chunk_ms ?? null,
    stream_duration_ms: attempt?.stream_duration_ms ?? null,
  };
}

function requestFinalAction(input: { status: number | null; error: string | null; failureSummary: ProxyFailureSummary | null }): string {
  if (input.status === 499) {
    return "client_aborted";
  }
  if (input.failureSummary?.code === "reasoning_guard_triggered" || input.error?.includes("reasoning_guard_triggered")) {
    return "blocked";
  }
  if (input.failureSummary?.code === "upstream_fetch_failed" || input.error?.includes("upstream_fetch_failed")) {
    return "upstream_fetch_failed";
  }
  if (input.error) {
    return "gateway_error";
  }
  if (input.status !== null && input.status >= 400 && input.failureSummary?.type === "upstream_error") {
    return "upstream_error";
  }
  return "passed";
}

function createProxyGuardAction(input: {
  action: ProxyGuardAction;
  upstream: string | null;
  attempt: number;
  status: number | null;
  reasoningTokens: number | null;
  error: string | null;
}): ProxyGuardActionRecord {
  return {
    at: new Date().toISOString(),
    action: input.action,
    upstream: input.upstream,
    attempt: input.attempt,
    status: input.status,
    reasoning_tokens: input.reasoningTokens,
    error: input.error,
  };
}

function createReasoningGuardResponse(upstream: ProxyUpstream, reasoningTokens: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `codex proxy blocked suspicious reasoning response from ${upstream.baseURL}`,
        type: "codex_proxy",
        code: "reasoning_guard_triggered",
        reasoning_tokens: reasoningTokens,
        status_code: NON_STREAM_STATUS_CODE,
      },
    }),
    { status: NON_STREAM_STATUS_CODE, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

function createUpstreamErrorResponse(message: string, code: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `proxy upstream error: ${message}`,
        type: "upstream_error",
        code,
        status_code: NON_STREAM_STATUS_CODE,
      },
    }),
    { status: NON_STREAM_STATUS_CODE, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

function createBufferedResponse(
  buffer: Buffer,
  status: number,
  headers: Record<string, string>,
  contentType = "",
  stripAutoEncryptedReasoning = false,
): Response {
  const responseHeaders = { ...headers };
  let responseBuffer = buffer;
  if (stripAutoEncryptedReasoning) {
    if (isStreamContentType(contentType)) {
      responseBuffer = stripEncryptedContentFromSseBody(buffer);
    } else if (isJsonContentType(contentType)) {
      responseBuffer = stripEncryptedContentFromJsonBuffer(buffer);
    }
    if (responseBuffer !== buffer) {
      delete responseHeaders["content-length"];
    }
  }
  return new Response(responseStatusAllowsBody(status) ? responseBuffer : null, { status, headers: responseHeaders });
}

function responseStatusAllowsBody(status: number): boolean {
  return status !== 101 && status !== 204 && status !== 205 && status !== 304;
}

function writeProxyJsonErrorResponse(res: ServerResponse, status: number, message: string, onHeadersWritten?: () => void): boolean {
  if (res.destroyed || res.writableEnded) {
    return false;
  }
  if (res.headersSent) {
    res.destroy();
    return false;
  }
  const payload = JSON.stringify({ error: { message } });
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  onHeadersWritten?.();
  res.end(payload);
  return true;
}

async function writeResponse(
  res: ServerResponse,
  response: Response,
  endpointClass: ProxyEndpointClass | null,
  modelObserver: ProxyWriteModelObserver,
  onHeadersWritten?: () => void,
): Promise<number> {
  res.writeHead(response.status, responseHeadersToObject(response.headers));
  onHeadersWritten?.();
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

function updateProxyModelObserver(modelObserver: ProxyWriteModelObserver, extraction: ProxyModelExtraction): Promise<void> {
  if (modelObserver.model === extraction.model && modelObserver.source === extraction.source) {
    return Promise.resolve();
  }
  modelObserver.model = extraction.model;
  modelObserver.source = extraction.source;
  return Promise.resolve(modelObserver.update?.(extraction));
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
    let modelUpdateQueue: Promise<void> = Promise.resolve();

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
    const queueModelObserverUpdate = (extraction: ProxyModelExtraction): Promise<void> => {
      modelUpdateQueue = modelUpdateQueue.then(() => updateProxyModelObserver(modelObserver, extraction));
      return modelUpdateQueue;
    };

    stream.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      responseBytes += value.length;
      if (scanner) {
        scanner.push(value);
        void queueModelObserverUpdate(scanner.current()).catch((error: unknown) => {
          stream.destroy(error instanceof Error ? error : new Error(String(error)));
        });
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
      void (async () => {
        if (scanner) {
          await queueModelObserverUpdate(scanner.finish());
        } else {
          await modelUpdateQueue;
        }
        finish();
      })().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finish(new ProxyResponseWriteError(message, 500, responseBytes));
      });
    });
    stream.pipe(res);
  });
}

async function buildProxyInstallPlan(options: ProxyOptions): Promise<ProxyInstallPlan> {
  if (!fs.existsSync(options.codexConfigPath)) {
    throw new Error(`Codex config file was not found: ${options.codexConfigPath}`);
  }
  if (await readProxyState(options.stateRoot)) {
    throw new Error(`proxy state already exists: ${statePath(options.stateRoot)}`);
  }

  const codexConfigText = await readFile(options.codexConfigPath, "utf8");
  const profiles = await readProfiles();
  if (!profiles.current) {
    throw new Error("profiles.current was not found");
  }
  if (!profiles.profiles?.[profiles.current]) {
    throw new Error(`profiles.current ${profiles.current} was not found in profiles`);
  }
  const backupPath = path.join(options.stateRoot, "backups", `config-${Date.now()}.toml`);
  const state = {
    ...buildProxyStateFromProfiles(profiles, codexConfigText, options.codexConfigPath, options.listenHost, options.listenPort),
    backup_path: backupPath,
  };
  return {
    backupPath,
    statePath: statePath(options.stateRoot),
    state,
    currentBaseUrl: state.original_base_url,
    targetBaseUrl: state.proxy_base_url,
    sourceConfig: codexConfigText,
    targetConfig: updateTomlProviderBaseUrl(codexConfigText, state.provider_name, state.proxy_base_url),
  };
}

async function applyProxyInstallPlan(options: ProxyOptions, plan: ProxyInstallPlan): Promise<ProxyInstallPlan> {
  if (await readProxyState(options.stateRoot)) {
    throw new Error(`proxy state already exists: ${statePath(options.stateRoot)}`);
  }
  if (await readFile(options.codexConfigPath, "utf8") !== plan.sourceConfig) {
    throw new Error(`Codex config changed after preview: ${options.codexConfigPath}`);
  }
  await mkdir(path.dirname(plan.backupPath), { recursive: true });
  await copyFile(options.codexConfigPath, plan.backupPath);
  await writeProxyState(options.stateRoot, plan.state);
  try {
    const runtime = await ensureProxyRunning(options);
    await writeTextFile(options.codexConfigPath, plan.targetConfig);
    if (await readFile(options.codexConfigPath, "utf8") !== plan.targetConfig) {
      throw new Error(`failed to verify proxy routing in Codex config: ${options.codexConfigPath}`);
    }
    return { ...plan, runtime };
  } catch (error) {
    await shutdownProxyRuntime(options).catch(() => undefined);
    await removeProxyState(options.stateRoot);
    throw error;
  }
}

export async function installProxy(options: ProxyOptions): Promise<ProxyInstallPlan> {
  return applyProxyInstallPlan(options, await buildProxyInstallPlan(options));
}

async function buildProxyRestorePlan(options: ProxyOptions): Promise<ProxyRestorePlan> {
  const state = await readProxyState(options.stateRoot);
  if (!state) {
    throw new Error(`proxy state file was not found: ${statePath(options.stateRoot)}`);
  }
  if (!fs.existsSync(options.codexConfigPath)) {
    throw new Error(`Codex config file was not found: ${options.codexConfigPath}`);
  }
  const profiles = await readProfiles();
  const current = profiles.current;
  if (!current) {
    throw new Error("profiles.current was not found");
  }
  const targetBaseUrl = profiles.profiles?.[current]?.baseURL;
  if (!targetBaseUrl) {
    throw new Error(`profiles.current ${current} has no baseURL`);
  }
  const sourceConfig = await readFile(options.codexConfigPath, "utf8");
  const currentBaseUrl = readTomlProviderBaseUrl(sourceConfig, state.provider_name);
  if (currentBaseUrl === null) {
    throw new Error(`base_url was not found in [model_providers.${state.provider_name}]`);
  }
  const targetConfig = updateTomlProviderBaseUrl(sourceConfig, state.provider_name, targetBaseUrl);
  return {
    backupPath: path.join(options.stateRoot, "backups", `config-restore-${Date.now()}.toml`),
    state,
    profileName: current,
    currentBaseUrl,
    targetBaseUrl,
    sourceConfig,
    targetConfig,
  };
}

async function applyProxyRestorePlan(options: ProxyOptions, plan: ProxyRestorePlan): Promise<string> {
  const currentState = await readProxyState(options.stateRoot);
  if (!currentState
    || currentState.installed_at !== plan.state.installed_at
    || currentState.provider_name !== plan.state.provider_name
    || currentState.proxy_base_url !== plan.state.proxy_base_url) {
    throw new Error(`proxy state changed after preview: ${statePath(options.stateRoot)}`);
  }
  if (await readFile(options.codexConfigPath, "utf8") !== plan.sourceConfig) {
    throw new Error(`Codex config changed after preview: ${options.codexConfigPath}`);
  }
  await mkdir(path.dirname(plan.backupPath), { recursive: true });
  await copyFile(options.codexConfigPath, plan.backupPath);
  await writeTextFile(options.codexConfigPath, plan.targetConfig);
  if (await readFile(options.codexConfigPath, "utf8") !== plan.targetConfig) {
    throw new Error(`failed to verify direct routing in Codex config: ${options.codexConfigPath}`);
  }
  const stopped = await shutdownProxyRuntime(options);
  await removeProxyState(options.stateRoot);
  return stopped;
}

export async function restoreProxy(options: ProxyOptions): Promise<string> {
  return applyProxyRestorePlan(options, await buildProxyRestorePlan(options));
}

function formatProxyRequestsSummary(metrics: ProxyMetrics, profileOrder: string[]): string {
  const statusCounts = formatExactProxyStatusCounts(metrics.status_counts);
  return [
    `status total=${colorCount(String(totalProxyStatusCounts(metrics.status_counts)))}`,
    `active=${metrics.active_requests.length === 0 ? textDim("0") : textYellow(String(metrics.active_requests.length))}`,
    ...statusCounts,
    `upstreams=${formatProxyUpstreamHits(profileOrder, metrics)}`,
  ].join(" ");
}

function formatProxyReasoningSummary(metrics: ProxyMetrics): string {
  const reasoningCounts = formatGroupedProxyReasoningTokenCounts(metrics.reasoning_token_counts);
  return [
    `reasoning total=${colorCount(String(totalProxyReasoningTokenCounts(metrics.reasoning_token_counts)))}`,
    `max=${formatProxyReasoningTokenValue(maxProxyReasoningToken(metrics.reasoning_token_counts))}`,
    ...reasoningCounts,
    ...formatProxyContinuationRecoveryCounts(proxyContinuationRecoveryCounts(metrics.recent_requests)),
  ].join(" ");
}

function proxyContinuationRecoveryCounts(records: ProxyRequestRecord[]): ProxyContinuationRecoveryCounts {
  const counts: ProxyContinuationRecoveryCounts = {
    attempts: 0,
    recovered: 0,
    exhausted: 0,
  };

  for (const record of records) {
    const recoveryAttempts = record.guard_actions.filter((action) => action.action === "continuation_recovery").length;
    if (recoveryAttempts === 0) {
      continue;
    }

    counts.attempts += recoveryAttempts;
    if (record.guard_actions.some((action) => action.action === "return_status_502")) {
      counts.exhausted += 1;
    } else if (record.status !== null && record.status < 400 && record.error === null) {
      counts.recovered += 1;
    }
  }

  return counts;
}

function formatProxyContinuationRecoveryCounts(counts: ProxyContinuationRecoveryCounts): string[] {
  if (counts.attempts === 0) {
    return [];
  }
  return [
    `recovery=${textYellow(String(counts.attempts))}`,
    `recovered=${textGreen(String(counts.recovered))}`,
    `exhausted=${formatProxyStatusCount(counts.exhausted, textRed)}`,
  ];
}

function formatProxyStatusCount(value: number, color: (text: string) => string): string {
  return value === 0 ? textDim("0") : color(String(value));
}

function totalProxyStatusCounts(counts: ProxyStatusCounts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function totalProxyReasoningTokenCounts(counts: ProxyReasoningTokenCounts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function maxProxyReasoningToken(counts: ProxyReasoningTokenCounts): number | null {
  const values = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([reasoningTokens]) => Number(reasoningTokens))
    .filter((reasoningTokens) => Number.isInteger(reasoningTokens));
  return values.length === 0 ? null : Math.max(...values);
}

function formatProxyReasoningTokenValue(reasoningTokens: number | null): string {
  if (reasoningTokens === null) {
    return textDim("-");
  }
  if (reasoningTokens === 0) {
    return textYellow(String(reasoningTokens));
  }
  if (REASONING_EQUALS.includes(reasoningTokens)) {
    return textRed(String(reasoningTokens));
  }
  return textGreen(String(reasoningTokens));
}

function formatExactProxyStatusCounts(counts: ProxyStatusCounts): string[] {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([status, count]) => `${status}=${formatProxyStatusCount(count, proxyStatusCountColor(Number(status)))}`);
}

function formatGroupedProxyReasoningTokenCounts(counts: ProxyReasoningTokenCounts): string[] {
  const grouped = REASONING_SUMMARY_VALUES.map((value) => [String(value), counts[String(value)] ?? 0] as const);
  const otherCount = totalOtherProxyReasoningTokenCounts(counts);
  return [
    ...grouped
      .filter(([, count]) => count > 0)
      .map(([reasoningTokens, count]) => {
        const color = reasoningTokens === "0" ? textYellow : textRed;
        return `${reasoningTokens}=${color(String(count))}`;
      }),
    ...(otherCount > 0 ? [`other=${textGreen(String(otherCount))}`] : []),
  ];
}

function totalOtherProxyReasoningTokenCounts(counts: ProxyReasoningTokenCounts): number {
  const fixedKeys = new Set(REASONING_SUMMARY_VALUES.map(String));
  return Object.entries(counts)
    .filter(([reasoningTokens]) => !fixedKeys.has(reasoningTokens))
    .reduce((sum, [, count]) => sum + count, 0);
}

function proxyStatusCountColor(status: number): (text: string) => string {
  if (status >= 500) {
    return textRed;
  }
  if (status >= 400) {
    return textYellow;
  }
  if (status >= 300) {
    return textYellow;
  }
  return textGreen;
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

export function proxyRequestTableColumns(view: ProxyView): TableColumn[] {
  if (view === "tokens") return PROXY_TOKEN_TABLE_COLUMNS;
  if (view === "cost") return PROXY_COST_TABLE_COLUMNS;
  return PROXY_OVERVIEW_TABLE_COLUMNS;
}

function renderProxyRequestTable(rows: TableRow[], view: ProxyView): string[] {
  const columns = process.stdout.columns;
  const maxWidth = columns ? Math.max(1, columns - PROXY_REQUEST_TABLE_INDENT.length) : undefined;
  return renderTable(proxyRequestTableColumns(view), rows, {
    gap: 1,
    maxWidth,
    boldHeader: false,
  }).map((line) => `${PROXY_REQUEST_TABLE_INDENT}${line}`);
}

function proxyActiveRowCount(metrics: ProxyMetrics): number {
  return metrics.active_requests.length === 0
    ? 1
    : Math.min(metrics.active_requests.length, PROXY_RECENT_RENDER_COUNT);
}

function proxyActiveSectionLineCount(metrics: ProxyMetrics): number {
  return 1 + 1 + proxyActiveRowCount(metrics);
}

function proxyPathLineCount(options: ProxyOptions): number {
  return options.watch ? 0 : 5;
}

function resolveProxyHistoryRenderCount(metrics: ProxyMetrics, options: ProxyOptions): number {
  if (options.historyCount !== undefined) {
    return options.historyCount;
  }
  if (!process.stdout.isTTY) {
    return PROXY_RECENT_RENDER_COUNT;
  }
  const terminalRows = process.stdout.rows;
  if (!Number.isInteger(terminalRows) || terminalRows <= 0) {
    return PROXY_RECENT_RENDER_COUNT;
  }
  const fixedLines = 1
    + proxyPathLineCount(options)
    + 3
    + proxyActiveSectionLineCount(metrics)
    + 1
    + 1
    + 1;
  return Math.max(0, terminalRows - fixedLines);
}

function formatProxyActiveRows(metrics: ProxyMetrics, now: Date, view: ProxyView, priceCache?: ModelPriceCache, count = PROXY_RECENT_RENDER_COUNT): string[] {
  if (metrics.active_requests.length === 0) {
    return [
      ...renderProxyRequestTable([], view),
      `  ${textDim("no active requests")}`,
    ];
  }
  return renderProxyRequestTable(metrics.active_requests.slice(0, count).map((record) => formatProxyRequest(record, now.getTime(), priceCache)), view);
}

function formatProxyHistoryRows(records: ProxyRequestRecord[], count: number, view: ProxyView, priceCache?: ModelPriceCache): string[] {
  if (count === 0) {
    return renderProxyRequestTable([], view);
  }
  if (records.length === 0) {
    return [
      ...renderProxyRequestTable([], view),
      `  ${textDim("no historical requests")}`,
    ];
  }
  const nowMs = Date.now();
  return renderProxyRequestTable(records.slice(0, count).map((record) => formatProxyRequest(record, nowMs, priceCache)), view);
}

async function readProxyRequestTail(stateRoot: string, count: number): Promise<ProxyRequestRecord[]> {
  if (count <= 0) {
    return [];
  }
  let file;
  try {
    file = await open(proxyRequestsPath(stateRoot), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  try {
    const stat = await file.stat();
    let position = stat.size;
    let carry = "";
    const records: ProxyRequestRecord[] = [];
    while (position > 0 && records.length < count) {
      const length = Math.min(PROXY_JSONL_TAIL_BLOCK_BYTES, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      await file.read(buffer, 0, length, position);
      const lines = `${buffer.toString("utf8")}${carry}`.split("\n");
      carry = position > 0 ? lines.shift() ?? "" : "";
      for (let index = lines.length - 1; index >= 0 && records.length < count; index -= 1) {
        const line = lines[index].trim();
        if (!line) {
          continue;
        }
        records.push(normalizeProxyHistoryRecord(parseJsonObject(line)));
      }
    }
    if (position === 0 && carry.trim() && records.length < count) {
      records.push(normalizeProxyHistoryRecord(parseJsonObject(carry.trim())));
    }
    return records;
  } finally {
    await file.close();
  }
}

async function resolveProxyHistoryRecords(stateRoot: string, metrics: ProxyMetrics, count: number, explicitHistory: boolean): Promise<ProxyRequestRecord[]> {
  if (count <= 0) {
    return [];
  }
  if (explicitHistory && count > metrics.recent_requests.length) {
    return readProxyRequestTail(stateRoot, count);
  }
  return metrics.recent_requests.slice(0, count);
}

async function renderProxyStatusLines(options: ProxyOptions): Promise<string[]> {
  const runtime = await ensureProxyRunning(options);
  const state = runtime?.state ?? await readProxyState(options.stateRoot);
  const profiles = await readProfiles();
  const priceCache = options.view === "cost" ? await readModelPriceCache({ overrides: profiles.pricing?.overrides }) : undefined;
  const currentProfileOrder = buildProfileOrder(profiles);
  const profileOrder = currentProfileOrder.length ? currentProfileOrder : state?.profile_order ?? [];
  const metrics = state?.metrics ?? createProxyMetrics();
  const historyCount = resolveProxyHistoryRenderCount(metrics, options);
  const historyRecords = await resolveProxyHistoryRecords(options.stateRoot, metrics, historyCount, options.historyCount !== undefined);
  return buildProxyStatusLines(new Date(), state, profileOrder, runtime, options, historyRecords, priceCache);
}

export function buildProxyStatusLines(
  now: Date,
  state: ProxyState | null,
  profileOrder: string[],
  runtime: ProxyRuntimeState | null,
  options: ProxyOptions,
  historyRecords?: ProxyRequestRecord[],
  priceCache?: ModelPriceCache,
): string[] {
  const metrics = state?.metrics
    ? { ...state.metrics, ...proxyMetricsFromRecentRequests(state.metrics.recent_requests) }
    : createProxyMetrics();
  const historyCount = resolveProxyHistoryRenderCount(metrics, options);
  const resolvedHistoryRecords = historyRecords ?? metrics.recent_requests.slice(0, historyCount);
  const view = options.view ?? "overview";
  return [
    fitTerminalLine(formatProxyStatusLine(now, state, runtime)),
    ...formatProxyPathsLines(options).map((line) => fitTerminalLine(line)),
    fitTerminalLine(formatProxyRequestsSummary(metrics, profileOrder)),
    fitTerminalLine(formatProxyReasoningSummary(metrics)),
    fitTerminalLine(formatProxyLatencySummary(metrics)),
    textBold("active"),
    ...formatProxyActiveRows(metrics, now, view, priceCache),
    textBold("history"),
    ...formatProxyHistoryRows(resolvedHistoryRecords, historyCount, view, priceCache),
    fitTerminalLine(textDim(options.watch
      ? `view: ${view}  keys: v view  q/Ctrl-C exit`
      : "commands: ccs proxy [--view overview|tokens|cost] | watch | mode [intercept|recovery] | install | restore | stop | serve")),
  ];
}

async function runProxyStatusOnce(options: ProxyOptions): Promise<void> {
  console.log((await renderProxyStatusLines({ ...options, once: true })).join("\n"));
}

async function runProxyStatusWatch(options: ProxyOptions): Promise<void> {
  let view = options.view ?? "overview";
  await runLiveView(
    () => renderProxyStatusLines({ ...options, watch: true, view }),
    {
      intervalMs: PROXY_STATUS_REFRESH_SECONDS * 1000,
      onKey: (key, controls) => {
        const result = proxyWatchKeyAction(key, view);
        view = result.view;
        if (result.action === "stop") {
          controls.stop();
        } else if (result.action === "render") {
          controls.render();
        }
      },
    },
  );
}

export function proxyWatchKeyAction(key: string, view: ProxyView): { view: ProxyView; action: "none" | "render" | "stop" } {
  if (key === "q") return { view, action: "stop" };
  if (key !== "v") return { view, action: "none" };
  return {
    view: view === "overview" ? "tokens" : view === "tokens" ? "cost" : "overview",
    action: "render",
  };
}

export async function shutdownProxyRuntime(options: ProxyOptions): Promise<string> {
  const state = await readProxyState(options.stateRoot);
  const health = state ? await readProxyHealth(state) : { healthy: false, pid: null, version: null, protocol: null, mode: null };
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

type ProxyModeChangeResult = {
  previousMode: ProxyMode;
  mode: ProxyMode;
  runtime: ProxyRuntimeState | null;
};

export async function setProxyMode(options: ProxyOptions, mode: ProxyMode): Promise<ProxyModeChangeResult> {
  const state = await readProxyState(options.stateRoot);
  if (!state) {
    throw new Error(`proxy state file was not found: ${statePath(options.stateRoot)}`);
  }
  const previousMode = state.mode;
  await writeProxyState(options.stateRoot, { ...state, mode });
  const health = await readProxyHealth({ ...state, mode });
  if (health.healthy && health.protocol !== PROXY_HEALTH_PROTOCOL) {
    await shutdownProxyRuntime(options);
  }
  const runtime = await ensureProxyRunning(options);
  return { previousMode, mode, runtime };
}

export async function stopProxy(options: ProxyOptions): Promise<ProxyModeChangeResult> {
  return setProxyMode(options, PROXY_MODE_PASSTHROUGH);
}

export async function serveProxy(options: ProxyOptions): Promise<void> {
  const state = await readProxyState(options.stateRoot);
  if (!state) {
    throw new Error(`proxy state file was not found: ${statePath(options.stateRoot)}`);
  }
  await resetProxyActiveRequestsOnStart(state, options.stateRoot);

  const server = createServer((req, res) => {
    void (async () => {
      let method = req.method || "GET";
      let requestPath = "/";
      try {
        const url = new URL(req.url || "/", "http://localhost");
        method = req.method || "GET";
        requestPath = url.pathname;
        const route = classifyProxyRoute(method, url.pathname);
        if (route.kind === "control") {
          const currentState = await readProxyState(options.stateRoot) ?? state;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            status: "ok",
            pid: process.pid,
            version: packageVersion(),
            protocol: PROXY_HEALTH_PROTOCOL,
            mode: currentState.mode,
          }));
          return;
        }
        if (route.kind === "invalid") {
          await logProxyUnsupportedPath(options.stateRoot, method, url.pathname);
          const payload = JSON.stringify({ error: { code: "unsupported_proxy_path", message: "unsupported proxy path" } });
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(payload);
          return;
        }
        const requestState = await readProxyState(options.stateRoot) ?? state;
        const mode = requestState.mode;
        const downstreamAbort = new AbortController();
        let responseFinished = false;
        res.once("finish", () => {
          responseFinished = true;
        });
        res.once("close", () => {
          if (!responseFinished) {
            downstreamAbort.abort();
          }
        });
        const requestStartedAt = new Date();
        const requestStartedAtMs = performance.now();
        const activeRecord: ProxyRequestRecord = {
          schema_version: PROXY_REQUEST_SCHEMA_VERSION,
          id: randomUUID(),
          started_at: requestStartedAt.toISOString(),
          completed_at: null,
          mode,
          method,
          path: url.pathname,
          status: null,
          upstream_status: null,
          client_status: null,
          final_action: "pending",
          failure_summary: null,
          upstream: null,
          attempts: 0,
          latency_ms: 0,
          client_ttfb_ms: null,
          upstream_wait_ms: null,
          time_to_first_chunk_ms: null,
          stream_duration_ms: null,
          request_bytes: 0,
          response_bytes: 0,
          session: null,
          client_turn_id: null,
          client_request_attempt: 1,
          request_kind: REQUEST_KIND_NORMAL,
          request_model: null,
          request_reasoning_effort: null,
          request_body_sha256: null,
          upstream_model: null,
          upstream_model_source: null,
          stream_model: null,
          final_response_model: null,
          system_fingerprint: null,
          service_tier: null,
          input_tokens: null,
          cached_input_tokens: null,
          reasoning_tokens: null,
          reasoning_tokens_source: null,
          output_tokens: null,
          total_tokens: null,
          usage_attempts: [],
          reasoning_text_observed: false,
          reasoning_text_source: null,
          has_commentary: false,
          has_final_answer: false,
          final_answer_only: false,
          has_tool_call: false,
          has_reasoning_item: false,
          guard_actions: [],
          retry_summary: createEmptyProxyRetrySummary(),
          error: null,
        };
        let clientTtfbMs: number | null = null;
        const recordClientTtfb = (): void => {
          if (clientTtfbMs !== null) {
            return;
          }
          clientTtfbMs = Math.max(0, performance.now() - requestStartedAtMs);
          activeRecord.client_ttfb_ms = clientTtfbMs;
          void updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord).catch(() => undefined);
        };
        await startProxyRequestMetric(state, options.stateRoot, activeRecord);

        let status: number | null = null;
        let upstreamStatus: number | null = null;
        let upstream: string | null = null;
        let attempts = 0;
        let responseBytes = 0;
        let upstreamModel: string | null = null;
        let upstreamModelSource: string | null = null;
        let streamModel: string | null = null;
        let finalResponseModel: string | null = null;
        let systemFingerprint: string | null = null;
        let serviceTier: string | null = null;
        let inputTokens: number | null = null;
        let cachedInputTokens: number | null = null;
        let reasoningTokens: number | null = null;
        let reasoningTokensSource: string | null = null;
        let outputTokens: number | null = null;
        let totalTokens: number | null = null;
        let reasoningTextObserved = false;
        let reasoningTextSource: string | null = null;
        let hasCommentary = false;
        let hasFinalAnswer = false;
        let finalAnswerOnly = false;
        let hasToolCall = false;
        let hasReasoningItem = false;
        let failureSummary: ProxyFailureSummary | null = null;
        let errorText: string | null = null;
        const attemptRecords: ProxyAttemptRecord[] = [];
        let requestHeaders: Record<string, string> = {};
        let requestServiceTier: string | null = null;
        const requestStartConfig = (await readTextIfExists(options.codexConfigPath)) ?? "";
        const configServiceTier = readTopLevelTomlString(requestStartConfig, "service_tier");
        const endpointClass = route.endpointClass;
        try {
          const profiles = await readProfiles();
          const upstreamProfile = resolveProxyUpstream(profiles);
          const body = await readBody(req);
          const requestJson = parseJsonBody(body);
          requestServiceTier = jsonStringAt(requestJson, ["service_tier"]);
          requestHeaders = sanitizeWhitelistedRequestHeaders(req.headers);
          activeRecord.request_bytes = body.length;
          activeRecord.request_body_sha256 = hashRequestBody(body);
          activeRecord.session = extractSessionShortId(body);
          activeRecord.client_turn_id = extractCodexTurnId(req.headers);
          activeRecord.request_kind = detectProxyRequestKind(req.headers, requestJson);
          activeRecord.request_model = extractRequestModelFromJson(requestJson, endpointClass);
          activeRecord.request_reasoning_effort = extractRequestReasoningEffortFromJson(requestJson);
          await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
          const passthroughCallbacks: ProxyForwardCallbacks = {
            signal: downstreamAbort.signal,
            onAttempt: async (attemptCount, upstreamName) => {
              activeRecord.upstream = upstreamName;
              activeRecord.attempts = attemptCount;
              await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
            },
            onResponseStart: async (responseStatus, upstreamName) => {
              activeRecord.status = responseStatus;
              activeRecord.upstream_status = responseStatus;
              activeRecord.upstream = upstreamName;
              await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
            },
          };
          const guardedCallbacks: ProxyForwardCallbacks = {
            ...passthroughCallbacks,
            onAttempt: async (attemptCount, upstreamName) => {
              activeRecord.upstream = upstreamName;
              activeRecord.attempts = attemptCount;
              if (attemptCount > 1) {
                activeRecord.status = null;
                activeRecord.upstream_status = null;
                activeRecord.reasoning_tokens = null;
                activeRecord.reasoning_tokens_source = null;
                activeRecord.input_tokens = null;
                activeRecord.cached_input_tokens = null;
                activeRecord.output_tokens = null;
                activeRecord.total_tokens = null;
                activeRecord.reasoning_text_observed = false;
                activeRecord.reasoning_text_source = null;
                activeRecord.upstream_model = null;
                activeRecord.upstream_model_source = null;
                activeRecord.stream_model = null;
                activeRecord.final_response_model = null;
                activeRecord.system_fingerprint = null;
                activeRecord.service_tier = null;
                activeRecord.has_commentary = false;
                activeRecord.has_final_answer = false;
                activeRecord.final_answer_only = false;
                activeRecord.has_tool_call = false;
                activeRecord.has_reasoning_item = false;
                activeRecord.error = null;
              }
              await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
            },
            onUpstreamModel: async (extraction) => {
              if (activeRecord.upstream_model === extraction.model && activeRecord.upstream_model_source === extraction.source) {
                return;
              }
              activeRecord.upstream_model = extraction.model;
              activeRecord.upstream_model_source = extraction.source;
              await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
            },
            onReasoningMetadata: async (metadata) => {
              if (
                activeRecord.reasoning_tokens === metadata.reasoningTokens
                && activeRecord.reasoning_tokens_source === metadata.reasoningTokensSource
                && activeRecord.reasoning_text_observed === metadata.reasoningTextObserved
                && activeRecord.reasoning_text_source === metadata.reasoningTextSource
              ) {
                return;
              }
              activeRecord.reasoning_tokens = metadata.reasoningTokens;
              activeRecord.reasoning_tokens_source = metadata.reasoningTokensSource;
              activeRecord.reasoning_text_observed = metadata.reasoningTextObserved;
              activeRecord.reasoning_text_source = metadata.reasoningTextSource;
              await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
            },
            onGuardAction: async (action) => {
              activeRecord.reasoning_tokens = action.reasoning_tokens;
              activeRecord.reasoning_tokens_source = action.reasoning_tokens === null ? null : activeRecord.reasoning_tokens_source;
              activeRecord.guard_actions.push(action);
              activeRecord.error = action.error;
              await logProxyGuardAction(options.stateRoot, activeRecord, action);
              await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
            },
          };
          const outcome = mode === PROXY_MODE_PASSTHROUGH
            ? await proxyThroughActiveUpstreamPassthrough(req, upstreamProfile, body, attemptRecords, endpointClass, passthroughCallbacks)
            : await proxyThroughActiveUpstreamWithStats(
              req,
              upstreamProfile,
              body,
              endpointClass,
              activeRecord.request_kind,
              requestJson,
              attemptRecords,
              mode === PROXY_MODE_INTERCEPT ? PROXY_MODE_INTERCEPT : PROXY_MODE_RECOVERY,
              guardedCallbacks,
            );
          status = outcome.response.status;
          upstreamStatus = outcome.upstreamStatus;
          upstream = outcome.upstream;
          attempts = outcome.attempts;
          upstreamModel = outcome.upstreamModel;
          upstreamModelSource = outcome.upstreamModelSource;
          streamModel = outcome.streamModel;
          finalResponseModel = outcome.finalResponseModel;
          systemFingerprint = outcome.systemFingerprint;
          serviceTier = outcome.serviceTier;
          inputTokens = outcome.usage.inputTokens;
          cachedInputTokens = outcome.usage.cachedInputTokens;
          reasoningTokens = outcome.reasoningTokens;
          reasoningTokensSource = outcome.reasoningTokensSource;
          outputTokens = outcome.usage.outputTokens;
          totalTokens = outcome.usage.totalTokens;
          reasoningTextObserved = outcome.reasoningTextObserved;
          reasoningTextSource = outcome.reasoningTextSource;
          hasCommentary = outcome.responseShape.hasCommentary;
          hasFinalAnswer = outcome.responseShape.hasFinalAnswer;
          finalAnswerOnly = isProxyFinalAnswerOnly(outcome.responseShape);
          hasToolCall = outcome.responseShape.hasToolCall;
          hasReasoningItem = outcome.responseShape.hasReasoningItem;
          failureSummary = outcome.failureSummary;
          errorText = outcome.error;
          activeRecord.status = status;
          activeRecord.upstream_status = upstreamStatus;
          activeRecord.upstream = upstream;
          activeRecord.attempts = attempts;
          activeRecord.upstream_model = upstreamModel;
          activeRecord.upstream_model_source = upstreamModelSource;
          activeRecord.stream_model = streamModel;
          activeRecord.final_response_model = finalResponseModel;
          activeRecord.system_fingerprint = systemFingerprint;
          activeRecord.service_tier = serviceTier;
          activeRecord.input_tokens = inputTokens;
          activeRecord.cached_input_tokens = cachedInputTokens;
          activeRecord.reasoning_tokens = reasoningTokens;
          activeRecord.reasoning_tokens_source = reasoningTokensSource;
          activeRecord.output_tokens = outputTokens;
          activeRecord.total_tokens = totalTokens;
          activeRecord.usage_attempts = projectProxyUsageAttempts(
            attemptRecords,
            activeRecord.request_model,
            requestServiceTier,
            configServiceTier,
          );
          activeRecord.reasoning_text_observed = reasoningTextObserved;
          activeRecord.reasoning_text_source = reasoningTextSource;
          activeRecord.has_commentary = hasCommentary;
          activeRecord.has_final_answer = hasFinalAnswer;
          activeRecord.final_answer_only = finalAnswerOnly;
          activeRecord.has_tool_call = hasToolCall;
          activeRecord.has_reasoning_item = hasReasoningItem;
          activeRecord.failure_summary = failureSummary;
          activeRecord.error = errorText;
          await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
          const streamModelObserver: ProxyWriteModelObserver = {
            model: upstreamModel,
            source: upstreamModelSource,
            update: async (extraction) => {
              activeRecord.upstream_model = extraction.model;
              activeRecord.upstream_model_source = extraction.source;
              await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
            },
          };
          responseBytes = await writeResponse(res, outcome.response, endpointClass, streamModelObserver, recordClientTtfb);
          if (outcome.deferredInspection) {
            const inspection = await outcome.deferredInspection;
            const deferred = createProxyOutcome({
              response: outcome.response,
              upstream: outcome.upstream,
              upstreamStatus: outcome.upstreamStatus,
              attempts: outcome.attempts,
              attemptRecords,
              inspection,
            });
            upstreamModel = deferred.upstreamModel;
            upstreamModelSource = deferred.upstreamModelSource;
            streamModel = deferred.streamModel;
            finalResponseModel = deferred.finalResponseModel;
            systemFingerprint = deferred.systemFingerprint;
            serviceTier = deferred.serviceTier;
            inputTokens = deferred.usage.inputTokens;
            cachedInputTokens = deferred.usage.cachedInputTokens;
            outputTokens = deferred.usage.outputTokens;
            totalTokens = deferred.usage.totalTokens;
            reasoningTokens = deferred.reasoningTokens;
            reasoningTokensSource = deferred.reasoningTokensSource;
            reasoningTextObserved = deferred.reasoningTextObserved;
            reasoningTextSource = deferred.reasoningTextSource;
            hasCommentary = deferred.responseShape.hasCommentary;
            hasFinalAnswer = deferred.responseShape.hasFinalAnswer;
            finalAnswerOnly = isProxyFinalAnswerOnly(deferred.responseShape);
            hasToolCall = deferred.responseShape.hasToolCall;
            hasReasoningItem = deferred.responseShape.hasReasoningItem;
          }
          upstreamModel = streamModelObserver.model ?? upstreamModel;
          upstreamModelSource = streamModelObserver.source ?? upstreamModelSource;
          streamModel = upstreamModelSource?.startsWith("sse.") ? upstreamModel : streamModel;
          finalResponseModel = upstreamModel ?? finalResponseModel;
        } catch (error) {
          if (error instanceof ProxyResponseWriteError) {
            status = error.status;
            responseBytes = error.responseBytes;
            errorText = error.message;
          } else {
            status = status ?? 500;
            errorText = error instanceof Error ? error.message : String(error);
          }
          failureSummary = proxyFailureSummary(
            status === 499 ? "client_error" : "gateway_error",
            status === 499 ? "client_aborted" : "gateway_error",
            errorText,
          );
          completeLastPendingProxyAttemptRecord(
            attemptRecords,
            status === 499 ? "client_aborted" : "gateway_error",
            {
              failureSummary,
            },
          );
          upstream = activeRecord.upstream;
          attempts = activeRecord.attempts;
          if (status !== 499) {
            if (writeProxyJsonErrorResponse(res, status ?? 500, errorText, recordClientTtfb)) {
              responseBytes = Buffer.byteLength(JSON.stringify({ error: { message: errorText } }));
            }
          }
          upstreamStatus = activeRecord.upstream_status;
          upstreamModel = activeRecord.upstream_model;
          upstreamModelSource = activeRecord.upstream_model_source;
          streamModel = activeRecord.stream_model;
          finalResponseModel = activeRecord.final_response_model;
          systemFingerprint = activeRecord.system_fingerprint;
          serviceTier = activeRecord.service_tier;
          inputTokens = activeRecord.input_tokens;
          cachedInputTokens = activeRecord.cached_input_tokens;
          reasoningTokens = activeRecord.reasoning_tokens;
          reasoningTokensSource = activeRecord.reasoning_tokens_source;
          outputTokens = activeRecord.output_tokens;
          totalTokens = activeRecord.total_tokens;
          reasoningTextObserved = activeRecord.reasoning_text_observed;
          reasoningTextSource = activeRecord.reasoning_text_source;
          hasCommentary = activeRecord.has_commentary;
          hasFinalAnswer = activeRecord.has_final_answer;
          finalAnswerOnly = activeRecord.final_answer_only;
          hasToolCall = activeRecord.has_tool_call;
          hasReasoningItem = activeRecord.has_reasoning_item;
          activeRecord.status = status;
          activeRecord.client_status = status;
          activeRecord.response_bytes = responseBytes;
          activeRecord.failure_summary = failureSummary;
          activeRecord.error = errorText;
          await logProxyRequestError(options.stateRoot, activeRecord, status, errorText);
          await updateProxyActiveRequestMetric(state, options.stateRoot, activeRecord);
        }

        const latencyMs = Math.max(0, performance.now() - requestStartedAtMs);
        const lastAttempt = lastProxyAttemptRecord(attemptRecords);
        const attemptTiming = requestTimingFromAttempt(lastAttempt);
        const finalAction = requestFinalAction({ status, error: errorText, failureSummary });
        const retrySummary = createRetrySummary(attemptRecords);
        await completeProxyRequestMetric(state, options.stateRoot, {
          ...activeRecord,
          completed_at: new Date().toISOString(),
          status,
          upstream_status: upstreamStatus,
          client_status: status,
          final_action: finalAction,
          failure_summary: failureSummary,
          upstream,
          attempts,
          latency_ms: latencyMs,
          client_ttfb_ms: clientTtfbMs,
          upstream_wait_ms: attemptTiming.upstream_wait_ms,
          time_to_first_chunk_ms: attemptTiming.time_to_first_chunk_ms,
          stream_duration_ms: attemptTiming.stream_duration_ms,
          response_bytes: responseBytes,
          request_model: activeRecord.request_model,
          request_reasoning_effort: activeRecord.request_reasoning_effort,
          request_body_sha256: activeRecord.request_body_sha256,
          upstream_model: upstreamModel,
          upstream_model_source: upstreamModelSource,
          stream_model: streamModel,
          final_response_model: finalResponseModel,
          system_fingerprint: systemFingerprint,
          service_tier: serviceTier,
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          reasoning_tokens: reasoningTokens,
          reasoning_tokens_source: reasoningTokensSource,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
          usage_attempts: projectProxyUsageAttempts(
            attemptRecords,
            activeRecord.request_model,
            requestServiceTier,
            configServiceTier,
          ),
          reasoning_text_observed: reasoningTextObserved,
          reasoning_text_source: reasoningTextSource,
          has_commentary: hasCommentary,
          has_final_answer: hasFinalAnswer,
          final_answer_only: finalAnswerOnly,
          has_tool_call: hasToolCall,
          has_reasoning_item: hasReasoningItem,
          retry_summary: retrySummary,
          error: errorText,
          request_headers: requestHeaders,
          attempt_records: attemptRecords,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendProxyJsonLine(proxyLogPath(options.stateRoot), {
          event: "ccs_proxy_request_error",
          method,
          path: requestPath,
          status: 500,
          error: message,
        });
        writeProxyJsonErrorResponse(res, 500, message);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.listen_port, state.listen_host, () => resolve());
  });

  await writeTextFile(pidPath(options.stateRoot), `${process.pid}\n`, 0o600);
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
    "  ccs proxy                                # print proxy status and active upstream once",
    "  ccs proxy --history N                    # print proxy status with N history rows",
    "  ccs proxy --view overview|tokens|cost    # select the initial request-table view",
    "  ccs proxy --once                         # print proxy status and active upstream once",
    "  ccs proxy --once --history N             # print proxy status with N history rows",
    "  ccs proxy watch                          # watch proxy status and active upstream",
    "  ccs proxy watch --history N              # watch proxy status with N history rows",
    "  ccs proxy watch --view overview|tokens|cost # select the initial watch view; v cycles; q or Ctrl-C exits",
    "  ccs proxy mode                           # print active proxy intervention mode",
    "  ccs proxy mode recovery                  # enable continuation recovery mode",
    "  ccs proxy mode intercept                 # enable guard intercept mode",
    "  ccs proxy install                        # back up config, install routing, and start background proxy",
    "  ccs proxy restore                        # restore config from the saved backup",
    "  ccs proxy stop                           # stop intervention and directly forward through the proxy",
    "  ccs proxy serve                          # run the proxy server in the foreground for debugging",
  ];
}

function parseProxyHistoryCount(rawCount: string | undefined): number {
  if (!rawCount) {
    throw new Error("ccs proxy --history requires a positive integer");
  }
  if (!/^[1-9]\d*$/.test(rawCount)) {
    throw new Error("ccs proxy --history requires a positive integer");
  }
  return Number(rawCount);
}

function parseProxyView(value: string | undefined): ProxyView {
  if (value === "overview" || value === "tokens" || value === "cost") return value;
  throw new Error("ccs proxy --view requires overview, tokens, or cost");
}

export function parseProxyStatusArgs(args: string[], commandName: string): { historyCount?: number; view?: ProxyView } {
  let historyCount: number | undefined;
  let view: ProxyView | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (flag === "--history" && historyCount === undefined) {
      historyCount = parseProxyHistoryCount(args[index + 1]);
    } else if (flag === "--view" && view === undefined) {
      view = parseProxyView(args[index + 1]);
    } else {
      throw new Error(`unknown argument for ${commandName}: ${flag}`);
    }
  }
  return { historyCount, view };
}

function rejectProxyCommandArgs(args: string[], commandName: string): void {
  if (args.length > 0) {
    throw new Error(`unknown argument for ${commandName}: ${args[0]}`);
  }
}

function parseProxyUserMode(value: string | undefined): Exclude<ProxyMode, "passthrough"> {
  if (value === PROXY_MODE_INTERCEPT) {
    return PROXY_MODE_INTERCEPT;
  }
  if (value === PROXY_MODE_RECOVERY) {
    return PROXY_MODE_RECOVERY;
  }
  throw new Error("ccs proxy mode requires intercept or recovery");
}

function formatProxyModeChange(result: ProxyModeChangeResult): string {
  return result.previousMode === result.mode
    ? textGreen(result.mode)
    : `${textYellow(result.previousMode)} -> ${textGreen(result.mode)}`;
}

function printProxyModeRuntime(runtime: ProxyRuntimeState | null): void {
  printKeyValue("runtime:", runtime?.started ? textGreen("started") : runtime?.healthy ? textGreen("healthy") : textDim("none"), 8);
  printKeyValue("pid:", runtime?.pid === null || runtime?.pid === undefined ? textDim("none") : textGreen(String(runtime.pid)), 8);
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
  if (command === "--history" || command === "--view") {
    const parsed = parseProxyStatusArgs(args, "ccs proxy");
    await runProxyStatusOnce({ ...options, ...parsed });
    return;
  }
  if (command === "--once") {
    const parsed = parseProxyStatusArgs(rest, "ccs proxy --once");
    await runProxyStatusOnce({ ...options, ...parsed });
    return;
  }
  if (command === "watch") {
    const parsed = parseProxyStatusArgs(rest, "ccs proxy watch");
    await runProxyStatusWatch({ ...options, ...parsed });
    return;
  }
  if (command === "mode") {
    if (rest.length === 0) {
      const state = await readProxyState(options.stateRoot);
      printKeyValue("mode:", state ? colorName(state.mode) : textDim("missing"), 5);
      return;
    }
    rejectRemovedYesFlags(rest, "ccs proxy mode");
    const mode = parseProxyUserMode(rest[0]);
    rejectProxyCommandArgs(rest.slice(1), `ccs proxy mode ${mode}`);
    const state = await readProxyState(options.stateRoot);
    if (!state) {
      throw new Error(`proxy state file was not found: ${statePath(options.stateRoot)}`);
    }
    printKeyValue("plan:", `proxy mode ${state.mode} -> ${mode}`, 5);
    printKeyValue("note:", "no changes are written unless you type yes", 5);
    if (!(await confirmApply())) {
      return;
    }
    const result = await setProxyMode(options, mode);
    printKeyValue("mode:", formatProxyModeChange(result), 5);
    printProxyModeRuntime(result.runtime);
    return;
  }
  if (command === "install") {
    rejectRemovedYesFlags(rest, "ccs proxy install");
    rejectProxyCommandArgs(rest, "ccs proxy install");
    const plan = await buildProxyInstallPlan(options);
    printKeyValue("config:", formatProxyFilePath(options.codexConfigPath), 8);
    printKeyValue("provider:", plan.state.provider_name, 8);
    printKeyValue("current:", colorUrl(plan.currentBaseUrl), 8);
    printKeyValue("local:", colorUrl(plan.targetBaseUrl), 8);
    printKeyValue("backup:", colorPath(formatProxyFilePath(plan.backupPath)), 8);
    printKeyValue("note:", "no changes are written unless you type yes", 5);
    if (!(await confirmApply())) {
      return;
    }
    const applied = await applyProxyInstallPlan(options, plan);
    const runtime = applied.runtime;
    printKeyValue("backup:", textBlue(formatProxyFilePath(applied.backupPath)), 8);
    printKeyValue("config:", textGreen(formatProxyFilePath(options.codexConfigPath)), 8);
    printKeyValue("state:", textGreen(formatProxyFilePath(applied.statePath)), 8);
    printKeyValue("proxy:", textGreen(applied.state.proxy_base_url), 8);
    printKeyValue("mode:", textGreen(applied.state.mode), 8);
    printKeyValue("runtime:", runtime?.started ? textGreen("started") : textGreen("healthy"), 8);
    printKeyValue("pid:", runtime?.pid === null || runtime?.pid === undefined ? textDim("none") : textGreen(String(runtime.pid)), 8);
    printKeyValue("server:", runtime?.version ? textGreen(runtime.version) : textDim("none"), 8);
    printKeyValue("protocol:", runtime?.protocol === null || runtime?.protocol === undefined ? textDim("none") : textGreen(String(runtime.protocol)), 9);
    printKeyValue("requests:", textBlue(formatProxyFilePath(proxyRequestsPath(options.stateRoot))), 9);
    printKeyValue("events:", textBlue(formatProxyFilePath(proxyLogPath(options.stateRoot))), 7);
    printKeyValue("runtime_log:", textBlue(formatProxyFilePath(proxyRuntimeLogPath(options.stateRoot))), 12);
    return;
  }
  if (command === "restore") {
    rejectRemovedYesFlags(rest, "ccs proxy restore");
    rejectProxyCommandArgs(rest, "ccs proxy restore");
    const plan = await buildProxyRestorePlan(options);
    printKeyValue("config:", formatProxyFilePath(options.codexConfigPath), 8);
    printKeyValue("provider:", plan.state.provider_name, 8);
    printKeyValue("current:", colorUrl(plan.currentBaseUrl), 8);
    printKeyValue("target:", colorUrl(plan.targetBaseUrl), 8);
    printKeyValue("profile:", colorName(plan.profileName), 8);
    printKeyValue("backup:", colorPath(formatProxyFilePath(plan.backupPath)), 8);
    printKeyValue("note:", "no changes are written unless you type yes", 5);
    if (!(await confirmApply())) {
      return;
    }
    const stopped = await applyProxyRestorePlan(options, plan);
    printKeyValue("backup:", textBlue(formatProxyFilePath(plan.backupPath)), 8);
    printKeyValue("config:", textGreen(formatProxyFilePath(options.codexConfigPath)), 8);
    printKeyValue("runtime:", stopped, 8);
    printKeyValue("state:", textGreen("removed"), 8);
    return;
  }
  if (command === "stop") {
    rejectRemovedYesFlags(rest, "ccs proxy stop");
    rejectProxyCommandArgs(rest, "ccs proxy stop");
    const state = await readProxyState(options.stateRoot);
    if (!state) {
      throw new Error(`proxy state file was not found: ${statePath(options.stateRoot)}`);
    }
    printKeyValue("plan:", `proxy mode ${state.mode} -> ${PROXY_MODE_PASSTHROUGH}`, 5);
    printKeyValue("note:", "no changes are written unless you type yes", 5);
    if (!(await confirmApply())) {
      return;
    }
    const result = await stopProxy(options);
    printKeyValue("mode:", formatProxyModeChange(result), 5);
    printProxyModeRuntime(result.runtime);
    return;
  }
  if (command === "serve") {
    rejectProxyCommandArgs(rest, "ccs proxy serve");
    await serveProxy(options);
    return;
  }
  throw new Error(`unknown argument for ccs proxy: ${command}`);
}
