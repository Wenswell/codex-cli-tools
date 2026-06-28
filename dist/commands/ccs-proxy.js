import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { setInterval } from "node:timers";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexConfigPath, profilesPath } from "../lib/paths.js";
import { readTextIfExists, writeTextFile, writeTextFileAtomic } from "../lib/fs.js";
import { colorCount, colorName, colorPath, colorUrl, printKeyValue } from "../lib/output.js";
import { textBlue, textBold, textDim, textGreen, textMagenta, textRed, textYellow, visibleLength } from "../lib/text.js";
import { readTomlBaseUrl, readTopLevelTomlString, updateTomlBaseUrl } from "../lib/toml.js";
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
const PROXY_RECENT_RENDER_COUNT = 5;
const PROXY_STATUS_RENDER_LINES = 8 + PROXY_RECENT_RENDER_COUNT;
const PROXY_RECENT_TIME_WIDTH = 8;
const PROXY_RECENT_METHOD_WIDTH = 6;
const PROXY_RECENT_PATH_WIDTH = 28;
const PROXY_RECENT_STATUS_WIDTH = 3;
const PROXY_RECENT_UPSTREAM_WIDTH = 12;
const PROXY_RECENT_LATENCY_WIDTH = 6;
const PROXY_RECENT_ATTEMPTS_WIDTH = 3;
const PROXY_START_TIMEOUT_MS = 5000;
const PROXY_HEALTH_TIMEOUT_MS = 500;
const PROXY_HEALTH_POLL_MS = 100;
const REASONING_POINTERS = [
    "/usage/output_tokens_details/reasoning_tokens",
    "/usage/completion_tokens_details/reasoning_tokens",
    "/response/usage/output_tokens_details/reasoning_tokens",
    "/response/usage/completion_tokens_details/reasoning_tokens",
];
function statePath(stateRoot) {
    return path.join(stateRoot, PROXY_STATE_FILE);
}
function pidPath(stateRoot) {
    return path.join(stateRoot, "proxy.pid");
}
function proxyBaseUrl(listenHost, listenPort) {
    return `http://${listenHost}:${listenPort}`;
}
async function readProfiles() {
    const text = await readTextIfExists(profilesPath());
    return text ? parseJsonObject(text) : {};
}
export async function readProxyState(stateRoot = process.env.CCS_PROXY_STATE_ROOT || `${process.env.HOME ?? ""}/.config/codex-tools`) {
    const text = await readTextIfExists(statePath(stateRoot));
    return text ? normalizeProxyState(parseJsonObject(text)) : null;
}
async function writeProxyState(stateRoot, state) {
    await mkdir(stateRoot, { recursive: true });
    await writeTextFileAtomic(statePath(stateRoot), stringifyJson(state), 0o600);
}
async function removeProxyState(stateRoot) {
    await rm(statePath(stateRoot), { force: true });
}
function proxyLogPath(stateRoot) {
    return path.join(stateRoot, "proxy.log");
}
function proxyStartLockPath(stateRoot) {
    return path.join(stateRoot, "proxy.start.lock");
}
function ccsBinPath() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/ccs.js");
}
function healthUrl(state) {
    return new URL(HEALTH_PATH, state.proxy_base_url).toString();
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
async function readProxyHealth(state, timeoutMs = PROXY_HEALTH_TIMEOUT_MS) {
    try {
        const response = await fetch(healthUrl(state), {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            return { healthy: false, pid: null };
        }
        const payload = await response.json().catch(() => null);
        return {
            healthy: payload?.status === "ok",
            pid: payload && Number.isInteger(payload.pid) ? Number(payload.pid) : null,
        };
    }
    catch {
        return { healthy: false, pid: null };
    }
}
async function isProxyHealthy(state, timeoutMs = PROXY_HEALTH_TIMEOUT_MS) {
    return (await readProxyHealth(state, timeoutMs)).healthy;
}
async function waitForProxyHealth(state, stateRoot) {
    const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await isProxyHealthy(state)) {
            return;
        }
        await sleep(PROXY_HEALTH_POLL_MS);
    }
    throw new Error(`proxy did not become healthy: ${healthUrl(state)}; log: ${proxyLogPath(stateRoot)}`);
}
async function waitForProxyStop(state) {
    const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (!(await isProxyHealthy(state))) {
            return;
        }
        await sleep(PROXY_HEALTH_POLL_MS);
    }
    throw new Error(`proxy did not stop: ${healthUrl(state)}`);
}
async function acquireProxyStartLock(stateRoot) {
    await mkdir(stateRoot, { recursive: true });
    const lockPath = proxyStartLockPath(stateRoot);
    const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
    while (true) {
        try {
            return fs.openSync(lockPath, "wx", 0o600);
        }
        catch (error) {
            if (error.code !== "EEXIST") {
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
function startProxyBackgroundProcess(options, state) {
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
    }
    finally {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
    }
}
async function releaseProxyStartLock(stateRoot, lockFd) {
    fs.closeSync(lockFd);
    await rm(proxyStartLockPath(stateRoot), { force: true });
}
async function readProxyPid(stateRoot) {
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
    }
    catch {
        return { pid, running: false };
    }
}
export async function ensureProxyRunning(options) {
    const initialState = await readProxyState(options.stateRoot);
    if (!initialState) {
        return null;
    }
    const logPath = proxyLogPath(options.stateRoot);
    const initialPid = await readProxyPid(options.stateRoot);
    const initialHealth = await readProxyHealth(initialState);
    if (initialHealth.healthy) {
        return {
            state: initialState,
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
    }
    finally {
        await releaseProxyStartLock(options.stateRoot, lockFd);
    }
}
function currentProviderName(content) {
    return readTopLevelTomlString(content, "model_provider") ?? "codex";
}
function currentProviderBaseUrl(content) {
    return readTomlBaseUrl(content) ?? "";
}
function buildProfileOrder(profiles) {
    const names = [
        ...(profiles.current ? [profiles.current] : []),
        ...(profiles.toggle ?? []),
        ...Object.keys(profiles.profiles ?? {}),
    ];
    return [...new Set(names.filter(Boolean))];
}
function buildProxyUpstreams(profiles) {
    const order = buildProfileOrder(profiles);
    return order
        .map((name) => ({
        name,
        baseURL: profiles.profiles?.[name]?.baseURL ?? "",
    }))
        .filter((upstream) => Boolean(upstream.baseURL));
}
function createProxyMetrics() {
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
function normalizeProxyMetrics(value) {
    const raw = value && typeof value === "object" ? value : {};
    const latency = raw.latency_ms && typeof raw.latency_ms === "object" ? raw.latency_ms : {};
    return {
        total_requests: Number.isInteger(raw.total_requests) ? Number(raw.total_requests) : 0,
        successful_requests: Number.isInteger(raw.successful_requests) ? Number(raw.successful_requests) : 0,
        failed_requests: Number.isInteger(raw.failed_requests) ? Number(raw.failed_requests) : 0,
        upstream_hit_counts: raw.upstream_hit_counts && typeof raw.upstream_hit_counts === "object" && !Array.isArray(raw.upstream_hit_counts)
            ? Object.fromEntries(Object.entries(raw.upstream_hit_counts)
                .filter(([, count]) => Number.isInteger(count))
                .map(([name, count]) => [name, Number(count)]))
            : {},
        latency_ms: {
            count: Number.isInteger(latency.count) ? Number(latency.count) : 0,
            sum: typeof latency.sum === "number" ? latency.sum : 0,
            min: typeof latency.min === "number" ? latency.min : null,
            max: typeof latency.max === "number" ? latency.max : null,
            samples: Array.isArray(latency.samples)
                ? latency.samples.filter((value) => typeof value === "number" && Number.isFinite(value))
                : [],
        },
        recent_requests: Array.isArray(raw.recent_requests)
            ? raw.recent_requests.filter((item) => Boolean(item) && typeof item === "object")
                .map((item) => {
                const request = item;
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
function normalizeProxyState(state) {
    if (!state) {
        return null;
    }
    return {
        ...state,
        profile_order: Array.isArray(state.profile_order) ? state.profile_order.filter((value) => typeof value === "string" && value.length > 0) : [],
        metrics: normalizeProxyMetrics(state.metrics),
    };
}
function ensureProxyMetrics(state) {
    return state.metrics ?? createProxyMetrics();
}
function updateProxyLatencyStats(latency, latencyMs) {
    latency.count += 1;
    latency.sum += latencyMs;
    latency.min = latency.min === null ? latencyMs : Math.min(latency.min, latencyMs);
    latency.max = latency.max === null ? latencyMs : Math.max(latency.max, latencyMs);
    latency.samples.push(latencyMs);
    if (latency.samples.length > PROXY_LATENCY_SAMPLE_LIMIT) {
        latency.samples.splice(0, latency.samples.length - PROXY_LATENCY_SAMPLE_LIMIT);
    }
}
function recordProxyRequestMetric(state, record) {
    const metrics = ensureProxyMetrics(state);
    metrics.total_requests += 1;
    if (record.status >= 500) {
        metrics.failed_requests += 1;
    }
    else {
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
function averageLatency(latency) {
    return latency.count > 0 ? latency.sum / latency.count : 0;
}
function percentileLatency(samples, percentile) {
    if (samples.length === 0) {
        return 0;
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
    return sorted[index];
}
function formatLatencyMs(value) {
    return `${Math.round(value)}ms`;
}
function formatFailureRate(successful, failed) {
    const total = successful + failed;
    const rate = total > 0 ? (failed / total) * 100 : 0;
    return `${rate.toFixed(1)}%`;
}
function formatProxyUpstreamHits(profileOrder, metrics) {
    const knownNames = [
        ...profileOrder,
        ...Object.keys(metrics.upstream_hit_counts).filter((name) => !profileOrder.includes(name)),
    ];
    if (knownNames.length === 0) {
        return `upstreams: ${textDim("none")}`;
    }
    return `upstreams: ${knownNames
        .map((name) => {
        const count = metrics.upstream_hit_counts[name] ?? 0;
        return `${colorName(truncateProxyText(name, 16))}=${count === 0 ? textDim("0") : colorCount(String(count))}`;
    })
        .join("  ")}`;
}
function formatProxyStatusCode(status) {
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
    return textDim("0");
}
function truncateProxyPath(value, max = 40) {
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, Math.max(0, max - 3))}...`;
}
function truncateProxyText(value, max = 40) {
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, Math.max(0, max - 3))}...`;
}
function padVisibleRight(value, width) {
    return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}
function padVisibleLeft(value, width) {
    return `${" ".repeat(Math.max(0, width - visibleLength(value)))}${value}`;
}
function fitProxyTerminalLine(line) {
    const columns = process.stdout.columns;
    if (!process.stdout.isTTY || !columns || visibleLength(line) < columns) {
        return line;
    }
    let visible = 0;
    let result = "";
    for (let index = 0; index < line.length && visible < columns - 1;) {
        const ansi = /^\u001b\[[0-9;]*m/.exec(line.slice(index));
        if (ansi) {
            result += ansi[0];
            index += ansi[0].length;
            continue;
        }
        result += line[index];
        visible += 1;
        index += 1;
    }
    return `${result}\u001b[0m`;
}
function formatProxyStatusLine(now, state, runtime) {
    const status = state ? textGreen("installed") : textRed("missing");
    const proxy = state ? colorUrl(state.proxy_base_url) : textDim("unset");
    const runtimeLabel = state && runtime?.healthy ? textGreen("healthy") : state ? textYellow("starting") : textDim("none");
    const pid = runtime?.pid === null || runtime?.pid === undefined
        ? textDim("none")
        : runtime.healthy
            ? textGreen(String(runtime.pid))
            : textYellow(String(runtime.pid));
    return [
        `status: ${status}`,
        `proxy: ${proxy}`,
        `runtime: ${runtimeLabel}`,
        `pid: ${pid}`,
        `time: ${textDim(now.toLocaleTimeString("en-GB", { hour12: false }))}`,
    ].join("  ");
}
function formatProxyFilesLine(state, options) {
    const parts = [
        `config ${colorPath(options.codexConfigPath)}`,
        `state ${colorPath(statePath(options.stateRoot))}`,
    ];
    if (state?.backup_path) {
        parts.push(`backup ${colorPath(state.backup_path)}`);
    }
    return `files: ${parts.join("  ")}`;
}
function formatProxyRecentRequest(record, index) {
    const at = record.at ? new Date(record.at).toLocaleTimeString("en-GB", { hour12: false }) : "--:--:--";
    const method = truncateProxyText(record.method || "-", PROXY_RECENT_METHOD_WIDTH);
    const path = truncateProxyPath(record.path || "-", PROXY_RECENT_PATH_WIDTH);
    const upstream = record.upstream ? truncateProxyText(record.upstream, PROXY_RECENT_UPSTREAM_WIDTH) : "-";
    const error = record.error ? ` ${textRed(truncateProxyText(record.error, 24))}` : "";
    return [
        `  ${padVisibleLeft(`${index + 1}.`, 3)}`,
        padVisibleRight(textDim(at), PROXY_RECENT_TIME_WIDTH),
        padVisibleRight(textMagenta(method), PROXY_RECENT_METHOD_WIDTH),
        padVisibleRight(colorPath(path), PROXY_RECENT_PATH_WIDTH),
        padVisibleLeft(formatProxyStatusCode(record.status), PROXY_RECENT_STATUS_WIDTH),
        padVisibleRight(record.upstream ? colorName(upstream) : textDim(upstream), PROXY_RECENT_UPSTREAM_WIDTH),
        padVisibleLeft(textYellow(formatLatencyMs(record.latency_ms)), PROXY_RECENT_LATENCY_WIDTH),
        padVisibleLeft(textDim(`x${record.attempts}`), PROXY_RECENT_ATTEMPTS_WIDTH),
        error,
    ].join(" ");
}
export function resolveProxySwitchBaseUrl(state) {
    return state?.proxy_base_url ?? null;
}
function buildProxyStateFromProfiles(profiles, codexConfigText, listenHost, listenPort) {
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
function parseReasoningTokens(payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }
    for (const pointer of REASONING_POINTERS) {
        const value = pointer
            .slice(1)
            .split("/")
            .reduce((current, segment) => (current && typeof current === "object" ? current[segment] : undefined), payload);
        if (Number.isInteger(value)) {
            return value;
        }
    }
    return null;
}
function responseHeadersToObject(headers) {
    const result = {};
    for (const [key, value] of headers.entries()) {
        result[key] = value;
    }
    return result;
}
function isStreamContentType(contentType) {
    return contentType.toLowerCase().includes("text/event-stream");
}
function isJsonContentType(contentType) {
    return contentType.toLowerCase().includes("application/json");
}
function rewriteUpstreamUrl(requestUrl, upstreamBaseUrl) {
    const upstream = new URL(upstreamBaseUrl);
    upstream.pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";
    upstream.search = requestUrl.search;
    upstream.hash = "";
    return upstream.toString();
}
async function readBody(request, limitBytes) {
    const chunks = [];
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
async function forwardRequest(request, upstreamBaseUrl, body, timeoutMs) {
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
        }
        else {
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
async function proxyThroughUpstreams(request, upstreams, body) {
    const contentType = `${request.headers["content-type"] || ""}`.toLowerCase();
    let lastStatus = 502;
    let lastError = "unknown";
    for (const upstream of upstreams) {
        let response;
        try {
            response = await forwardRequest(request, upstream.baseURL, body, UPSTREAM_TIMEOUT_MS);
        }
        catch (error) {
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
                const parsed = JSON.parse(text);
                const reasoning = parseReasoningTokens(parsed);
                if (reasoning !== null && REASONING_EQUALS.includes(reasoning)) {
                    return new Response(JSON.stringify({
                        error: {
                            message: `codex proxy blocked suspicious reasoning response from ${upstream.baseURL}`,
                            type: "codex_proxy",
                            code: "reasoning_guard_triggered",
                            reasoning_tokens: reasoning,
                            status_code: NON_STREAM_STATUS_CODE,
                        },
                    }), { status: NON_STREAM_STATUS_CODE, headers: { "content-type": "application/json; charset=utf-8" } });
                }
            }
            catch {
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
    return new Response(JSON.stringify({
        error: {
            message: `proxy upstreams failed: ${lastError}`,
            type: "codex_proxy",
            code: "upstream_failure",
            status_code: lastStatus,
        },
    }), { status: NON_STREAM_STATUS_CODE, headers: { "content-type": "application/json; charset=utf-8" } });
}
async function proxyThroughUpstreamsWithStats(request, upstreams, body) {
    const contentType = `${request.headers["content-type"] || ""}`.toLowerCase();
    let lastStatus = 502;
    let lastError = "unknown";
    let attempts = 0;
    for (const upstream of upstreams) {
        attempts += 1;
        let response;
        try {
            response = await forwardRequest(request, upstream.baseURL, body, UPSTREAM_TIMEOUT_MS);
        }
        catch (error) {
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
                const parsed = JSON.parse(text);
                const reasoning = parseReasoningTokens(parsed);
                if (reasoning !== null && REASONING_EQUALS.includes(reasoning)) {
                    return {
                        response: new Response(JSON.stringify({
                            error: {
                                message: `codex proxy blocked suspicious reasoning response from ${upstream.baseURL}`,
                                type: "codex_proxy",
                                code: "reasoning_guard_triggered",
                                reasoning_tokens: reasoning,
                                status_code: NON_STREAM_STATUS_CODE,
                            },
                        }), { status: NON_STREAM_STATUS_CODE, headers: { "content-type": "application/json; charset=utf-8" } }),
                        upstream: upstream.name,
                        attempts,
                        error: null,
                    };
                }
            }
            catch {
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
        response: new Response(JSON.stringify({
            error: {
                message: `proxy upstreams failed: ${lastError}`,
                type: "codex_proxy",
                code: "upstream_failure",
                status_code: lastStatus,
            },
        }), { status: NON_STREAM_STATUS_CODE, headers: { "content-type": "application/json; charset=utf-8" } }),
        upstream: null,
        attempts,
        error: lastError,
    };
}
function writeResponse(res, response) {
    res.writeHead(response.status, responseHeadersToObject(response.headers));
    if (!response.body) {
        res.end();
        return;
    }
    Readable.fromWeb(response.body).pipe(res);
}
export async function installProxy(options) {
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
export async function restoreProxy(options) {
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
function formatProxyRequestsSummary(metrics) {
    return [
        `requests: total ${colorCount(String(metrics.total_requests))}`,
        `ok ${textGreen(String(metrics.successful_requests))}`,
        `failed ${textRed(String(metrics.failed_requests))}`,
        `rate ${metrics.failed_requests === 0 ? textGreen(formatFailureRate(metrics.successful_requests, metrics.failed_requests)) : textRed(formatFailureRate(metrics.successful_requests, metrics.failed_requests))}`,
    ].join(" | ");
}
function formatProxyLatencySummary(metrics) {
    if (metrics.latency_ms.count === 0) {
        return `latency: ${textDim("no requests yet")}`;
    }
    return [
        `latency: avg ${textYellow(formatLatencyMs(averageLatency(metrics.latency_ms)))}`,
        `p50 ${textYellow(formatLatencyMs(percentileLatency(metrics.latency_ms.samples, 50)))}`,
        `p95 ${textYellow(formatLatencyMs(percentileLatency(metrics.latency_ms.samples, 95)))}`,
        `min ${textYellow(formatLatencyMs(metrics.latency_ms.min ?? 0))}`,
        `max ${textYellow(formatLatencyMs(metrics.latency_ms.max ?? 0))}`,
    ].join(" | ");
}
function formatProxyRecentHeader(metrics) {
    return `${textBold("recent")}${metrics.recent_requests.length > 0 ? "" : ` ${textDim("none")}`}`;
}
function formatProxyRecentRows(metrics, count = 5) {
    const rows = metrics.recent_requests.slice(0, count).map((record, index) => formatProxyRecentRequest(record, index));
    while (rows.length < count) {
        rows.push(textDim("-"));
    }
    return rows;
}
function buildProxyStatusLines(now, state, profileOrder, runtime, options) {
    const metrics = state?.metrics ?? createProxyMetrics();
    return [
        textBold("ccs proxy"),
        formatProxyStatusLine(now, state, runtime),
        formatProxyFilesLine(state, options),
        formatProxyRequestsSummary(metrics),
        formatProxyLatencySummary(metrics),
        formatProxyUpstreamHits(profileOrder, metrics),
        formatProxyRecentHeader(metrics),
        ...formatProxyRecentRows(metrics, PROXY_RECENT_RENDER_COUNT),
        textDim("commands: ccs proxy [--once] | install | restore | stop | serve"),
    ].map(fitProxyTerminalLine);
}
async function runProxyStatusLoop(options) {
    let stopped = false;
    let timer = null;
    let refreshing = false;
    let firstFrame = true;
    const renderLineCount = PROXY_STATUS_RENDER_LINES;
    const render = async () => {
        if (refreshing || stopped) {
            return;
        }
        refreshing = true;
        try {
            const runtime = await ensureProxyRunning(options);
            const state = runtime?.state ?? await readProxyState(options.stateRoot);
            const profiles = await readProfiles();
            const profileOrder = state?.profile_order?.length ? state.profile_order : buildProfileOrder(profiles);
            const lines = buildProxyStatusLines(new Date(), state, profileOrder, runtime, options);
            if (process.stdout.isTTY) {
                if (firstFrame) {
                    process.stdout.write(lines.join("\n"));
                    firstFrame = false;
                }
                else {
                    process.stdout.write(`\u001b[${Math.max(0, renderLineCount - 1)}A\r${lines.map((line) => `\u001b[2K${line}`).join("\n")}`);
                }
            }
            else {
                console.log(lines.join("\n"));
            }
        }
        finally {
            refreshing = false;
        }
    };
    await render();
    if (options.once || !process.stdout.isTTY) {
        return;
    }
    await new Promise((resolve) => {
        const cleanup = () => {
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
export async function stopProxy(options) {
    const state = await readProxyState(options.stateRoot);
    const health = state ? await readProxyHealth(state) : { healthy: false, pid: null };
    const file = pidPath(options.stateRoot);
    if (!fs.existsSync(file)) {
        if (state && health.healthy && health.pid !== null) {
            try {
                process.kill(health.pid);
            }
            catch {
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
        }
        catch {
            // ignore
        }
    }
    await waitForProxyStop(state);
    await rm(file, { force: true });
    return `Proxy stopped. PID=${targetPid}`;
}
export async function serveProxy(options) {
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
            }
            catch (error) {
                res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
            }
        })();
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(state.listen_port, state.listen_host, () => resolve());
    });
    await writeTextFile(pidPath(options.stateRoot), `${process.pid}\n`);
    process.stdout.write(`proxy listening: ${state.proxy_base_url}\n`);
    await new Promise((resolve) => {
        const close = () => {
            server.close(() => resolve());
        };
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
    });
    await rm(pidPath(options.stateRoot), { force: true });
}
function usageHelpLines() {
    return [
        "Usage:",
        "  ccs proxy [--once]                  # print or watch proxy status and upstream order",
        "  ccs proxy install                   # back up config, install routing, and start background proxy",
        "  ccs proxy restore                   # restore config from the saved backup",
        "  ccs proxy stop                      # stop the healthy background proxy",
        "  ccs proxy serve                     # run the proxy server in the foreground for debugging",
    ];
}
export async function runProxyCommand(args, options) {
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
