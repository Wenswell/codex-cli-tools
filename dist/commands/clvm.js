import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { appendFile, chmod } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { readTextIfExists, writeTextFile, writeTextFileAtomic } from "../lib/fs.js";
import { printKeyValue } from "../lib/output.js";
import { clvmConfigPath, codexToolsCacheDir, codexToolsConfigDir, formatHomePath } from "../lib/paths.js";
import { renderTable } from "../lib/table.js";
import { maskSecret, textBlue, textBold, textCyan, textDim, textGreen, textMagenta, textRed, textYellow, truncateVisible, visibleLength, } from "../lib/text.js";
import { printToolVersionIfRequested } from "../lib/version.js";
const domainFields = [
    "host",
    "destinationHost",
    "sniffHost",
    "sni",
    "domain",
];
const durationUnits = new Map([
    ["ms", 1],
    ["s", 1000],
    ["m", 60_000],
    ["h", 3_600_000],
]);
const closedHistoryLimit = 5;
const clvmStateVersion = 3;
const clvmRetryMaxIntervalMs = 300_000;
const clvmRetryMultipliers = [1, 2, 5, 10, 30, 60];
const commandsLine = "commands: clvm | clvm version | clvm -v | clvm monitor | clvm config | clvm setup --domain DOMAIN | clvm sync | clvm help";
const compactCommandsLine = "commands: clvm | version|-v | monitor | config | setup | sync | help";
const setupFields = new Set([
    "baseUrl",
    "secret",
    "domains",
    "interval",
    "zeroSpeedThreshold",
    "closeZeroForSeconds",
]);
function clvmTemplatePath() {
    return fileURLToPath(new URL("../../config/clvm.json", import.meta.url));
}
function clvmStatePath() {
    return join(codexToolsCacheDir(), "clvm-state.json");
}
function clvmHistoryPath() {
    return join(codexToolsCacheDir(), "clvm-history.jsonl");
}
function clvmRawDir() {
    return join(codexToolsCacheDir(), "clvm-raw");
}
class ClvmRuntimeError extends Error {
    code;
    status;
    statusText;
    body;
    raw;
    causeDetail;
    constructor(code, message, options = {}) {
        super(message);
        this.name = "ClvmRuntimeError";
        this.code = code;
        this.status = options.status;
        this.statusText = options.statusText;
        this.body = options.body;
        this.raw = options.raw;
        this.causeDetail = options.cause === undefined ? undefined : errorCauseDetail(options.cause);
    }
}
export class ClashApi {
    #baseUrl;
    #secret;
    #fetch;
    constructor({ baseUrl, secret, fetchImpl = globalThis.fetch, }) {
        if (!baseUrl) {
            throw new Error("baseUrl is required");
        }
        if (typeof fetchImpl !== "function") {
            throw new Error("global fetch is required; use Node.js 20 or newer");
        }
        this.#baseUrl = new URL(baseUrl);
        this.#secret = secret;
        this.#fetch = fetchImpl;
    }
    async getConnections() {
        const response = await this.#request("/connections", "GET");
        const text = await response.text();
        const raw = buildClvmRawHttpResponse("GET", "/connections", response, text);
        try {
            return {
                payload: JSON.parse(text),
                raw,
            };
        }
        catch (error) {
            throw new ClvmRuntimeError("invalid_connections_payload", "/connections response must be valid JSON", {
                raw,
                cause: error,
            });
        }
    }
    async closeConnection(id) {
        await this.#request(`/connections/${encodeURIComponent(id)}`, "DELETE");
    }
    async #request(pathname, method) {
        let response;
        try {
            response = await this.#fetch(new URL(pathname, this.#baseUrl), {
                method,
                headers: this.#headers(),
            });
        }
        catch (error) {
            throw new ClvmRuntimeError("fetch_failed", `${method} ${pathname} fetch failed`, {
                cause: error,
            });
        }
        if (!response.ok) {
            const text = await response.text();
            const suffix = text ? `: ${text}` : "";
            throw new ClvmRuntimeError("http_error", `${method} ${pathname} failed with ${response.status} ${response.statusText}${suffix}`, {
                status: response.status,
                statusText: response.statusText,
                body: text,
                raw: buildClvmRawHttpResponse(method, pathname, response, text),
            });
        }
        return response;
    }
    #headers() {
        return this.#secret ? { Authorization: `Bearer ${this.#secret}` } : {};
    }
}
export class ConnectionSampler {
    #states = new Map();
    #now;
    constructor({ now = () => new Date() } = {}) {
        this.#now = now;
    }
    sample(payload, options) {
        const now = this.#now();
        const nowMs = now.getTime();
        const connections = readConnections(payload);
        const nextIds = new Set();
        const matched = [];
        for (const connection of connections) {
            const id = String(readObjectValue(connection, "id") ?? "");
            if (!id) {
                continue;
            }
            nextIds.add(id);
            const state = this.#updateState(connection, nowMs, options.zeroSpeedThreshold);
            const domainMatch = findDomainMatch(connection, options.domains);
            if (!domainMatch) {
                continue;
            }
            const entry = toEntry(connection, state, domainMatch);
            matched.push({
                ...entry,
                status: statusFor(entry),
            });
        }
        for (const id of this.#states.keys()) {
            if (!nextIds.has(id)) {
                this.#states.delete(id);
            }
        }
        return {
            timestamp: now.toISOString(),
            totalConnections: connections.length,
            matchedConnections: matched,
        };
    }
    #updateState(connection, nowMs, zeroSpeedThreshold) {
        const id = String(connection.id);
        const previous = this.#states.get(id);
        const uploadTotal = numberOrZero(connection.upload);
        const downloadTotal = numberOrZero(connection.download);
        const startMs = parseStartTime(connection.start) ?? previous?.startMs ?? nowMs;
        const elapsedSeconds = previous ? Math.max((nowMs - previous.lastSeenMs) / 1000, 0) : 0;
        const speeds = readSpeeds(connection, previous, {
            elapsedSeconds,
            uploadTotal,
            downloadTotal,
        });
        const isIdle = speeds.totalBytesPerSecond !== null && speeds.totalBytesPerSecond <= zeroSpeedThreshold;
        const idleSinceMs = isIdle
            ? previous?.isIdle
                ? previous.idleSinceMs
                : speeds.coversPreviousInterval && previous
                    ? previous.lastSeenMs
                    : nowMs
            : null;
        const next = {
            startMs,
            lastSeenMs: nowMs,
            uploadTotal,
            downloadTotal,
            uploadBytesPerSecond: speeds.uploadBytesPerSecond,
            downloadBytesPerSecond: speeds.downloadBytesPerSecond,
            totalBytesPerSecond: speeds.totalBytesPerSecond,
            zeroSpeedThreshold,
            isIdle,
            idleSinceMs,
            observedIdleMs: idleSinceMs === null ? 0 : nowMs - idleSinceMs,
        };
        this.#states.set(id, next);
        return next;
    }
}
export async function runClvm(argv) {
    if (printToolVersionIfRequested("clvm", argv)) {
        return;
    }
    const parsed = parseArgs(argv);
    if (parsed.command === "help") {
        printHelp();
        return;
    }
    if (parsed.command === "config") {
        const runtimeConfig = buildRuntimeConfig(await loadActiveClvmConfig(), {}, { autoCloseEnabled: false, clear: false, once: true });
        printConfigStatus(runtimeConfig, { includeCommands: true });
        return;
    }
    if (parsed.command === "setup") {
        await runSetup(parsed.options);
        return;
    }
    if (parsed.command === "sync") {
        await runSync();
        return;
    }
    const fileConfig = await loadActiveClvmConfig();
    const runtimeConfig = buildRuntimeConfig(fileConfig, parsed.options, {
        autoCloseEnabled: parsed.command === "monitor",
        clear: parsed.command === "monitor",
        once: parsed.command === "status",
    });
    if (parsed.command === "status") {
        await runStatus(runtimeConfig);
        return;
    }
    await runMonitor(runtimeConfig);
}
function parseArgs(argv) {
    rejectRemovedYesFlags(argv, "clvm");
    if (argv.length > 0 && isHelpArg(argv[0])) {
        assertExactArgs(argv.slice(1), "help", 0);
        return { command: "help", options: {} };
    }
    const [first, ...rest] = argv;
    if (first === "monitor") {
        return { command: "monitor", options: parseRunOptions(rest, "monitor") };
    }
    if (first === "config") {
        return { command: "config", options: parseConfigOptions(rest) };
    }
    if (first === "setup") {
        return { command: "setup", options: parseSetupOptions(rest) };
    }
    if (first === "sync") {
        return { command: "sync", options: parseSyncOptions(rest) };
    }
    if (first && !first.startsWith("-")) {
        throw new Error(`unknown command: ${first}`);
    }
    return { command: "status", options: parseRunOptions(argv, "clvm") };
}
function parseRunOptions(argv, command) {
    const options = {};
    const domains = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (isHelpArg(arg)) {
            assertExactArgs(argv.slice(index + 1), `${command} help`, 0);
            printHelp();
            process.exit(0);
        }
        if (arg === "-d" || arg === "--domain") {
            domains.push(requireValue(argv, index));
            index += 1;
            continue;
        }
        if (arg === "--base-url") {
            options.baseUrl = requireValue(argv, index);
            index += 1;
            continue;
        }
        if (arg === "--secret") {
            options.secret = requireValue(argv, index);
            index += 1;
            continue;
        }
        if (arg === "--interval") {
            options.interval = requireValue(argv, index);
            index += 1;
            continue;
        }
        if (arg === "--zero-speed") {
            options.zeroSpeedThreshold = parseNonNegativeNumber(requireValue(argv, index), "zero speed");
            index += 1;
            continue;
        }
        if (arg === "--close-zero-for-seconds") {
            options.closeZeroForSeconds = parseCloseZeroForSeconds(requireValue(argv, index));
            index += 1;
            continue;
        }
        if (arg === "--json") {
            options.json = true;
            continue;
        }
        if (arg === "--no-clear") {
            options.clear = false;
            continue;
        }
        if (arg === "--no-color") {
            options.color = false;
            continue;
        }
        if (arg === "--once") {
            options.once = true;
            continue;
        }
        throw new Error(`unknown argument: ${arg}`);
    }
    if (domains.length > 0) {
        options.domains = domains;
    }
    return options;
}
function parseConfigOptions(argv) {
    if (argv.length === 0) {
        return {};
    }
    if (argv.length === 1 && isHelpArg(argv[0])) {
        printHelp();
        process.exit(0);
    }
    throw new Error(`unknown argument for clvm config: ${argv[0]}`);
}
function parseSetupOptions(argv) {
    if (argv.length === 1 && isHelpArg(argv[0])) {
        printSetupHelp();
        process.exit(0);
    }
    const options = parseRunOptions(argv, "setup");
    if (options.json !== undefined || options.clear !== undefined || options.color !== undefined || options.once !== undefined) {
        throw new Error("clvm setup accepts config flags only");
    }
    if (options.baseUrl === undefined &&
        options.secret === undefined &&
        options.domains === undefined &&
        options.interval === undefined &&
        options.zeroSpeedThreshold === undefined &&
        options.closeZeroForSeconds === undefined) {
        throw new Error("clvm setup requires at least one config flag; run clvm config to view current config");
    }
    return options;
}
function parseSyncOptions(argv) {
    if (argv.length === 0) {
        return {};
    }
    if (argv.length === 1 && isHelpArg(argv[0])) {
        printSyncHelp();
        process.exit(0);
    }
    throw new Error(`unknown argument for clvm sync: ${argv[0]}`);
}
function isHelpArg(arg) {
    return arg === "help" || arg === "--help" || arg === "-h";
}
function assertExactArgs(args, command, expected) {
    if (args.length !== expected) {
        throw new Error(`${command} accepts ${expected} argument${expected === 1 ? "" : "s"}`);
    }
}
function requireValue(argv, index) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
        throw new Error(`${argv[index]} requires a value`);
    }
    return value;
}
function printHelp() {
    console.log([
        "Usage:",
        "  clvm                                      # print active config and one matched-connections status",
        "  clvm version                              # print package version",
        "  clvm -v                                   # print package version",
        "  clvm monitor                              # refresh matched connections from mihomo /connections",
        "  clvm config                               # print active config",
        "  clvm setup --domain DOMAIN [OPTIONS]      # preview, confirm, and write config",
        "  clvm sync                                 # preview, confirm, and sync default config",
        "  clvm help                                 # show this help",
        "",
        "Options:",
        "  -d, --domain DOMAIN                       # domain to match; repeat or comma-separate",
        "  --base-url URL                            # mihomo external-controller URL",
        "  --secret SECRET                           # mihomo API secret",
        "  --interval DURATION                       # monitor interval, for example 1s",
        "  --zero-speed BYTES                        # zero-speed threshold in bytes per second",
        "  --close-zero-for-seconds SECONDS|off      # close zero-speed connections in monitor mode",
        "  --json                                    # print JSON samples",
        "  --no-clear                                # append samples in monitor mode",
        "  --no-color                                # disable clvm output colors",
        "  --once                                    # poll once when used with monitor",
    ].join("\n"));
}
function printSetupHelp() {
    console.log([
        "Usage:",
        "  clvm setup --domain DOMAIN                # preview, confirm, back up, and write clvm.json",
        "  clvm setup --base-url URL --secret SECRET # preview, confirm, back up, and update API config",
        "  clvm setup --interval 1s                  # preview, confirm, back up, and update monitor interval",
        "  clvm setup --close-zero-for-seconds off   # preview, confirm, back up, and disable automatic close",
    ].join("\n"));
}
function printSyncHelp() {
    console.log([
        "Usage:",
        "  clvm sync                                 # preview, confirm, back up, and sync config/clvm.json to ~/.config/codex-tools/clvm.json",
        "  clvm sync help                            # show this help",
    ].join("\n"));
}
async function runSetup(options) {
    const configPath = clvmConfigPath();
    const existingText = await readTextIfExists(configPath);
    const currentText = existingText ?? "";
    const currentConfig = await loadActiveClvmConfig();
    const nextConfig = buildSetupConfig(currentConfig, options);
    const nextText = renderConfigJson(nextConfig);
    printSetupPlan(configPath, currentText, nextText, existingText !== null, buildRuntimeConfig(nextConfig, {}, {
        autoCloseEnabled: false,
        clear: false,
        once: true,
    }));
    if (currentText === nextText) {
        console.log("");
        console.log(textDim("no config changes."));
        return;
    }
    if (!(await confirmApply())) {
        return;
    }
    const backupDir = await backupClvmConfig(configPath);
    await writeTextFile(configPath, nextText, 0o600);
    console.log("");
    if (backupDir) {
        printKeyValue("backup:", textBlue(backupDir), 12);
    }
    printKeyValue("target:", `${textGreen("updated")} ${textBlue(configPath)}`, 12);
}
async function runSync() {
    const configPath = clvmConfigPath();
    const templatePath = clvmTemplatePath();
    const existingText = await readTextIfExists(configPath);
    const currentText = existingText ?? "";
    const templateConfig = await readClvmTemplateConfig();
    const localConfig = await readClvmConfig();
    const nextConfig = mergeClvmConfig(templateConfig, localConfig);
    const nextText = renderConfigJson(nextConfig);
    printSyncPlan(templatePath, configPath, currentText, nextText, existingText !== null, buildRuntimeConfig(nextConfig, {}, { autoCloseEnabled: false, clear: false, once: true }));
    if (currentText === nextText) {
        console.log("");
        console.log(textDim("already synced"));
        return;
    }
    if (!(await confirmApply())) {
        return;
    }
    const backupDir = await backupClvmConfig(configPath);
    await writeTextFile(configPath, nextText, 0o600);
    console.log("");
    if (backupDir) {
        printKeyValue("backup:", textBlue(backupDir), 12);
    }
    printKeyValue("target:", `${textGreen("synced")} ${textBlue(configPath)}`, 12);
}
function buildSetupConfig(current, options) {
    return mergeClvmConfig(current, {
        baseUrl: options.baseUrl,
        secret: options.secret,
        domains: options.domains !== undefined ? normalizeDomains(options.domains) : undefined,
        interval: options.interval,
        zeroSpeedThreshold: options.zeroSpeedThreshold,
        closeZeroForSeconds: options.closeZeroForSeconds,
    });
}
function printSetupPlan(configPath, currentText, nextText, currentExists, runtimeConfig) {
    printWritePlanSummary("clvm setup", configPath, currentText, nextText, currentExists);
    printKeyValue("target:", `${textBlue("would update")} ${textBlue(configPath)}`, 12);
    printConfigValues(runtimeConfig);
    printConfigDiff(configPath, currentText, nextText);
}
function printSyncPlan(sourcePath, configPath, currentText, nextText, currentExists, runtimeConfig) {
    printWritePlanSummary("clvm sync", configPath, currentText, nextText, currentExists);
    printKeyValue("source:", textBlue(sourcePath), 12);
    const targetLabel = currentText === nextText ? textDim("already synced") : textBlue("would update");
    printKeyValue("target:", `${targetLabel} ${textBlue(configPath)}`, 12);
    printConfigValues(runtimeConfig);
    printConfigDiff(configPath, currentText, nextText);
}
function printWritePlanSummary(title, configPath, currentText, nextText, currentExists) {
    const changed = currentText !== nextText;
    const label = basename(configPath);
    console.log(textBold(`Plan: ${title}`));
    console.log(textDim("no changes are written unless you type yes at the prompt."));
    console.log(`Will modify: ${textBlue(changed ? label : "(none)")}`);
    console.log(`Will back up: ${textBlue(changed && currentExists ? label : "(none)")}`);
    console.log(`Warnings: ${textDim("0")}`);
}
export async function backupClvmConfig(configPath) {
    const currentText = await readTextIfExists(configPath);
    if (currentText === null) {
        return null;
    }
    const backupDir = join(codexToolsConfigDir(), "backups", `clvm-${formatTimestamp(new Date())}`);
    await writeTextFile(join(backupDir, basename(configPath)), currentText, 0o600);
    return backupDir;
}
function formatTimestamp(date) {
    const pad = (value) => value.toString().padStart(2, "0");
    const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
    return [
        date.getFullYear().toString(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "-",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
        "-",
        milliseconds,
    ].join("");
}
function printConfigStatus(runtimeConfig, { includeCommands }) {
    const style = createStyle(runtimeConfig);
    console.log(style.bold("clvm config"));
    printKeyValue("config:", style.blue(formatHomePath(clvmConfigPath())), 12);
    printKeyValue("state:", style.blue(formatHomePath(clvmStatePath())), 12);
    printKeyValue("history:", style.blue(formatHomePath(clvmHistoryPath())), 12);
    printKeyValue("raw:", style.blue(formatHomePath(clvmRawDir())), 12);
    printConfigValues(runtimeConfig, style);
    if (includeCommands) {
        printCommands(style);
    }
}
function printConfigValues(config, style = createStyle(config)) {
    printKeyValue("base URL:", style.cyan(config.baseUrl), 12);
    printKeyValue("secret:", config.secret ? style.green(maskSecret(config.secret)) : style.dim("empty"), 12);
    printKeyValue("domains:", config.domains.length > 0 ? config.domains.join(",") : style.yellow("missing"), 12);
    printKeyValue("interval:", formatDuration(config.intervalMs), 12);
    printKeyValue("zero speed:", formatSpeed(config.zeroSpeedThreshold), 12);
    printKeyValue("auto close:", config.closeZeroForSeconds === null ? style.dim("off") : style.red(`${formatSeconds(config.closeZeroForSeconds)}`), 12);
}
function printCommands(style) {
    console.log(style.dim(fitCommandsLine(terminalColumns(process.stdout))));
}
function fitCommandsLine(columns) {
    const line = visibleLength(commandsLine) <= columns ? commandsLine : compactCommandsLine;
    return visibleLength(line) <= columns ? line : truncateVisible(line, columns);
}
function printConfigDiff(configPath, currentText, nextText) {
    if (currentText === nextText) {
        return;
    }
    const label = basename(configPath);
    const patch = createTwoFilesPatch(`current/${label}`, `next/${label}`, redactConfigText(currentText), redactConfigText(nextText), "", "", { context: 3 });
    console.log("");
    console.log(`${textBold("File:")} ${textBlue(label)}`);
    for (const line of patch.split("\n")) {
        if (line.startsWith("===")) {
            continue;
        }
        if (line.startsWith("--- ") || line.startsWith("+++ ")) {
            console.log(textDim(`  ${line}`));
            continue;
        }
        if (line.startsWith("@@")) {
            console.log(textBlue(`  ${line}`));
            continue;
        }
        if (line.startsWith("+")) {
            console.log(textGreen(`  ${line}`));
            continue;
        }
        if (line.startsWith("-")) {
            console.log(textRed(`  ${line}`));
            continue;
        }
        console.log(textDim(`  ${line}`));
    }
}
function redactConfigText(text) {
    return text.replace(/("secret"\s*:\s*)"((?:\\.|[^"\\])*)"/gu, (match, prefix, raw) => {
        try {
            const value = JSON.parse(`"${raw}"`);
            return `${prefix}${JSON.stringify(maskSecret(value))}`;
        }
        catch {
            return match;
        }
    });
}
async function runStatus(config) {
    const style = createStyle(config);
    if (config.json) {
        if (config.domains.length === 0) {
            throw new Error("domains are required for JSON status; run clvm setup --domain DOMAIN or use --domain DOMAIN");
        }
        try {
            printMonitorResult(await sampleOnce(config), config);
        }
        catch (error) {
            const failure = buildMonitorFailure(error);
            await recordClvmFailure("status", config, failure);
            printMonitorFailure(failure, config);
        }
        return;
    }
    printConfigStatus(config, { includeCommands: false });
    if (config.domains.length === 0) {
        printKeyValue("status:", style.yellow("missing domains"), 12);
        printCommands(style);
        return;
    }
    try {
        const result = await sampleOnce(config);
        printKeyValue("status:", `${style.green("ok")} total=${style.green(String(result.totalConnections))} current=${style.green(String(result.matchedConnections.length))}`, 12);
        console.log("");
        printMonitorResult(result, config);
    }
    catch (error) {
        const failure = buildMonitorFailure(error);
        await recordClvmFailure("status", config, failure);
        printKeyValue("status:", formatUnavailableStatus(failure, style), 12);
    }
    printCommands(style);
}
async function runMonitor(config) {
    if (config.domains.length === 0) {
        throw new Error(`domains are required; run clvm setup --domain DOMAIN or use --domain DOMAIN`);
    }
    const api = new ClashApi({
        baseUrl: config.baseUrl,
        secret: config.secret,
    });
    const sampler = new ConnectionSampler();
    const closedIds = new Set();
    const closedHistory = [];
    let closedTotal = 0;
    let stopped = false;
    let retryAttempt = 0;
    let stopDelay = null;
    process.once("SIGINT", () => {
        stopped = true;
        stopDelay?.();
    });
    const wait = async (milliseconds) => {
        await new Promise((resolve) => {
            const timeout = setTimeout(resolve, milliseconds);
            stopDelay = () => {
                clearTimeout(timeout);
                resolve();
            };
        });
        stopDelay = null;
    };
    while (!stopped) {
        try {
            const payload = await api.getConnections();
            const result = sampleConnections(sampler, payload, config);
            const closedConnections = await closeExpiredConnections(api, result, config, closedIds);
            if (closedConnections.length > 0) {
                closedTotal += closedConnections.length;
                recordClosedConnections(closedHistory, closedConnections);
            }
            result.closedHistory = closedHistory;
            result.closedTotal = closedTotal;
            await recordClvmSample("monitor", config, result, payload.raw);
            printMonitorResult(result, config);
            retryAttempt = 0;
            if (config.once) {
                break;
            }
            await wait(nextAlignedDelay(config.intervalMs));
        }
        catch (error) {
            retryAttempt += 1;
            const retryIntervalMs = nextClvmRetryInterval(config.intervalMs, retryAttempt);
            const failure = buildMonitorFailure(error, buildRetryState(retryAttempt, retryIntervalMs));
            await recordClvmFailure("monitor", config, failure);
            printMonitorFailure(failure, config);
            if (config.once) {
                break;
            }
            await wait(retryIntervalMs);
        }
    }
}
async function sampleOnce(config) {
    const api = new ClashApi({
        baseUrl: config.baseUrl,
        secret: config.secret,
    });
    const sampler = new ConnectionSampler();
    const response = await api.getConnections();
    const result = sampleConnections(sampler, response, config);
    result.closedConnections = [];
    result.closeFailures = [];
    result.closedHistory = [];
    result.closedTotal = 0;
    await recordClvmSample("status", config, result, response.raw);
    return result;
}
function sampleConnections(sampler, response, config) {
    try {
        return sampler.sample(response.payload, {
            domains: config.domains,
            zeroSpeedThreshold: config.zeroSpeedThreshold,
        });
    }
    catch (error) {
        if (error instanceof ClvmRuntimeError && error.code === "invalid_connections_payload") {
            throw new ClvmRuntimeError(error.code, error.message, {
                raw: response.raw,
                cause: error,
            });
        }
        throw error;
    }
}
async function recordClvmSample(source, config, result, raw) {
    const record = buildClvmSampleRecord(source, config, result, raw);
    await writeClvmRuntimeRecord(record);
}
async function recordClvmFailure(source, config, failure) {
    const record = buildClvmFailureRecord(source, config, failure);
    await writeClvmRuntimeRecord(record);
}
async function writeClvmRuntimeRecord(record) {
    const recordWithRawRef = {
        ...record,
        raw_ref: await writeClvmRawPayload(record.raw),
    };
    await writeTextFileAtomic(clvmStatePath(), `${JSON.stringify(recordWithRawRef, null, 2)}\n`, 0o600);
    await appendClvmHistoryRecord(toClvmHistoryRecord(recordWithRawRef));
}
async function appendClvmHistoryRecord(record) {
    const path = clvmHistoryPath();
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
}
async function writeClvmRawPayload(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    const text = JSON.stringify(raw);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const path = join(clvmRawDir(), `${sha256}.json`);
    if (await readTextIfExists(path) === null) {
        await writeTextFileAtomic(path, `${text}\n`, 0o600);
    }
    return {
        sha256,
        bytes: Buffer.byteLength(text, "utf8"),
        path,
    };
}
function toClvmHistoryRecord(record) {
    const { raw: _raw, ...history } = record;
    return history;
}
function buildClvmSampleRecord(source, config, result, raw) {
    const matched = result.matchedConnections;
    return {
        version: clvmStateVersion,
        ok: true,
        status: "ok",
        recorded_at: new Date().toISOString(),
        source,
        config: clvmRecordConfig(config),
        summary: {
            totalConnections: result.totalConnections,
            matchedConnections: matched.length,
            activeConnections: matched.filter((connection) => connection.status === "active").length,
            zeroConnections: matched.filter((connection) => connection.status === "zero").length,
            unknownConnections: matched.filter((connection) => connection.status === "unknown").length,
            closedNow: result.closedConnections?.length ?? 0,
            closeFailed: result.closeFailures?.length ?? 0,
            closedTotal: result.closedTotal ?? 0,
            uploadBytesPerSecond: sumConnectionNumber(matched, "uploadBytesPerSecond"),
            downloadBytesPerSecond: sumConnectionNumber(matched, "downloadBytesPerSecond"),
            uploadBytes: sumConnectionNumber(matched, "uploadTotal"),
            downloadBytes: sumConnectionNumber(matched, "downloadTotal"),
        },
        result: toJsonResult(result),
        raw_ref: null,
        raw,
    };
}
function buildClvmFailureRecord(source, config, failure) {
    return {
        version: clvmStateVersion,
        ok: false,
        status: "unavailable",
        recorded_at: failure.timestamp,
        source,
        config: clvmRecordConfig(config),
        error: failure.error,
        retry: failure.retry,
        raw_ref: null,
        raw: failure.raw,
    };
}
function clvmRecordConfig(config) {
    return {
        baseUrl: config.baseUrl,
        domains: config.domains,
        intervalMs: config.intervalMs,
        zeroSpeedThreshold: config.zeroSpeedThreshold,
        closeZeroForSeconds: config.closeZeroForSeconds,
        autoCloseEnabled: config.autoCloseEnabled,
    };
}
function buildMonitorFailure(error, retry) {
    return {
        timestamp: new Date().toISOString(),
        error: clvmErrorDetail(error),
        retry,
        raw: clvmErrorRaw(error),
    };
}
function buildRetryState(attempt, intervalMs, now = Date.now()) {
    return {
        attempt,
        intervalMs,
        nextAt: new Date(now + intervalMs).toISOString(),
    };
}
export function nextClvmRetryInterval(baseIntervalMs, attempt) {
    if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) {
        throw new Error("base interval must be a positive finite number");
    }
    if (!Number.isFinite(attempt) || attempt <= 0) {
        throw new Error("retry attempt must be a positive finite number");
    }
    const multiplier = clvmRetryMultipliers[attempt - 1] ?? Number.POSITIVE_INFINITY;
    const interval = multiplier === Number.POSITIVE_INFINITY
        ? clvmRetryMaxIntervalMs
        : Math.round(baseIntervalMs * multiplier);
    return Math.min(clvmRetryMaxIntervalMs, Math.max(1, interval));
}
function clvmErrorDetail(error) {
    if (error instanceof ClvmRuntimeError) {
        return {
            code: error.code,
            message: error.message,
            status: error.status,
            statusText: error.statusText,
            body: error.body,
            cause: error.causeDetail,
        };
    }
    return {
        code: "unknown_error",
        message: errorMessage(error),
        cause: errorCauseDetail(error),
    };
}
function clvmErrorRaw(error) {
    if (error instanceof ClvmRuntimeError) {
        return error.raw ?? null;
    }
    return null;
}
function errorCauseDetail(error) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
        };
    }
    return {
        name: typeof error,
        message: String(error),
    };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function sumConnectionNumber(connections, field) {
    return connections.reduce((sum, connection) => {
        const value = connection[field];
        return typeof value === "number" && Number.isFinite(value) ? sum + value : sum;
    }, 0);
}
function recordClosedConnections(closedHistory, closedConnections) {
    const closedAt = new Date().toISOString();
    for (const connection of closedConnections) {
        closedHistory.unshift({
            ...connection,
            closedAt,
        });
    }
    closedHistory.length = Math.min(closedHistory.length, closedHistoryLimit);
}
function buildClvmRawHttpResponse(method, path, response, body) {
    return {
        method,
        path,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        body,
        bodyBytes: Buffer.byteLength(body, "utf8"),
    };
}
export async function closeExpiredConnections(api, result, config, closedIds = new Set()) {
    result.closedConnections = [];
    result.closeFailures = [];
    if (!config.autoCloseEnabled || config.closeZeroForMs === null) {
        return result.closedConnections;
    }
    const currentIds = new Set(result.matchedConnections.map((connection) => connection.id));
    for (const id of closedIds) {
        if (!currentIds.has(id)) {
            closedIds.delete(id);
        }
    }
    const targets = result.matchedConnections.filter((connection) => connection.isIdle && connection.observedIdleMs > config.closeZeroForMs && !closedIds.has(connection.id));
    for (const connection of targets) {
        try {
            await api.closeConnection(connection.id);
            closedIds.add(connection.id);
            result.closedConnections.push(connection);
        }
        catch (error) {
            result.closeFailures.push({
                ...connection,
                failedAt: new Date().toISOString(),
                error: clvmErrorDetail(error),
                raw: clvmErrorRaw(error),
            });
        }
    }
    return result.closedConnections;
}
async function readClvmConfig() {
    const path = clvmConfigPath();
    const text = await readTextIfExists(path);
    if (text === null) {
        return {};
    }
    return parseClvmConfig(text, path);
}
async function readClvmTemplateConfig() {
    const path = clvmTemplatePath();
    const text = await readTextIfExists(path);
    if (text === null) {
        throw new Error(`default clvm config template not found: ${path}`);
    }
    return requireResolvedClvmConfig(parseClvmConfig(text, path), path);
}
async function loadActiveClvmConfig() {
    const templateConfig = await readClvmTemplateConfig();
    const localConfig = await readClvmConfig();
    return mergeClvmConfig(templateConfig, localConfig);
}
export function mergeClvmConfig(base, overlay) {
    return {
        baseUrl: overlay.baseUrl ?? base.baseUrl,
        secret: overlay.secret ?? base.secret,
        domains: overlay.domains ?? base.domains,
        interval: overlay.interval ?? base.interval,
        zeroSpeedThreshold: overlay.zeroSpeedThreshold ?? base.zeroSpeedThreshold,
        closeZeroForSeconds: overlay.closeZeroForSeconds !== undefined
            ? overlay.closeZeroForSeconds
            : base.closeZeroForSeconds,
    };
}
function requireResolvedClvmConfig(config, path) {
    return {
        baseUrl: requireString(config.baseUrl, `${path} baseUrl`),
        secret: requireString(config.secret, `${path} secret`),
        domains: requireStringArray(config.domains, `${path} domains`),
        interval: requireString(config.interval, `${path} interval`),
        zeroSpeedThreshold: requireNumber(config.zeroSpeedThreshold, `${path} zeroSpeedThreshold`),
        closeZeroForSeconds: config.closeZeroForSeconds === undefined
            ? null
            : requireNullableSeconds(config.closeZeroForSeconds, `${path} closeZeroForSeconds`),
    };
}
export function parseClvmConfig(text, path = "clvm.json") {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${path} is not valid JSON: ${message}`);
    }
    if (!isPlainObject(parsed)) {
        throw new Error(`${path} must contain a JSON object`);
    }
    const unknownKeys = Object.keys(parsed).filter((key) => !setupFields.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`${path} has unknown keys: ${unknownKeys.join(", ")}`);
    }
    const config = {};
    if (parsed.baseUrl !== undefined) {
        config.baseUrl = requireString(parsed.baseUrl, "baseUrl");
    }
    if (parsed.secret !== undefined) {
        config.secret = requireString(parsed.secret, "secret");
    }
    if (parsed.domains !== undefined) {
        if (!Array.isArray(parsed.domains)) {
            throw new Error(`${path} domains must be an array of strings`);
        }
        config.domains = parsed.domains.map((domain, index) => requireString(domain, `domains[${index}]`));
    }
    if (parsed.interval !== undefined) {
        config.interval = requireString(parsed.interval, "interval");
    }
    if (parsed.zeroSpeedThreshold !== undefined) {
        if (typeof parsed.zeroSpeedThreshold !== "number") {
            throw new Error(`${path} zeroSpeedThreshold must be a number`);
        }
        config.zeroSpeedThreshold = parseNonNegativeNumber(parsed.zeroSpeedThreshold, "zeroSpeedThreshold");
    }
    if (parsed.closeZeroForSeconds !== undefined) {
        if (parsed.closeZeroForSeconds === null) {
            config.closeZeroForSeconds = null;
        }
        else {
            if (typeof parsed.closeZeroForSeconds !== "number") {
                throw new Error(`${path} closeZeroForSeconds must be a number or null`);
            }
            config.closeZeroForSeconds = parsePositiveSeconds(parsed.closeZeroForSeconds, "closeZeroForSeconds");
        }
    }
    return config;
}
function requireString(value, name) {
    if (typeof value !== "string") {
        throw new Error(`${name} must be a string`);
    }
    return value;
}
function requireStringArray(value, name) {
    if (!Array.isArray(value)) {
        throw new Error(`${name} must be an array of strings`);
    }
    return value.map((entry, index) => requireString(entry, `${name}[${index}]`));
}
function requireNumber(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${name} must be a number`);
    }
    return value;
}
function requireNullableSeconds(value, name) {
    if (value === null) {
        return null;
    }
    return parsePositiveSeconds(value, name);
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function buildRuntimeConfig(fileConfig, options, mode) {
    const baseUrl = options.baseUrl ?? fileConfig.baseUrl;
    const secret = options.secret ?? fileConfig.secret;
    const domains = options.domains !== undefined
        ? normalizeDomains(options.domains)
        : normalizeDomains(fileConfig.domains);
    const interval = options.interval ?? fileConfig.interval;
    const intervalMs = parseDuration(interval, "interval");
    const zeroSpeedThreshold = options.zeroSpeedThreshold ?? fileConfig.zeroSpeedThreshold;
    const closeZeroForSeconds = options.closeZeroForSeconds !== undefined
        ? options.closeZeroForSeconds
        : fileConfig.closeZeroForSeconds;
    new URL(baseUrl);
    if (intervalMs <= 0) {
        throw new Error("interval must be greater than 0");
    }
    if (zeroSpeedThreshold < 0) {
        throw new Error("zero speed threshold must be a non-negative number");
    }
    if (closeZeroForSeconds !== null && closeZeroForSeconds <= 0) {
        throw new Error("closeZeroForSeconds must be a positive number or null");
    }
    return {
        baseUrl,
        secret,
        domains,
        interval,
        intervalMs,
        zeroSpeedThreshold,
        closeZeroForSeconds,
        closeZeroForMs: closeZeroForSeconds === null ? null : closeZeroForSeconds * 1000,
        autoCloseEnabled: mode.autoCloseEnabled,
        once: options.once ?? mode.once,
        json: options.json ?? false,
        clear: (options.clear ?? true) && mode.clear && options.json !== true && options.once !== true,
        color: options.color ?? true,
    };
}
function renderConfigJson(config) {
    return `${JSON.stringify(config, null, 2)}\n`;
}
function readConnections(payload) {
    if (!isPlainObject(payload) || !Array.isArray(payload.connections)) {
        throw new ClvmRuntimeError("invalid_connections_payload", "/connections response must contain a connections array", {
            raw: payload,
        });
    }
    return payload.connections.filter(isPlainObject);
}
function readObjectValue(value, key) {
    return value[key];
}
export function normalizeDomains(values) {
    const domains = values
        .flatMap((value) => String(value ?? "").split(","))
        .map((value) => normalizeHost(value))
        .filter(Boolean);
    return [...new Set(domains)];
}
export function getDomainCandidates(connection) {
    const metadataValue = connection.metadata;
    const metadata = isPlainObject(metadataValue) ? metadataValue : {};
    const candidates = domainFields.map((field) => metadata[field]);
    if (String(connection.rule ?? "").toUpperCase().includes("DOMAIN")) {
        candidates.push(connection.rulePayload);
    }
    return normalizeDomains(candidates);
}
export function findDomainMatch(connection, domains) {
    const candidates = getDomainCandidates(connection);
    for (const candidate of candidates) {
        const domain = domains.find((target) => domainMatches(candidate, target));
        if (domain) {
            return { domain, candidate };
        }
    }
    return null;
}
export function domainMatches(candidate, target) {
    const normalizedCandidate = normalizeHost(candidate);
    const normalizedTarget = normalizeHost(target);
    if (!normalizedCandidate || !normalizedTarget) {
        return false;
    }
    return normalizedCandidate === normalizedTarget || normalizedCandidate.endsWith(`.${normalizedTarget}`);
}
export function parseDuration(value, name = "duration") {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return Math.round(value);
    }
    const text = String(value ?? "").trim();
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u.exec(text);
    if (!match) {
        throw new Error(`${name} must use one of: 500ms, 5s, 3m, 1h`);
    }
    const amount = Number(match[1]);
    const unit = match[2] ?? "ms";
    return Math.round(amount * durationUnits.get(unit));
}
export function nextAlignedDelay(intervalMs, nowMs = Date.now()) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error("interval must be a positive finite number");
    }
    const nextTick = Math.ceil((nowMs + 1) / intervalMs) * intervalMs;
    return Math.max(0, nextTick - nowMs);
}
export function formatDuration(milliseconds) {
    const value = Math.max(0, Math.round(milliseconds));
    if (value < 1000) {
        return `${value}ms`;
    }
    if (value < 60_000) {
        return `${formatNumber(value / 1000)}s`;
    }
    if (value < 3_600_000) {
        return `${formatNumber(value / 60_000)}m`;
    }
    return `${formatNumber(value / 3_600_000)}h`;
}
function parseCloseZeroForSeconds(value) {
    if (value === "off") {
        return null;
    }
    return parsePositiveSeconds(value, "close zero-for seconds");
}
function parsePositiveSeconds(value, name) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`${name} must be a positive number of seconds`);
    }
    return seconds;
}
function parseNonNegativeNumber(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new Error(`${name} must be a non-negative number`);
    }
    return number;
}
function endpointLabel(connection) {
    const metadataValue = connection.metadata;
    const metadata = isPlainObject(metadataValue) ? metadataValue : {};
    const host = metadata.host
        ?? metadata.destinationHost
        ?? metadata.sniffHost
        ?? metadata.sni
        ?? metadata.destinationIP
        ?? "unknown";
    const port = metadata.destinationPort;
    return port ? `${host}:${port}` : String(host);
}
function normalizeHost(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/^\*\./u, "")
        .replace(/^\+\./u, "")
        .replace(/^\./u, "")
        .replace(/\.$/u, "");
}
function statusFor(entry) {
    if (entry.totalBytesPerSecond === null) {
        return "unknown";
    }
    return entry.isIdle ? "zero" : "active";
}
function toEntry(connection, state, domainMatch) {
    const metadataValue = connection.metadata;
    const metadata = isPlainObject(metadataValue) ? metadataValue : {};
    return {
        id: String(connection.id),
        endpoint: endpointLabel(connection),
        process: String(metadata.process ?? metadata.processPath ?? ""),
        rule: [connection.rule, connection.rulePayload].filter(Boolean).join(":"),
        chains: Array.isArray(connection.chains) ? connection.chains.map(String) : [],
        matchedDomain: domainMatch.domain,
        matchedValue: domainMatch.candidate,
        ageMs: Math.max(0, state.lastSeenMs - state.startMs),
        observedIdleMs: state.observedIdleMs,
        uploadTotal: state.uploadTotal,
        downloadTotal: state.downloadTotal,
        uploadBytesPerSecond: state.uploadBytesPerSecond,
        downloadBytesPerSecond: state.downloadBytesPerSecond,
        totalBytesPerSecond: state.totalBytesPerSecond,
        isIdle: state.isIdle,
    };
}
function readSpeeds(connection, previous, { elapsedSeconds, uploadTotal, downloadTotal }) {
    const explicitUploadSpeed = numberOrNull(connection.uploadSpeed);
    const explicitDownloadSpeed = numberOrNull(connection.downloadSpeed);
    if (explicitUploadSpeed !== null || explicitDownloadSpeed !== null) {
        const uploadBytesPerSecond = explicitUploadSpeed ?? 0;
        const downloadBytesPerSecond = explicitDownloadSpeed ?? 0;
        return {
            uploadBytesPerSecond,
            downloadBytesPerSecond,
            totalBytesPerSecond: uploadBytesPerSecond + downloadBytesPerSecond,
            coversPreviousInterval: false,
        };
    }
    if (!previous || elapsedSeconds <= 0) {
        return {
            uploadBytesPerSecond: null,
            downloadBytesPerSecond: null,
            totalBytesPerSecond: null,
            coversPreviousInterval: false,
        };
    }
    const uploadBytesPerSecond = Math.max(0, (uploadTotal - previous.uploadTotal) / elapsedSeconds);
    const downloadBytesPerSecond = Math.max(0, (downloadTotal - previous.downloadTotal) / elapsedSeconds);
    return {
        uploadBytesPerSecond,
        downloadBytesPerSecond,
        totalBytesPerSecond: uploadBytesPerSecond + downloadBytesPerSecond,
        coversPreviousInterval: true,
    };
}
function parseStartTime(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value > 1_000_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}
function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
function numberOrZero(value) {
    return numberOrNull(value) ?? 0;
}
function formatNumber(value) {
    return formatThreeSignificant(value);
}
function formatThreeSignificant(value) {
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
function formatSeconds(seconds) {
    if (seconds < 60) {
        return `${formatNumber(seconds)}s`;
    }
    return `${formatNumber(seconds / 60)}m`;
}
function printMonitorResult(result, config, stream = process.stdout) {
    if (config.json) {
        stream.write(`${JSON.stringify(toJsonResult(result))}\n`);
        return;
    }
    if (config.clear) {
        stream.write("\x1B[2J\x1B[H");
    }
    const closed = result.closedConnections ?? [];
    const closeFailures = result.closeFailures ?? [];
    const closedHistory = result.closedHistory ?? [];
    const closedTotal = result.closedTotal ?? 0;
    const shownConnections = sortConnections(result.matchedConnections);
    const style = createStyle(config);
    const header = [
        style.dim(formatLocalTimestamp(result.timestamp)),
        style.cyan(`domains=${config.domains.join(",")}`),
        style.blue(`current=${result.matchedConnections.length}`),
        style.dim(`refresh=${formatDuration(config.intervalMs)}`),
    ];
    if (config.closeZeroForSeconds === null) {
        header.push(style.dim("autoClose=off"));
        header.push(style.dim("closeAfter=none"));
    }
    else {
        header.push(config.autoCloseEnabled ? style.red(style.bold("autoClose=on")) : style.dim("autoClose=configured"));
        header.push(style.dim(`closeAfter=${formatSeconds(config.closeZeroForSeconds)}`));
    }
    if (config.zeroSpeedThreshold > 0) {
        header.push(style.dim(`zero<=${formatSpeed(config.zeroSpeedThreshold)}`));
    }
    if (config.autoCloseEnabled && config.closeZeroForSeconds !== null) {
        if (closed.length > 0) {
            header.push(style.red(style.bold(`closedNow=${closed.length}`)));
        }
        if (closeFailures.length > 0) {
            header.push(style.red(style.bold(`closeFailed=${closeFailures.length}`)));
        }
        if (closedTotal > 0) {
            header.push(style.dim(`closedTotal=${closedTotal}`));
        }
    }
    stream.write(`${header.join(" ")}\n`);
    const layout = buildLayout(stream);
    if (shownConnections.length === 0) {
        stream.write("no current connections for configured domains\n");
    }
    else {
        printCurrentConnections(shownConnections, layout, style, stream);
    }
    printClosedHistory(closedHistory, layout, style, stream);
}
function printMonitorFailure(failure, config, stream = process.stdout) {
    if (config.json) {
        stream.write(`${JSON.stringify(toJsonFailure(failure))}\n`);
        return;
    }
    if (config.clear) {
        stream.write("\x1B[2J\x1B[H");
    }
    const style = createStyle(config);
    const header = [
        style.dim(formatLocalTimestamp(failure.timestamp)),
        style.cyan(`domains=${config.domains.join(",")}`),
        style.red("status=unavailable"),
        style.dim(`error=${failure.error.code}`),
    ];
    if (failure.retry) {
        header.push(style.dim(`attempt=${failure.retry.attempt}`));
        header.push(style.dim(`retry=${formatDuration(failure.retry.intervalMs)}`));
        header.push(style.dim(`next=${formatLocalTimestamp(failure.retry.nextAt)}`));
    }
    stream.write(`${header.join(" ")}\n`);
    stream.write(`${style.red("error:")} ${failure.error.message}\n`);
}
function printCurrentConnections(shownConnections, layout, style, stream) {
    const rows = shownConnections.map((connection) => ({
        status: statusCell(connection.status, style),
        endpoint: style.cyan(connection.endpoint),
        age: formatDuration(connection.ageMs),
        zeroFor: formatDuration(connection.observedIdleMs),
        up: speedCell(connection.uploadBytesPerSecond, style),
        down: speedCell(connection.downloadBytesPerSecond, style),
        upload: bytesCell(connection.uploadTotal, style),
        download: bytesCell(connection.downloadTotal, style),
        chain: style.magenta(connection.chains.join(" > ")),
        rule: style.dim(connection.rule),
    }));
    stream.write(`${renderTable(currentConnectionColumns(layout), rows, { gap: 1, maxWidth: layout.maxWidth }).join("\n")}\n`);
}
function printClosedHistory(closedHistory, layout, style, stream) {
    if (closedHistory.length === 0) {
        return;
    }
    stream.write(`\n${style.bold("recent closed")}\n`);
    const rows = closedHistory.map((connection) => ({
        closedAt: formatLocalTimestamp(connection.closedAt),
        endpoint: style.cyan(connection.endpoint),
        zeroFor: formatDuration(connection.observedIdleMs),
        upload: bytesCell(connection.uploadTotal, style),
        download: bytesCell(connection.downloadTotal, style),
        chain: style.magenta(connection.chains.join(" > ")),
        rule: style.dim(connection.rule),
    }));
    stream.write(`${renderTable(closedConnectionColumns(layout), rows, { gap: 1, maxWidth: layout.maxWidth }).join("\n")}\n`);
}
function toJsonResult(result) {
    return {
        ok: true,
        status: "ok",
        timestamp: result.timestamp,
        totalConnections: result.totalConnections,
        matchedConnections: result.matchedConnections,
        closedConnections: result.closedConnections ?? [],
        closeFailures: result.closeFailures ?? [],
        closedHistory: result.closedHistory ?? [],
        closedTotal: result.closedTotal ?? 0,
    };
}
function toJsonFailure(failure) {
    return {
        ok: false,
        status: "unavailable",
        timestamp: failure.timestamp,
        error: failure.error,
        retry: failure.retry ?? null,
    };
}
function formatUnavailableStatus(failure, style) {
    return `${style.red("unavailable")} ${style.dim(failure.error.code)} ${failure.error.message}`;
}
function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond === null) {
        return "[unknown]";
    }
    return `${formatByteQuantity(bytesPerSecond)}/s`;
}
function formatBytes(bytes) {
    if (bytes === null) {
        return "[unknown]";
    }
    return formatByteQuantity(bytes);
}
function formatByteQuantity(bytes) {
    const value = Math.max(0, bytes);
    const units = ["B", "K", "M", "G", "T"];
    let scaled = value;
    let unitIndex = 0;
    while (scaled >= 1024 && unitIndex < units.length - 1) {
        scaled /= 1024;
        unitIndex += 1;
    }
    return `${unitIndex === 0 ? Math.round(scaled).toString() : formatThreeSignificant(scaled)}${units[unitIndex]}`;
}
function formatLocalTimestamp(value) {
    const date = new Date(value);
    return [
        date.getFullYear(),
        padNumber(date.getMonth() + 1),
        padNumber(date.getDate()),
    ].join("-") + ` ${[
        padNumber(date.getHours()),
        padNumber(date.getMinutes()),
        padNumber(date.getSeconds()),
    ].join(":")}`;
}
function sortConnections(connections) {
    return [...connections].sort((left, right) => {
        const statusOrder = statusRank(left.status) - statusRank(right.status);
        if (statusOrder !== 0) {
            return statusOrder;
        }
        return right.observedIdleMs - left.observedIdleMs || right.ageMs - left.ageMs;
    });
}
function statusRank(status) {
    return {
        zero: 0,
        unknown: 1,
        active: 2,
    }[status] ?? 4;
}
function currentConnectionColumns(layout) {
    const columns = [
        { key: "status", title: "status", width: layout.status },
        { key: "endpoint", title: "endpoint", width: layout.endpoint },
        { key: "age", title: "age", width: layout.age },
        { key: "zeroFor", title: "zeroFor", width: layout.zeroFor },
        { key: "up", title: "up/s", width: layout.up, align: "right" },
        { key: "down", title: "down/s", width: layout.down, align: "right" },
    ];
    if (layout.showTrafficTotals) {
        columns.push({ key: "upload", title: "upload", width: layout.upload, align: "right" }, { key: "download", title: "download", width: layout.download, align: "right" });
    }
    if (layout.showChain) {
        columns.push({ key: "chain", title: "chain", width: layout.chain });
    }
    columns.push({ key: "rule", title: "rule", flex: true, minWidth: layout.ruleMin });
    return columns;
}
function closedConnectionColumns(layout) {
    const columns = [
        { key: "closedAt", title: "closedAt", width: 19 },
        { key: "endpoint", title: "endpoint", width: layout.endpoint },
        { key: "zeroFor", title: "zeroFor", width: layout.zeroFor },
    ];
    if (layout.showTrafficTotals) {
        columns.push({ key: "upload", title: "upload", width: layout.upload, align: "right" }, { key: "download", title: "download", width: layout.download, align: "right" });
    }
    if (layout.showChain) {
        columns.push({ key: "chain", title: "chain", width: layout.chain });
    }
    columns.push({ key: "rule", title: "rule", flex: true, minWidth: layout.ruleMin });
    return columns;
}
function statusCell(status, style) {
    const text = formatStatus(status);
    if (status === "zero") {
        return style.yellow(text);
    }
    if (status === "active") {
        return style.green(text);
    }
    return style.dim(text);
}
function speedCell(bytesPerSecond, style) {
    const text = formatSpeed(bytesPerSecond);
    if (bytesPerSecond === null || bytesPerSecond === 0) {
        return style.dim(text);
    }
    return style.green(text);
}
function bytesCell(bytes, style) {
    const text = formatBytes(bytes);
    if (bytes === null || bytes === 0) {
        return style.dim(text);
    }
    return text;
}
function buildLayout(stream) {
    const maxWidth = terminalColumns(stream);
    const fixed = {
        status: 9,
        endpoint: maxWidth >= 120 ? 28 : 22,
        age: 7,
        zeroFor: 7,
        up: 10,
        down: 10,
        upload: 8,
        download: 8,
        chain: maxWidth >= 120 ? 20 : 14,
    };
    return {
        maxWidth,
        showTrafficTotals: maxWidth >= 96,
        showChain: maxWidth >= 72,
        ...fixed,
        ruleMin: maxWidth >= 72 ? 12 : 4,
    };
}
function terminalColumns(stream) {
    const columns = Number.isFinite(stream.columns) ? stream.columns : process.stdout.columns;
    return columns && columns > 0 ? Math.floor(columns) : 120;
}
function formatStatus(status) {
    return status === "unknown" ? "[unknown]" : status;
}
function createStyle(config) {
    if (config.color === false) {
        return {
            bold: identity,
            blue: identity,
            cyan: identity,
            dim: identity,
            green: identity,
            magenta: identity,
            red: identity,
            yellow: identity,
        };
    }
    return {
        bold: textBold,
        blue: textBlue,
        cyan: textCyan,
        dim: textDim,
        green: textGreen,
        magenta: textMagenta,
        red: textRed,
        yellow: textYellow,
    };
}
function identity(value) {
    return value;
}
function padNumber(value) {
    return String(value).padStart(2, "0");
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
