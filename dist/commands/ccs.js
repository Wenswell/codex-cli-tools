import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as asciichart from "asciichart";
import { createTwoFilesPatch } from "diff";
import { DateTime } from "luxon";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { aggregateDaily, aggregateDayProjects, aggregateDayTimeBuckets, aggregateMonthly, aggregateProjectDaily, aggregateProjects, aggregateWeekly, addUsage, dateRangeForDay, emptyAggregate, filterCodexUsageEvents, formatProjectPath, loadCodexUsageEvents, resolveProjectPath, systemTimezone, totalAggregate, } from "../lib/codex-usage.js";
import { ensureDir, readTextIfExists, writeTextFile, writeTextFileAtomic } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexAgentsPath, codexAuthPath, codexConfigPath, codexDir, codexToolsCacheDir, modelPricesConfigPath, codexToolsConfigDir, profilesPath, weztermConfigPath, } from "../lib/paths.js";
import { appendBoundedJsonLine, writeJsonStateAtomic } from "../lib/runtime-log.js";
import { buildModelPriceSnapshotPlanFromRemoteCatalog, calculateCodexCostBreakdown, litellmPricingUrl, matchingModelNames, missingPricingModels, modelPriceParts, modelPricingStatus, normalizeModelPricePatterns, normalizeModelPriceProviders, pruneModelPriceCache, readModelPriceCache, readModelPriceCacheForModels, readRemoteModelPriceCatalog, readStoredModelPriceCache, resolveCodexCostSpeed, selectRemoteModelPrices, writeModelPriceCache, writeModelPriceSnapshotPlan, } from "../lib/pricing.js";
import { bgDarkBlue, maskSecret, textBlue, textBold, textDim, textGreen, textRed, textYellow, padVisibleLeft, padVisibleRight, visibleLength, } from "../lib/text.js";
import { colorCost, colorHost, colorInput, colorName, colorOutput, colorPath, colorUrl, printKeyValue, } from "../lib/output.js";
import { ensureProxyRunning, readProxyState, resolveProxySwitchBaseUrl, runProxyCommand } from "./ccs-proxy.js";
import { syncTomlTemplate, readTomlBaseUrl, readTopLevelTomlString, updateTomlBaseUrl, } from "../lib/toml.js";
import { printTable, renderTable } from "../lib/table.js";
import { fitTerminalLine } from "../lib/terminal.js";
import { isVersionArgument, printToolVersionIfRequested } from "../lib/version.js";
const execFile = promisify(execFileCallback);
const usageTopMinIntervalMs = 25_000;
const usageTopStepIntervalMs = 30_000;
const usageTopMaxIntervalMs = 300_000;
const usageTopServerIntervalsMs = [
    25_000,
    60_000,
    120_000,
    300_000,
    600_000,
    900_000,
];
const usageTopMaxIntervalIdleLimit = 3;
const usageTopDefaultMarkIntervalMs = 5 * 60 * 1000;
const usageTopTickMs = 1000;
const usageTopChangeTtlMs = 60 * 60 * 1000;
const usageTopChangeColorTtlMs = 60 * 1000;
const usageTopMaxDisplayDelta = 10;
const usageTopStatusWidth = 24;
const usageTopMarkNameWidth = 8;
const usageTopMarkDeltaWidth = 5;
const usageTopSnapshotActiveTtlMs = 5_000;
const usageTopHistoryWindowMs = 24 * 60 * 60 * 1000;
const usageTopHistoryBucketMs = 30 * 60 * 1000;
const usageTopHistoryRetentionMs = usageTopHistoryWindowMs + usageTopHistoryBucketMs;
const usageTopHistoryMaxWindowMs = usageTopHistoryRetentionMs;
const usageTopHistoryBucketMinutes = usageTopHistoryBucketMs / (60 * 1000);
const usageTopHistorySummaryDeltaMs = 5 * 60 * 60 * 1000;
const usageTopHistoryEpsilon = 0.05;
const usageTopHistoryChartMinWidth = 56;
const usageTopHistoryChartMinIntervals = 3;
const usageTopHistoryChartMaxIntervals = 6;
const usageTopHistoryChartTargetIntervals = 5;
const usageTopHistoryChartAxisPrefix = 9;
const usageTopHistoryChartSummaryGap = 4;
const usageTopHistoryChartNamedProviderLimit = 2;
const usageTopHistoryOtherName = "other";
const usageTopHistoryTailBlockBytes = 64 * 1024;
const usageTopHistoryMaxBytes = 64 * 1024 * 1024;
const weztermStatusUpdateIntervalMs = 250;
const weztermStatusStaleAfterSeconds = 2;
const usageHttpTimeoutMs = 5_000;
const modelsHttpTimeoutMs = 5_000;
const usageTopHttpTimeoutMs = 5_000;
const usageTopHistoryHttpTimeoutMs = 5_000;
const ccsCostReportHttpTimeoutMs = 30_000;
const ccsCostRefreshHttpTimeoutMs = 5_000;
const ccsCostRefreshDebounceMs = 5 * 60 * 1000;
const configSyncUser = "ravvss";
const configSyncHost = "10.126.126.1";
const configSyncPort = "32753";
const configSyncRemotePath = "/home/ravvss/.config/codex-tools/profiles.json";
const configSyncRemoteDisplay = `${configSyncUser}@${configSyncHost}:${configSyncRemotePath}`;
const ccsCostRemoteDir = "/home/ravvss/.cache/codex-tools/ccs-cost";
const ccsCostRemoteDisplay = `${configSyncUser}@${configSyncHost}:${ccsCostRemoteDir}`;
const weztermStatusBegin = "-- ccs wezterm status begin";
const weztermStatusEnd = "-- ccs wezterm status end";
function assertProfile(value, name) {
    if (!value || typeof value !== "object") {
        throw new Error(`profile ${name} is invalid`);
    }
    const profile = value;
    if (typeof profile.baseURL !== "string" || typeof profile.apiKey !== "string") {
        throw new Error(`profile ${name} is missing baseURL or apiKey`);
    }
    return { baseURL: profile.baseURL, apiKey: profile.apiKey };
}
async function readProfiles() {
    const text = await readTextIfExists(profilesPath());
    if (!text) {
        return {};
    }
    try {
        return parseJsonObject(text);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid profiles.json: ${message}`);
    }
}
async function writeProfiles(profiles) {
    await writeTextFileAtomic(profilesPath(), stringifyJson(profiles), 0o600);
}
async function readDefaultProfiles() {
    const path = fileURLToPath(new URL("../../config/ccs-profiles.json", import.meta.url));
    const text = await readTextIfExists(path);
    if (!text) {
        throw new Error(`default profiles template not found: ${path}`);
    }
    return parseJsonObject(text);
}
async function readDefaultCodexConfig() {
    const path = fileURLToPath(new URL("../../config/codex-config.toml", import.meta.url));
    const text = await readTextIfExists(path);
    if (!text) {
        throw new Error(`default Codex config template not found: ${path}`);
    }
    return text;
}
async function readDefaultCodexAgents() {
    const path = fileURLToPath(new URL("../../config/codex-agents.md", import.meta.url));
    const text = await readTextIfExists(path);
    if (!text) {
        throw new Error(`default Codex AGENTS template not found: ${path}`);
    }
    return text;
}
async function readCurrentCodexProfile() {
    const configText = (await readTextIfExists(codexConfigPath())) ?? "";
    const authText = (await readTextIfExists(codexAuthPath())) ?? "";
    const auth = authText ? parseJsonObject(authText) : {};
    const apiKey = typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "";
    return {
        baseURL: readTomlBaseUrl(configText) ?? "",
        apiKey,
    };
}
function getCcsBackupFiles() {
    return [
        { source: codexConfigPath(), target: "config.toml" },
        { source: codexAgentsPath(), target: "AGENTS.md" },
        { source: codexAuthPath(), target: "auth.json" },
        { source: profilesPath(), target: "profiles.json" },
    ];
}
async function getExistingBackupFiles() {
    const existing = [];
    for (const file of getCcsBackupFiles()) {
        if ((await readTextIfExists(file.source)) !== null) {
            existing.push(file);
        }
    }
    return existing;
}
async function backupCcsFiles(files) {
    const backupDir = join(codexToolsConfigDir(), "backups", `ccs-${formatTimestamp(new Date())}`);
    for (const file of files) {
        const content = await readTextIfExists(file.source);
        if (content === null)
            continue;
        await writeTextFile(join(backupDir, file.target), content, 0o600);
    }
    return files.length > 0 ? backupDir : null;
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
async function planCodexConfigSync(replacePaths = new Set()) {
    const defaults = await readDefaultCodexConfig();
    const existing = (await readTextIfExists(codexConfigPath())) ?? "";
    const sync = syncTomlTemplate(defaults, existing, replacePaths);
    return {
        nextContent: sync.content,
        differentPaths: sync.differentPaths,
        updatedPaths: sync.updatedPaths,
    };
}
async function syncCodexConfigFromTemplate() {
    await ensureDir(codexDir());
    const plan = await planCodexConfigSync();
    await writeTextFile(codexConfigPath(), plan.nextContent);
    return plan;
}
async function syncCodexAgentsFromTemplate() {
    await ensureDir(codexDir());
    const next = await readDefaultCodexAgents();
    await writeTextFile(codexAgentsPath(), next);
    return next;
}
async function planInitProfilesFromCurrent() {
    const defaults = await readDefaultProfiles();
    const existing = await readProfiles();
    const existingProfilesText = await readTextIfExists(profilesPath());
    const shouldCaptureCurrent = existingProfilesText === null;
    const defaultProfiles = defaults.profiles ?? {};
    const existingProfiles = existing.profiles ?? {};
    const profiles = { ...existingProfiles };
    for (const [name, defaultProfile] of Object.entries(defaultProfiles)) {
        const existingProfile = existingProfiles[name];
        profiles[name] = {
            baseURL: defaultProfile.baseURL,
            apiKey: existingProfile?.apiKey || defaultProfile.apiKey,
        };
    }
    if (shouldCaptureCurrent) {
        const current = await readCurrentCodexProfile();
        profiles.current = {
            baseURL: current.baseURL,
            apiKey: current.apiKey,
        };
    }
    const next = {
        ...existing,
        ...defaults,
        profiles,
        current: shouldCaptureCurrent ? "current" : (existing.current ?? defaults.current),
        toggle: existing.toggle ?? defaults.toggle,
        top: existing.top ?? defaults.top,
    };
    return next;
}
async function initProfilesFromCurrent() {
    const next = await planInitProfilesFromCurrent();
    await writeProfiles(next);
    return next;
}
async function planSyncProfiles() {
    const defaults = await readDefaultProfiles();
    const existing = await readProfiles();
    const defaultProfiles = defaults.profiles ?? {};
    const existingProfiles = existing.profiles ?? {};
    const nextProfiles = { ...existingProfiles };
    for (const [name, defaultProfile] of Object.entries(defaultProfiles)) {
        const current = existingProfiles[name];
        nextProfiles[name] = {
            baseURL: defaultProfile.baseURL,
            apiKey: current?.apiKey || defaultProfile.apiKey,
        };
    }
    const next = {
        ...existing,
        profiles: nextProfiles,
        current: existing.current ?? defaults.current,
        toggle: existing.toggle ?? defaults.toggle,
        top: existing.top ?? defaults.top,
    };
    return next;
}
async function syncProfiles() {
    const next = await planSyncProfiles();
    await writeProfiles(next);
    return next;
}
function configFileHash(text) {
    return createHash("sha256").update(text).digest("hex");
}
function formatConfigSummary(summary) {
    if (!summary.exists) {
        return textDim("missing");
    }
    const size = summary.size === undefined ? "?" : `${summary.size}b`;
    const mtime = summary.mtime ? formatClockTime(summary.mtime) : "?";
    return `${size} ${textDim(mtime)}`;
}
async function readLocalConfigText() {
    const text = await readTextIfExists(profilesPath());
    if (text === null) {
        throw new Error(`local profiles.json not found: ${profilesPath()}`);
    }
    try {
        parseJsonObject(text);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid local profiles.json: ${message}`);
    }
    return text;
}
async function localConfigSummary() {
    const text = await readTextIfExists(profilesPath());
    if (text === null) {
        return { exists: false };
    }
    const file = await stat(profilesPath());
    return {
        exists: true,
        size: file.size,
        sha256: configFileHash(text),
        mtime: file.mtime,
    };
}
async function execConfigSyncFile(command, args) {
    try {
        return await execFile(command, args, { maxBuffer: 10 * 1024 * 1024 });
    }
    catch (error) {
        const stderr = typeof error.stderr === "string"
            ? error.stderr.trim()
            : "";
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(stderr || message);
    }
}
async function configSyncSsh(script) {
    const { stdout } = await execConfigSyncFile("ssh", [
        "-p",
        configSyncPort,
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "StrictHostKeyChecking=accept-new",
        `${configSyncUser}@${configSyncHost}`,
        script,
    ]);
    return stdout;
}
async function configSyncScp(source, target) {
    await execConfigSyncFile("scp", [
        "-P",
        configSyncPort,
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "StrictHostKeyChecking=accept-new",
        source,
        target,
    ]);
}
async function remoteConfigSummary() {
    const script = [
        `p=${JSON.stringify(configSyncRemotePath)}`,
        'if [ -f "$p" ]; then',
        '  size=$(wc -c < "$p" | tr -d " ")',
        '  hash=$(sha256sum "$p" | awk \'{print $1}\')',
        '  mtime=$(stat -c %Y "$p")',
        '  printf "exists\\t%s\\t%s\\t%s\\n" "$size" "$hash" "$mtime"',
        "else",
        '  printf "missing\\n"',
        "fi",
    ].join("\n");
    const output = (await configSyncSsh(script)).trim();
    if (output === "missing") {
        return { exists: false };
    }
    const [status, size, sha256, mtime] = output.split("\t");
    if (status !== "exists") {
        throw new Error(`unexpected remote status: ${output}`);
    }
    return {
        exists: true,
        size: Number(size),
        sha256,
        mtime: new Date(Number(mtime) * 1000),
    };
}
async function readRemoteConfigTextIfExists(remote) {
    if (!remote.exists) {
        return null;
    }
    return configSyncSsh(`cat ${JSON.stringify(configSyncRemotePath)}`);
}
function printConfigSyncPlan(action, local, remote, localText, remoteText) {
    console.log(textBold(`ccs config ${action}`));
    printKeyValue("local:", `${colorPath(profilesPath())}  ${formatConfigSummary(local)}`, 9);
    printKeyValue("remote:", `${colorPath(configSyncRemoteDisplay)}  ${formatConfigSummary(remote)}`, 9);
    const same = local.exists && remote.exists && local.sha256 === remote.sha256;
    printKeyValue("same:", same ? textGreen("yes") : textRed("no"), 9);
    if (action === "push") {
        printKeyValue("action:", "upload local profiles.json to LAN server", 9);
    }
    else if (action === "pull") {
        printKeyValue("action:", "download LAN server profiles.json to local", 9);
    }
    else {
        printKeyValue("action:", "status only", 9);
    }
    if (action !== "status") {
        console.log(textDim("no changes are written unless you type yes at the prompt."));
    }
    printConfigSyncDiff(action, localText, remoteText);
}
function printConfigSyncDiff(action, localText, remoteText) {
    if (localText === null && remoteText === null) {
        printKeyValue("diff:", textDim("none"), 9);
        return;
    }
    const file = action === "push"
        ? {
            label: "profiles.json",
            path: configSyncRemoteDisplay,
            current: remoteText ?? "",
            next: localText ?? "",
        }
        : {
            label: "profiles.json",
            path: action === "pull" ? profilesPath() : `${profilesPath()} <-> ${configSyncRemoteDisplay}`,
            current: localText ?? "",
            next: remoteText ?? "",
        };
    if (normalizePreviewContent(file.label, file.current) === normalizePreviewContent(file.label, file.next)) {
        printKeyValue("diff:", textDim("none"), 9);
        return;
    }
    printDiffBlock(file);
}
function printConfigSyncStatus(local) {
    console.log(textBold("ccs config"));
    printKeyValue("local:", `${colorPath(profilesPath())}  ${formatConfigSummary(local)}`, 9);
    printKeyValue("remote:", colorPath(configSyncRemoteDisplay), 9);
    printKeyValue("action:", "status only", 9);
    console.log(textDim("commands: ccs config | ccs config push | ccs config pull"));
}
async function pushConfigToServer(local, remote) {
    await readLocalConfigText();
    if (remote.exists && local.sha256 === remote.sha256) {
        console.log(textDim("already synced"));
        return;
    }
    const tmpRemotePath = `${configSyncRemotePath}.${process.pid}.${Date.now()}.tmp`;
    const backupRemotePath = `${configSyncRemotePath}.backup-${formatTimestamp(new Date())}`;
    await configSyncSsh([
        `dir=$(dirname ${JSON.stringify(configSyncRemotePath)})`,
        'mkdir -p "$dir"',
    ].join("\n"));
    await configSyncScp(profilesPath(), `${configSyncUser}@${configSyncHost}:${tmpRemotePath}`);
    await configSyncSsh([
        `p=${JSON.stringify(configSyncRemotePath)}`,
        `tmp=${JSON.stringify(tmpRemotePath)}`,
        `backup=${JSON.stringify(backupRemotePath)}`,
        'if [ -f "$p" ]; then cp -p "$p" "$backup"; fi',
        'chmod 600 "$tmp"',
        'mv "$tmp" "$p"',
        'printf "%s\\n" "$backup"',
    ].join("\n"));
    console.log(`uploaded: ${textGreen(configSyncRemoteDisplay)}`);
    if (remote.exists) {
        console.log(`remote backup: ${textBlue(`${configSyncUser}@${configSyncHost}:${backupRemotePath}`)}`);
    }
}
async function pullConfigFromServer(local, remote) {
    if (!remote.exists) {
        throw new Error(`remote profiles.json not found: ${configSyncRemoteDisplay}`);
    }
    if (local.exists && local.sha256 === remote.sha256) {
        console.log(textDim("already synced"));
        return;
    }
    const tempDir = await mkdtemp(join(tmpdir(), "ccs-config-"));
    const tempPath = join(tempDir, "profiles.json");
    try {
        await configSyncScp(`${configSyncUser}@${configSyncHost}:${configSyncRemotePath}`, tempPath);
        const nextText = await readFile(tempPath, "utf8");
        try {
            parseJsonObject(nextText);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`invalid remote profiles.json: ${message}`);
        }
        const backupDir = await backupCcsFiles([{ source: profilesPath(), target: "profiles.json" }]);
        await writeTextFileAtomic(profilesPath(), nextText, 0o600);
        if (backupDir) {
            console.log(`backup: ${textBlue(backupDir)}`);
        }
        console.log(`downloaded: ${textGreen(profilesPath())}`);
    }
    finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}
