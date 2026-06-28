import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { setInterval } from "node:timers";
import { Readable } from "node:stream";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexConfigPath, profilesPath } from "../lib/paths.js";
import { readTextIfExists, writeTextFile } from "../lib/fs.js";
import { colorPath, printKeyValue } from "../lib/output.js";
import { textBlue, textDim, textGreen } from "../lib/text.js";
import { readTomlBaseUrl, readTopLevelTomlString, updateTomlBaseUrl } from "../lib/toml.js";
const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 4610;
const HEALTH_PATH = "/__codex_proxy/health";
const PROXY_STATE_FILE = "proxy.json";
const REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60 * 1000;
const NON_STREAM_STATUS_CODE = 502;
const REASONING_EQUALS = [516];
const REASONING_POINTERS = [
    "/usage/output_tokens_details/reasoning_tokens",
    "/usage/completion_tokens_details/reasoning_tokens",
    "/response/usage/output_tokens_details/reasoning_tokens",
    "/response/usage/completion_tokens_details/reasoning_tokens",
];
function statePath(stateRoot) {
    return path.join(stateRoot, PROXY_STATE_FILE);
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
    return text ? parseJsonObject(text) : null;
}
async function writeProxyState(stateRoot, state) {
    await mkdir(stateRoot, { recursive: true });
    await writeTextFile(statePath(stateRoot), stringifyJson(state), 0o600);
}
async function removeProxyState(stateRoot) {
    await rm(statePath(stateRoot), { force: true });
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
    await copyFile(state.backup_path, options.codexConfigPath);
    await removeProxyState(options.stateRoot);
}
async function readProxyPid(stateRoot) {
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
    }
    catch {
        return { pid, running: false };
    }
}
function formatProxyStatusLine(now, state, profileOrder, pidState) {
    const segments = [
        now.toLocaleTimeString("en-GB", { hour12: false }),
        state ? "installed" : "missing",
        state ? state.proxy_base_url : "proxy unset",
        `upstreams ${profileOrder.length > 0 ? profileOrder.join(" -> ") : "none"}`,
        pidState.pid ? `pid ${pidState.running ? "running" : "stopped"} ${pidState.pid}` : "pid none",
    ];
    return segments.join(" | ");
}
function formatProxyStatusFooter(options) {
    return `files: ${colorPath(options.codexConfigPath)}  ${colorPath(options.stateRoot)}`;
}
async function runProxyStatusLoop(options) {
    let stopped = false;
    let timer = null;
    let refreshing = false;
    let firstFrame = true;
    const commandsLine = textDim("commands: ccs proxy [--once] | install | restore | stop | serve");
    const render = async () => {
        if (refreshing || stopped) {
            return;
        }
        refreshing = true;
        try {
            const state = await readProxyState(options.stateRoot);
            const profiles = await readProfiles();
            const profileOrder = state?.profile_order?.length ? state.profile_order : buildProfileOrder(profiles);
            const pidState = await readProxyPid(options.stateRoot);
            const statusLine = formatProxyStatusLine(new Date(), state, profileOrder, pidState);
            const lines = [statusLine, formatProxyStatusFooter(options), commandsLine];
            if (process.stdout.isTTY) {
                if (firstFrame) {
                    process.stdout.write(lines.join("\n"));
                    firstFrame = false;
                }
                else {
                    process.stdout.write(`\u001b[2A\r\u001b[2K${statusLine}\n\u001b[2K${formatProxyStatusFooter(options)}\n\u001b[2K${commandsLine}`);
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
        }
        catch {
            // ignore
        }
    }
    await rm(pidPath, { force: true });
    return `Proxy stopped. PID=${pid}`;
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
                    res.end(JSON.stringify({ status: "ok" }));
                    return;
                }
                const profiles = await readProfiles();
                const upstreamProfiles = buildProfileOrder(profiles)
                    .map((name) => profiles.profiles?.[name])
                    .filter((profile) => Boolean(profile?.baseURL));
                const body = await readBody(req, REQUEST_BODY_LIMIT_BYTES);
                const response = await proxyThroughUpstreams(req, upstreamProfiles, body);
                writeResponse(res, response);
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
    const pidPath = path.join(options.stateRoot, "proxy.pid");
    await writeTextFile(pidPath, `${process.pid}\n`);
    process.stdout.write(`proxy listening: ${state.proxy_base_url}\n`);
    await new Promise((resolve) => {
        process.once("SIGINT", () => server.close(() => resolve()));
        process.once("SIGTERM", () => server.close(() => resolve()));
    });
}
function usageHelpLines() {
    return [
        "Usage:",
        "  ccs proxy [--once]                  # print or watch proxy status and upstream order",
        "  ccs proxy install                   # back up config and install proxy routing",
        "  ccs proxy restore                   # restore config from the saved backup",
        "  ccs proxy stop                      # stop a running proxy process by PID file",
        "  ccs proxy serve                     # run the proxy server in the foreground",
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