async function runConfigSync(args) {
    if (isHelpArgument(args[0])) {
        assertExactArgs(args.slice(1), "config help", 0);
        printHelp();
        return;
    }
    const options = parseConfigSyncArgs(args);
    const local = await localConfigSummary();
    if (options.action === "status") {
        printConfigSyncStatus(local);
        return;
    }
    const remote = await remoteConfigSummary();
    const localText = await readTextIfExists(profilesPath());
    const remoteText = await readRemoteConfigTextIfExists(remote);
    printConfigSyncPlan(options.action, local, remote, localText, remoteText);
    if (!(await confirmApply())) {
        return;
    }
    if (options.action === "push") {
        await pushConfigToServer(local, remote);
        return;
    }
    await pullConfigFromServer(local, remote);
}
function assertNameAvailable(name, profiles, target) {
    const other = target === "profiles" ? profiles.usage : profiles.profiles;
    if (other?.[name]) {
        throw new Error(`${name} already exists in ${target === "profiles" ? "usage" : "profiles"}`);
    }
}
function assertOnlyFlags(argv, command, allowed) {
    for (const arg of argv) {
        if (!allowed.includes(arg)) {
            throw new Error(`unknown argument for ccs ${command}: ${arg}`);
        }
    }
}
function assertMaxArgs(argv, command, count) {
    if (argv.length > count) {
        throw new Error(`usage: ccs ${command}`);
    }
}
function assertExactArgs(argv, command, count) {
    if (argv.length !== count) {
        throw new Error(`usage: ccs ${command}`);
    }
}
function parseConfigSyncArgs(args) {
    rejectRemovedYesFlags(args, "ccs config");
    const action = (args[0] ?? "status");
    if (action !== "status" && action !== "push" && action !== "pull") {
        throw new Error(`unknown argument for ccs config: ${action}`);
    }
    const flags = args.slice(args[0] ? 1 : 0);
    assertOnlyFlags(flags, `config ${action}`, []);
    return { action };
}
function parseDurationMs(value) {
    const match = /^(\d+)(s|m|h)?$/.exec(value.trim());
    if (!match) {
        throw new Error(`invalid duration: ${value}`);
    }
    const amount = Number(match[1]);
    const unit = match[2] ?? "s";
    const multiplier = unit === "h" ? 60 * 60 * 1000 : unit === "m" ? 60 * 1000 : 1000;
    return amount * multiplier;
}
function nextAlignedTimeMs(now, interval) {
    return Math.ceil((now + 1) / interval) * interval;
}
function msUntilNextAlignedTime(cycleStart, interval, now = Date.now()) {
    return Math.max(0, nextAlignedTimeMs(cycleStart, interval) - now);
}
function formatList(values) {
    return values.length > 0 ? values.join(", ") : "(none)";
}
function printPreviewSummary(title, modifiedFiles, backupFiles, warnings, dryRun) {
    console.log(textBold(`Plan: ${title}`));
    if (dryRun) {
        console.log(textDim("no changes are written unless you type yes at the prompt."));
    }
    console.log(`Will modify: ${textBlue(formatList(modifiedFiles))}`);
    console.log(`Will back up: ${textBlue(formatList(backupFiles))}`);
    console.log(`Warnings: ${warnings.length === 0 ? textDim("0") : textRed(String(warnings.length))}`);
}
function collectChangedPreviewFiles(files) {
    return files.filter((file) => {
        const current = normalizePreviewContent(file.label, file.current);
        const next = normalizePreviewContent(file.label, file.next);
        return current !== next;
    });
}
function collectExistingBackupFilesForPaths(paths) {
    const wanted = new Set(paths);
    return getExistingBackupFiles().then((files) => files.filter((file) => wanted.has(file.source)));
}
function printDiffBlock(file) {
    const current = normalizePreviewContent(file.label, file.current);
    const next = normalizePreviewContent(file.label, file.next);
    if (current === next) {
        return;
    }
    const redactedCurrent = normalizePreviewContent(file.label, redactPreviewSecrets(file.current));
    const redactedNext = normalizePreviewContent(file.label, redactPreviewSecrets(file.next));
    console.log("");
    console.log(`${textBold("File:")} ${textBlue(file.path)}`);
    if (redactedCurrent === redactedNext) {
        console.log(textDim("  changes only affect masked secret values"));
        return;
    }
    const patch = createTwoFilesPatch(`current/${file.label}`, `next/${file.label}`, redactedCurrent, redactedNext, "", "", { context: 3 });
    const lines = patch.split("\n");
    for (const line of lines) {
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
function redactPreviewSecrets(content) {
    return content
        .replace(/("apiKey"\s*:\s*")([^"]*)(")/g, (_match, before, value, after) => {
        return `${before}${maskSecretValue(value)}${after}`;
    })
        .replace(/("OPENAI_API_KEY"\s*:\s*")([^"]*)(")/g, (_match, before, value, after) => {
        return `${before}${maskSecretValue(value)}${after}`;
    });
}
function maskSecretValue(value) {
    if (!value) {
        return value;
    }
    return maskSecret(value);
}
function normalizePreviewContent(label, content) {
    if (label.endsWith(".json")) {
        return normalizeJsonPreview(content);
    }
    if (label.endsWith(".toml")) {
        return normalizeTomlPreview(content);
    }
    return content;
}
function normalizeJsonPreview(content) {
    const trimmed = content.trim();
    if (!trimmed) {
        return "";
    }
    try {
        return stringifyJson(JSON.parse(trimmed));
    }
    catch {
        return content;
    }
}
function normalizeTomlPreview(content) {
    const normalized = content.replace(/\r\n/g, "\n");
    const lines = normalized
        .split("\n")
        .map((line) => stripTomlInlineComment(line).trimEnd());
    const compact = [];
    let previousBlank = false;
    for (const line of lines) {
        const isBlank = line.trim() === "";
        if (isBlank) {
            if (!previousBlank) {
                compact.push("");
            }
            previousBlank = true;
            continue;
        }
        compact.push(line);
        previousBlank = false;
    }
    while (compact[0] === "") {
        compact.shift();
    }
    while (compact.at(-1) === "") {
        compact.pop();
    }
    return compact.length > 0 ? `${compact.join("\n")}\n` : "";
}
function stripTomlInlineComment(line) {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        const prev = i > 0 ? line[i - 1] : "";
        if (char === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }
        if (char === "\"" && !inSingle && prev !== "\\") {
            inDouble = !inDouble;
            continue;
        }
        if (char === "#" && !inSingle && !inDouble) {
            return line.slice(0, i).trimEnd();
        }
    }
    return line;
}
function printWarnings(warnings) {
    console.log("");
    console.log(textBold("Warnings:"));
    if (warnings.length === 0) {
        console.log(textDim("  (none)"));
        return;
    }
    for (const warning of warnings) {
        console.log(`  ${textRed("-")} ${warning}`);
    }
}
async function buildInitPreviewPlan() {
    const nextProfiles = await planInitProfilesFromCurrent();
    const configPlan = await planCodexConfigSync();
    const currentProfilesText = (await readTextIfExists(profilesPath())) ?? "";
    const currentConfigText = (await readTextIfExists(codexConfigPath())) ?? "";
    const currentAgentsText = (await readTextIfExists(codexAgentsPath())) ?? "";
    const currentAuthText = (await readTextIfExists(codexAuthPath())) ?? "";
    const nextAgentsText = await readDefaultCodexAgents();
    const nextCurrentProfile = nextProfiles.profiles?.[nextProfiles.current ?? ""];
    const nextAuthText = nextCurrentProfile?.apiKey
        ? stringifyJson({ OPENAI_API_KEY: nextCurrentProfile.apiKey })
        : currentAuthText;
    const warnings = [];
    const currentProfiles = await readProfiles();
    if ((currentProfiles.current ?? null) !== (nextProfiles.current ?? null)) {
        warnings.unshift(`profile current will change from ${currentProfiles.current ?? "(none)"} to ${nextProfiles.current ?? "(none)"}`);
    }
    const previewFiles = collectChangedPreviewFiles([
        {
            label: "profiles.json",
            path: profilesPath(),
            current: currentProfilesText,
            next: stringifyJson(nextProfiles),
        },
        {
            label: "config.toml",
            path: codexConfigPath(),
            current: currentConfigText,
            next: configPlan.nextContent,
        },
        {
            label: "AGENTS.md",
            path: codexAgentsPath(),
            current: currentAgentsText,
            next: nextAgentsText,
        },
        {
            label: "auth.json",
            path: codexAuthPath(),
            current: currentAuthText,
            next: nextAuthText,
        },
    ]);
    const backupFiles = await collectExistingBackupFilesForPaths(previewFiles.map((file) => file.path));
    return {
        title: "ccs init",
        previewFiles,
        backupFiles,
        warnings,
    };
}
async function buildSyncPreviewPlan(options) {
    const nextProfiles = await planSyncProfiles();
    const defaults = await readDefaultCodexConfig();
    const template = syncTomlTemplate(defaults, "", new Set());
    const selectedPaths = options.replaceAll
        ? template.leafPaths.filter((path) => !isProviderBaseUrlPath(path))
        : options.replacePaths;
    const templatePaths = new Set(template.leafPaths);
    for (const path of selectedPaths) {
        if (isProviderBaseUrlPath(path)) {
            throw new Error(`ccs sync cannot replace proxy routing field: ${path}`);
        }
        if (!templatePaths.has(path)) {
            const prefix = `${path}.`;
            const kind = template.leafPaths.some((candidate) => candidate.startsWith(prefix)) ? "non-leaf" : "unknown";
            throw new Error(`${kind} TOML path for ccs sync --replace: ${path}`);
        }
    }
    const configPlan = await planCodexConfigSync(new Set(selectedPaths));
    if (selectedPaths.includes("model_provider") && configPlan.differentPaths.includes("model_provider") && await readProxyState()) {
        throw new Error("ccs sync cannot replace model_provider while proxy state exists");
    }
    const currentProfilesText = (await readTextIfExists(profilesPath())) ?? "";
    const currentConfigText = (await readTextIfExists(codexConfigPath())) ?? "";
    const currentAgentsText = (await readTextIfExists(codexAgentsPath())) ?? "";
    const nextAgentsText = await readDefaultCodexAgents();
    const previewFiles = collectChangedPreviewFiles([
        {
            label: "profiles.json",
            path: profilesPath(),
            current: currentProfilesText,
            next: stringifyJson(nextProfiles),
        },
        {
            label: "config.toml",
            path: codexConfigPath(),
            current: currentConfigText,
            next: configPlan.nextContent,
        },
        {
            label: "AGENTS.md",
            path: codexAgentsPath(),
            current: currentAgentsText,
            next: nextAgentsText,
        },
    ]);
    const backupFiles = await collectExistingBackupFilesForPaths(previewFiles.map((file) => file.path));
    return {
        title: "ccs sync",
        previewFiles,
        backupFiles,
        warnings: [],
        configSync: configPlan,
    };
}
function isProviderBaseUrlPath(path) {
    return /^model_providers\.[^.]+\.base_url$/.test(path);
}
function parseSyncOptions(args) {
    const replacePaths = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== "--replace") {
            throw new Error(`unknown argument for ccs sync: ${args[index]}`);
        }
        const path = args[index + 1];
        if (!path || path === "--replace") {
            throw new Error("ccs sync --replace requires a TOML path or all");
        }
        replacePaths.push(path);
        index += 1;
    }
    const normalized = [...new Set(replacePaths)];
    const replaceAll = normalized.includes("all");
    if (replaceAll && normalized.length > 1) {
        throw new Error("ccs sync --replace all cannot be combined with explicit paths");
    }
    return { replaceAll, replacePaths: replaceAll ? [] : normalized };
}
function formatSyncFieldSummary(label, paths) {
    return `${label.padEnd(11)}${paths.length}  ${paths.join(", ")}`.trimEnd();
}
function buildWeztermStatusBlock() {
    return [
        weztermStatusBegin,
        "config.enable_tab_bar = true",
        "config.hide_tab_bar_if_only_one_tab = false",
        `config.status_update_interval = ${weztermStatusUpdateIntervalMs}`,
        `local ccs_status_stale_after_seconds = ${weztermStatusStaleAfterSeconds}`,
        "",
        "local function ccs_status_suffix()",
        `\tlocal path = os.getenv("CCS_WEZTERM_STATUS_FILE") or ${JSON.stringify(usageTopStatusTextPath())}`,
        "\tlocal handle = io.open(path, \"r\")",
        "\tif not handle then",
        "\t\treturn \" | ccs status inactive\"",
        "\tend",
        "",
        "\tlocal value = handle:read(\"*a\") or \"\"",
        "\thandle:close()",
        "\tvalue = value:gsub(\"%s+$\", \"\")",
        "\tif value == \"\" then",
        "\t\treturn \" | ccs status inactive\"",
        "\tend",
        "",
        "\tlocal timestamp, suffix = value:match(\"^(%d+)\\t(.*)$\")",
        "\tlocal generated_at = tonumber(timestamp)",
        "\tif not generated_at or suffix == \"\" then",
        "\t\treturn \" | ccs status inactive\"",
        "\tend",
        "",
        "\tif os.time() - generated_at > ccs_status_stale_after_seconds then",
        "\t\treturn \" | ccs status inactive\"",
        "\tend",
        "\treturn suffix",
        "end",
        "",
        "wezterm.on(\"update-right-status\", function(window)",
        "\tlocal status = os.date(\"%H:%M:%S\") .. ccs_status_suffix()",
        "",
        "\twindow:set_right_status(wezterm.format({",
        "\t\t{ Foreground = { Color = \"#89b4fa\" } },",
        "\t\t{ Text = \" \" .. status .. \" \" },",
        "\t}))",
        "end)",
        weztermStatusEnd,
        "",
    ].join("\n");
}
function stripWeztermStatusBlock(content) {
    const begin = content.indexOf(weztermStatusBegin);
    if (begin === -1) {
        return content;
    }
    const end = content.indexOf(weztermStatusEnd, begin);
    if (end === -1) {
        throw new Error(`found ${weztermStatusBegin} without ${weztermStatusEnd}`);
    }
    const afterEnd = end + weztermStatusEnd.length;
    const afterNewline = content.slice(afterEnd).match(/^\r?\n/);
    const before = content.slice(0, begin).trimEnd();
    const after = content.slice(afterEnd + (afterNewline?.[0].length ?? 0)).trimStart();
    return after ? `${before}\n${after}` : `${before}\n`;
}
function insertWeztermStatusBlock(content, block) {
    const stripped = stripWeztermStatusBlock(content).trimEnd();
    if (/\breturn\s+config\s*$/m.test(stripped)) {
        return `${stripped.replace(/\breturn\s+config\s*$/m, `${block}\nreturn config`)}\n`;
    }
    if (stripped.length === 0) {
        return `local wezterm = require("wezterm")\nlocal config = wezterm.config_builder()\n\n${block}\nreturn config\n`;
    }
    return `${stripped}\n\n${block}`;
}
function planWeztermStatusConfig(current) {
    return insertWeztermStatusBlock(current, buildWeztermStatusBlock());
}
function planWeztermStatusRemove(current) {
    return stripWeztermStatusBlock(current);
}
async function buildWeztermPreviewPlan() {
    const currentConfigText = (await readTextIfExists(weztermConfigPath())) ?? "";
    const nextConfigText = planWeztermStatusConfig(currentConfigText);
    const previewFiles = collectChangedPreviewFiles([
        {
            label: ".wezterm.lua",
            path: weztermConfigPath(),
            current: currentConfigText,
            next: nextConfigText,
        },
    ]);
    const backupFiles = await collectExistingBackupFilesForPaths(previewFiles.map((file) => file.path));
    return {
        title: "ccs s wezterm",
        previewFiles,
        backupFiles,
        warnings: [],
    };
}
async function buildWeztermRemovePreviewPlan() {
    const currentConfigText = (await readTextIfExists(weztermConfigPath())) ?? "";
    const nextConfigText = planWeztermStatusRemove(currentConfigText);
    const previewFiles = collectChangedPreviewFiles([
        {
            label: ".wezterm.lua",
            path: weztermConfigPath(),
            current: currentConfigText,
            next: nextConfigText,
        },
    ]);
    const backupFiles = await collectExistingBackupFilesForPaths(previewFiles.map((file) => file.path));
    return {
        title: "ccs s wezterm remove",
        previewFiles,
        backupFiles,
        warnings: [],
    };
}
function printPreviewPlan(plan, dryRun) {
    printPreviewSummary(plan.title, plan.previewFiles.map((file) => file.label), plan.backupFiles.map((file) => file.target), plan.warnings, dryRun);
    for (const file of plan.previewFiles) {
        printDiffBlock(file);
    }
    printWarnings(plan.warnings);
}
async function addProfile(defaultName) {
    const data = await readProfiles();
    const profiles = data.profiles ?? {};
    const input = createPrompt();
    let name = "";
    try {
        name = await askRequired(input, "name", defaultName);
        assertNameAvailable(name, data, "profiles");
        const existing = profiles[name];
        const baseURL = await askRequired(input, "baseURL", existing?.baseURL);
        const apiKey = await askOptional(input, "apiKey", existing?.apiKey);
        profiles[name] = { baseURL, apiKey };
    }
    finally {
        input.close();
    }
    await writeProfiles({ ...data, profiles, current: data.current ?? name });
    console.log(`profile saved: ${textGreen(name)}`);
}
async function addUsageProfile(defaultName) {
    const data = await readProfiles();
    const usage = data.usage ?? {};
    const input = createPrompt();
    let name = "";
    try {
        name = await askRequired(input, "name", defaultName);
        assertNameAvailable(name, data, "usage");
        const existing = usage[name];
        const baseURL = await askRequired(input, "baseURL", existing?.baseURL);
        const apiKey = await askOptional(input, "apiKey", existing?.apiKey);
        usage[name] = { baseURL, apiKey };
    }
    finally {
        input.close();
    }
    await writeProfiles({ ...data, usage });
    console.log(`usage saved: ${textGreen(name)}`);
}
function printProfile(name, profiles) {
    const profile = profiles.profiles?.[name];
    if (!profile) {
        throw new Error(`profile not found: ${name}`);
    }
    const normalized = assertProfile(profile, name);
    printProfileSummary("profile", name, normalized);
}
function printProfileDetails(name, profile) {
    printProfileSummary("profile", name, profile);
}
function proxyOptions() {
    const stateRoot = process.env.CCS_PROXY_STATE_ROOT || join(codexToolsCacheDir(), "proxy");
    return {
        codexConfigPath: codexConfigPath(),
        listenHost: process.env.CCS_PROXY_LISTEN_HOST || "127.0.0.1",
        listenPort: process.env.CCS_PROXY_LISTEN_PORT ? Number.parseInt(process.env.CCS_PROXY_LISTEN_PORT, 10) : 4610,
        stateRoot,
    };
}
async function resolveActiveBaseUrl(profileBaseUrl) {
    const proxyState = await readProxyState();
    if (!proxyState) {
        return profileBaseUrl;
    }
    const runtime = await ensureProxyRunning(proxyOptions());
    return resolveProxySwitchBaseUrl(runtime?.state ?? proxyState) ?? profileBaseUrl;
}
async function runCodexWithProfile(profiles, name, codexArgs) {
    if (!name || name.startsWith("-")) {
        throw new Error("usage: ccs run PROFILE [CODEX_ARGS...]");
    }
    const profile = profiles.profiles?.[name];
    if (!profile) {
        throw new Error(`profile not found: ${name}`);
    }
    const normalized = assertProfile(profile, name);
    if (!normalized.apiKey) {
        throw new Error(`profile ${name} is missing apiKey`);
    }
    const currentConfig = (await readTextIfExists(codexConfigPath())) ?? "";
    const provider = readTopLevelTomlString(currentConfig, "model_provider") ?? "codex";
    const apiKeyEnv = "CCS_RUN_OPENAI_API_KEY";
    const baseURL = await resolveActiveBaseUrl(normalized.baseURL);
    const args = [
        "-c",
        `model_providers.${provider}.base_url=${JSON.stringify(baseURL)}`,
        "-c",
        `model_providers.${provider}.env_key=${JSON.stringify(apiKeyEnv)}`,
        ...codexArgs,
    ];
    printProfileSummary("run", name, normalized);
    printKeyValue("mode:", "temporary codex launch; no files changed", 5);
    await new Promise((resolve, reject) => {
        const child = spawn("codex", args, {
            stdio: "inherit",
            env: {
                ...process.env,
                [apiKeyEnv]: normalized.apiKey,
            },
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal) {
                process.exitCode = 1;
                resolve();
                return;
            }
            process.exitCode = code ?? 1;
            resolve();
        });
    });
}
function formatApiKey(apiKey) {
    return apiKey ? textDim(maskSecret(apiKey)) : textDim("(empty)");
}
function formatSystemLabel() {
    const username = process.env.USER || process.env.LOGNAME || userInfo().username || "unknown";
    const host = (process.env.HOSTNAME || hostname() || "unknown").split(".")[0] || "unknown";
    return `${username}@${host}`;
}
function formatDisplayPath(path) {
    const home = process.env.HOME;
    if (!home) {
        return path;
    }
    if (path === home) {
        return "~";
    }
    return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
function printProfileSummary(label, name, profile) {
    printKeyValue(`${label}:`, `${colorName(name)}  ${colorUrl(profile.baseURL)}  ${formatApiKey(profile.apiKey)}`);
}
function buildUsageUrl(baseURL) {
    const value = baseURL.trim();
    if (!value) {
        return null;
    }
    try {
        const url = new URL(value);
        const path = url.pathname.replace(/\/+$/, "");
        url.pathname = path === "" || path === "/v1" ? "/v1/usage" : `${path}/v1/usage`;
        url.search = "";
        url.hash = "";
        return url.toString();
    }
    catch {
        return null;
    }
}
function buildModelsUrl(baseURL) {
    const value = baseURL.trim();
    if (!value) {
        return null;
    }
    try {
        const url = new URL(value);
        const path = url.pathname.replace(/\/+$/, "");
        url.pathname = path === "" ? "/v1/models" : path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
        url.search = "";
        url.hash = "";
        return url.toString();
    }
    catch {
        return null;
    }
}
function readNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function parseUsageResponse(value) {
    const root = value && typeof value === "object" ? value : {};
    const usage = root.usage && typeof root.usage === "object" ? root.usage : {};
    const today = usage.today && typeof usage.today === "object" ? usage.today : {};
    return {
        used: readNumber(today.actual_cost),
        inputTokens: readNumber(today.input_tokens),
        outputTokens: readNumber(today.output_tokens),
        cacheReadTokens: readNumber(today.cache_read_tokens),
        requests: readNumber(today.requests),
    };
}
function parseModelsResponse(value) {
    const root = value && typeof value === "object" ? value : {};
    if (!Array.isArray(root.data)) {
        return null;
    }
    const models = [];
    for (const item of root.data) {
        const record = item && typeof item === "object" ? item : {};
        const id = record.id;
        if (typeof id !== "string" || !id.trim()) {
            return null;
        }
        models.push(id);
    }
    return models;
}
async function fetchUsage(profile) {
    if (!profile.apiKey) {
        return null;
    }
    const url = buildUsageUrl(profile.baseURL);
    if (!url) {
        return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), usageHttpTimeoutMs);
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${profile.apiKey}`,
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            return null;
        }
        return parseUsageResponse(await response.json());
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function fetchModels(profile) {
    if (!profile.apiKey) {
        return { models: [], error: "missing apiKey" };
    }
    const url = buildModelsUrl(profile.baseURL);
    if (!url) {
        return { models: [], error: "invalid baseURL" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), modelsHttpTimeoutMs);
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${profile.apiKey}`,
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            return { models: [], error: `http ${response.status}` };
        }
        try {
            const models = parseModelsResponse(await response.json());
            return models ? { models, error: null } : { models: [], error: "invalid response" };
        }
        catch {
            return { models: [], error: "invalid response" };
        }
    }
    catch (error) {
        const name = error instanceof Error ? error.name : "";
        return { models: [], error: name === "AbortError" ? "timeout" : "fetch failed" };
    }
    finally {
        clearTimeout(timeout);
    }
}
function prettifyBigNum(value) {
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000)
        return `${formatCompact(value / 1_000_000_000)}B`;
    if (abs >= 1_000_000)
        return `${formatCompact(value / 1_000_000)}M`;
    if (abs >= 1_000)
        return `${formatCompact(value / 1_000)}K`;
    return Math.round(value).toString();
}
function formatCompact(value) {
    const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1);
    return fixed.replace(/\.0$/, "");
}
function formatCost(value) {
    if (value === 0)
        return "$0";
    if (value < 0.01)
        return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
    return `$${value.toFixed(2)}`;
}
function formatSignedCost(value) {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}${formatCost(Math.abs(value))}`;
}
function formatTopCost(value) {
    return `$${value.toFixed(1).padStart(5, " ")}`;
}
function formatSignedTopCost(value) {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}$${Math.min(Math.abs(value), usageTopMaxDisplayDelta - 0.1).toFixed(1)}`;
}
function formatUsage(result) {
    return formatUsageColumns(result).join("  ");
}
function formatUsageColumns(result) {
    return [
        colorCost(formatCost(result.used)),
        `${colorInput(prettifyBigNum(result.inputTokens))}↑`,
        `${colorOutput(prettifyBigNum(result.outputTokens))}↓`,
        `${textDim(prettifyBigNum(result.cacheReadTokens))}↻`,
        `${textDim(prettifyBigNum(result.requests))}⤨`,
    ];
}
async function formatProfileUsageColumns(profile) {
    if (!profile.apiKey || !profile.baseURL.trim()) {
        return [textDim("skipped"), "", "", "", ""];
    }
    const usage = await fetchUsage(profile);
    return usage ? formatUsageColumns(usage) : [textRed("unavailable"), "", "", "", ""];
}
async function printUsageLine(profile) {
    const time = formatClockTime(new Date());
    if (!profile?.apiKey || !profile.baseURL.trim()) {
        printKeyValue("usage:", `${textDim(time)} ${textDim("skipped")}`);
        return;
    }
    const usage = await fetchUsage(profile);
    printKeyValue("usage:", `${textDim(time)} ${usage ? formatUsage(usage) : textRed("unavailable")}`);
}
function formatClockTime(date) {
    const pad = (value) => value.toString().padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function formatRelativeTime(date, now) {
    const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
    const pad = (value) => value.toString().padStart(2, " ");
    if (seconds < 60)
        return `${pad(seconds)}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${pad(minutes)}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${pad(hours)}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
async function askRequired(input, label, current) {
    const value = await askOptional(input, label, current);
    if (!value) {
        throw new Error(`${label} is required`);
    }
    return value;
}
async function askOptional(input, label, current) {
    const suffix = current ? ` [${label === "apiKey" ? maskSecret(current) : current}]` : "";
    const value = await input.question(`${label}${suffix}: `);
    return value || current || "";
}
function createPrompt() {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: process.stdin.isTTY,
    });
    const iterator = rl[Symbol.asyncIterator]();
    return {
        async question(prompt) {
            process.stdout.write(prompt);
            const next = await iterator.next();
            return next.done ? "" : next.value;
        },
        close() {
            rl.close();
        },
    };
}
async function removeProfile(name) {
    if (!name) {
        throw new Error("usage: ccs remove NAME");
    }
    const data = await readProfiles();
    const profiles = data.profiles ?? {};
    if (!profiles[name]) {
        throw new Error(`profile not found: ${name}`);
    }
    delete profiles[name];
    const names = Object.keys(profiles);
    const current = data.current === name ? names[0] : data.current;
    const toggle = data.toggle?.filter((item) => item !== name);
    await writeProfiles({ ...data, profiles, current, toggle });
    console.log(`profile removed: ${textRed(name)}`);
}
async function removeUsageProfile(name) {
    if (!name) {
        throw new Error("usage: ccs usage remove NAME");
    }
    const data = await readProfiles();
    const usage = data.usage ?? {};
    if (!usage[name]) {
        throw new Error(`usage profile not found: ${name}`);
    }
    delete usage[name];
    await writeProfiles({ ...data, usage });
    console.log(`usage removed: ${textRed(name)}`);
}
async function switchProfile(name) {
    const data = await readProfiles();
    const profiles = data.profiles ?? {};
    const profile = profiles[name];
    if (!profile) {
        throw new Error(`profile not found: ${name}`);
    }
    const normalized = assertProfile(profile, name);
    if (!normalized.apiKey) {
        throw new Error(`profile ${name} is missing apiKey`);
    }
    await ensureDir(codexDir());
    const currentConfig = (await readTextIfExists(codexConfigPath())) ?? "";
    const nextConfig = updateTomlBaseUrl(currentConfig, await resolveActiveBaseUrl(normalized.baseURL));
    await writeTextFile(codexConfigPath(), nextConfig);
    await writeTextFile(codexAuthPath(), stringifyJson({ OPENAI_API_KEY: normalized.apiKey }), 0o600);
    await writeProfiles({
        ...data,
        current: name,
        profiles,
    });
    printProfileDetails(name, normalized);
    return normalized;
}
async function printStatus() {
    const profiles = await readProfiles();
    const current = profiles.current ?? "input";
    const profile = profiles.profiles?.[current];
    const systemLabel = formatSystemLabel();
    if (!profile) {
        printKeyValue("current:", `${textDim("none")}  ${colorHost(systemLabel)}`);
        printKeyValue("files:", `${colorPath(formatDisplayPath(profilesPath()))}  ${colorPath(formatDisplayPath(codexConfigPath()))}`);
        return null;
    }
    const normalized = assertProfile(profile, current);
    printKeyValue("current:", `${colorName(current)}  ${colorHost(systemLabel)}`);
    printKeyValue("api:", `${colorUrl(normalized.baseURL)}  ${formatApiKey(normalized.apiKey)}`);
    printKeyValue("files:", `${colorPath(formatDisplayPath(profilesPath()))}  ${colorPath(formatDisplayPath(codexConfigPath()))}`);
    return normalized;
}
async function printProfileList(profiles, includeUsage) {
    const entries = Object.entries(profiles.profiles ?? {});
    const current = profiles.current ?? "";
    const switchRows = await Promise.all(entries.map(async ([name, profile]) => ({
        name,
        profile,
        type: includeUsage ? textDim("codex") : "",
        marker: name === current ? textGreen("*") : "",
        usage: includeUsage ? await formatProfileUsageColumns(profile) : [],
    })));
    const usageRows = includeUsage
        ? await Promise.all(Object.entries(profiles.usage ?? {}).map(async ([name, profile]) => ({
            name,
            profile,
            type: textDim("usage"),
            marker: "",
            usage: await formatProfileUsageColumns(profile),
        })))
        : [];
    const rows = [...switchRows, ...usageRows];
    const columns = [
        { key: "marker", title: "" },
        ...(includeUsage ? [{ key: "type", title: "" }] : []),
        { key: "name", title: "" },
        { key: "url", title: "" },
        { key: "key", title: "" },
        ...(includeUsage ? usageTableColumns() : []),
    ];
    printTable(columns, rows.map((row) => ({
        marker: row.marker,
        type: row.type,
        name: colorName(row.name),
        url: colorUrl(row.profile.baseURL),
        key: row.profile.apiKey ? textDim(maskSecret(row.profile.apiKey)) : textDim("(empty)"),
        ...usageTableValues(row.usage),
    })), { header: false });
}
async function printUsageTargets(profiles) {
    const rows = await Promise.all(Object.entries(profiles.usage ?? {}).map(async ([name, profile]) => ({
        name,
        profile,
        usage: await formatProfileUsageColumns(profile),
    })));
    if (rows.length === 0) {
        console.log(textDim("no usage profiles"));
        return;
    }
    printTable([
        { key: "name", title: "" },
        { key: "url", title: "" },
        { key: "key", title: "" },
        ...usageTableColumns(),
    ], rows.map((row) => ({
        name: colorName(row.name),
        url: colorUrl(row.profile.baseURL),
        key: row.profile.apiKey ? textDim(maskSecret(row.profile.apiKey)) : textDim("(empty)"),
        ...usageTableValues(row.usage),
    })), { header: false });
}
async function printModels(profiles, args) {
    if (isHelpArgument(args[0])) {
        assertExactArgs(args.slice(1), "models help", 0);
        printHelp();
        return;
    }
    const options = parseModelsArgs(args);
    const pricing = await readModelsPricingContext(profiles);
    const entries = Object.entries(profiles.profiles ?? {});
    if (entries.length === 0) {
        if (options.json) {
            console.log(stringifyJson(buildModelsJson([], pricing)).trimEnd());
        }
        else {
            console.log(textDim("no profiles"));
        }
        return;
    }
    const results = await Promise.all(entries.map(async ([name, profile]) => ({
        name,
        result: await fetchModels(assertProfile(profile, name)),
    })));
    if (options.json) {
        console.log(stringifyJson(buildModelsJson(results, pricing)).trimEnd());
        return;
    }
    const rowCount = Math.max(1, ...results.map(({ result }) => result.models.length || 1));
    const rows = Array.from({ length: rowCount }, (_value, index) => (Object.fromEntries(results.flatMap(({ name, result }) => {
        const model = result.models[index];
        const value = model ?? (index === 0 ? formatModelsStatus(result) : "");
        const price = model ? formatModelPricingStatus(modelPricingStatus(pricing.priceCache, model, pricing.speed)) : "";
        return [
            [name, value],
            [modelsPricingColumnKey(name), price],
        ];
    }))));
    printTable(results.flatMap(({ name }) => [
        { key: name, title: name },
        { key: modelsPricingColumnKey(name), title: "price" },
    ]), rows);
}
async function readModelsPricingContext(profiles) {
    return {
        priceCache: await readModelPriceCache(ccsCostPriceOptions(profiles)),
        speed: await resolveCodexCostSpeed("auto"),
    };
}
function modelsPricingColumnKey(name) {
    return `${name}__pricing`;
}
function parseModelsArgs(args) {
    let json = false;
    for (const arg of args) {
        if (arg === "--json") {
            json = true;
            continue;
        }
        throw new Error(`unknown argument for ccs models: ${arg}`);
    }
    return { json };
}
function buildModelsJson(results, pricing) {
    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        pricing: {
            speed: pricing.speed,
            source: pricing.priceCache.source,
            fetchedAt: pricing.priceCache.fetchedAt,
        },
        profiles: results.map(({ name, result }) => ({
            name,
            models: result.models,
            pricing: Object.fromEntries(result.models.map((model) => [
                model,
                modelPricingStatus(pricing.priceCache, model, pricing.speed),
            ])),
            error: result.error,
        })),
    };
}
function formatModelsStatus(result) {
    return result.error ? textRed(result.error) : textDim("(none)");
}
function formatModelPricingStatus(status) {
    if (status === "ok") {
        return textGreen("ok");
    }
    if (status === "partial") {
        return textYellow("partial");
    }
    return textRed("missing");
}
function usageTableColumns() {
    return [
        { key: "cost", title: "", align: "right" },
        { key: "input", title: "", align: "right" },
        { key: "output", title: "", align: "right" },
        { key: "cache", title: "", align: "right" },
        { key: "requests", title: "", align: "right" },
    ];
}
function usageTableValues(usage) {
    return {
        cost: usage[0] ?? "",
        input: usage[1] ?? "",
        output: usage[2] ?? "",
        cache: usage[3] ?? "",
        requests: usage[4] ?? "",
    };
}
function collectUsageTopTargets(profiles) {
    return [
        ...Object.entries(profiles.profiles ?? {}).map(([name, profile]) => ({ name, profile })),
        ...Object.entries(profiles.usage ?? {}).map(([name, profile]) => ({ name, profile })),
    ];
}
async function readUsageTopEntry(target, now, nextRefreshAt) {
    const { name, profile } = target;
    if (!profile.apiKey || !profile.baseURL.trim()) {
        return {
            name,
            profile,
            usage: null,
            skipped: true,
            stale: false,
            nextRefreshAt: null,
            refreshIntervalMs: usageTopMinIntervalMs,
            maxIntervalIdleCount: 0,
            done: true,
            refreshing: false,
        };
    }
    return {
        name,
        profile,
        usage: await fetchUsage(profile),
        skipped: false,
        stale: false,
        nextRefreshAt,
        refreshIntervalMs: usageTopMinIntervalMs,
        maxIntervalIdleCount: 0,
        done: false,
        refreshing: false,
    };
}
async function readInitialUsageTopEntries(targets, once) {
    const now = new Date();
    const nextRefreshAt = once ? null : new Date(now.getTime() + usageTopMinIntervalMs);
    return Promise.all(targets.map((target) => readUsageTopEntry(target, now, nextRefreshAt)));
}
async function createUsageTopRuntime(targets, once) {
    const entries = await readInitialUsageTopEntries(targets, once);
    const states = new Map();
    for (const entry of entries) {
        const state = states.get(entry.name) ?? {};
        updateUsageTopState(state, entry.usage, new Date());
        states.set(entry.name, state);
    }
    return { entries, states };
}
function formatUsageTopEntry(entry, state, now) {
    const { name, usage, skipped } = entry;
    if (skipped) {
        return `${formatTopName(name)} ${textDim("skipped")}`;
    }
    const delta = state?.delta;
    const changedAt = state?.changedAt;
    const shouldShowChange = delta !== undefined
        && changedAt !== undefined
        && now.getTime() - changedAt.getTime() < usageTopChangeTtlMs;
    const tags = [];
    if (shouldShowChange) {
        const age = now.getTime() - changedAt.getTime();
        const formattedDelta = formatSignedTopCost(delta);
        const coloredDelta = age < usageTopChangeColorTtlMs
            ? (delta >= 0 ? textRed(formattedDelta) : textGreen(formattedDelta))
            : textDim(formattedDelta);
        tags.push(`${coloredDelta} ${textDim(formatRelativeTime(changedAt, now))}`);
    }
    const used = usage?.used ?? state?.used;
    if (used === undefined) {
        return `${formatTopName(name)} ${textRed("unavailable")}`;
    }
    if (entry.stale) {
        tags.push(textRed("stale"));
    }
    if (entry.done) {
        tags.push(textDim("done"));
    }
    if (entry.nextRefreshAt) {
        tags.push(textDim(`r${formatCountdownSeconds(entry.nextRefreshAt, now)}`));
    }
    const status = tags.length > 0 ? `${textDim("(")}${tags.join(textDim(", "))}${textDim(")")}` : "";
    return `${formatTopName(name)} ${colorCost(formatTopCost(used))} ${padVisibleRight(status, usageTopStatusWidth)}`;
}
function formatTopName(name) {
    return bgDarkBlue(` ${name} `);
}
function formatCountdownSeconds(date, now) {
    const seconds = Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 1000));
    return `${seconds.toString().padStart(3, " ")}s`;
}
function nextUsageTopInterval(current, changed) {
    if (changed) {
        return usageTopMinIntervalMs;
    }
    return Math.min(usageTopMaxIntervalMs, current + usageTopStepIntervalMs);
}
function nextUsageTopServerInterval(current, changed) {
    if (changed) {
        return usageTopMinIntervalMs;
    }
    return usageTopServerIntervalsMs.find((interval) => interval > current)
        ?? usageTopServerIntervalsMs[usageTopServerIntervalsMs.length - 1];
}
function nextUsageTopRefreshInterval(current, changed, mode) {
    return mode === "server"
        ? nextUsageTopServerInterval(current, changed)
        : nextUsageTopInterval(current, changed);
}
function nextUsageTopMaxIdleCount(entry, changed, nextInterval) {
    if (changed) {
        return 0;
    }
    if (entry.refreshIntervalMs === usageTopMaxIntervalMs && nextInterval === usageTopMaxIntervalMs) {
        return entry.maxIntervalIdleCount + 1;
    }
    return 0;
}
async function refreshUsageTopEntries(entries, states, options) {
    return Promise.all(entries.map(async (entry) => {
        if (entry.skipped) {
            return entry;
        }
        const refreshedAt = new Date();
        const nextEntry = await readUsageTopEntry(entry, refreshedAt, null);
        const state = states.get(entry.name) ?? {};
        const changed = updateUsageTopState(state, nextEntry.usage, refreshedAt);
        states.set(entry.name, state);
        const interval = options.resetInterval
            ? usageTopMinIntervalMs
            : nextUsageTopRefreshInterval(entry.refreshIntervalMs, changed, options.intervalMode);
        const maxIntervalIdleCount = options.resetInterval || !options.stopAtMaxIdle
            ? 0
            : nextUsageTopMaxIdleCount(entry, changed, interval);
        const done = options.stopAtMaxIdle
            && !options.resetInterval
            && maxIntervalIdleCount >= usageTopMaxIntervalIdleLimit;
        return {
            ...nextEntry,
            usage: nextEntry.usage ?? entry.usage,
            stale: nextEntry.usage ? false : entry.usage !== null,
            refreshIntervalMs: interval,
            maxIntervalIdleCount,
            done,
            nextRefreshAt: done ? null : new Date(Date.now() + interval),
        };
    }));
}
function updateUsageTopState(state, usage, now) {
    if (!usage) {
        return false;
    }
    if (state.used === undefined) {
        state.used = usage.used;
        return false;
    }
    const delta = usage.used - state.used;
    if (Math.abs(delta) < 0.0000001) {
        return false;
    }
    state.used = usage.used;
    state.delta = delta;
    state.changedAt = now;
    return true;
}
async function refreshDueUsageTopRuntime(runtime, now, stopAtMaxIdle, intervalMode) {
    const due = runtime.entries.map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => (!entry.done && entry.nextRefreshAt && !entry.refreshing && now >= entry.nextRefreshAt));
    for (const { index } of due) {
        runtime.entries[index] = { ...runtime.entries[index], refreshing: true };
    }
    const refreshed = await refreshUsageTopEntries(due.map(({ entry }) => entry), runtime.states, {
        resetInterval: false,
        stopAtMaxIdle,
        intervalMode,
    });
    for (const [refreshedIndex, { index }] of due.entries()) {
        runtime.entries[index] = refreshed[refreshedIndex];
    }
}
async function refreshAllUsageTopRuntime(runtime, stopAtMaxIdle, intervalMode) {
    runtime.entries = await refreshUsageTopEntries(runtime.entries, runtime.states, {
        resetInterval: true,
        stopAtMaxIdle,
        intervalMode,
    });
}
function nextUsageTopRuntimeDelayMs(runtime, now) {
    const dueAt = runtime.entries
        .filter((entry) => !entry.done && entry.nextRefreshAt && !entry.refreshing)
        .map((entry) => entry.nextRefreshAt?.getTime() ?? Number.POSITIVE_INFINITY);
    if (dueAt.length === 0) {
        return null;
    }
    return Math.max(0, Math.min(...dueAt) - now.getTime());
}
function buildUsageTopLine(entries, states, now) {
    const parts = entries.map((entry) => (formatUsageTopEntry(entry, states.get(entry.name), now)));
    return fitTerminalLine(`${textDim(formatClockTime(now))} ${textDim("|")} ${parts.join(` ${textDim("|")} `)}`);
}
function readUsageTopCosts(entries) {
    const costs = new Map();
    for (const entry of entries) {
        if (entry.usage) {
            costs.set(entry.name, entry.usage.used);
        }
    }
    return costs;
}
function formatTopMarkDelta(value) {
    if (Math.abs(value) < 0.05) {
        return padVisibleLeft(textDim("-"), usageTopMarkDeltaWidth);
    }
    const formatted = formatSignedTopCost(value);
    return padVisibleLeft(value >= 0 ? textRed(formatted) : textGreen(formatted), usageTopMarkDeltaWidth);
}
function formatTopMarkName(name) {
    return padVisibleRight(name, usageTopMarkNameWidth);
}
function formatUsageTopMarkLine(entries, previousCosts, now) {
    const parts = entries.map((entry) => {
        const used = entry.usage?.used;
        if (used === undefined) {
            return `${formatTopMarkName(entry.name)} ${padVisibleRight(entry.skipped ? "skipped" : "unavailable", visibleLength(formatTopCost(0)) + 1 + usageTopMarkDeltaWidth)}`;
        }
        const previous = previousCosts.get(entry.name);
        const delta = previous === undefined ? padVisibleLeft(textDim("-"), usageTopMarkDeltaWidth) : formatTopMarkDelta(used - previous);
        return `${formatTopMarkName(entry.name)} ${formatTopCost(used)} ${delta}`;
    });
    return `${formatClockTime(now)} ${textDim("|")} ${parts.join(` ${textDim("|")} `)}`;
}
function formatStatusLineCost(value) {
    return value.toFixed(1).replace(/\.0$/, "");
}
function formatStatusLineDelta(value, changedAt, now) {
    if (value === undefined || Math.abs(value) < 0.05 || !changedAt) {
        return "";
    }
    const changed = new Date(changedAt);
    if (Number.isNaN(changed.getTime()) || now.getTime() - changed.getTime() >= usageTopChangeColorTtlMs) {
        return "";
    }
    return formatSignedTopCost(value).replace("$", "");
}
function formatStatusLineClock(date) {
    const pad = (value) => value.toString().padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function formatStatusLineRefresh(snapshot, now) {
    if (snapshot.paused) {
        return "paused";
    }
    const { entries } = snapshot;
    const dueAt = entries
        .map((entry) => entry.nextRefreshAt ? new Date(entry.nextRefreshAt).getTime() : Number.POSITIVE_INFINITY)
        .filter((value) => Number.isFinite(value));
    if (dueAt.length === 0) {
        return entries.length > 0 && entries.every((entry) => entry.done) ? "done" : "";
    }
    const seconds = Math.max(0, Math.ceil((Math.min(...dueAt) - now.getTime()) / 1000));
    return `r${seconds}s`;
}
function renderUsageTopStatusSuffix(snapshot, stateNow, currentProfile) {
    const parts = snapshot.entries.map((entry) => {
        const name = entry.name === currentProfile ? `*${entry.name}` : entry.name;
        if (entry.skipped) {
            return `${name} -`;
        }
        if (entry.used === undefined) {
            return `${name} ?`;
        }
        const delta = formatStatusLineDelta(entry.delta, entry.changedAt, stateNow);
        const tags = [
            delta,
            entry.stale ? "stale" : "",
            entry.done ? "done" : "",
        ].filter(Boolean);
        return `${name} ${formatStatusLineCost(entry.used)}${tags.length > 0 ? ` ${tags.join(" ")}` : ""}`;
    });
    const refresh = formatStatusLineRefresh(snapshot, stateNow);
    return `${refresh ? ` ${refresh}` : ""} | ${parts.join(" | ")}`;
}
function renderUsageTopStatusLine(snapshot, displayNow, stateNow, currentProfile) {
    return `${formatStatusLineClock(displayNow)}${renderUsageTopStatusSuffix(snapshot, stateNow, currentProfile)}`;
}
function usageTopSnapshotPath() {
    return join(codexToolsCacheDir(), "ccs-top-state.json");
}
function usageTopHistoryPath() {
    return join(codexToolsCacheDir(), "ccs-top-history.jsonl");
}
function usageTopStatusTextPath() {
    return join(codexToolsCacheDir(), "ccs-top-status.txt");
}
function ccsCostSnapshotDir() {
    return join(codexToolsCacheDir(), "ccs-cost");
}
function ccsCostDerivedPath() {
    return join(codexToolsCacheDir(), "ccs-cost-derived.json");
}
function toUsageTopSnapshotEntry(entry, state) {
    const used = entry.usage?.used ?? state?.used;
    return {
        name: entry.name,
        used,
        delta: state?.delta,
        changedAt: state?.changedAt?.toISOString(),
        skipped: entry.skipped || undefined,
        unavailable: !entry.skipped && used === undefined ? true : undefined,
        stale: entry.stale || undefined,
        done: entry.done || undefined,
        nextRefreshAt: entry.nextRefreshAt?.toISOString(),
    };
}
function normalizeUsageTopSnapshot(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const rawSnapshot = value;
    const entries = Array.isArray(rawSnapshot.entries)
        ? rawSnapshot.entries.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || typeof entry.name !== "string") {
                return [];
            }
            const raw = entry;
            return [{
                    name: raw.name,
                    used: typeof raw.used === "number" && Number.isFinite(raw.used) ? raw.used : undefined,
                    delta: typeof raw.delta === "number" && Number.isFinite(raw.delta) ? raw.delta : undefined,
                    changedAt: typeof raw.changedAt === "string" ? raw.changedAt : undefined,
                    skipped: raw.skipped === true ? true : undefined,
                    unavailable: raw.unavailable === true ? true : undefined,
                    stale: raw.stale === true ? true : undefined,
                    done: raw.done === true ? true : undefined,
                    nextRefreshAt: typeof raw.nextRefreshAt === "string" ? raw.nextRefreshAt : undefined,
                }];
        })
        : null;
    if (rawSnapshot.version !== 1
        || typeof rawSnapshot.active !== "boolean"
        || typeof rawSnapshot.pid !== "number"
        || typeof rawSnapshot.updatedAt !== "string"
        || !entries) {
        return null;
    }
    return {
        version: 1,
        active: rawSnapshot.active,
        pid: rawSnapshot.pid,
        updatedAt: rawSnapshot.updatedAt,
        paused: rawSnapshot.paused === true ? true : undefined,
        entries,
    };
}
function buildUsageTopSnapshot(entries, states, now, active, paused = false) {
    return {
        version: 1,
        active,
        pid: process.pid,
        updatedAt: now.toISOString(),
        paused: paused || undefined,
        entries: entries.map((entry) => toUsageTopSnapshotEntry(entry, states.get(entry.name))),
    };
}
async function writeUsageTopSnapshot(snapshot) {
    await writeJsonStateAtomic(usageTopSnapshotPath(), snapshot, 0o600);
}
function parseUsageTopSnapshot(text) {
    if (!text) {
        return null;
    }
    try {
        return normalizeUsageTopSnapshot(JSON.parse(text));
    }
    catch {
        return null;
    }
}
async function readUsageTopSnapshot() {
    return parseUsageTopSnapshot(await readTextIfExists(usageTopSnapshotPath()));
}
function usageTopSnapshotTime(snapshot) {
    const at = new Date(snapshot.updatedAt);
    return Number.isNaN(at.getTime()) ? null : at;
}
function filterUsageTopHistoryRecords(records, now) {
    const cutoff = now.getTime() - usageTopHistoryRetentionMs;
    return records
        .filter((record) => {
        const at = usageTopSnapshotTime(record);
        return at && at.getTime() >= cutoff && at.getTime() <= now.getTime();
    })
        .sort((left, right) => {
        const leftAt = usageTopSnapshotTime(left)?.getTime() ?? 0;
        const rightAt = usageTopSnapshotTime(right)?.getTime() ?? 0;
        return leftAt - rightAt;
    });
}
async function readUsageTopHistoryRecords(now = new Date()) {
    const cutoff = now.getTime() - usageTopHistoryRetentionMs;
    let file;
    try {
        file = await open(usageTopHistoryPath(), "r");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    try {
        const fileStat = await file.stat();
        let position = fileStat.size;
        let carry = "";
        const records = [];
        let reachedCutoff = false;
        while (position > 0 && !reachedCutoff) {
            const length = Math.min(usageTopHistoryTailBlockBytes, position);
            position -= length;
            const buffer = Buffer.allocUnsafe(length);
            await file.read(buffer, 0, length, position);
            const lines = `${buffer.toString("utf8")}${carry}`.split("\n");
            carry = position > 0 ? lines.shift() ?? "" : "";
            for (let index = lines.length - 1; index >= 0; index -= 1) {
                const snapshot = parseUsageTopSnapshot(lines[index].trim());
                if (!snapshot) {
                    continue;
                }
                const at = usageTopSnapshotTime(snapshot);
                if (!at) {
                    continue;
                }
                if (at.getTime() < cutoff) {
                    reachedCutoff = true;
                    break;
                }
                records.push(snapshot);
            }
        }
        if (!reachedCutoff && position === 0 && carry.trim()) {
            const snapshot = parseUsageTopSnapshot(carry.trim());
            const at = snapshot ? usageTopSnapshotTime(snapshot) : null;
            if (snapshot && at && at.getTime() >= cutoff) {
                records.push(snapshot);
            }
        }
        return filterUsageTopHistoryRecords(records, now);
    }
    finally {
        await file.close();
    }
}
async function recordUsageTopHistorySnapshot(snapshot) {
    if (!snapshot.active) {
        return;
    }
    const at = usageTopSnapshotTime(snapshot);
    if (!at) {
        return;
    }
    await ensureDir(codexToolsCacheDir());
    await appendBoundedJsonLine(usageTopHistoryPath(), snapshot, { maxBytes: usageTopHistoryMaxBytes, mode: 0o600 });
}
function buildUsageTopHistory(records, request) {
    const windowEnd = request.windowEnd ?? new Date();
    const bucketMs = request.bucketMinutes * 60 * 1000;
    const filteredRecords = filterUsageTopHistoryRecords(records, windowEnd).filter((record) => {
        const at = usageTopSnapshotTime(record);
        return at && at.getTime() >= request.windowStart.getTime() && at.getTime() <= windowEnd.getTime();
    });
    const pointMap = buildUsageTopPointMap(filteredRecords);
    const availableNames = [...pointMap.keys()].sort();
    const names = request.profileName
        ? availableNames.filter((name) => name === request.profileName)
        : availableNames;
    const summaries = names
        .map((name) => summarizeUsageTopHistory(name, pointMap.get(name) ?? [], request.windowStart, windowEnd))
        .sort((left, right) => (right.delta ?? 0) - (left.delta ?? 0));
    const sortedNames = summaries.map((summary) => summary.name);
    const buckets = buildUsageTopHistoryBuckets(pointMap, sortedNames, request.windowStart, windowEnd, bucketMs);
    const series = buildUsageTopHistorySeries(pointMap, sortedNames, buckets, request.windowStart);
    return {
        version: 2,
        updatedAt: windowEnd.toISOString(),
        windowStart: request.windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        bucketMinutes: request.bucketMinutes,
        names: sortedNames,
        availableNames,
        summaries: summaries.map(toUsageTopHistorySummaryRecord),
        series: series.map(toUsageTopHistorySeriesRecord),
        buckets: buckets.map((bucket) => toUsageTopHistoryBucketRecord(bucket, sortedNames)),
    };
}
function isUsageTopNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isInvalidOptionalUsageTopNumber(value) {
    return value !== undefined && !isUsageTopNumber(value);
}
function isInvalidOptionalUsageTopString(value) {
    return value !== undefined && typeof value !== "string";
}
function normalizeUsageTopStringArray(value) {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        return null;
    }
    return value;
}
function normalizeUsageTopHistorySummaryRecord(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    const changes = raw.changes;
    if (typeof raw.name !== "string"
        || typeof raw.reset !== "boolean"
        || changes === undefined
        || !Number.isInteger(changes)
        || changes < 0
        || isInvalidOptionalUsageTopNumber(raw.first)
        || isInvalidOptionalUsageTopNumber(raw.latest)
        || isInvalidOptionalUsageTopNumber(raw.delta)
        || isInvalidOptionalUsageTopNumber(raw.lastChangeDelta)
        || isInvalidOptionalUsageTopString(raw.lastChangeAt)
        || isInvalidOptionalUsageTopString(raw.lastResetAt)) {
        return null;
    }
    return {
        name: raw.name,
        first: raw.first,
        latest: raw.latest,
        delta: raw.delta,
        reset: raw.reset,
        changes,
        lastChangeAt: raw.lastChangeAt,
        lastChangeDelta: raw.lastChangeDelta,
        lastResetAt: raw.lastResetAt,
    };
}
function normalizeUsageTopHistoryBucketDeltaRecord(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (typeof raw.name !== "string"
        || typeof raw.reset !== "boolean"
        || isInvalidOptionalUsageTopNumber(raw.delta)) {
        return null;
    }
    return {
        name: raw.name,
        delta: raw.delta,
        reset: raw.reset,
    };
}
function normalizeUsageTopHistoryBucketRecord(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (typeof raw.start !== "string"
        || typeof raw.end !== "string"
        || typeof raw.reset !== "boolean"
        || isInvalidOptionalUsageTopNumber(raw.total)
        || !Array.isArray(raw.deltas)) {
        return null;
    }
    const deltas = raw.deltas.map(normalizeUsageTopHistoryBucketDeltaRecord);
    if (deltas.some((delta) => !delta)) {
        return null;
    }
    return {
        start: raw.start,
        end: raw.end,
        deltas: deltas,
        total: raw.total,
        reset: raw.reset,
    };
}
function normalizeUsageTopHistoryPointRecord(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (typeof raw.at !== "string" || !isUsageTopNumber(raw.value)) {
        return null;
    }
    return {
        at: raw.at,
        value: raw.value,
    };
}
function normalizeUsageTopHistorySeriesRecord(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (typeof raw.name !== "string" || !Array.isArray(raw.points)) {
        return null;
    }
    const points = raw.points.map(normalizeUsageTopHistoryPointRecord);
    if (points.some((point) => !point)) {
        return null;
    }
    return {
        name: raw.name,
        points: points,
    };
}
function normalizeUsageTopHistory(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    const names = normalizeUsageTopStringArray(raw.names);
    const availableNames = normalizeUsageTopStringArray(raw.availableNames);
    if (raw.version !== 2
        || typeof raw.updatedAt !== "string"
        || typeof raw.windowStart !== "string"
        || typeof raw.windowEnd !== "string"
        || !isUsageTopNumber(raw.bucketMinutes)
        || !names
        || !availableNames
        || !Array.isArray(raw.summaries)
        || !Array.isArray(raw.series)
        || !Array.isArray(raw.buckets)) {
        return null;
    }
    const summaries = raw.summaries.map(normalizeUsageTopHistorySummaryRecord);
    const series = raw.series.map(normalizeUsageTopHistorySeriesRecord);
    const buckets = raw.buckets.map(normalizeUsageTopHistoryBucketRecord);
    if (summaries.some((summary) => !summary)
        || series.some((item) => !item)
        || buckets.some((bucket) => !bucket)) {
        return null;
    }
    return {
        version: 2,
        updatedAt: raw.updatedAt,
        windowStart: raw.windowStart,
        windowEnd: raw.windowEnd,
        bucketMinutes: raw.bucketMinutes,
        names,
        availableNames,
        summaries: summaries,
        series: series,
        buckets: buckets,
    };
}
function parseUsageTopHistory(text) {
    if (!text) {
        return null;
    }
    try {
        return normalizeUsageTopHistory(JSON.parse(text));
    }
    catch {
        return null;
    }
}
async function fetchUsageTopSnapshot(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), usageTopHttpTimeoutMs);
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) {
            return null;
        }
        return parseUsageTopSnapshot(await response.text());
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function fetchUsageTopHistory(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), usageTopHistoryHttpTimeoutMs);
    let text = "";
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) {
            return null;
        }
        text = await response.text();
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
    const history = parseUsageTopHistory(text);
    if (!history) {
        throw new Error(`invalid ccs top history response from ${url}; expected version 2 series payload`);
    }
    return history;
}
function buildUsageTopHistoryRequest(profileName) {
    return {
        windowStart: startOfHistoryDay(new Date()),
        bucketMinutes: usageTopHistoryBucketMinutes,
        profileName,
    };
}
function usageTopHistoryUrl(stateUrl, request) {
    const url = new URL(stateUrl);
    url.pathname = url.pathname.endsWith("/ccs/top/state")
        ? url.pathname.replace(/\/ccs\/top\/state$/, "/ccs/top/history")
        : "/ccs/top/history";
    url.search = "";
    url.hash = "";
    if (request) {
        url.searchParams.set("since", request.windowStart.toISOString());
        url.searchParams.set("bucketMinutes", request.bucketMinutes.toString());
        if (request.windowEnd) {
            url.searchParams.set("until", request.windowEnd.toISOString());
        }
        if (request.profileName) {
            url.searchParams.set("profile", request.profileName);
        }
    }
    return url.toString();
}
function usageTopControlUrl(stateUrl, action) {
    const url = new URL(stateUrl);
    url.pathname = url.pathname.endsWith("/ccs/top/state")
        ? url.pathname.replace(/\/ccs\/top\/state$/, `/ccs/top/${action}`)
        : `/ccs/top/${action}`;
    url.search = "";
    url.hash = "";
    return url.toString();
}
async function postUsageTopControl(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), usageTopHttpTimeoutMs);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        return response.ok;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function readUsageTopStateUrls(profiles) {
    const urls = (profiles.top?.stateUrls ?? [])
        .map((url) => url.trim())
        .filter((url) => !!url);
    return [...new Set(urls)];
}
function formatUsageTopControlAction(action) {
    if (action === "pause") {
        return "paused";
    }
    if (action === "resume") {
        return "resumed";
    }
    return "reset";
}
async function controlUsageTopServer(profiles, action) {
    const urls = await readUsageTopStateUrls(profiles);
    if (urls.length === 0) {
        throw new Error("ccs s pause/resume/reset requires top.stateUrls");
    }
    for (const url of urls) {
        const controlUrl = usageTopControlUrl(url, action);
        if (await postUsageTopControl(controlUrl)) {
            console.log(`server ${formatUsageTopControlAction(action)}: ${textGreen(controlUrl)}`);
            return;
        }
    }
    throw new Error(`no configured ccs top server accepted ${action}`);
}
async function readUsageTopStatusSnapshot(profiles) {
    for (const url of await readUsageTopStateUrls(profiles)) {
        const remote = await fetchUsageTopSnapshot(url);
        if (remote) {
            return { snapshot: remote, remote: true };
        }
    }
    const local = await readUsageTopSnapshot();
    return local ? { snapshot: local, remote: false } : null;
}
async function readUsageTopHistorySource(profiles, request) {
    for (const url of await readUsageTopStateUrls(profiles)) {
        const historyUrl = usageTopHistoryUrl(url, request);
        const remote = await fetchUsageTopHistory(historyUrl);
        if (remote) {
            return { history: remote, source: historyUrl, remote: true };
        }
    }
    const windowEnd = request.windowEnd ?? new Date();
    const local = buildUsageTopHistory(await readUsageTopHistoryRecords(windowEnd), { ...request, windowEnd });
    return local.availableNames.length > 0
        ? { history: local, source: usageTopHistoryPath(), remote: false }
        : null;
}
function isUsageTopSnapshotActive(snapshot, now) {
    if (!snapshot.active) {
        return false;
    }
    const updatedAt = new Date(snapshot.updatedAt);
    return !Number.isNaN(updatedAt.getTime()) && now.getTime() - updatedAt.getTime() < usageTopSnapshotActiveTtlMs;
}
async function readActiveUsageTopStatusSource(profiles, now) {
    const source = await readUsageTopStatusSnapshot(profiles);
    if (!source || (!source.remote && !isUsageTopSnapshotActive(source.snapshot, now)) || !source.snapshot.active) {
        return null;
    }
    const remoteUpdatedAt = new Date(source.snapshot.updatedAt);
    const stateNow = source.remote && !Number.isNaN(remoteUpdatedAt.getTime()) ? remoteUpdatedAt : now;
    return { snapshot: source.snapshot, stateNow };
}
async function renderCurrentUsageTopStatusSuffix(profiles, now, inactiveLabel = "ccs top inactive") {
    const source = await readActiveUsageTopStatusSource(profiles, now);
    const currentProfile = profiles.current && profiles.profiles?.[profiles.current]
        ? profiles.current
        : undefined;
    return source
        ? renderUsageTopStatusSuffix(source.snapshot, source.stateNow, currentProfile)
        : ` | ${inactiveLabel}`;
}
async function printUsageTopStatusLine(profiles) {
    const now = new Date();
    console.log(`${formatStatusLineClock(now)}${await renderCurrentUsageTopStatusSuffix(profiles, now)}`);
}
function formatHistoryTime(date) {
    const pad = (value) => value.toString().padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatHistoryBucketWindow(minutes) {
    return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
function startOfHistoryDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function endOfHistoryDay(date) {
    const start = startOfHistoryDay(date);
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
}
function formatHistoryCost(value) {
    return `$${value.toFixed(1)}`;
}
function formatHistorySignedCost(value) {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}${formatHistoryCost(Math.abs(value))}`;
}
function formatHistoryDeltaValue(value) {
    const formatted = formatHistorySignedCost(Math.abs(value) < usageTopHistoryEpsilon ? 0 : value);
    if (Math.abs(value) < usageTopHistoryEpsilon) {
        return textDim(formatted);
    }
    return value >= 0 ? textRed(formatted) : textGreen(formatted);
}
function formatHistoryValue(value) {
    return value === undefined ? textDim("n/a") : colorCost(formatHistoryCost(value));
}
function formatHistoryDeltaCell(delta, reset = false) {
    if (reset) {
        return textDim("reset");
    }
    return delta === undefined ? textDim("n/a") : formatHistoryDeltaValue(delta);
}
function buildUsageTopPointMap(records) {
    const map = new Map();
    for (const record of records) {
        const at = usageTopSnapshotTime(record);
        if (!at) {
            continue;
        }
        for (const entry of record.entries) {
            if (entry.used === undefined) {
                continue;
            }
            const points = map.get(entry.name) ?? [];
            points.push({ at, value: entry.used });
            map.set(entry.name, points);
        }
    }
    for (const points of map.values()) {
        points.sort((left, right) => left.at.getTime() - right.at.getTime());
    }
    return map;
}
function summarizeUsageTopHistory(name, points, windowStart, now) {
    const windowStartMs = windowStart.getTime();
    const windowPoints = [
        { at: windowStart, value: 0 },
        ...points.filter((point) => (point.at.getTime() > windowStartMs && point.at.getTime() <= now.getTime())),
    ];
    if (windowPoints.length === 0) {
        return { name, reset: false, changes: 0 };
    }
    let reset = false;
    let changes = 0;
    let lastChangeAt;
    let lastChangeDelta;
    let lastResetAt;
    for (let index = 1; index < windowPoints.length; index += 1) {
        const delta = windowPoints[index].value - windowPoints[index - 1].value;
        if (delta < -usageTopHistoryEpsilon) {
            reset = true;
            lastResetAt = windowPoints[index].at;
            lastChangeAt = windowPoints[index].at;
            lastChangeDelta = undefined;
            continue;
        }
        if (delta > usageTopHistoryEpsilon) {
            changes += 1;
            lastChangeAt = windowPoints[index].at;
            lastChangeDelta = delta;
        }
    }
    const first = windowPoints[0]?.value;
    const latest = windowPoints[windowPoints.length - 1]?.value;
    return {
        name,
        first,
        latest,
        delta: first !== undefined && latest !== undefined && !reset ? latest - first : undefined,
        reset,
        changes,
        lastChangeAt,
        lastChangeDelta,
        lastResetAt,
    };
}
function findUsageTopPointAtOrBefore(points, atMs) {
    let found;
    for (const point of points) {
        if (point.at.getTime() > atMs) {
            break;
        }
        found = point;
    }
    return found;
}
function findUsageTopDayPointAtOrBefore(points, atMs, windowStart) {
    const found = findUsageTopPointAtOrBefore(points, atMs);
    if (found && found.at.getTime() >= windowStart.getTime()) {
        return found;
    }
    if (atMs >= windowStart.getTime()) {
        return { at: windowStart, value: 0 };
    }
    return found;
}
function buildUsageTopHistoryBuckets(pointMap, names, windowStart, now, bucketMs = usageTopHistoryBucketMs) {
    const nowMs = now.getTime();
    const windowStartMs = windowStart.getTime();
    const firstBucketStart = Math.floor(windowStartMs / bucketMs) * bucketMs;
    const buckets = [];
    for (let startMs = firstBucketStart; startMs < nowMs; startMs += bucketMs) {
        const endMs = Math.min(startMs + bucketMs, nowMs);
        const deltas = new Map();
        let total = 0;
        let hasTotal = false;
        let reset = false;
        for (const name of names) {
            const points = pointMap.get(name) ?? [];
            const startPoint = findUsageTopDayPointAtOrBefore(points, startMs, windowStart);
            const endPoint = findUsageTopDayPointAtOrBefore(points, endMs, windowStart);
            if (!startPoint || !endPoint) {
                deltas.set(name, { reset: false });
                continue;
            }
            const delta = endPoint.value - startPoint.value;
            if (delta < -usageTopHistoryEpsilon) {
                reset = true;
                deltas.set(name, { reset: true });
                continue;
            }
            const normalized = Math.abs(delta) < usageTopHistoryEpsilon ? 0 : delta;
            deltas.set(name, { delta: normalized, reset: false });
            total += normalized;
            hasTotal = true;
        }
        buckets.push({
            start: new Date(startMs),
            end: new Date(endMs),
            deltas,
            total: reset || !hasTotal ? undefined : total,
            reset,
        });
    }
    return buckets;
}
function toUsageTopHistorySummaryRecord(summary) {
    return {
        name: summary.name,
        first: summary.first,
        latest: summary.latest,
        delta: summary.delta,
        reset: summary.reset,
        changes: summary.changes,
        lastChangeAt: summary.lastChangeAt?.toISOString(),
        lastChangeDelta: summary.lastChangeDelta,
        lastResetAt: summary.lastResetAt?.toISOString(),
    };
}
function toUsageTopHistoryBucketRecord(bucket, names) {
    return {
        start: bucket.start.toISOString(),
        end: bucket.end.toISOString(),
        total: bucket.total,
        reset: bucket.reset,
        deltas: names.map((name) => {
            const delta = bucket.deltas.get(name);
            return {
                name,
                delta: delta?.delta,
                reset: delta?.reset ?? false,
            };
        }),
    };
}
function toUsageTopHistoryPointRecord(point) {
    return {
        at: point.at.toISOString(),
        value: point.value,
    };
}
function toUsageTopHistorySeriesRecord(series) {
    return {
        name: series.name,
        points: series.points.map(toUsageTopHistoryPointRecord),
    };
}
function formatHistoryLastChangeTime(summary) {
    const at = summary.lastChangeAt ?? summary.lastResetAt;
    return at ? formatHistoryTime(at) : textDim("-");
}
function formatHistoryLastChangeDelta(summary) {
    if (summary.lastChangeDelta !== undefined) {
        return formatHistorySignedCost(summary.lastChangeDelta);
    }
    if (summary.lastResetAt) {
        return textDim("reset");
    }
    return textDim("-");
}
function isUsageTopHistoryBucketEmpty(bucket) {
    if (bucket.reset || (bucket.total !== undefined && Math.abs(bucket.total) >= usageTopHistoryEpsilon)) {
        return false;
    }
    for (const delta of bucket.deltas.values()) {
        if (delta.reset || (delta.delta !== undefined && Math.abs(delta.delta) >= usageTopHistoryEpsilon)) {
            return false;
        }
    }
    return true;
}
function formatUsageTopHistoryBucketRow(bucket, names) {
    return [
        `${formatHistoryTime(bucket.start)}-${formatHistoryTime(bucket.end)}`,
        formatHistoryDeltaCell(bucket.total, bucket.reset),
        ...names.map((name) => {
            const delta = bucket.deltas.get(name);
            return formatHistoryDeltaCell(delta?.delta, delta?.reset);
        }),
    ];
}
function printUsageTopHistoryBuckets(buckets, names) {
    console.log();
    console.log(textBold("bucket changes"));
    const firstVisibleBucketIndex = buckets.findIndex((bucket) => !isUsageTopHistoryBucketEmpty(bucket));
    if (firstVisibleBucketIndex < 0) {
        console.log(textDim("no bucket changes yet"));
        return;
    }
    const visibleBuckets = buckets.slice(firstVisibleBucketIndex);
    const columns = ["time", "total", ...names];
    const emptyColumns = columns.map(() => "");
    const rows = [];
    for (let index = 0; index < visibleBuckets.length; index += 2) {
        const left = formatUsageTopHistoryBucketRow(visibleBuckets[index], names);
        const right = visibleBuckets[index + 1]
            ? formatUsageTopHistoryBucketRow(visibleBuckets[index + 1], names)
            : emptyColumns;
        rows.push(usageTopHistoryBucketTableRow(columns, left, right));
    }
    const tableColumns = [
        ...usageTopHistoryBucketColumns(columns, "left"),
        { key: "separator", title: "" },
        ...usageTopHistoryBucketColumns(columns, "right"),
    ];
    printTable(tableColumns, rows);
}
function usageTopHistoryBucketColumns(columns, side) {
    return columns.map((title, index) => ({
        key: `${side}_${index}`,
        title,
        align: index === 0 ? "left" : "right",
    }));
}
function usageTopHistoryBucketTableRow(columns, left, right) {
    const values = { separator: "|" };
    for (let index = 0; index < columns.length; index += 1) {
        values[`left_${index}`] = left[index] ?? "";
        values[`right_${index}`] = right[index] ?? "";
    }
    return values;
}
function readUsageTopHistoryTotalAt(pointMap, names, atMs, windowStart) {
    let total = 0;
    let count = 0;
    for (const name of names) {
        const point = findUsageTopDayPointAtOrBefore(pointMap.get(name) ?? [], atMs, windowStart);
        if (!point) {
            continue;
        }
        total += point.value;
        count += 1;
    }
    return count > 0 ? total : null;
}
function usageTopHistoryChartGroups(names) {
    const primary = names.slice(0, usageTopHistoryChartNamedProviderLimit)
        .map((name) => ({ name, names: [name] }));
    const otherNames = names.slice(usageTopHistoryChartNamedProviderLimit);
    return otherNames.length > 0
        ? [...primary, { name: usageTopHistoryOtherName, names: otherNames }]
        : primary;
}
function buildUsageTopHistorySeries(pointMap, names, buckets, windowStart) {
    return usageTopHistoryChartGroups(names).map((group) => ({
        name: group.name,
        points: [
            { at: windowStart, value: 0 },
            ...buckets.flatMap((bucket) => {
                const total = readUsageTopHistoryTotalAt(pointMap, group.names, bucket.end.getTime(), windowStart);
                return total === null ? [] : [{ at: bucket.end, value: total }];
            }),
        ],
    }));
}
function expandUsageTopHistoryChartPoints(points, width) {
    if (points.length >= width) {
        return points;
    }
    return Array.from({ length: width }, (_, index) => {
        const sourceIndex = Math.round(index * (points.length - 1) / (width - 1));
        return points[sourceIndex];
    });
}
function placeHistoryAxisLabel(chars, label, index) {
    const start = Math.max(0, Math.min(index, chars.length - label.length));
    for (let offset = 0; offset < label.length; offset += 1) {
        chars[start + offset] = label[offset];
    }
}
function usageTopHistoryChartTickIntervalMs(axisStart, axisEnd) {
    const rangeMs = axisEnd.getTime() - axisStart.getTime();
    if (rangeMs > 12 * 60 * 60 * 1000) {
        return 6 * 60 * 60 * 1000;
    }
    if (rangeMs > 6 * 60 * 60 * 1000) {
        return 3 * 60 * 60 * 1000;
    }
    if (rangeMs > 2 * 60 * 60 * 1000) {
        return 60 * 60 * 1000;
    }
    if (rangeMs > 60 * 60 * 1000) {
        return 30 * 60 * 1000;
    }
    return 15 * 60 * 1000;
}
function ceilHistoryTimeToInterval(axisStart, intervalMs) {
    const dayStartMs = startOfHistoryDay(axisStart).getTime();
    return dayStartMs + Math.ceil((axisStart.getTime() - dayStartMs) / intervalMs) * intervalMs;
}
function formatUsageTopHistoryChartTickLabel(tickMs, axisEnd) {
    if (tickMs === axisEnd.getTime()) {
        return "24:00";
    }
    return formatHistoryTime(new Date(tickMs));
}
function buildUsageTopHistoryChartTicks(axisStart, axisEnd, width) {
    const axisStartMs = axisStart.getTime();
    const axisEndMs = axisEnd.getTime();
    if (axisEndMs <= axisStartMs || width <= 1) {
        return [{ index: 0, label: formatHistoryTime(axisStart) }];
    }
    const intervalMs = usageTopHistoryChartTickIntervalMs(axisStart, axisEnd);
    const ticks = [];
    for (let tickMs = ceilHistoryTimeToInterval(axisStart, intervalMs); tickMs <= axisEndMs; tickMs += intervalMs) {
        ticks.push({
            index: Math.round((tickMs - axisStartMs) / (axisEndMs - axisStartMs) * (width - 1)),
            label: formatUsageTopHistoryChartTickLabel(tickMs, axisEnd),
        });
    }
    return ticks;
}
function usageTopHistoryVisibleCells(line) {
    const cells = [];
    let pending = "";
    for (let index = 0; index < line.length;) {
        const ansi = /^\u001b\[[0-9;]*m/.exec(line.slice(index));
        if (ansi) {
            pending += ansi[0];
            index += ansi[0].length;
            continue;
        }
        cells.push(`${pending}${line[index]}`);
        pending = "";
        index += 1;
    }
    return { cells, trailing: pending };
}
function usageTopHistoryCellChar(cell) {
    return cell.replace(/\u001b\[[0-9;]*m/g, "") || " ";
}
function usageTopHistoryCellAnsi(cell) {
    return cell.match(/\u001b\[[0-9;]*m/g)?.join("") ?? "";
}
function replaceUsageTopHistoryCellChar(cell, char) {
    return `${usageTopHistoryCellAnsi(cell)}${char}`;
}
function joinUsageTopHistoryVisibleCells(cells, trailing) {
    let suffix = trailing;
    while (cells.length > 0 && usageTopHistoryCellChar(cells[cells.length - 1]) === " ") {
        suffix = `${usageTopHistoryCellAnsi(cells.pop() ?? "")}${suffix}`;
    }
    return `${cells.join("")}${suffix}`;
}
function formatUsageTopHistoryChartZeroAxis(line, ticks, width) {
    const { cells, trailing } = usageTopHistoryVisibleCells(line);
    const endColumn = usageTopHistoryChartAxisPrefix + width - 1;
    while (cells.length <= endColumn) {
        cells.push(" ");
    }
    for (let column = usageTopHistoryChartAxisPrefix + 1; column <= endColumn; column += 1) {
        if (usageTopHistoryCellChar(cells[column]) === " ") {
            cells[column] = replaceUsageTopHistoryCellChar(cells[column], "─");
        }
    }
    for (const tick of ticks) {
        const column = usageTopHistoryChartAxisPrefix + tick.index;
        if (column === usageTopHistoryChartAxisPrefix) {
            cells[column] = replaceUsageTopHistoryCellChar(cells[column], "┼");
        }
        else if ([" ", "─"].includes(usageTopHistoryCellChar(cells[column]))) {
            cells[column] = replaceUsageTopHistoryCellChar(cells[column], "┬");
        }
    }
    return joinUsageTopHistoryVisibleCells(cells, trailing);
}
function formatUsageTopHistoryChartAxis(ticks, width) {
    const chars = Array.from({ length: width }, () => " ");
    for (const tick of ticks) {
        placeHistoryAxisLabel(chars, tick.label, tick.index - Math.floor(tick.label.length / 2));
    }
    return `${" ".repeat(usageTopHistoryChartAxisPrefix)}${chars.join("")}`;
}
function usageTopHistoryChartStepCandidates(max) {
    if (max <= 0) {
        return [1];
    }
    const baseExponent = Math.floor(Math.log10(max));
    const steps = [];
    for (let exponent = baseExponent - 2; exponent <= baseExponent + 1; exponent += 1) {
        const magnitude = 10 ** exponent;
        steps.push(magnitude, 2 * magnitude, 5 * magnitude);
    }
    return [...new Set(steps)].filter((step) => step > 0).sort((left, right) => left - right);
}
function usageTopHistoryChartScale(series) {
    const max = Math.max(0, ...series);
    if (max <= 0) {
        return {
            max: usageTopHistoryChartTargetIntervals,
            height: usageTopHistoryChartTargetIntervals,
        };
    }
    const candidates = usageTopHistoryChartStepCandidates(max)
        .map((step) => {
        const height = Math.ceil(max / step);
        return {
            max: step * height,
            height,
        };
    })
        .filter((scale) => (scale.height >= usageTopHistoryChartMinIntervals
        && scale.height <= usageTopHistoryChartMaxIntervals))
        .sort((left, right) => (left.max - right.max
        || Math.abs(left.height - usageTopHistoryChartTargetIntervals)
            - Math.abs(right.height - usageTopHistoryChartTargetIntervals)));
    return candidates[0] ?? {
        max,
        height: usageTopHistoryChartTargetIntervals,
    };
}
function formatHistoryChartCost(value) {
    const rounded = Math.round(value);
    return Math.abs(value - rounded) < usageTopHistoryEpsilon ? `$${rounded}` : formatHistoryCost(value);
}
function usageTopHistoryChartDataWidth(start, end, axisStart, axisEnd) {
    const axisStartMs = axisStart.getTime();
    const axisEndMs = axisEnd.getTime();
    const endMs = Math.max(axisStartMs, Math.min(end.getTime(), axisEndMs));
    if (axisEndMs <= axisStartMs) {
        return usageTopHistoryChartMinWidth;
    }
    const ratio = (endMs - axisStartMs) / (axisEndMs - axisStartMs);
    return Math.max(2, Math.round((usageTopHistoryChartMinWidth - 1) * ratio) + 1);
}
function canColorizeUsageTopHistoryChart() {
    return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}
function usageTopHistoryChartColor(index) {
    if (!canColorizeUsageTopHistoryChart()) {
        return undefined;
    }
    const colors = [
        asciichart.cyan,
        asciichart.green,
        asciichart.yellow,
    ];
    return colors[index % colors.length];
}
function colorUsageTopHistorySeriesName(name, index) {
    const color = usageTopHistoryChartColor(index);
    return color ? asciichart.colored(name, color) : name;
}
function stackUsageTopHistoryChartSeries(series) {
    const cumulative = Array.from({ length: Math.max(0, ...series.map((values) => values.length)) }, () => 0);
    return series.map((values) => values.map((value, index) => {
        cumulative[index] += value;
        return cumulative[index];
    }));
}
function formatUsageTopHistoryChartLegend(series) {
    return `${textDim("stack:")} ${series
        .map((item, index) => colorUsageTopHistorySeriesName(item.name, index))
        .join(textDim(" / "))}`;
}
function formatUsageTopHistoryChartPlot(series, ticks) {
    const scale = usageTopHistoryChartScale(series.flat());
    const config = {
        min: 0,
        max: scale.max,
        height: scale.height,
        format: (value) => `${formatHistoryChartCost(value).padStart(7)} `,
    };
    if (canColorizeUsageTopHistoryChart()) {
        config.colors = series.map((_, index) => usageTopHistoryChartColor(index));
    }
    const lines = asciichart.plot(series, config).split("\n");
    lines[lines.length - 1] = formatUsageTopHistoryChartZeroAxis(lines[lines.length - 1], ticks, usageTopHistoryChartMinWidth);
    return lines.join("\n");
}
function formatUsageTopHistoryChartLines(series) {
    const chartSeries = series.map((item) => ({
        name: item.name,
        points: item.points
            .filter((point) => Number.isFinite(point.value) && !Number.isNaN(point.at.getTime()))
            .sort((left, right) => left.at.getTime() - right.at.getTime()),
    })).filter((item) => item.points.length >= 2);
    const lines = [textBold("stacked trend")];
    if (chartSeries.length === 0) {
        return [...lines, textDim("not enough history yet")];
    }
    const allPoints = chartSeries.flatMap((item) => item.points);
    const start = new Date(Math.min(...allPoints.map((point) => point.at.getTime())));
    const end = new Date(Math.max(...allPoints.map((point) => point.at.getTime())));
    const axisEnd = endOfHistoryDay(start);
    const dataWidth = usageTopHistoryChartDataWidth(start, end, start, axisEnd);
    const rawSeries = chartSeries.map((item) => expandUsageTopHistoryChartPoints(item.points, dataWidth)
        .map((point) => point.value));
    const stackedSeries = stackUsageTopHistoryChartSeries(rawSeries);
    const ticks = buildUsageTopHistoryChartTicks(start, axisEnd, usageTopHistoryChartMinWidth);
    return [
        ...lines,
        formatUsageTopHistoryChartLegend(chartSeries),
        ...formatUsageTopHistoryChartPlot(stackedSeries, ticks).split("\n"),
        textDim(formatUsageTopHistoryChartAxis(ticks, usageTopHistoryChartMinWidth)),
    ];
}
function usageTopHistoryRecentDelta(name, buckets, windowEnd) {
    const sinceMs = windowEnd.getTime() - usageTopHistorySummaryDeltaMs;
    let total = 0;
    let reset = false;
    for (const bucket of buckets) {
        if (bucket.end.getTime() <= sinceMs || bucket.start.getTime() >= windowEnd.getTime()) {
            continue;
        }
        const delta = bucket.deltas.get(name);
        if (delta?.reset) {
            reset = true;
        }
        total += delta?.delta ?? 0;
    }
    return {
        delta: Math.abs(total) < usageTopHistoryEpsilon ? 0 : total,
        reset,
    };
}
function formatUsageTopHistorySummaryLines(summaries, buckets, windowEnd) {
    return [
        textBold("summary"),
        ...renderTable([
            { key: "provider", title: "provider" },
            { key: "now", title: "now", align: "right" },
            { key: "recent", title: "5h delta", align: "right" },
            { key: "last", title: "last", align: "right" },
            { key: "change", title: "change", align: "right" },
        ], summaries.map((summary) => {
            const recentDelta = usageTopHistoryRecentDelta(summary.name, buckets, windowEnd);
            return {
                provider: colorName(summary.name),
                now: formatHistoryValue(summary.latest),
                recent: formatHistoryDeltaCell(recentDelta.delta, recentDelta.reset),
                last: formatHistoryLastChangeTime(summary),
                change: formatHistoryLastChangeDelta(summary),
            };
        })),
    ];
}
function printUsageTopHistoryChartWithSummary(series, summaries, buckets, windowEnd) {
    const chartLines = formatUsageTopHistoryChartLines(series);
    const summaryLines = formatUsageTopHistorySummaryLines(summaries, buckets, windowEnd);
    const chartWidth = Math.max(...chartLines.map(visibleLength));
    const lineCount = Math.max(chartLines.length, summaryLines.length);
    console.log();
    for (let index = 0; index < lineCount; index += 1) {
        const chartLine = chartLines[index] ?? "";
        const summaryLine = summaryLines[index] ?? "";
        console.log(`${padVisibleRight(chartLine, chartWidth)}${" ".repeat(usageTopHistoryChartSummaryGap)}${summaryLine}`.trimEnd());
    }
}
async function printUsageTopHistoryUnavailable(profiles, request) {
    const urls = await readUsageTopStateUrls(profiles);
    if (urls.length > 0) {
        console.log(textDim("ccs top history unavailable"));
        printKeyValue("source:", colorUrl(usageTopHistoryUrl(urls[0], request)), 7);
        if (urls.length > 1) {
            printKeyValue("also:", urls.slice(1).map((url) => colorUrl(usageTopHistoryUrl(url, request))).join("  "), 7);
        }
        printKeyValue("note:", "restart ccs s server with a version that serves compact /ccs/top/history", 5);
        return;
    }
    console.log(textDim("ccs top history inactive"));
    printKeyValue("source:", colorPath(usageTopHistoryPath()), 7);
    printKeyValue("note:", "start ccs s server to collect history; ccs s agent does not record history", 5);
}
function printUsageTopHistoryEmpty(source, profileName, availableNames) {
    if (profileName) {
        console.log(textDim(`no history for ${profileName}`));
        printKeyValue("source:", source.remote ? colorUrl(source.source) : colorPath(source.source), 7);
        if (availableNames.length > 0) {
            printKeyValue("profiles:", availableNames.join(", "), 9);
        }
        return;
    }
    console.log(textDim("ccs top history empty"));
    printKeyValue("source:", source.remote ? colorUrl(source.source) : colorPath(source.source), 7);
    printKeyValue("note:", "wait for ccs s server to write the first usage snapshot", 5);
}
function parseUsageTopHistoryDate(value) {
    return new Date(value);
}
function parseOptionalUsageTopHistoryDate(value) {
    return value ? parseUsageTopHistoryDate(value) : undefined;
}
function toUsageTopSummary(record) {
    return {
        name: record.name,
        first: record.first,
        latest: record.latest,
        delta: record.delta,
        reset: record.reset,
        changes: record.changes,
        lastChangeAt: parseOptionalUsageTopHistoryDate(record.lastChangeAt),
        lastChangeDelta: record.lastChangeDelta,
        lastResetAt: parseOptionalUsageTopHistoryDate(record.lastResetAt),
    };
}
function toUsageTopBucket(record) {
    return {
        start: parseUsageTopHistoryDate(record.start),
        end: parseUsageTopHistoryDate(record.end),
        deltas: new Map(record.deltas.map((delta) => [
            delta.name,
            { delta: delta.delta, reset: delta.reset },
        ])),
        total: record.total,
        reset: record.reset,
    };
}
function toUsageTopPoint(record) {
    return {
        at: parseUsageTopHistoryDate(record.at),
        value: record.value,
    };
}
function toUsageTopSeries(record) {
    return {
        name: record.name,
        points: record.points.map(toUsageTopPoint),
    };
}
async function printUsageTopHistory(profiles, profileName) {
    const request = buildUsageTopHistoryRequest(profileName);
    const source = await readUsageTopHistorySource(profiles, request);
    if (!source) {
        await printUsageTopHistoryUnavailable(profiles, request);
        return;
    }
    const names = source.history.names;
    if (names.length === 0) {
        printUsageTopHistoryEmpty(source, profileName, source.history.availableNames);
        return;
    }
    const summaries = source.history.summaries.map(toUsageTopSummary);
    const buckets = source.history.buckets.map(toUsageTopBucket);
    const series = source.history.series.map(toUsageTopSeries);
    const windowEnd = parseUsageTopHistoryDate(source.history.windowEnd);
    console.log(`ccs usage history  today  bucket ${formatHistoryBucketWindow(source.history.bucketMinutes)}`);
    printKeyValue("source:", source.remote ? colorUrl(source.source) : colorPath(source.source), 7);
    printUsageTopHistoryChartWithSummary(series, summaries, buckets, windowEnd);
    printUsageTopHistoryBuckets(buckets, names);
}
async function writeUsageTopStatusText(value) {
    await writeTextFileAtomic(usageTopStatusTextPath(), value, 0o600);
}
function formatUsageTopStatusFileText(now, suffix) {
    return `${Math.floor(now.getTime() / 1000)}\t${suffix}\n`;
}
function parseUsageTopHistoryDateParam(params, name) {
    const value = params.get(name);
    if (value === null) {
        return undefined;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`invalid ${name}: ${value}`);
    }
    return date;
}
function parseUsageTopHistoryBucketMinutes(params) {
    const value = params.get("bucketMinutes");
    if (value === null) {
        return usageTopHistoryBucketMinutes;
    }
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
        throw new Error(`invalid bucketMinutes: ${value}`);
    }
    return minutes;
}
function parseUsageTopHistoryRequestFromUrl(url, now = new Date()) {
    const windowStart = parseUsageTopHistoryDateParam(url.searchParams, "since") ?? startOfHistoryDay(now);
    const windowEnd = parseUsageTopHistoryDateParam(url.searchParams, "until") ?? now;
    if (windowStart.getTime() > windowEnd.getTime()) {
        throw new Error("since must be before until");
    }
    if (windowEnd.getTime() - windowStart.getTime() > usageTopHistoryMaxWindowMs) {
        throw new Error("history window must be 24h30m or shorter");
    }
    return {
        windowStart,
        windowEnd,
        bucketMinutes: parseUsageTopHistoryBucketMinutes(url.searchParams),
        profileName: url.searchParams.get("profile")?.trim() || undefined,
    };
}
async function runUsageTopStatusAgent() {
    let stopped = false;
    let cachedSuffix = " | ccs top unavailable";
    let refreshInFlight = false;
    const refreshStatus = async () => {
        if (refreshInFlight || stopped) {
            return;
        }
        refreshInFlight = true;
        try {
            const currentProfiles = await readProfiles();
            cachedSuffix = await renderCurrentUsageTopStatusSuffix(currentProfiles, new Date(), "ccs top unavailable");
        }
        catch {
            cachedSuffix = " | ccs top unavailable";
        }
        finally {
            refreshInFlight = false;
        }
    };
    const writeStatus = async () => {
        const displayNow = new Date();
        const line = `${formatStatusLineClock(displayNow)}${cachedSuffix}`;
        if (!stopped) {
            await writeUsageTopStatusText(formatUsageTopStatusFileText(displayNow, cachedSuffix)).catch(() => undefined);
        }
        if (process.stdout.isTTY) {
            process.stdout.write(`\r\u001b[2K${line}`);
            return;
        }
        console.log(line);
    };
    let timer = null;
    let cleanedUp = false;
    const schedule = (cycleStart) => {
        if (cleanedUp) {
            return;
        }
        const delay = msUntilNextAlignedTime(cycleStart, usageTopTickMs);
        timer = setTimeout(() => {
            timer = null;
            void (async () => {
                const nextCycleStart = Date.now();
                void refreshStatus();
                await writeStatus();
                schedule(nextCycleStart);
            })();
        }, delay);
    };
    await refreshStatus();
    await writeStatus();
    await new Promise((resolve) => {
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            stopped = true;
            if (timer) {
                clearTimeout(timer);
            }
            await writeUsageTopStatusText(formatUsageTopStatusFileText(new Date(), " | ccs top inactive")).catch(() => undefined);
            if (process.stdout.isTTY) {
                process.stdout.write("\n");
            }
            resolve();
        };
        schedule(Date.now());
        process.once("SIGINT", () => void cleanup());
        process.once("SIGTERM", () => void cleanup());
    });
}
function parseUsageTopServerPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`invalid server port: ${value}`);
    }
    return port;
}
function sendUsageTopJson(response, status, body) {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    response.end(`${JSON.stringify(body)}\n`);
}
async function serveUsageTop(profiles, portValue) {
    const host = "0.0.0.0";
    const port = parseUsageTopServerPort(portValue);
    const targets = collectUsageTopTargets(profiles);
    if (targets.length === 0) {
        throw new Error("ccs s server requires profiles");
    }
    const runtime = await createUsageTopRuntime(targets, false);
    let paused = false;
    let timer = null;
    let ccsCostRefreshTimer = null;
    let cleanedUp = false;
    let serverTaskQueue = Promise.resolve();
    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
    const clearCcsCostRefreshTimer = () => {
        if (ccsCostRefreshTimer) {
            clearTimeout(ccsCostRefreshTimer);
            ccsCostRefreshTimer = null;
        }
    };
    const publish = async (active = true) => {
        snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), active, paused);
        await writeUsageTopSnapshot(snapshot);
        await recordUsageTopHistorySnapshot(snapshot);
    };
    const resetPolling = async () => {
        clearTimer();
        await refreshAllUsageTopRuntime(runtime, false, "server");
        await publish();
        schedule();
    };
    const schedule = () => {
        if (cleanedUp || paused) {
            return;
        }
        clearTimer();
        const delay = nextUsageTopRuntimeDelayMs(runtime, new Date());
        if (delay === null) {
            return;
        }
        timer = setTimeout(() => {
            timer = null;
            queueServerTask("ccs top scheduled refresh", async () => {
                await refreshDueUsageTopRuntime(runtime, new Date(), false, "server");
                await publish();
                schedule();
            });
        }, delay);
    };
    const runCcsCostRefresh = async () => {
        try {
            await refreshCentralCcsCostDerivedStore(profiles);
        }
        catch (error) {
            console.error(`ccs cost refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const scheduleCcsCostRefresh = () => {
        clearCcsCostRefreshTimer();
        const scheduledAt = new Date(Date.now() + ccsCostRefreshDebounceMs).toISOString();
        ccsCostRefreshTimer = setTimeout(() => {
            ccsCostRefreshTimer = null;
            void runCcsCostRefresh();
        }, ccsCostRefreshDebounceMs);
        return scheduledAt;
    };
    const queueServerTask = (name, task) => {
        serverTaskQueue = serverTaskQueue.then(async () => {
            try {
                await task();
            }
            catch (error) {
                console.error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    };
    let snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), true, paused);
    await writeUsageTopSnapshot(snapshot);
    await recordUsageTopHistorySnapshot(snapshot);
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method === "GET" && url.pathname === "/health") {
            sendUsageTopJson(response, 200, { ok: true });
            return;
        }
        if (request.method === "GET" && url.pathname === "/ccs/top/state") {
            snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), true, paused);
            sendUsageTopJson(response, 200, snapshot);
            return;
        }
        if (request.method === "GET" && url.pathname === "/ccs/top/history") {
            let historyRequest;
            try {
                historyRequest = parseUsageTopHistoryRequestFromUrl(url);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                sendUsageTopJson(response, 400, { error: message });
                return;
            }
            void (async () => {
                try {
                    const windowEnd = historyRequest.windowEnd ?? new Date();
                    sendUsageTopJson(response, 200, buildUsageTopHistory(await readUsageTopHistoryRecords(windowEnd), { ...historyRequest, windowEnd }));
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    sendUsageTopJson(response, 500, { error: message });
                }
            })();
            return;
        }
        if (request.method === "GET" && url.pathname === "/ccs/cost/status") {
            void (async () => {
                try {
                    sendUsageTopJson(response, 200, await buildCcsCostStatus(profiles));
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    sendUsageTopJson(response, 500, { error: message });
                }
            })();
            return;
        }
        if (request.method === "GET" && url.pathname === "/ccs/cost/report") {
            let costOptions;
            try {
                costOptions = parseCcsCostOptionsFromUrl(url);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                sendUsageTopJson(response, 400, { error: message });
                return;
            }
            void (async () => {
                try {
                    sendUsageTopJson(response, 200, await buildCentralCcsCostReport(costOptions, profiles));
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    sendUsageTopJson(response, 500, { error: message });
                }
            })();
            return;
        }
        if (request.method === "POST" && url.pathname === "/ccs/cost/refresh") {
            const scheduledAt = scheduleCcsCostRefresh();
            sendUsageTopJson(response, 200, {
                ok: true,
                debounceMs: ccsCostRefreshDebounceMs,
                scheduledAt,
            });
            return;
        }
        if (request.method === "POST" && url.pathname === "/ccs/top/pause") {
            paused = true;
            clearTimer();
            sendUsageTopJson(response, 200, { ok: true, paused });
            queueServerTask("ccs top pause", async () => {
                await publish();
            });
            return;
        }
        if (request.method === "POST" && url.pathname === "/ccs/top/resume") {
            paused = false;
            sendUsageTopJson(response, 200, { ok: true, paused });
            queueServerTask("ccs top resume", async () => {
                await resetPolling();
            });
            return;
        }
        if (request.method === "POST" && url.pathname === "/ccs/top/reset") {
            sendUsageTopJson(response, 200, { ok: true, paused });
            queueServerTask("ccs top reset", async () => {
                await resetPolling();
            });
            return;
        }
        if (request.method !== "GET" && request.method !== "POST") {
            sendUsageTopJson(response, 405, { error: "method not allowed" });
            return;
        }
        sendUsageTopJson(response, 404, { error: "not found" });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    console.log(`ccs top server: http://${host}:${port}/ccs/top/state`);
    void runCcsCostRefresh();
    await new Promise((resolve) => {
        schedule();
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            clearTimer();
            clearCcsCostRefreshTimer();
            await serverTaskQueue;
            await publish(false);
            server.close(() => resolve());
        };
        process.once("SIGINT", () => void cleanup());
        process.once("SIGTERM", () => void cleanup());
    });
}
function parseUsageTopOptions(args) {
    const options = {
        once: false,
        markIntervalMs: usageTopDefaultMarkIntervalMs,
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--once") {
            options.once = true;
            continue;
        }
        if (arg === "--mark") {
            const value = args[index + 1];
            if (!value) {
                throw new Error("usage: ccs top [--once] [--mark DURATION]");
            }
            options.markIntervalMs = parseDurationMs(value);
            index += 1;
            continue;
        }
        throw new Error(`unknown argument for ccs top: ${arg}`);
    }
    return options;
}
async function printUsageTop(profiles, options) {
    const targets = collectUsageTopTargets(profiles);
    if (targets.length === 0) {
        console.log(textDim("no profiles"));
        return;
    }
    const runtime = await createUsageTopRuntime(targets, options.once);
    let lastMarkAt = Date.now();
    let nextMarkAt = nextAlignedTimeMs(lastMarkAt, options.markIntervalMs);
    let lastMarkCosts = readUsageTopCosts(runtime.entries);
    const writeLine = async () => {
        const now = new Date();
        const line = buildUsageTopLine(runtime.entries, runtime.states, now);
        const snapshot = buildUsageTopSnapshot(runtime.entries, runtime.states, now, true);
        if (options.once) {
            await writeUsageTopSnapshot(snapshot);
            await recordUsageTopHistorySnapshot(snapshot);
            console.log(line);
            return;
        }
        if (!process.stdout.isTTY) {
            console.log(line);
            return;
        }
        process.stdout.write(`\r\u001b[2K${line}`);
        await writeUsageTopSnapshot(snapshot);
    };
    const printMarkLine = () => {
        const now = new Date();
        const line = formatUsageTopMarkLine(runtime.entries, lastMarkCosts, now);
        lastMarkAt = now.getTime();
        nextMarkAt = nextAlignedTimeMs(lastMarkAt, options.markIntervalMs);
        lastMarkCosts = readUsageTopCosts(runtime.entries);
        if (process.stdout.isTTY) {
            process.stdout.write(`\r\u001b[2K${line}\n`);
            return;
        }
        console.log(line);
    };
    await writeLine();
    if (options.once) {
        return;
    }
    if (!process.stdout.isTTY) {
        throw new Error("ccs top requires a terminal unless --once is used");
    }
    await new Promise((resolve) => {
        const timer = setInterval(() => {
            void (async () => {
                const now = new Date();
                await refreshDueUsageTopRuntime(runtime, now, true, "top");
                if (now.getTime() >= nextMarkAt) {
                    printMarkLine();
                }
                await writeLine();
            })();
        }, usageTopTickMs);
        const refreshAll = async () => {
            await refreshAllUsageTopRuntime(runtime, true, "top");
            await writeLine();
        };
        let cleanedUp = false;
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            clearInterval(timer);
            process.stdin.off("data", onData);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            process.stdin.pause();
            await writeUsageTopSnapshot(buildUsageTopSnapshot(runtime.entries, runtime.states, new Date(), false));
            process.stdout.write("\n");
            resolve();
        };
        const onData = (chunk) => {
            const value = chunk.toString("utf8");
            if (value === "r") {
                void refreshAll();
                return;
            }
            if (value === "q" || value === "\u0003") {
                void cleanup();
            }
        };
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on("data", onData);
        }
        process.once("SIGINT", () => void cleanup());
        process.once("SIGTERM", () => void cleanup());
    });
}
async function runCcsStatus(profiles, args) {
    const subcommand = args[0] ?? "";
    const subargs = args.slice(1);
    if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
        assertExactArgs(subargs, "s help", 0);
        printHelp();
        return;
    }
    if (!subcommand) {
        assertExactArgs(subargs, "s", 0);
        await printUsageTopStatusLine(profiles);
        printStatusUsageHelp();
        return;
    }
    if (subcommand === "line") {
        assertExactArgs(subargs, "s line", 0);
        await printUsageTopStatusLine(profiles);
        return;
    }
    if (subcommand === "agent") {
        assertExactArgs(subargs, "s agent", 0);
        await runUsageTopStatusAgent();
        return;
    }
    if (subcommand === "server") {
        assertMaxArgs(subargs, "s server [PORT]", 1);
        await serveUsageTop(profiles, subargs[0] ?? "8765");
        return;
    }
    if (subcommand === "history") {
        assertMaxArgs(subargs, "s history [PROFILE]", 1);
        await printUsageTopHistory(profiles, subargs[0]);
        return;
    }
    if (subcommand === "pause" || subcommand === "resume" || subcommand === "reset") {
        assertExactArgs(subargs, `s ${subcommand}`, 0);
        await controlUsageTopServer(profiles, subcommand);
        return;
    }
    if (subcommand === "wezterm") {
        const options = parseWeztermArgs(subargs);
        const previewPlan = options.remove
            ? await buildWeztermRemovePreviewPlan()
            : await buildWeztermPreviewPlan();
        printPreviewPlan(previewPlan, true);
        if (!(await confirmApply())) {
            return;
        }
        const backupDir = await backupCcsFiles(previewPlan.backupFiles);
        const nextConfigText = previewPlan.previewFiles[0]?.next;
        if (nextConfigText !== undefined) {
            await writeTextFile(weztermConfigPath(), nextConfigText);
        }
        if (backupDir) {
            console.log(`backup: ${textBlue(backupDir)}`);
        }
        console.log(`wezterm config ${options.remove ? "updated" : "written"}: ${textGreen(weztermConfigPath())}`);
        return;
    }
    throw new Error(`unknown argument for ccs s: ${subcommand}`);
}
function usageLines() {
    return [
        "  ccs                                  # show current profile and usage",
        "  ccs version                          # print package version",
        "  ccs -v                               # print package version",
        "  ccs r                                # show app-server daemon status and version",
        "  ccs PROFILE                          # show profile details and usage",
        "  ccs run PROFILE [CODEX_ARGS...]       # launch codex once with a profile",
        "  ccs models [--json]                  # list profile models from /v1/models",
        "  ccs pricing                          # show pricing cache status",
        "  ccs pricing list [--remote]          # show local or watched-provider remote prices",
        "  ccs pricing pattern                   # show watched patterns and matching model counts",
        "  ccs pricing pattern watch PATTERN...  # add patterns and rebuild remote model prices",
        "  ccs pricing pattern unwatch PATTERN... # remove patterns and rebuild remote model prices",
        "  ccs pricing provider                  # show watched LiteLLM providers",
        "  ccs pricing provider add PROVIDER...  # add providers locally",
        "  ccs pricing provider remove PROVIDER... # remove providers and prune local models",
        "  ccs pricing refresh                   # rebuild prices from watched patterns and providers",
        "  ccs proxy [--view overview|tokens|cost] # show proxy status with the selected request view",
        "  ccs proxy [watch|mode|install|restore|stop|serve] # manage proxy state and runtime",
        "  ccs cost                             # show cost data source and commands",
        "  ccs cost daily                       # show Codex session daily cost totals",
        "  ccs cost weekly                      # show Codex session weekly cost totals",
        "  ccs cost monthly                     # show Codex session monthly cost totals",
        "  ccs cost projects                    # show Codex session project cost totals",
        "  ccs cost project PROJECT             # show one Codex project by day",
        "  ccs cost day YYYY-MM-DD              # show one Codex day by time and project",
        "  ccs cost push                        # upload this machine's cost events to the LAN server",
        "  ccs cost central [REPORT]            # show central cost status or report from the LAN server",
        "  ccs toggle [PROFILE]                 # switch profile",
        "  ccs top [--once] [--mark DURATION]   # show all usage costs with checkpoint lines",
        "  ccs config [push|pull]                # preview, confirm, and sync profiles.json with LAN server",
        "  ccs s [line]                         # print compact status from configured top state",
        "  ccs s agent                          # write local status text for WezTerm",
        "  ccs s server [PORT]                  # serve top state on 0.0.0.0",
        "  ccs s history [PROFILE]              # show today's usage history with 30-minute buckets",
        "  ccs s pause                          # pause first reachable configured top server",
        "  ccs s resume                         # resume first reachable configured top server",
        "  ccs s reset                          # refresh server now and reset polling to 25s",
        "  ccs s wezterm                        # preview, confirm, and install WezTerm status integration",
        "  ccs s wezterm remove                 # preview, confirm, and remove WezTerm status integration",
        "  ccs list | l [-u|--usage]             # list profiles; -u also shows usage profiles",
        "  ccs usage                            # list usage-only profiles",
        "  ccs usage add [PROFILE]               # add or update a usage-only profile",
        "  ccs usage remove | rm | delete PROFILE # remove a usage-only profile",
        "  ccs init                             # preview, confirm, and create config",
        "  ccs sync                             # add missing template config fields",
        "  ccs sync --replace TOML_PATH          # replace one repeatable template leaf field",
        "  ccs sync --replace all                # replace every template leaf except provider base URLs",
        "  ccs add [PROFILE]                     # add or update a profile",
        "  ccs remove | rm | delete PROFILE      # remove a profile",
    ];
}
function printHelp() {
    console.log([
        textBold("Usage:"),
        ...usageLines(),
    ].join("\n"));
}
function isHelpArgument(value) {
    return value === "help" || value === "--help" || value === "-h";
}
function parseWeztermArgs(args) {
    rejectRemovedYesFlags(args, "ccs s wezterm");
    let remove = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "remove") {
            remove = true;
            continue;
        }
        throw new Error(`unknown argument for ccs s wezterm: ${arg}`);
    }
    return { remove };
}
let ccsCostSnapshotCache = null;
let ccsCostDerivedCache = null;
let ccsCostReportCache = new Map();
const ccsCostReports = new Set(["daily", "weekly", "monthly", "projects", "project", "models", "day"]);
const ccsCostBucketMinutes = new Map([
    ["15m", 15],
    ["30m", 30],
    ["1h", 60],
    ["2h", 120],
]);
function printCcsCostHelp() {
    console.log([
        textBold("Usage:"),
        "  ccs cost                                           # show cost data source and commands",
        "  ccs cost daily                                     # show daily totals",
        "  ccs cost weekly                                    # show weekly totals",
        "  ccs cost monthly                                   # show monthly totals",
        "  ccs cost projects                                  # show project totals",
        "  ccs cost project PROJECT                           # show one project by day",
        "  ccs cost models                                    # show totals by model",
        "  ccs cost day YYYY-MM-DD                            # show one day by time and project",
        "  ccs cost push                                      # upload this machine's cost events to the LAN server",
        "  ccs cost central daily                             # show central daily totals from the LAN server",
        "  ccs cost central weekly                            # show central weekly totals from the LAN server",
        "  ccs cost central monthly                           # show central monthly totals from the LAN server",
        "  ccs cost central projects                          # show central project totals from the LAN server",
        "  ccs cost central project PROJECT                   # show one central project by day",
        "  ccs cost central models                            # show central totals by model",
        "  ccs cost central day YYYY-MM-DD                    # show one central day by time and project",
        "",
        textBold("Options:"),
        "  --since YYYY-MM-DD      inclusive start date",
        "  --until YYYY-MM-DD      inclusive end date",
        "  --timezone IANA_NAME    date grouping timezone; defaults to the system timezone",
        "  --bucket 15m|30m|1h|2h  time bucket for ccs cost day; default 1h",
        "  --json                  print stable JSON",
        "  --raw                   print full token counts and decimal costs",
        "  --speed auto|standard|fast",
    ].join("\n"));
}
async function printCcsCostStatus(profiles) {
    const speed = await resolveCodexCostSpeed("auto");
    const urls = await readUsageTopStateUrls(profiles);
    printKeyValue("sessions:", colorPath(formatDisplayPath(codexDir())), 9);
    printKeyValue("pricing:", colorPath(formatDisplayPath(modelPricesConfigPath())), 9);
    printKeyValue("remote:", urls[0] ? colorUrl(ccsCostStatusUrl(urls[0])) : textDim("none"), 9);
    printKeyValue("upload:", colorPath(ccsCostRemoteDisplay), 9);
    printKeyValue("timezone:", systemTimezone(), 9);
    printKeyValue("speed:", `auto -> ${speed}`, 9);
    console.log(textDim("commands: ccs cost push | ccs cost [daily|weekly|monthly|projects|project PROJECT|models|day YYYY-MM-DD] | ccs cost central [daily|weekly|monthly|projects|project PROJECT|models|day YYYY-MM-DD]"));
    console.log(textDim("options: --since YYYY-MM-DD | --until YYYY-MM-DD | --timezone IANA_NAME | --bucket 15m|30m|1h|2h | --json | --raw | --speed auto|standard|fast"));
}
async function runCcsCost(args, profiles) {
    const parsed = parseCcsCostCommandArgs(args);
    if (parsed.command === "status") {
        await printCcsCostStatus(profiles);
        return;
    }
    if (parsed.command === "help") {
        printCcsCostHelp();
        return;
    }
    if (parsed.command === "push") {
        await pushCcsCostSnapshot(profiles, parsed.options);
        return;
    }
    if (parsed.command === "central") {
        if (!parsed.options) {
            await printCentralCcsCostStatus(profiles);
            return;
        }
        await printCentralCcsCost(profiles, parsed.options);
        return;
    }
    if (!parsed.options) {
        printCcsCostHelp();
        return;
    }
    await printLocalCcsCost(parsed.options, profiles);
}
async function printLocalCcsCost(options, profiles) {
    const events = await loadCodexUsageEvents({
        ...(options.report === "day" && options.day ? dateRangeForDay(options.day, options.timezone) : {
            since: options.since,
            until: options.until,
            timezone: options.timezone,
        }),
        project: options.project,
    });
    const speed = await resolveCodexCostSpeed(options.speed);
    const context = {
        priceCache: await readModelPriceCacheForModels(ccsCostAggregateEvents(events).modelUsage, speed, ccsCostPriceOptions(profiles)),
        speed,
    };
    printCcsCostReport(buildCcsCostReport(options, events, context, "local"), options);
}
async function printCcsPricingStatus() {
    const speed = await resolveCodexCostSpeed("auto");
    const cache = await readStoredModelPriceCache();
    printKeyValue("pricing:", colorPath(formatDisplayPath(modelPricesConfigPath())), 9);
    printKeyValue("patterns:", cache.patterns.length > 0 ? formatInteger(cache.patterns.length) : textDim("none"), 9);
    printKeyValue("providers:", cache.providers.length > 0 ? formatInteger(cache.providers.length) : textDim("none"), 9);
    printKeyValue("models:", Object.keys(cache.models).length > 0 ? formatInteger(Object.keys(cache.models).length) : textDim("none"), 9);
    printKeyValue("source:", cache.source === "builtin" ? textDim(cache.source) : colorUrl(cache.source), 9);
    printKeyValue("fetched:", cache.fetchedAt, 9);
    printKeyValue("speed:", `auto -> ${speed}`, 9);
    console.log(textDim("commands: ccs pricing list [--remote] | ccs pricing pattern [watch|unwatch] | ccs pricing provider [add|remove] | ccs pricing refresh"));
}
function printCcsPricingHelp() {
    console.log([
        textBold("Usage:"),
        "  ccs pricing                          # show pricing cache status",
        "  ccs pricing list [--remote]          # show local or watched-provider remote prices",
        "  ccs pricing pattern                   # show watched patterns and matching model counts",
        "  ccs pricing pattern watch PATTERN...  # add patterns and rebuild remote model prices",
        "  ccs pricing pattern unwatch PATTERN... # remove patterns and rebuild remote model prices",
        "  ccs pricing provider                  # show watched LiteLLM providers",
        "  ccs pricing provider add PROVIDER...  # add providers locally",
        "  ccs pricing provider remove PROVIDER... # remove providers and prune local models",
        "  ccs pricing refresh                   # rebuild prices from watched patterns and providers",
    ].join("\n"));
}
async function runCcsPricing(args) {
    if (args.some(isHelpArgument)) {
        printCcsPricingHelp();
        return;
    }
    if (args.length === 0) {
        await printCcsPricingStatus();
        return;
    }
    const subcommand = args[0];
    if (subcommand === "list") {
        await printCcsPricingList(await readProfiles(), parseCcsPricingListArgs(args.slice(1)));
        return;
    }
    if (subcommand === "refresh") {
        rejectRemovedYesFlags(args, "ccs pricing refresh");
        if (args.length !== 1) {
            throw new Error("usage: ccs pricing refresh");
        }
        await refreshCcsPricing();
        return;
    }
    if (subcommand === "pattern") {
        await runCcsPricingPattern(args.slice(1));
        return;
    }
    if (subcommand === "provider") {
        await runCcsPricingProvider(args.slice(1));
        return;
    }
    throw new Error(`unknown argument for ccs pricing: ${subcommand}`);
}
async function refreshCcsPricing() {
    const cache = await readStoredModelPriceCache();
    if (cache.patterns.length === 0 || cache.providers.length === 0) {
        throw new Error("ccs pricing refresh requires watched patterns and providers");
    }
    await rebuildCcsPricingSnapshot("ccs pricing refresh", cache.patterns, cache.providers);
}
async function runCcsPricingPattern(args) {
    if (args.length === 0) {
        await printCcsPricingPatterns();
        return;
    }
    const command = args[0];
    if (command !== "watch" && command !== "unwatch") {
        throw new Error(`unknown argument for ccs pricing pattern: ${command}`);
    }
    const label = `ccs pricing pattern ${command}`;
    rejectRemovedYesFlags(args, label);
    const patterns = parseCcsPricingNames(args.slice(1), label, "PATTERN...");
    const cache = await readStoredModelPriceCache();
    if (command === "unwatch") {
        const missing = patterns.filter((pattern) => !cache.patterns.includes(pattern));
        if (missing.length > 0) {
            throw new Error(`pricing patterns not watched: ${missing.join(", ")}`);
        }
        await rebuildCcsPricingSnapshot(label, cache.patterns.filter((pattern) => !patterns.includes(pattern)), cache.providers);
        return;
    }
    await rebuildCcsPricingSnapshot(label, normalizeModelPricePatterns([...cache.patterns, ...patterns]), cache.providers);
}
async function printCcsPricingPatterns() {
    const cache = await readStoredModelPriceCache();
    console.log(textBold("ccs pricing pattern"));
    printKeyValue("cache:", colorPath(formatDisplayPath(modelPricesConfigPath())), 9);
    printKeyValue("patterns:", cache.patterns.length > 0 ? formatInteger(cache.patterns.length) : textDim("none"), 9);
    if (cache.patterns.length === 0) {
        return;
    }
    const models = Object.keys(cache.models);
    printTable([
        { key: "pattern", title: "pattern" },
        { key: "models", title: "models", align: "right" },
    ], cache.patterns.map((pattern) => ({
        pattern,
        models: formatInteger(matchingModelNames(pattern, models).length),
    })));
}
async function runCcsPricingProvider(args) {
    if (args.length === 0) {
        await printCcsPricingProviders();
        return;
    }
    const command = args[0];
    if (command !== "add" && command !== "remove") {
        throw new Error(`unknown argument for ccs pricing provider: ${command}`);
    }
    const label = `ccs pricing provider ${command}`;
    rejectRemovedYesFlags(args, label);
    const providers = parseCcsPricingNames(args.slice(1), label, "PROVIDER...");
    const cache = await readStoredModelPriceCache();
    if (command === "remove") {
        const missing = providers.filter((provider) => !cache.providers.includes(provider));
        if (missing.length > 0) {
            throw new Error(`pricing providers not watched: ${missing.join(", ")}`);
        }
    }
    const nextProviders = command === "add"
        ? normalizeModelPriceProviders([...cache.providers, ...providers])
        : cache.providers.filter((provider) => !providers.includes(provider));
    const nextCache = pruneModelPriceCache(cache, cache.patterns, nextProviders);
    const speed = await resolveCodexCostSpeed("auto");
    console.log(textBold(label));
    printKeyValue("cache:", colorPath(formatDisplayPath(modelPricesConfigPath())), 9);
    printKeyValue("providers:", `${formatInteger(cache.providers.length)} -> ${formatInteger(nextCache.providers.length)}`, 9);
    printKeyValue("models:", `${formatInteger(Object.keys(cache.models).length)} -> ${formatInteger(Object.keys(nextCache.models).length)}`, 9);
    console.log(textDim("no changes are written unless you type yes at the prompt."));
    printCcsPricingPriceTable(nextCache, Object.keys(nextCache.models).sort(), speed);
    if (!(await confirmApply())) {
        return;
    }
    await writeModelPriceCache(nextCache);
    console.log(`pricing cache updated: ${textGreen(modelPricesConfigPath())}`);
}
async function printCcsPricingProviders() {
    const cache = await readStoredModelPriceCache();
    console.log(textBold("ccs pricing provider"));
    printKeyValue("cache:", colorPath(formatDisplayPath(modelPricesConfigPath())), 9);
    printKeyValue("providers:", cache.providers.length > 0 ? formatInteger(cache.providers.length) : textDim("none"), 9);
    if (cache.providers.length > 0) {
        printTable([{ key: "provider", title: "provider" }], cache.providers.map((provider) => ({ provider })));
    }
}
async function rebuildCcsPricingSnapshot(title, patterns, providers) {
    const remote = await readRemoteModelPriceCatalog();
    const speed = await resolveCodexCostSpeed("auto");
    console.log(textBold(title));
    printKeyValue("cache:", colorPath(formatDisplayPath(modelPricesConfigPath())), 9);
    printKeyValue("remote:", remote.models ? colorUrl(litellmPricingUrl) : textYellow(`unavailable (${remote.error})`), 9);
    printKeyValue("speed:", `auto -> ${speed}`, 9);
    if (!remote.models) {
        return;
    }
    const plan = await buildModelPriceSnapshotPlanFromRemoteCatalog(patterns, providers, remote.models);
    printCcsPricingSnapshotPlan(plan, speed);
    if (!(await confirmApply())) {
        return;
    }
    await writeModelPriceSnapshotPlan(plan);
    console.log(`pricing cache updated: ${textGreen(plan.configPath)}`);
}
function printCcsPricingSnapshotPlan(plan, speed) {
    printKeyValue("cache:", colorPath(formatDisplayPath(plan.configPath)), 9);
    printKeyValue("source:", colorUrl(plan.source), 9);
    printKeyValue("fetched:", plan.fetchedAt, 9);
    printKeyValue("patterns:", `${formatInteger(plan.currentCache.patterns.length)} -> ${formatInteger(plan.nextCache.patterns.length)}`, 9);
    printKeyValue("providers:", `${formatInteger(plan.currentCache.providers.length)} -> ${formatInteger(plan.nextCache.providers.length)}`, 9);
    printKeyValue("models:", `${formatInteger(Object.keys(plan.currentCache.models).length)} -> ${formatInteger(Object.keys(plan.nextCache.models).length)}`, 9);
    console.log(textDim("no changes are written unless you type yes at the prompt."));
    printCcsPricingPriceTable(plan.nextCache, Object.keys(plan.nextCache.models).sort(), speed);
}
async function printCcsPricingList(profiles, options) {
    const speed = await resolveCodexCostSpeed("auto");
    if (options.remote) {
        await printRemoteCcsPricingList(speed);
        return;
    }
    const storedCache = await readStoredModelPriceCache();
    const cache = await readModelPriceCache(ccsCostPriceOptions(profiles));
    printKeyValue("cache:", colorPath(formatDisplayPath(modelPricesConfigPath())), 8);
    printKeyValue("source:", storedCache.source === "builtin" ? textDim(storedCache.source) : colorUrl(storedCache.source), 8);
    printKeyValue("speed:", `auto -> ${speed}`, 8);
    printCcsPricingPriceTable(cache, Object.keys(storedCache.models).sort(), speed);
}
async function printRemoteCcsPricingList(speed) {
    const storedCache = await readStoredModelPriceCache();
    const remote = await readRemoteModelPriceCatalog();
    printKeyValue("remote:", remote.models ? colorUrl(litellmPricingUrl) : textYellow(`unavailable (${remote.error})`), 8);
    printKeyValue("providers:", storedCache.providers.length > 0 ? formatInteger(storedCache.providers.length) : textDim("none"), 8);
    printKeyValue("speed:", `auto -> ${speed}`, 8);
    if (!remote.models) {
        return;
    }
    const cache = remoteModelPriceCache(selectRemoteModelPrices(remote.models, ["*"], storedCache.providers), storedCache.providers);
    printCcsPricingPriceTable(cache, Object.keys(cache.models).sort(), speed);
}
function printCcsPricingPriceTable(cache, models, speed) {
    if (models.length === 0) {
        console.log(textDim("model prices: none."));
        return;
    }
    printTable(ccsPricingPriceColumns(), models.map((model) => ccsPricingPriceRow(cache, model, speed)));
}
function ccsPricingPriceColumns() {
    return [
        { key: "model", title: "model" },
        { key: "status", title: "status" },
        { key: "input", title: "input/M", align: "right" },
        { key: "cache", title: "cache/M", align: "right" },
        { key: "output", title: "output/M", align: "right" },
    ];
}
function ccsPricingPriceRow(cache, model, speed) {
    const parts = modelPriceParts(cache, model, speed);
    return {
        model,
        status: formatModelPricingStatus(modelPricingStatus(cache, model, speed)),
        input: formatPricePerMillion(parts?.input ?? null),
        cache: formatPricePerMillion(parts?.cacheRead ?? null),
        output: formatPricePerMillion(parts?.output ?? null),
    };
}
function formatPricePerMillion(value) {
    return value === null ? textDim("missing") : colorCost(formatCost(value * 1_000_000));
}
function remoteModelPriceCache(models, providers = []) {
    return {
        source: litellmPricingUrl,
        fetchedAt: new Date().toISOString(),
        patterns: [],
        providers,
        models,
    };
}
function parseCcsPricingListArgs(args) {
    let remote = false;
    for (const arg of args) {
        if (arg === "--remote") {
            remote = true;
            continue;
        }
        throw new Error(`unknown argument for ccs pricing list: ${arg}`);
    }
    return { remote };
}
function parseCcsPricingNames(args, command, usage) {
    for (const arg of args) {
        if (arg.startsWith("-")) {
            throw new Error(`unknown argument for ${command}: ${arg}`);
        }
    }
    const names = normalizeModelPricePatterns(args);
    if (names.length === 0) {
        throw new Error(`usage: ${command} ${usage}`);
    }
    return names;
}
function ccsCostPriceOptions(profiles) {
    return { overrides: profiles.pricing?.overrides };
}
function ccsCostAggregateEvents(events) {
    const aggregate = emptyAggregate();
    for (const event of events) {
        addUsage(aggregate, event.model, event.usage);
    }
    return aggregate;
}
function ccsCostModelRows(events) {
    const aggregate = ccsCostAggregateEvents(events);
    return [...aggregate.modelUsage.entries()].map(([model, usage]) => {
        const modelAggregate = emptyAggregate();
        addUsage(modelAggregate, model, usage);
        return { key: model, aggregate: modelAggregate };
    });
}
function parseCcsCostCommandArgs(args) {
    if (args.length === 0) {
        return { command: "status" };
    }
    if (args.some(isHelpArgument)) {
        return { command: "help" };
    }
    const first = args[0];
    if (first === "push") {
        const reportArgs = args.slice(1);
        return {
            command: "push",
            options: reportArgs.length > 0 ? parseCcsCostReportArgs(reportArgs) : undefined,
        };
    }
    if (first === "central") {
        return {
            command: "central",
            options: args.length > 1 ? parseCcsCostReportArgs(args.slice(1)) : undefined,
        };
    }
    return {
        command: "report",
        options: parseCcsCostReportArgs(args),
    };
}
function buildCcsCostReport(options, events, context, source) {
    const selectedEvents = filterCodexUsageEvents(events, {
        ...(options.report === "day" && options.day ? dateRangeForDay(options.day, options.timezone) : {
            since: options.since,
            until: options.until,
            timezone: options.timezone,
        }),
        project: options.project,
    });
    if (options.report === "daily") {
        const rows = aggregateDaily(selectedEvents, options.timezone);
        return buildCcsCostRowsReport(options, rows, context, source);
    }
    if (options.report === "weekly") {
        const rows = aggregateWeekly(selectedEvents, options.timezone);
        return buildCcsCostRowsReport(options, rows, context, source);
    }
    if (options.report === "monthly") {
        const rows = aggregateMonthly(selectedEvents, options.timezone);
        return buildCcsCostRowsReport(options, rows, context, source);
    }
    if (options.report === "projects") {
        return buildCcsCostRowsReport(options, aggregateProjects(selectedEvents), context, source);
    }
    if (options.report === "project") {
        const project = options.project;
        if (!project) {
            throw new Error("usage: ccs cost project PROJECT");
        }
        const rows = aggregateProjectDaily(selectedEvents, options.timezone, project);
        return buildCcsCostRowsReport(options, rows, context, source);
    }
    if (options.report === "models") {
        return buildCcsCostRowsReport(options, ccsCostModelRows(selectedEvents), context, source);
    }
    const day = options.day;
    if (!day) {
        throw new Error("usage: ccs cost day YYYY-MM-DD");
    }
    const timeRows = aggregateDayTimeBuckets(selectedEvents, options.timezone, day, options.bucketMinutes);
    const unsortedProjectRows = aggregateDayProjects(selectedEvents, options.timezone, day);
    const total = totalAggregate(unsortedProjectRows);
    const projectRows = [...unsortedProjectRows]
        .sort((left, right) => compareNullableCosts(calculateCodexCostBreakdown(left.aggregate.modelUsage, context.priceCache, context.speed).costUSD, calculateCodexCostBreakdown(right.aggregate.modelUsage, context.priceCache, context.speed).costUSD, left.key, right.key))
        .map((row) => ({ key: row.key, ...ccsCostMetricsJson(row.aggregate, context) }));
    return {
        version: 2,
        report: "day",
        date: day,
        timezone: options.timezone,
        bucket: options.bucket,
        totals: ccsCostMetricsJson(total, context),
        timeBuckets: timeRows.map((row) => ({ key: row.key, ...ccsCostMetricsJson(row.aggregate, context) })),
        projects: projectRows,
        source,
        generatedAt: new Date().toISOString(),
    };
}
function buildCcsCostRowsReport(options, rows, context, source) {
    const total = totalAggregate(rows);
    const selectedRows = options.report === "models" || options.report === "projects"
        ? [...rows].sort((left, right) => compareNullableCosts(calculateCodexCostBreakdown(left.aggregate.modelUsage, context.priceCache, context.speed).costUSD, calculateCodexCostBreakdown(right.aggregate.modelUsage, context.priceCache, context.speed).costUSD, left.key, right.key))
        : rows;
    const reportRows = selectedRows.map((row) => ({ key: row.key, ...ccsCostMetricsJson(row.aggregate, context) }));
    return {
        version: 2,
        report: options.report,
        range: {
            since: options.since ?? null,
            until: options.until ?? null,
            timezone: options.timezone,
        },
        timezone: options.timezone,
        rows: reportRows,
        totals: ccsCostMetricsJson(total, context),
        source,
        generatedAt: new Date().toISOString(),
    };
}
function parseCcsCostReportArgs(args) {
    let index = 1;
    let project;
    let day;
    const first = args[0];
    if (!first || first.startsWith("-")) {
        throw new Error("usage: ccs cost daily|weekly|monthly|projects|project|models|day [OPTIONS]");
    }
    if (!ccsCostReports.has(first)) {
        throw new Error(`unknown argument for ccs cost: ${first}`);
    }
    const report = first;
    if (report === "project") {
        const value = args[index];
        if (!value || value.startsWith("-")) {
            throw new Error("usage: ccs cost project PROJECT");
        }
        project = resolveProjectPath(value);
        index += 1;
    }
    if (report === "day") {
        const value = args[index];
        if (!value || value.startsWith("-")) {
            throw new Error("usage: ccs cost day YYYY-MM-DD");
        }
        day = value;
        index += 1;
    }
    let since;
    let until;
    let timezone = systemTimezone();
    let json = false;
    let raw = false;
    let speed = "auto";
    let bucket = "1h";
    let bucketProvided = false;
    for (; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg === "--raw") {
            raw = true;
            continue;
        }
        if (arg === "--since") {
            since = readCcsCostOptionValue(args, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--until") {
            until = readCcsCostOptionValue(args, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--timezone") {
            timezone = readCcsCostOptionValue(args, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--bucket") {
            const value = readCcsCostOptionValue(args, index, arg);
            if (!ccsCostBucketMinutes.has(value)) {
                throw new Error(`invalid ccs cost bucket: ${value}`);
            }
            bucket = value;
            bucketProvided = true;
            index += 1;
            continue;
        }
        if (arg === "--speed") {
            const value = readCcsCostOptionValue(args, index, arg);
            if (value !== "auto" && value !== "standard" && value !== "fast") {
                throw new Error(`invalid ccs cost speed: ${value}`);
            }
            speed = value;
            index += 1;
            continue;
        }
        throw new Error(`unknown argument for ccs cost ${report}: ${arg}`);
    }
    if (report === "day" && (since || until)) {
        throw new Error("ccs cost day uses YYYY-MM-DD instead of --since or --until");
    }
    if (report !== "day" && bucketProvided) {
        throw new Error("--bucket is only valid for ccs cost day");
    }
    return {
        report,
        since,
        until,
        timezone,
        json,
        raw,
        speed,
        bucket,
        bucketMinutes: ccsCostBucketMinutes.get(bucket) ?? 60,
        project,
        day,
    };
}
function readCcsCostOptionValue(args, index, option) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${option}`);
    }
    return value;
}
function parseCcsCostOptionsFromUrl(url) {
    const report = url.searchParams.get("report") ?? "";
    if (!ccsCostReports.has(report)) {
        throw new Error(`invalid report: ${report}`);
    }
    const args = [report];
    if (report === "project") {
        const project = url.searchParams.get("project");
        if (!project) {
            throw new Error("missing project");
        }
        args.push(project);
    }
    if (report === "day") {
        const day = url.searchParams.get("day");
        if (!day) {
            throw new Error("missing day");
        }
        args.push(day);
    }
    for (const option of ["since", "until", "timezone", "bucket", "speed"]) {
        const value = url.searchParams.get(option);
        if (value !== null) {
            args.push(`--${option}`, value);
        }
    }
    return parseCcsCostReportArgs(args);
}
function printCcsCostReport(report, options) {
    if (options.json) {
        console.log(stringifyJson(ccsCostReportJson(report)).trimEnd());
        return;
    }
    if (report.report === "day") {
        printCcsCostDayReport(report, options);
        return;
    }
    const rows = report.rows ?? [];
    console.log(ccsCostReportTitle(report, options));
    printCcsCostRecordTable(ccsCostReportKey(options.report), rows, report.totals, options.raw, (value) => (options.report === "projects" ? formatCcsCostProjectPath(value) : value));
}
function ccsCostReportJson(report) {
    if (report.report === "day") {
        return {
            version: report.version,
            report: "day",
            date: report.date,
            timezone: report.timezone,
            bucket: report.bucket,
            totals: report.totals,
            timeBuckets: (report.timeBuckets ?? []).map((row) => {
                const [start, end] = row.key.split("-");
                const { key: _key, ...metrics } = row;
                return {
                    start,
                    end,
                    ...metrics,
                };
            }),
            projects: (report.projects ?? []).map(({ key, ...metrics }) => ({ project: key, ...metrics })),
        };
    }
    const key = ccsCostReportKey(report.report);
    return {
        version: report.version,
        report: report.report,
        range: report.range,
        rows: (report.rows ?? []).map(({ key: value, ...metrics }) => ({ [key]: value, ...metrics })),
        totals: report.totals,
    };
}
function ccsCostReportKey(report) {
    if (report === "weekly") {
        return "week";
    }
    if (report === "monthly") {
        return "month";
    }
    if (report === "projects") {
        return "project";
    }
    if (report === "models") {
        return "model";
    }
    return "date";
}
function ccsCostReportTitle(report, options) {
    if (report.report === "project" && options.project) {
        return `ccs cost ${report.source === "central" ? "central project" : "project"}  ${formatProjectPath(options.project)}`;
    }
    const command = report.source === "central" ? `ccs cost central ${report.report}` : `ccs cost ${report.report}`;
    return `${command}  ${formatCcsCostRange(options)}  timezone ${options.timezone}`;
}
function printCcsCostDayReport(report, options) {
    const day = report.date;
    if (!day) {
        throw new Error("invalid ccs cost day report");
    }
    const title = report.source === "central" ? "ccs cost central day" : "ccs cost day";
    console.log(`${title}  ${day}  bucket ${options.bucket}  timezone ${options.timezone}`);
    const pricing = report.totals.missingPricingModels.length > 0
        ? `  pricing ${formatCcsCostPricing(report.totals)}`
        : "";
    console.log(textBold(`total  input ${colorInput(formatCcsCostTokens(report.totals.inputTokens, options.raw))}  output ${colorOutput(formatCcsCostTokens(report.totals.outputTokens, options.raw))}  cached ${formatCcsCostTokens(report.totals.cachedInputTokens, options.raw)}  total$ ${colorCost(formatCcsCostUSD(report.totals.costUSD, options.raw))}${pricing}`));
    console.log("");
    console.log("by time");
    printCcsCostRecordTable("time", report.timeBuckets ?? [], null, options.raw);
    console.log("");
    console.log("by project");
    printCcsCostRecordTable("project", report.projects ?? [], null, options.raw, formatCcsCostProjectPath);
}
function printCcsCostRecordTable(firstHeader, rows, total, raw, formatKey = (value) => value) {
    const showPricing = [...rows, ...(total ? [total] : [])].some(ccsCostHasMissingPricing);
    const bodyRows = rows.map((row) => ccsCostRecordTableRow(formatKey(row.key), row, raw, false, showPricing));
    const totalRow = total ? ccsCostRecordTableRow("total", total, raw, true, showPricing) : null;
    const tableRows = [...bodyRows];
    if (totalRow) {
        tableRows.push(totalRow);
    }
    const formatted = renderTable(ccsCostRecordTableColumns(firstHeader, showPricing), tableRows.map((row) => ccsCostRecordTableValues(row, showPricing)));
    const separatorIndex = totalRow ? formatted.length - 1 : -1;
    const width = Math.max(0, ...formatted.map(visibleLength));
    for (let index = 0; index < formatted.length; index += 1) {
        if (index === separatorIndex) {
            console.log(textDim("-".repeat(width)));
        }
        console.log(formatted[index]);
    }
}
function ccsCostRecordTableColumns(firstHeader, showPricing) {
    return [
        { key: "label", title: firstHeader },
        { key: "input", title: "input", align: "right" },
        { key: "output", title: "output", align: "right" },
        { key: "cached", title: "cached", align: "right" },
        { key: "inputCost", title: "input$", align: "right" },
        { key: "outputCost", title: "output$", align: "right" },
        { key: "cachedCost", title: "cached$", align: "right" },
        { key: "cost", title: "total$", align: "right" },
        ...(showPricing ? [{ key: "pricing", title: "pricing" }] : []),
    ];
}
function ccsCostRecordTableValues(row, showPricing) {
    return {
        label: row[0] ?? "",
        input: row[1] ?? "",
        output: row[2] ?? "",
        cached: row[3] ?? "",
        inputCost: row[4] ?? "",
        outputCost: row[5] ?? "",
        cachedCost: row[6] ?? "",
        cost: row[7] ?? "",
        pricing: showPricing ? row[8] ?? "" : "",
    };
}
function ccsCostRecordTableRow(label, record, raw, emphasize, showPricing) {
    const row = [
        label,
        colorInput(formatCcsCostTokens(record.inputTokens, raw)),
        colorOutput(formatCcsCostTokens(record.outputTokens, raw)),
        formatCcsCostTokens(record.cachedInputTokens, raw),
        colorCost(formatCcsCostUSD(record.inputCostUSD, raw)),
        colorCost(formatCcsCostUSD(record.outputCostUSD, raw)),
        colorCost(formatCcsCostUSD(record.cachedCostUSD, raw)),
        colorCost(formatCcsCostUSD(record.costUSD, raw)),
        ...(showPricing ? [formatCcsCostPricing(record)] : []),
    ];
    return emphasize ? row.map(textBold) : row;
}
function ccsCostHasMissingPricing(record) {
    return record.missingPricingModels.length > 0;
}
function formatCcsCostPricing(record) {
    return record.missingPricingModels.length === 0
        ? textGreen("ok")
        : textRed(`missing ${record.missingPricingModels.length}`);
}
function ccsCostMetricsJson(aggregate, context) {
    const breakdown = calculateCodexCostBreakdown(aggregate.modelUsage, context.priceCache, context.speed);
    return {
        inputTokens: aggregate.inputTokens - aggregate.cachedInputTokens,
        outputTokens: aggregate.outputTokens,
        cachedInputTokens: aggregate.cachedInputTokens,
        inputCostUSD: roundNullableCostUSD(breakdown.inputCostUSD),
        outputCostUSD: roundNullableCostUSD(breakdown.outputCostUSD),
        cachedCostUSD: roundNullableCostUSD(breakdown.cachedCostUSD),
        costUSD: roundNullableCostUSD(breakdown.costUSD),
        missingPricingModels: breakdown.missingPricingModels,
    };
}
function ccsCostTokenUsageRecord(usage) {
    return {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        totalTokens: usage.totalTokens,
    };
}
function ccsCostEventRecord(event) {
    return {
        timestampMs: event.timestampMs,
        project: event.project,
        model: event.model,
        usage: ccsCostTokenUsageRecord(event.usage),
    };
}
function ccsCostMachineName() {
    return `${formatSystemLabel().replace(/[^A-Za-z0-9._-]+/g, "_")}`;
}
async function buildCcsCostSnapshot(options) {
    const timezone = options?.timezone ?? systemTimezone();
    const speed = await resolveCodexCostSpeed("auto");
    const events = await loadCodexUsageEvents({
        ...(options?.report === "day" && options.day ? dateRangeForDay(options.day, timezone) : {
            since: options?.since,
            until: options?.until,
            timezone,
        }),
        project: options?.project,
    });
    const systemLabel = formatSystemLabel();
    const [sourceUser, sourceHost] = systemLabel.split("@");
    return {
        version: 1,
        machine: ccsCostMachineName(),
        sourceHost: sourceHost || hostname(),
        sourceUser: sourceUser || userInfo().username,
        sourceCodexDir: codexDir(),
        generatedAt: new Date().toISOString(),
        timezone,
        speed,
        events: events.map(ccsCostEventRecord),
    };
}
function ccsCostSnapshotFileName(snapshot) {
    return `${snapshot.machine}.json`;
}
async function pushCcsCostSnapshot(profiles, options) {
    const snapshot = await buildCcsCostSnapshot(options);
    const tempDir = await mkdtemp(join(tmpdir(), "ccs-cost-"));
    const tempPath = join(tempDir, ccsCostSnapshotFileName(snapshot));
    const remotePath = `${ccsCostRemoteDir}/${ccsCostSnapshotFileName(snapshot)}`;
    const remoteTempPath = `${remotePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await writeTextFile(tempPath, stringifyJson(snapshot), 0o600);
        await configSyncSsh(`mkdir -p ${JSON.stringify(ccsCostRemoteDir)}`);
        await configSyncScp(tempPath, `${configSyncUser}@${configSyncHost}:${remoteTempPath}`);
        await configSyncSsh(`mv -f ${JSON.stringify(remoteTempPath)} ${JSON.stringify(remotePath)}`);
    }
    finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const refreshUrl = await triggerCcsCostRefresh(profiles);
    const totals = snapshot.events.reduce((aggregate, event) => {
        aggregate.inputTokens += event.usage.inputTokens - event.usage.cachedInputTokens;
        aggregate.outputTokens += event.usage.outputTokens;
        aggregate.cachedInputTokens += event.usage.cachedInputTokens;
        return aggregate;
    }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    console.log(`uploaded: ${textGreen(`${configSyncUser}@${configSyncHost}:${remotePath}`)}`);
    printKeyValue("machine:", snapshot.machine, 9);
    printKeyValue("events:", formatInteger(snapshot.events.length), 9);
    printKeyValue("input:", formatCcsCostTokens(totals.inputTokens, false), 9);
    printKeyValue("output:", formatCcsCostTokens(totals.outputTokens, false), 9);
    printKeyValue("cached:", formatCcsCostTokens(totals.cachedInputTokens, false), 9);
    printKeyValue("refresh:", colorUrl(refreshUrl), 9);
}
async function triggerCcsCostRefresh(profiles) {
    const errors = [];
    const stateUrls = await readUsageTopStateUrls(profiles);
    if (stateUrls.length === 0) {
        throw new Error("ccs cost push requires top.stateUrls for refresh trigger");
    }
    for (const stateUrl of stateUrls) {
        const url = ccsCostRefreshUrl(stateUrl);
        const error = await postCcsCostRefresh(url);
        if (!error) {
            return url;
        }
        errors.push(`${url}: ${error}`);
    }
    throw new Error(`central ccs cost refresh trigger failed: ${errors.join("; ")}`);
}
async function postCcsCostRefresh(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ccsCostRefreshHttpTimeoutMs);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        const text = await response.text();
        return response.ok ? null : `HTTP ${response.status}${formatCcsCostFetchBody(text)}`;
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            return `timeout after ${ccsCostRefreshHttpTimeoutMs / 1000}s`;
        }
        return error instanceof Error ? error.message : String(error);
    }
    finally {
        clearTimeout(timeout);
    }
}
async function readCcsCostSnapshotFiles() {
    const dir = ccsCostSnapshotDir();
    let names;
    try {
        names = await readdir(dir);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const files = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
        const path = join(dir, name);
        const file = await stat(path);
        if (file.isFile()) {
            files.push({ name, path, size: file.size, mtimeMs: file.mtimeMs });
        }
    }
    return files;
}
function ccsCostSnapshotFingerprint(files) {
    return files.map((file) => `${file.name}:${file.size}:${file.mtimeMs}`).join("|");
}
async function getCcsCostSnapshotCache() {
    const files = await readCcsCostSnapshotFiles();
    const fingerprint = ccsCostSnapshotFingerprint(files);
    if (ccsCostSnapshotCache?.fingerprint === fingerprint) {
        return ccsCostSnapshotCache;
    }
    const snapshots = [];
    for (const file of files) {
        snapshots.push(parseCcsCostSnapshot(file.name, await readTextIfExists(file.path)));
    }
    ccsCostSnapshotCache = { fingerprint, snapshots };
    ccsCostReportCache = new Map();
    return ccsCostSnapshotCache;
}
function parseCcsCostSnapshot(name, text) {
    if (!text) {
        throw new Error(`empty ccs cost snapshot: ${name}`);
    }
    try {
        const snapshot = normalizeCcsCostSnapshot(JSON.parse(text));
        if (!snapshot) {
            throw new Error(`invalid ccs cost snapshot: ${name}`);
        }
        return snapshot;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid ccs cost snapshot ${name}: ${message}`);
    }
}
function normalizeCcsCostSnapshot(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (raw.version !== 1
        || typeof raw.machine !== "string"
        || typeof raw.sourceHost !== "string"
        || typeof raw.sourceUser !== "string"
        || typeof raw.sourceCodexDir !== "string"
        || typeof raw.generatedAt !== "string"
        || typeof raw.timezone !== "string"
        || (raw.speed !== "standard" && raw.speed !== "fast")
        || !Array.isArray(raw.events)) {
        return null;
    }
    const events = raw.events.map(normalizeCcsCostSnapshotEvent);
    if (events.some((event) => !event)) {
        return null;
    }
    return {
        version: 1,
        machine: raw.machine,
        sourceHost: raw.sourceHost,
        sourceUser: raw.sourceUser,
        sourceCodexDir: raw.sourceCodexDir,
        generatedAt: raw.generatedAt,
        timezone: raw.timezone,
        speed: raw.speed,
        events: events,
    };
}
function normalizeCcsCostSnapshotEvent(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (typeof raw.timestampMs !== "number"
        || !Number.isFinite(raw.timestampMs)
        || typeof raw.project !== "string"
        || typeof raw.model !== "string"
        || !raw.usage) {
        return null;
    }
    const usage = normalizeCcsCostTokenUsageRecord(raw.usage);
    return usage ? {
        timestampMs: raw.timestampMs,
        project: raw.project,
        model: raw.model,
        usage,
    } : null;
}
function normalizeCcsCostTokenUsageRecord(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (typeof raw.inputTokens !== "number"
        || typeof raw.cachedInputTokens !== "number"
        || typeof raw.outputTokens !== "number"
        || typeof raw.reasoningOutputTokens !== "number"
        || typeof raw.totalTokens !== "number"
        || !Number.isFinite(raw.inputTokens)
        || !Number.isFinite(raw.cachedInputTokens)
        || !Number.isFinite(raw.outputTokens)
        || !Number.isFinite(raw.reasoningOutputTokens)
        || !Number.isFinite(raw.totalTokens)) {
        return null;
    }
    return ccsCostTokenUsageRecord(raw);
}
async function buildCentralCcsCostReport(options, profiles) {
    const derived = await readCcsCostDerivedStore();
    const priceCache = await readCcsCostPriceCacheForDerived(derived, profiles, options.speed);
    const priceFingerprint = await ccsCostPriceFingerprint();
    const cacheKey = ccsCostReportCacheKey(derived.snapshotFingerprint, `${priceFingerprint}:${ccsCostPricingConfigFingerprint(profiles)}`, options);
    const cached = ccsCostReportCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const report = buildCcsCostReportFromDerived(derived, options, priceCache);
    ccsCostReportCache.set(cacheKey, report);
    return report;
}
async function buildCcsCostStatus(profiles) {
    const derived = await readCcsCostDerivedStore();
    const priceCache = await readCcsCostPriceCacheForDerived(derived, profiles, "auto");
    return {
        version: 2,
        updatedAt: new Date().toISOString(),
        snapshotCount: derived.machines.length,
        machines: derived.machines.map((machine) => {
            const metrics = ccsCostMetricsFromDerivedAggregate(machine.aggregate, priceCache, "auto");
            return {
                machine: machine.machine,
                generatedAt: machine.generatedAt,
                speed: machine.speed,
                events: machine.events,
                inputTokens: metrics.inputTokens,
                outputTokens: metrics.outputTokens,
                cachedInputTokens: metrics.cachedInputTokens,
                inputCostUSD: metrics.inputCostUSD,
                outputCostUSD: metrics.outputCostUSD,
                cachedCostUSD: metrics.cachedCostUSD,
                costUSD: metrics.costUSD,
                missingPricingModels: metrics.missingPricingModels,
            };
        }).sort((left, right) => left.machine.localeCompare(right.machine)),
    };
}
async function refreshCentralCcsCostDerivedStore(profiles) {
    const derived = await buildCcsCostDerivedStore();
    await writeTextFileAtomic(ccsCostDerivedPath(), stringifyJson(derived), 0o600);
    ccsCostDerivedCache = derived;
    ccsCostReportCache = new Map();
    const options = ["daily", "weekly", "monthly", "projects", "models"]
        .map((report) => defaultCentralCcsCostOptions(report, derived.timezone));
    for (const option of options) {
        await buildCentralCcsCostReport(option, profiles);
    }
    return { fingerprint: derived.snapshotFingerprint, reports: options.length };
}
async function readCcsCostPriceCacheForDerived(derived, profiles, speed) {
    if (speed !== "auto") {
        const modelUsage = ccsCostModelUsageFromDerivedStore(derived, ["standard", "fast"]);
        return readModelPriceCacheForModels(modelUsage, speed, ccsCostPriceOptions(profiles));
    }
    const standardUsage = ccsCostModelUsageFromDerivedStore(derived, ["standard"]);
    const fastUsage = ccsCostModelUsageFromDerivedStore(derived, ["fast"]);
    const standardCache = await readModelPriceCacheForModels(standardUsage, "standard", ccsCostPriceOptions(profiles));
    if (missingPricingModels(fastUsage, standardCache, "fast").length === 0) {
        return standardCache;
    }
    return readModelPriceCacheForModels(fastUsage, "fast", ccsCostPriceOptions(profiles));
}
function ccsCostModelUsageFromDerivedStore(derived, speeds) {
    const usage = new Map();
    for (const machine of derived.machines) {
        for (const speed of speeds) {
            addCcsCostModelUsageRecord(usage, machine.aggregate[speed].modelUsage);
        }
    }
    return usage;
}
function addCcsCostModelUsageRecord(target, source) {
    for (const [model, usage] of Object.entries(source)) {
        const existing = target.get(model) ?? {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
        };
        existing.inputTokens += usage.inputTokens;
        existing.cachedInputTokens += usage.cachedInputTokens;
        existing.outputTokens += usage.outputTokens;
        existing.reasoningOutputTokens += usage.reasoningOutputTokens;
        existing.totalTokens += usage.totalTokens;
        target.set(model, existing);
    }
}
function defaultCentralCcsCostOptions(report, timezone = systemTimezone()) {
    return {
        report,
        timezone,
        json: false,
        raw: false,
        speed: "auto",
        bucket: "1h",
        bucketMinutes: 60,
    };
}
async function ccsCostPriceFingerprint() {
    try {
        const file = await stat(modelPricesConfigPath());
        return `${file.size}:${file.mtimeMs}`;
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return "missing";
        }
        throw error;
    }
}
function ccsCostPricingConfigFingerprint(profiles) {
    return createHash("sha256").update(JSON.stringify(profiles.pricing?.overrides ?? {})).digest("hex").slice(0, 16);
}
function ccsCostReportCacheKey(snapshotFingerprint, priceFingerprint, options) {
    return JSON.stringify({
        snapshotFingerprint,
        priceFingerprint,
        report: options.report,
        since: options.since ?? null,
        until: options.until ?? null,
        timezone: options.timezone,
        bucket: options.bucket,
        speed: options.speed,
        project: options.project ?? null,
        day: options.day ?? null,
    });
}
async function readCcsCostDerivedStore() {
    if (ccsCostDerivedCache) {
        return ccsCostDerivedCache;
    }
    const text = await readTextIfExists(ccsCostDerivedPath());
    if (text === null) {
        throw new Error(`central ccs cost derived cache missing: ${ccsCostDerivedPath()}`);
    }
    const derived = normalizeCcsCostDerivedStore(JSON.parse(text));
    if (!derived) {
        throw new Error(`invalid central ccs cost derived cache: ${ccsCostDerivedPath()}`);
    }
    ccsCostDerivedCache = derived;
    return derived;
}
async function buildCcsCostDerivedStore() {
    const snapshotCache = await getCcsCostSnapshotCache();
    const timezone = ccsCostDerivedTimezone(snapshotCache.snapshots);
    const derived = {
        version: 1,
        snapshotFingerprint: snapshotCache.fingerprint,
        timezone,
        generatedAt: new Date().toISOString(),
        machines: [],
        daily: {},
        projects: {},
        projectDaily: {},
        dayBuckets15m: {},
        dayProjects: {},
    };
    for (const snapshot of snapshotCache.snapshots) {
        const machineAggregate = emptyCcsCostDerivedAggregate();
        for (const event of snapshot.events) {
            addCcsCostDerivedEvent(machineAggregate, snapshot.speed, event);
            const date = ccsCostLocalDateKey(event.timestampMs, timezone);
            const bucket = ccsCostTimeBucketKey(event.timestampMs, timezone, 15);
            addCcsCostDerivedEvent(ensureCcsCostDerivedAggregate(derived.daily, date), snapshot.speed, event);
            addCcsCostDerivedEvent(ensureCcsCostDerivedAggregate(derived.projects, event.project), snapshot.speed, event);
            addCcsCostDerivedEvent(ensureCcsCostNestedDerivedAggregate(derived.projectDaily, event.project, date), snapshot.speed, event);
            addCcsCostDerivedEvent(ensureCcsCostNestedDerivedAggregate(derived.dayBuckets15m, date, bucket), snapshot.speed, event);
            addCcsCostDerivedEvent(ensureCcsCostNestedDerivedAggregate(derived.dayProjects, date, event.project), snapshot.speed, event);
        }
        derived.machines.push({
            machine: snapshot.machine,
            generatedAt: snapshot.generatedAt,
            speed: snapshot.speed,
            events: snapshot.events.length,
            aggregate: machineAggregate,
        });
    }
    derived.machines.sort((left, right) => left.machine.localeCompare(right.machine));
    return derived;
}
function ccsCostDerivedTimezone(snapshots) {
    const timezones = [...new Set(snapshots.map((snapshot) => snapshot.timezone).filter((timezone) => !!timezone))];
    return timezones.length === 1 ? timezones[0] : systemTimezone();
}
function buildCcsCostReportFromDerived(derived, options, priceCache) {
    if (options.timezone !== derived.timezone) {
        throw new Error(`central ccs cost derived timezone is ${derived.timezone}; requested ${options.timezone}`);
    }
    if (options.report === "daily") {
        return buildCcsCostDerivedRowsReport(options, filteredCcsCostDerivedMap(derived.daily, options), priceCache);
    }
    if (options.report === "weekly") {
        return buildCcsCostDerivedRowsReport(options, groupCcsCostDerivedDates(derived.daily, options, ccsCostWeekKey), priceCache);
    }
    if (options.report === "monthly") {
        return buildCcsCostDerivedRowsReport(options, groupCcsCostDerivedDates(derived.daily, options, (date) => date.slice(0, 7)), priceCache);
    }
    if (options.report === "projects") {
        const projects = {};
        for (const [project, dates] of Object.entries(derived.projectDaily)) {
            const aggregate = sumCcsCostDerivedAggregates(Object.entries(dates)
                .filter(([date]) => ccsCostDateInRange(date, options))
                .map(([, value]) => value));
            if (!isEmptyCcsCostDerivedAggregate(aggregate)) {
                projects[project] = aggregate;
            }
        }
        return buildCcsCostDerivedRowsReport(options, projects, priceCache, "cost-desc");
    }
    if (options.report === "project") {
        const project = options.project;
        if (!project) {
            throw new Error("usage: ccs cost project PROJECT");
        }
        return buildCcsCostDerivedRowsReport(options, filteredCcsCostDerivedMap(derived.projectDaily[project] ?? {}, options), priceCache);
    }
    if (options.report === "models") {
        const selected = sumCcsCostDerivedAggregates(Object.values(filteredCcsCostDerivedMap(derived.daily, options)));
        return buildCcsCostDerivedRowsReport(options, ccsCostDerivedModels(selected), priceCache, "cost-desc");
    }
    const day = options.day;
    if (!day) {
        throw new Error("usage: ccs cost day YYYY-MM-DD");
    }
    const timeBuckets = groupCcsCostTimeBuckets(derived.dayBuckets15m[day] ?? {}, options.bucketMinutes);
    const projects = derived.dayProjects[day] ?? {};
    const timeRows = ccsCostRowsFromDerivedMap(timeBuckets, priceCache, options.speed);
    const projectRows = ccsCostRowsFromDerivedMap(projects, priceCache, options.speed, "cost-desc");
    return {
        version: 2,
        report: "day",
        date: day,
        timezone: options.timezone,
        bucket: options.bucket,
        totals: ccsCostMetricsFromDerivedAggregate(sumCcsCostDerivedAggregates(Object.values(projects)), priceCache, options.speed),
        timeBuckets: timeRows,
        projects: projectRows,
        source: "central",
        generatedAt: derived.generatedAt,
    };
}
function buildCcsCostDerivedRowsReport(options, values, priceCache, sortMode = "key-asc") {
    const rows = ccsCostRowsFromDerivedMap(values, priceCache, options.speed, sortMode);
    return {
        version: 2,
        report: options.report,
        range: {
            since: options.since ?? null,
            until: options.until ?? null,
            timezone: options.timezone,
        },
        timezone: options.timezone,
        rows,
        totals: ccsCostMetricsFromDerivedAggregate(sumCcsCostDerivedAggregates(Object.values(values)), priceCache, options.speed),
        source: "central",
        generatedAt: new Date().toISOString(),
    };
}
function ccsCostRowsFromDerivedMap(values, priceCache, speed, sortMode = "key-asc") {
    const entries = Object.entries(values);
    if (sortMode === "cost-desc") {
        entries.sort(([leftKey, left], [rightKey, right]) => compareNullableCosts(ccsCostBreakdownFromDerivedAggregate(left, priceCache, speed).costUSD, ccsCostBreakdownFromDerivedAggregate(right, priceCache, speed).costUSD, leftKey, rightKey));
    }
    else {
        entries.sort(([left], [right]) => left.localeCompare(right));
    }
    return entries.map(([key, aggregate]) => ({
        key,
        ...ccsCostMetricsFromDerivedAggregate(aggregate, priceCache, speed),
    }));
}
function filteredCcsCostDerivedMap(values, options) {
    return Object.fromEntries(Object.entries(values).filter(([date]) => ccsCostDateInRange(date, options)));
}
function groupCcsCostDerivedDates(values, options, keyOf) {
    const grouped = {};
    for (const [date, aggregate] of Object.entries(values)) {
        if (!ccsCostDateInRange(date, options)) {
            continue;
        }
        mergeCcsCostDerivedAggregate(ensureCcsCostDerivedAggregate(grouped, keyOf(date)), aggregate);
    }
    return grouped;
}
function groupCcsCostTimeBuckets(values, bucketMinutes) {
    const grouped = {};
    for (const [bucket, aggregate] of Object.entries(values)) {
        mergeCcsCostDerivedAggregate(ensureCcsCostDerivedAggregate(grouped, ccsCostMergedBucketKey(bucket, bucketMinutes)), aggregate);
    }
    return grouped;
}
function ccsCostDateInRange(date, options) {
    return (!options.since || date >= options.since) && (!options.until || date <= options.until);
}
function ccsCostMetricsFromDerivedAggregate(aggregate, priceCache, speed) {
    const total = ccsCostRecordToAggregate(sumCcsCostAggregateRecords([aggregate.standard, aggregate.fast]));
    const breakdown = ccsCostBreakdownFromDerivedAggregate(aggregate, priceCache, speed);
    return {
        inputTokens: total.inputTokens - total.cachedInputTokens,
        outputTokens: total.outputTokens,
        cachedInputTokens: total.cachedInputTokens,
        inputCostUSD: roundNullableCostUSD(breakdown.inputCostUSD),
        outputCostUSD: roundNullableCostUSD(breakdown.outputCostUSD),
        cachedCostUSD: roundNullableCostUSD(breakdown.cachedCostUSD),
        costUSD: roundNullableCostUSD(breakdown.costUSD),
        missingPricingModels: breakdown.missingPricingModels,
    };
}
function ccsCostBreakdownFromDerivedAggregate(aggregate, priceCache, speed) {
    const standard = ccsCostRecordToAggregate(aggregate.standard);
    const fast = ccsCostRecordToAggregate(aggregate.fast);
    const total = ccsCostRecordToAggregate(sumCcsCostAggregateRecords([aggregate.standard, aggregate.fast]));
    if (speed === "auto") {
        const standardCost = calculateCodexCostBreakdown(standard.modelUsage, priceCache, "standard");
        const fastCost = calculateCodexCostBreakdown(fast.modelUsage, priceCache, "fast");
        const inputCostUSD = sumNullableCosts(standardCost.inputCostUSD, fastCost.inputCostUSD);
        const outputCostUSD = sumNullableCosts(standardCost.outputCostUSD, fastCost.outputCostUSD);
        const cachedCostUSD = sumNullableCosts(standardCost.cachedCostUSD, fastCost.cachedCostUSD);
        return {
            inputCostUSD,
            outputCostUSD,
            cachedCostUSD,
            costUSD: sumNullableCosts(inputCostUSD, outputCostUSD, cachedCostUSD),
            missingPricingModels: uniqueSorted([...standardCost.missingPricingModels, ...fastCost.missingPricingModels]),
        };
    }
    return calculateCodexCostBreakdown(total.modelUsage, priceCache, speed);
}
function ccsCostDerivedModels(aggregate) {
    const models = {};
    for (const speed of ["standard", "fast"]) {
        for (const [model, usage] of Object.entries(aggregate[speed].modelUsage)) {
            addCcsCostAggregateRecordUsage(ensureCcsCostDerivedAggregate(models, model)[speed], model, usage);
        }
    }
    return models;
}
function ensureCcsCostDerivedAggregate(values, key) {
    values[key] ??= emptyCcsCostDerivedAggregate();
    return values[key];
}
function ensureCcsCostNestedDerivedAggregate(values, first, second) {
    values[first] ??= {};
    return ensureCcsCostDerivedAggregate(values[first], second);
}
function emptyCcsCostDerivedAggregate() {
    return {
        standard: emptyCcsCostAggregateRecord(),
        fast: emptyCcsCostAggregateRecord(),
    };
}
function emptyCcsCostAggregateRecord() {
    return {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        modelUsage: {},
    };
}
function addCcsCostDerivedEvent(aggregate, speed, event) {
    addCcsCostAggregateRecordUsage(aggregate[speed], event.model, event.usage);
}
function addCcsCostAggregateRecordUsage(aggregate, model, usage) {
    aggregate.inputTokens += usage.inputTokens;
    aggregate.cachedInputTokens += usage.cachedInputTokens;
    aggregate.outputTokens += usage.outputTokens;
    aggregate.reasoningOutputTokens += usage.reasoningOutputTokens;
    aggregate.totalTokens += usage.totalTokens;
    const modelUsage = aggregate.modelUsage[model] ?? {
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
    aggregate.modelUsage[model] = modelUsage;
}
function mergeCcsCostDerivedAggregate(target, source) {
    mergeCcsCostAggregateRecord(target.standard, source.standard);
    mergeCcsCostAggregateRecord(target.fast, source.fast);
}
function mergeCcsCostAggregateRecord(target, source) {
    for (const [model, usage] of Object.entries(source.modelUsage)) {
        addCcsCostAggregateRecordUsage(target, model, usage);
    }
}
function sumCcsCostDerivedAggregates(values) {
    const total = emptyCcsCostDerivedAggregate();
    for (const value of values) {
        mergeCcsCostDerivedAggregate(total, value);
    }
    return total;
}
function sumCcsCostAggregateRecords(values) {
    const total = emptyCcsCostAggregateRecord();
    for (const value of values) {
        mergeCcsCostAggregateRecord(total, value);
    }
    return total;
}
function isEmptyCcsCostDerivedAggregate(value) {
    return value.standard.totalTokens === 0 && value.fast.totalTokens === 0;
}
function ccsCostRecordToAggregate(record) {
    return {
        inputTokens: record.inputTokens,
        cachedInputTokens: record.cachedInputTokens,
        outputTokens: record.outputTokens,
        reasoningOutputTokens: record.reasoningOutputTokens,
        totalTokens: record.totalTokens,
        modelUsage: new Map(Object.entries(record.modelUsage)),
    };
}
function ccsCostLocalDateKey(timestampMs, timezone) {
    return DateTime.fromMillis(timestampMs, { zone: timezone }).toISODate() ?? "";
}
function ccsCostWeekKey(date) {
    return DateTime.fromISO(date, { zone: "UTC" }).startOf("week").toISODate() ?? date;
}
function ccsCostTimeBucketKey(timestampMs, timezone, bucketMinutes) {
    const local = DateTime.fromMillis(timestampMs, { zone: timezone });
    const minuteOfDay = local.hour * 60 + local.minute;
    const startMinute = Math.floor(minuteOfDay / bucketMinutes) * bucketMinutes;
    const endMinute = Math.min(24 * 60, startMinute + bucketMinutes);
    return `${formatCcsCostMinuteOfDay(startMinute)}-${formatCcsCostMinuteOfDay(endMinute)}`;
}
function ccsCostMergedBucketKey(bucket, bucketMinutes) {
    const match = /^(\d\d):(\d\d)-/.exec(bucket);
    if (!match) {
        throw new Error(`invalid ccs cost bucket: ${bucket}`);
    }
    const minuteOfDay = Number(match[1]) * 60 + Number(match[2]);
    const startMinute = Math.floor(minuteOfDay / bucketMinutes) * bucketMinutes;
    const endMinute = Math.min(24 * 60, startMinute + bucketMinutes);
    return `${formatCcsCostMinuteOfDay(startMinute)}-${formatCcsCostMinuteOfDay(endMinute)}`;
}
function formatCcsCostMinuteOfDay(value) {
    const hour = Math.floor(value / 60);
    const minute = value % 60;
    return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}
function normalizeCcsCostDerivedStore(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (raw.version !== 1
        || typeof raw.snapshotFingerprint !== "string"
        || typeof raw.timezone !== "string"
        || typeof raw.generatedAt !== "string"
        || !Array.isArray(raw.machines)
        || !raw.daily
        || !raw.projects
        || !raw.projectDaily
        || !raw.dayBuckets15m
        || !raw.dayProjects) {
        return null;
    }
    return raw;
}
function ccsCostStatusUrl(stateUrl) {
    const url = new URL(stateUrl);
    url.pathname = url.pathname.endsWith("/ccs/top/state")
        ? url.pathname.replace(/\/ccs\/top\/state$/, "/ccs/cost/status")
        : "/ccs/cost/status";
    url.search = "";
    url.hash = "";
    return url.toString();
}
function ccsCostRefreshUrl(stateUrl) {
    const url = new URL(stateUrl);
    url.pathname = url.pathname.endsWith("/ccs/top/state")
        ? url.pathname.replace(/\/ccs\/top\/state$/, "/ccs/cost/refresh")
        : "/ccs/cost/refresh";
    url.search = "";
    url.hash = "";
    return url.toString();
}
function ccsCostReportUrl(stateUrl, options) {
    const url = new URL(stateUrl);
    url.pathname = url.pathname.endsWith("/ccs/top/state")
        ? url.pathname.replace(/\/ccs\/top\/state$/, "/ccs/cost/report")
        : "/ccs/cost/report";
    url.search = "";
    url.hash = "";
    url.searchParams.set("report", options.report);
    url.searchParams.set("timezone", options.timezone);
    url.searchParams.set("speed", options.speed);
    if (options.since) {
        url.searchParams.set("since", options.since);
    }
    if (options.until) {
        url.searchParams.set("until", options.until);
    }
    if (options.project) {
        url.searchParams.set("project", options.project);
    }
    if (options.day) {
        url.searchParams.set("day", options.day);
    }
    if (options.report === "day") {
        url.searchParams.set("bucket", options.bucket);
    }
    return url.toString();
}
async function fetchCentralCcsCostReport(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ccsCostReportHttpTimeoutMs);
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            return { report: null, error: `HTTP ${response.status}${formatCcsCostFetchBody(text)}` };
        }
        let raw;
        try {
            raw = JSON.parse(text);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { report: null, error: `invalid JSON: ${message}` };
        }
        const report = normalizeCcsCostReportPayload(raw);
        return report ? { report } : { report: null, error: "invalid report response shape" };
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            return { report: null, error: `timeout after ${ccsCostReportHttpTimeoutMs / 1000}s` };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { report: null, error: message };
    }
    finally {
        clearTimeout(timeout);
    }
}
function formatCcsCostFetchBody(text) {
    const compact = text.trim().replace(/\s+/g, " ");
    return compact ? `: ${compact.slice(0, 200)}` : "";
}
async function fetchCentralCcsCostStatus(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), usageTopHistoryHttpTimeoutMs);
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) {
            return null;
        }
        return normalizeCcsCostStatus(await response.json());
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function printCentralCcsCostStatus(profiles) {
    for (const stateUrl of await readUsageTopStateUrls(profiles)) {
        const url = ccsCostStatusUrl(stateUrl);
        const status = await fetchCentralCcsCostStatus(url);
        if (status) {
            console.log(textBold("ccs cost central"));
            printKeyValue("source:", colorUrl(url), 9);
            printKeyValue("machines:", status.snapshotCount.toString(), 9);
            if (status.machines.length === 0) {
                console.log(textDim("no uploaded cost snapshots"));
                return;
            }
            const showPricing = status.machines.some((machine) => machine.missingPricingModels.length > 0);
            printTable([
                { key: "machine", title: "machine" },
                { key: "speed", title: "speed" },
                { key: "events", title: "events", align: "right" },
                { key: "input", title: "input", align: "right" },
                { key: "output", title: "output", align: "right" },
                { key: "cached", title: "cached", align: "right" },
                { key: "inputCost", title: "input$", align: "right" },
                { key: "outputCost", title: "output$", align: "right" },
                { key: "cachedCost", title: "cached$", align: "right" },
                { key: "cost", title: "total$", align: "right" },
                ...(showPricing ? [{ key: "pricing", title: "pricing" }] : []),
                { key: "updated", title: "updated", align: "right" },
            ], status.machines.map((machine) => ({
                machine: colorName(machine.machine),
                speed: machine.speed,
                events: formatInteger(machine.events),
                input: colorInput(formatCcsCostTokens(machine.inputTokens, false)),
                output: colorOutput(formatCcsCostTokens(machine.outputTokens, false)),
                cached: formatCcsCostTokens(machine.cachedInputTokens, false),
                inputCost: colorCost(formatCcsCostUSD(machine.inputCostUSD, false)),
                outputCost: colorCost(formatCcsCostUSD(machine.outputCostUSD, false)),
                cachedCost: colorCost(formatCcsCostUSD(machine.cachedCostUSD, false)),
                cost: colorCost(formatCcsCostUSD(machine.costUSD, false)),
                pricing: showPricing ? formatCcsCostPricing(machine) : "",
                updated: textDim(formatClockTime(new Date(machine.generatedAt))),
            })));
            return;
        }
    }
    throw new Error("central ccs cost status unavailable");
}
async function printCentralCcsCost(profiles, options) {
    const errors = [];
    for (const stateUrl of await readUsageTopStateUrls(profiles)) {
        const url = ccsCostReportUrl(stateUrl, options);
        const { report, error } = await fetchCentralCcsCostReport(url);
        if (report) {
            printCcsCostReport(report, options);
            if (!options.json) {
                printKeyValue("source:", colorUrl(url), 7);
            }
            return;
        }
        errors.push(`${url}: ${error ?? "unknown error"}`);
    }
    throw new Error(`central ccs cost report unavailable: ${errors.join("; ")}`);
}
function normalizeCcsCostStatus(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (raw.version !== 2
        || typeof raw.updatedAt !== "string"
        || typeof raw.snapshotCount !== "number"
        || !Array.isArray(raw.machines)) {
        return null;
    }
    const machines = raw.machines.map(normalizeCcsCostSnapshotSummary);
    if (machines.some((machine) => !machine)) {
        return null;
    }
    return {
        version: 2,
        updatedAt: raw.updatedAt,
        snapshotCount: raw.snapshotCount,
        machines: machines,
    };
}
function normalizeCcsCostSnapshotSummary(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (typeof raw.machine !== "string"
        || typeof raw.generatedAt !== "string"
        || (raw.speed !== "standard" && raw.speed !== "fast")
        || typeof raw.events !== "number"
        || typeof raw.inputTokens !== "number"
        || typeof raw.outputTokens !== "number"
        || typeof raw.cachedInputTokens !== "number"
        || !isNullableFiniteNumber(raw.inputCostUSD)
        || !isNullableFiniteNumber(raw.outputCostUSD)
        || !isNullableFiniteNumber(raw.cachedCostUSD)
        || !isNullableFiniteNumber(raw.costUSD)
        || !Array.isArray(raw.missingPricingModels)
        || !Number.isFinite(raw.events)
        || !Number.isFinite(raw.inputTokens)
        || !Number.isFinite(raw.outputTokens)
        || !Number.isFinite(raw.cachedInputTokens)) {
        return null;
    }
    return {
        machine: raw.machine,
        generatedAt: raw.generatedAt,
        speed: raw.speed,
        events: raw.events,
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        cachedInputTokens: raw.cachedInputTokens,
        inputCostUSD: raw.inputCostUSD,
        outputCostUSD: raw.outputCostUSD,
        cachedCostUSD: raw.cachedCostUSD,
        costUSD: raw.costUSD,
        missingPricingModels: normalizeMissingPricingModels(raw.missingPricingModels),
    };
}
function normalizeCcsCostReportPayload(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (raw.version !== 2
        || typeof raw.report !== "string"
        || !ccsCostReports.has(raw.report)
        || typeof raw.timezone !== "string"
        || !raw.totals
        || typeof raw.source !== "string"
        || typeof raw.generatedAt !== "string") {
        return null;
    }
    const totals = normalizeCcsCostMetricsRecord(raw.totals);
    if (!totals) {
        return null;
    }
    if (raw.report === "day") {
        const timeBuckets = Array.isArray(raw.timeBuckets)
            ? raw.timeBuckets.map(normalizeCcsCostReportRowRecord)
            : null;
        const projects = Array.isArray(raw.projects)
            ? raw.projects.map(normalizeCcsCostReportRowRecord)
            : null;
        if (!timeBuckets || !projects || timeBuckets.some((row) => !row) || projects.some((row) => !row)) {
            return null;
        }
        return {
            version: 2,
            report: "day",
            date: typeof raw.date === "string" ? raw.date : undefined,
            timezone: raw.timezone,
            bucket: raw.bucket,
            totals,
            timeBuckets: timeBuckets,
            projects: projects,
            source: raw.source === "central" ? "central" : "local",
            generatedAt: raw.generatedAt,
        };
    }
    const rows = Array.isArray(raw.rows)
        ? raw.rows.map(normalizeCcsCostReportRowRecord)
        : null;
    if (!rows || rows.some((row) => !row)) {
        return null;
    }
    return {
        version: 2,
        report: raw.report,
        range: raw.range,
        timezone: raw.timezone,
        rows: rows,
        totals,
        source: raw.source === "central" ? "central" : "local",
        generatedAt: raw.generatedAt,
    };
}
function normalizeCcsCostReportRowRecord(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    const metrics = normalizeCcsCostMetricsRecord(raw);
    return metrics && typeof raw.key === "string" ? { key: raw.key, ...metrics } : null;
}
function normalizeCcsCostMetricsRecord(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    if (typeof raw.inputTokens !== "number"
        || typeof raw.outputTokens !== "number"
        || typeof raw.cachedInputTokens !== "number"
        || !isNullableFiniteNumber(raw.inputCostUSD)
        || !isNullableFiniteNumber(raw.outputCostUSD)
        || !isNullableFiniteNumber(raw.cachedCostUSD)
        || !isNullableFiniteNumber(raw.costUSD)
        || !Array.isArray(raw.missingPricingModels)
        || !Number.isFinite(raw.inputTokens)
        || !Number.isFinite(raw.outputTokens)
        || !Number.isFinite(raw.cachedInputTokens)) {
        return null;
    }
    return {
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        cachedInputTokens: raw.cachedInputTokens,
        inputCostUSD: raw.inputCostUSD,
        outputCostUSD: raw.outputCostUSD,
        cachedCostUSD: raw.cachedCostUSD,
        costUSD: raw.costUSD,
        missingPricingModels: normalizeMissingPricingModels(raw.missingPricingModels),
    };
}
function uniqueSorted(values) {
    return [...new Set(values)].sort();
}
function normalizeMissingPricingModels(value) {
    return uniqueSorted(value.filter((model) => typeof model === "string" && model.length > 0));
}
function formatCcsCostRange(options) {
    if (options.since && options.until) {
        return `${options.since}..${options.until}`;
    }
    if (options.since) {
        return `${options.since}..`;
    }
    if (options.until) {
        return `..${options.until}`;
    }
    return "all";
}
function formatInteger(value) {
    return Math.round(value).toLocaleString("en-US");
}
function formatCcsCostTokens(value, raw) {
    return raw ? formatInteger(value) : prettifyBigNum(value);
}
function formatCcsCostUSD(value, raw) {
    if (value === null) {
        return textDim("-");
    }
    return raw ? formatCost(value) : `$${Math.round(value).toLocaleString("en-US")}`;
}
function compareNullableCosts(leftCost, rightCost, leftKey, rightKey) {
    if (leftCost === null || rightCost === null) {
        if (leftCost === null && rightCost === null) {
            return leftKey.localeCompare(rightKey);
        }
        return leftCost === null ? 1 : -1;
    }
    return rightCost - leftCost || leftKey.localeCompare(rightKey);
}
function isNullableFiniteNumber(value) {
    return value === null || (typeof value === "number" && Number.isFinite(value));
}
function sumNullableCosts(...values) {
    return values.some((value) => value === null)
        ? null
        : values.reduce((sum, value) => sum + (value ?? 0), 0);
}
function formatCcsCostProjectPath(value) {
    return colorPath(formatProjectPath(value));
}
function roundCostUSD(value) {
    return Math.round(value * 1_000_000) / 1_000_000;
}
function roundNullableCostUSD(value) {
    return value === null ? null : roundCostUSD(value);
}
function printUsageHelp() {
    console.log(textDim("commands: ccs | version|-v | r | PROFILE | run PROFILE [ARGS] | models [--json] | pricing [list|pattern|provider|refresh] | proxy [--view VIEW|watch|mode|install|restore|stop|serve] | cost [push|central|daily|weekly|monthly|projects|project|models|day] | [toggle|add|rm] [PROFILE] | top | config [push|pull] | s [line|agent|server|history|pause|resume|reset|wezterm] | list [-u] | usage | init | sync [--replace PATH|all]"));
}
async function printAppServerDaemonVersion() {
    const { stdout } = await execFile("codex", ["app-server", "daemon", "version"]);
    const response = parseJsonObject(stdout);
    const status = response.status;
    const version = response.appServerVersion;
    if (typeof status !== "string" || typeof version !== "string") {
        throw new Error("invalid codex app-server daemon version response");
    }
    console.log(textBold("codex app-server daemon"));
    printKeyValue("status:", status === "running" ? textGreen(status) : textYellow(status));
    printKeyValue("version:", textBlue(version));
}
function printStatusUsageHelp() {
    console.log(textDim("commands: ccs s [line|agent|server|history|pause|resume|reset|wezterm]"));
}
export async function runCcs(argv) {
    const command = argv[0] ?? "";
    const args = argv.slice(1);
    if (isHelpArgument(command)) {
        printHelp();
        return;
    }
    if (isVersionArgument(command)) {
        printToolVersionIfRequested("ccs", argv);
        return;
    }
    if (command === "config") {
        await runConfigSync(args);
        return;
    }
    if (command === "pricing") {
        await runCcsPricing(args);
        return;
    }
    if (command === "r") {
        if (isHelpArgument(args[0])) {
            assertExactArgs(args.slice(1), "r help", 0);
            printHelp();
            return;
        }
        assertExactArgs(args, "r", 0);
        await printAppServerDaemonVersion();
        return;
    }
    const profiles = await readProfiles();
    if (command === "cost") {
        await runCcsCost(args, profiles);
        return;
    }
    if (command === "models") {
        await printModels(profiles, args);
        return;
    }
    if (!command) {
        const profile = await printStatus();
        await printUsageLine(profile);
        printUsageHelp();
        return;
    }
    if (command === "init") {
        rejectRemovedYesFlags(args, "ccs init");
        assertExactArgs(args, "init", 0);
        const previewPlan = await buildInitPreviewPlan();
        printPreviewPlan(previewPlan, true);
        if (!(await confirmApply())) {
            return;
        }
        const backupDir = await backupCcsFiles(previewPlan.backupFiles);
        const initialized = await initProfilesFromCurrent();
        await syncCodexConfigFromTemplate();
        await syncCodexAgentsFromTemplate();
        const profile = initialized.profiles?.[initialized.current ?? ""];
        if (profile?.apiKey) {
            await writeTextFile(codexAuthPath(), stringifyJson({ OPENAI_API_KEY: profile.apiKey }), 0o600);
        }
        if (backupDir) {
            console.log(`backup: ${textBlue(backupDir)}`);
        }
        console.log(`profiles written: ${textGreen(profilesPath())}`);
        console.log(`codex config synced: ${textGreen(codexConfigPath())}`);
        console.log(`codex agents synced: ${textGreen(codexAgentsPath())}`);
        return;
    }
    if (command === "sync") {
        rejectRemovedYesFlags(args, "ccs sync");
        const previewPlan = await buildSyncPreviewPlan(parseSyncOptions(args));
        console.log(formatSyncFieldSummary("different:", previewPlan.configSync.differentPaths));
        console.log(formatSyncFieldSummary("update:", previewPlan.configSync.updatedPaths));
        printPreviewPlan(previewPlan, true);
        if (!(await confirmApply())) {
            return;
        }
        const backupDir = await backupCcsFiles(previewPlan.backupFiles);
        await ensureDir(codexDir());
        for (const file of previewPlan.previewFiles) {
            if (file.path === profilesPath()) {
                await writeTextFileAtomic(file.path, file.next, 0o600);
            }
            else {
                await writeTextFile(file.path, file.next);
            }
            const applied = await readTextIfExists(file.path);
            if (applied !== file.next) {
                throw new Error(`ccs sync verification failed: ${file.path}`);
            }
        }
        if (backupDir) {
            console.log(`backup: ${textBlue(backupDir)}`);
        }
        console.log(`profiles synced: ${textGreen(profilesPath())}`);
        console.log(`codex config synced: ${textGreen(codexConfigPath())}`);
        console.log(`codex agents synced: ${textGreen(codexAgentsPath())}`);
        const synced = await readProfiles();
        for (const name of Object.keys(synced.profiles ?? {})) {
            console.log(`  ${textBlue(name)}`);
        }
        return;
    }
    if (command === "list" || command === "l") {
        const unknown = args.find((arg) => arg !== "--usage" && arg !== "-u");
        if (unknown) {
            throw new Error(`unknown argument for ccs list: ${unknown}`);
        }
        await printProfileList(profiles, args.some((arg) => arg === "--usage" || arg === "-u"));
        return;
    }
    if (command === "top") {
        if (isHelpArgument(args[0])) {
            assertExactArgs(args.slice(1), "top help", 0);
            printHelp();
            return;
        }
        await printUsageTop(profiles, parseUsageTopOptions(args));
        return;
    }
    if (command === "s") {
        await runCcsStatus(profiles, args);
        return;
    }
    if (command === "proxy") {
        await runProxyCommand(args, proxyOptions());
        return;
    }
    if (command === "run") {
        if (isHelpArgument(args[0])) {
            assertExactArgs(args.slice(1), "run help", 0);
            printHelp();
            return;
        }
        await runCodexWithProfile(profiles, args[0], args.slice(1));
        return;
    }
    if (command === "add") {
        assertMaxArgs(args, "add [PROFILE]", 1);
        if (args[0]?.startsWith("-")) {
            throw new Error(`unknown argument for ccs add: ${args[0]}`);
        }
        await addProfile(args[0]);
        return;
    }
    if (command === "usage") {
        const subcommand = args[0] ?? "";
        const subargs = args.slice(1);
        if (!subcommand) {
            await printUsageTargets(profiles);
            return;
        }
        if (subcommand === "add") {
            assertMaxArgs(subargs, "usage add [PROFILE]", 1);
            if (subargs[0]?.startsWith("-")) {
                throw new Error(`unknown argument for ccs usage add: ${subargs[0]}`);
            }
            await addUsageProfile(subargs[0]);
            return;
        }
        if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
            assertExactArgs(subargs, `usage ${subcommand} PROFILE`, 1);
            await removeUsageProfile(subargs[0]);
            return;
        }
        throw new Error(`unknown argument for ccs usage: ${subcommand}`);
    }
    if (command === "remove" || command === "rm" || command === "delete") {
        assertExactArgs(args, `${command} PROFILE`, 1);
        await removeProfile(args[0]);
        return;
    }
    if (command === "toggle") {
        assertMaxArgs(args, "toggle [PROFILE]", 1);
        if (args[0]) {
            if (args[0].startsWith("-")) {
                throw new Error(`unknown argument for ccs toggle: ${args[0]}`);
            }
            const profile = await switchProfile(args[0]);
            await printUsageLine(profile);
            return;
        }
        const toggle = profiles.toggle ?? [];
        if (toggle.length < 2) {
            throw new Error("toggle requires at least two profile names in profiles.json toggle");
        }
        const index = Math.max(0, toggle.indexOf(profiles.current ?? ""));
        const next = toggle[(index + 1) % toggle.length];
        const profile = await switchProfile(next);
        await printUsageLine(profile);
        return;
    }
    if (profiles.profiles?.[command]) {
        assertExactArgs(args, command, 0);
        printProfile(command, profiles);
        await printUsageLine(assertProfile(profiles.profiles[command], command));
        return;
    }
    console.error(`${textRed("unknown command:")} ${basename(command)}`);
    process.exitCode = 1;
}
