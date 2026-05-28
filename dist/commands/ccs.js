import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as asciichart from "asciichart";
import { createTwoFilesPatch } from "diff";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { ensureDir, readTextIfExists, writeTextFile } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexAgentsPath, codexAuthPath, codexConfigPath, codexDir, codexToolsCacheDir, codexToolsConfigDir, profilesPath, weztermConfigPath, } from "../lib/paths.js";
import { bgDarkBlue, maskSecret, textBlue, textBold, textDim, textGreen, textRed, visibleLength, } from "../lib/text.js";
import { colorCost, colorHost, colorInput, colorName, colorOutput, colorPath, colorUrl, printKeyValue, } from "../lib/output.js";
import { listTomlSectionNames, mergeTomlModelProviderSections, readTomlBaseUrl, readTopLevelTomlString, updateTomlBaseUrl, updateTopLevelTomlString, } from "../lib/toml.js";
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
const usageTopHistoryBucketMinutes = usageTopHistoryBucketMs / (60 * 1000);
const usageTopHistoryPeakLimit = 5;
const usageTopHistoryEpsilon = 0.05;
const usageTopHttpTimeoutMs = 1_500;
const usageTopHistoryHttpTimeoutMs = 3_000;
let usageTopStatusWriteSequence = 0;
const configSyncUser = "ravvss";
const configSyncHost = "10.126.126.1";
const configSyncPort = "32753";
const configSyncRemotePath = "/home/ravvss/.config/codex-tools/profiles.json";
const configSyncRemoteDisplay = `${configSyncUser}@${configSyncHost}:${configSyncRemotePath}`;
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
    await writeTextFile(profilesPath(), stringifyJson(profiles), 0o600);
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
async function planCodexConfigSync() {
    const defaults = await readDefaultCodexConfig();
    const existing = (await readTextIfExists(codexConfigPath())) ?? "";
    const provider = readTopLevelTomlString(existing, "model_provider")
        ?? readTopLevelTomlString(defaults, "model_provider")
        ?? "codex";
    const baseURL = readTomlBaseUrl(existing);
    const templateSections = new Set(listTomlSectionNames(defaults));
    const existingSections = listTomlSectionNames(existing);
    let next = mergeTomlModelProviderSections(defaults, existing);
    next = updateTopLevelTomlString(next, "model_provider", provider);
    if (baseURL !== null) {
        next = updateTomlBaseUrl(next, baseURL);
    }
    const nextSections = listTomlSectionNames(next);
    return {
        nextContent: next,
        removedSections: existingSections.filter((name) => !nextSections.includes(name)),
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
        await writeTextFile(profilesPath(), nextText, 0o600);
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
function formatList(values) {
    return values.length > 0 ? values.join(", ") : "(none)";
}
function buildConfigSection(plan) {
    const warnings = [];
    for (const section of plan.removedSections) {
        warnings.push(`config section [${section}] will be removed`);
    }
    return { lines: [], warnings };
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
    const configSection = buildConfigSection(configPlan);
    const nextCurrentProfile = nextProfiles.profiles?.[nextProfiles.current ?? ""];
    const nextAuthText = nextCurrentProfile?.apiKey
        ? stringifyJson({ OPENAI_API_KEY: nextCurrentProfile.apiKey })
        : currentAuthText;
    const warnings = [...configSection.warnings];
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
async function buildSyncPreviewPlan() {
    const nextProfiles = await planSyncProfiles();
    const configPlan = await planCodexConfigSync();
    const currentProfilesText = (await readTextIfExists(profilesPath())) ?? "";
    const currentConfigText = (await readTextIfExists(codexConfigPath())) ?? "";
    const currentAgentsText = (await readTextIfExists(codexAgentsPath())) ?? "";
    const nextAgentsText = await readDefaultCodexAgents();
    const configSection = buildConfigSection(configPlan);
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
        warnings: configSection.warnings,
    };
}
function buildWeztermStatusBlock() {
    return [
        weztermStatusBegin,
        "config.enable_tab_bar = true",
        "config.hide_tab_bar_if_only_one_tab = false",
        "config.status_update_interval = 1000",
        "",
        "local function ccs_status()",
        `\tlocal path = os.getenv("CCS_WEZTERM_STATUS_FILE") or ${JSON.stringify(usageTopStatusTextPath())}`,
        "\tlocal handle = io.open(path, \"r\")",
        "\tif not handle then",
        "\t\treturn os.date(\"%H:%M:%S\") .. \" | ccs status inactive\"",
        "\tend",
        "",
        "\tlocal value = handle:read(\"*a\") or \"\"",
        "\thandle:close()",
        "\tvalue = value:gsub(\"%s+$\", \"\")",
        "\tif value == \"\" then",
        "\t\treturn os.date(\"%H:%M:%S\") .. \" | ccs status inactive\"",
        "\tend",
        "\treturn value",
        "end",
        "",
        "wezterm.on(\"update-right-status\", function(window)",
        "\tlocal status = ccs_status()",
        "\tif status == \"\" then",
        "\t\twindow:set_right_status(\"\")",
        "\t\treturn",
        "\tend",
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
async function fetchUsage(profile) {
    if (!profile.apiKey) {
        return null;
    }
    const url = buildUsageUrl(profile.baseURL);
    if (!url) {
        return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
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
    const nextConfig = updateTomlBaseUrl(currentConfig, normalized.baseURL);
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
function alignTableCell(value, width, align) {
    const padding = " ".repeat(Math.max(0, width - visibleLength(value)));
    return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}
function printTable(rows, aligns = []) {
    const widths = rows[0]?.map((_, index) => (Math.max(...rows.map((row) => visibleLength(row[index] ?? ""))))) ?? [];
    for (const row of rows) {
        console.log(row.map((value, index) => (alignTableCell(value, widths[index] ?? 0, aligns[index] ?? "left"))).join("  ").trimEnd());
    }
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
    printTable(rows.map((row) => ([
        row.marker,
        ...(includeUsage ? [row.type] : []),
        colorName(row.name),
        colorUrl(row.profile.baseURL),
        row.profile.apiKey ? textDim(maskSecret(row.profile.apiKey)) : textDim("(empty)"),
        ...(includeUsage ? row.usage : []),
    ])), includeUsage ? ["left", "left", "left", "left", "left", "right", "right", "right", "right", "right"] : []);
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
    printTable(rows.map((row) => [
        colorName(row.name),
        colorUrl(row.profile.baseURL),
        row.profile.apiKey ? textDim(maskSecret(row.profile.apiKey)) : textDim("(empty)"),
        ...row.usage,
    ]), ["left", "left", "left", "right", "right", "right", "right", "right"]);
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
function padVisibleRight(value, width) {
    return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}
function padVisibleLeft(value, width) {
    return `${" ".repeat(Math.max(0, width - visibleLength(value)))}${value}`;
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
function fitSingleTerminalLine(line) {
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
function buildUsageTopLine(entries, states, now) {
    const parts = entries.map((entry) => (formatUsageTopEntry(entry, states.get(entry.name), now)));
    return fitSingleTerminalLine(`${textDim(formatClockTime(now))} ${textDim("|")} ${parts.join(` ${textDim("|")} `)}`);
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
function renderUsageTopStatusSuffix(snapshot, stateNow) {
    const parts = snapshot.entries.map((entry) => {
        if (entry.skipped) {
            return `${entry.name} -`;
        }
        if (entry.used === undefined) {
            return `${entry.name} ?`;
        }
        const delta = formatStatusLineDelta(entry.delta, entry.changedAt, stateNow);
        const tags = [
            delta,
            entry.stale ? "stale" : "",
            entry.done ? "done" : "",
        ].filter(Boolean);
        return `${entry.name} ${formatStatusLineCost(entry.used)}${tags.length > 0 ? ` ${tags.join(" ")}` : ""}`;
    });
    const refresh = formatStatusLineRefresh(snapshot, stateNow);
    return `${refresh ? ` ${refresh}` : ""} | ${parts.join(" | ")}`;
}
function renderUsageTopStatusLine(snapshot, displayNow, stateNow) {
    return `${formatStatusLineClock(displayNow)}${renderUsageTopStatusSuffix(snapshot, stateNow)}`;
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
    const path = usageTopSnapshotPath();
    const tmpPath = `${path}.${process.pid}.tmp`;
    await writeTextFile(tmpPath, stringifyJson(snapshot));
    await rename(tmpPath, path);
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
function parseUsageTopHistoryRecords(text) {
    if (!text) {
        return [];
    }
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => !!line)
        .flatMap((line) => {
        const snapshot = parseUsageTopSnapshot(line);
        return snapshot ? [snapshot] : [];
    });
}
async function readUsageTopHistoryRecords(now = new Date()) {
    return filterUsageTopHistoryRecords(parseUsageTopHistoryRecords(await readTextIfExists(usageTopHistoryPath())), now);
}
async function writeUsageTopHistoryRecords(records) {
    await writeTextFile(usageTopHistoryPath(), records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""));
}
async function recordUsageTopHistorySnapshot(snapshot) {
    if (!snapshot.active) {
        return;
    }
    const at = usageTopSnapshotTime(snapshot);
    if (!at) {
        return;
    }
    const records = filterUsageTopHistoryRecords([
        ...parseUsageTopHistoryRecords(await readTextIfExists(usageTopHistoryPath())),
        snapshot,
    ], at);
    await writeUsageTopHistoryRecords(records);
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
    const trend = buildUsageTopHistoryTrend(pointMap, sortedNames, buckets, request.windowStart);
    return {
        version: 1,
        updatedAt: windowEnd.toISOString(),
        windowStart: request.windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        bucketMinutes: request.bucketMinutes,
        names: sortedNames,
        availableNames,
        summaries: summaries.map(toUsageTopHistorySummaryRecord),
        trend: trend.map(toUsageTopHistoryTrendPoint),
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
function normalizeUsageTopHistoryTrendPoint(value) {
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
function normalizeUsageTopHistory(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const raw = value;
    const names = normalizeUsageTopStringArray(raw.names);
    const availableNames = normalizeUsageTopStringArray(raw.availableNames);
    if (raw.version !== 1
        || typeof raw.updatedAt !== "string"
        || typeof raw.windowStart !== "string"
        || typeof raw.windowEnd !== "string"
        || !isUsageTopNumber(raw.bucketMinutes)
        || !names
        || !availableNames
        || !Array.isArray(raw.summaries)
        || !Array.isArray(raw.trend)
        || !Array.isArray(raw.buckets)) {
        return null;
    }
    const summaries = raw.summaries.map(normalizeUsageTopHistorySummaryRecord);
    const trend = raw.trend.map(normalizeUsageTopHistoryTrendPoint);
    const buckets = raw.buckets.map(normalizeUsageTopHistoryBucketRecord);
    if (summaries.some((summary) => !summary)
        || trend.some((point) => !point)
        || buckets.some((bucket) => !bucket)) {
        return null;
    }
    return {
        version: 1,
        updatedAt: raw.updatedAt,
        windowStart: raw.windowStart,
        windowEnd: raw.windowEnd,
        bucketMinutes: raw.bucketMinutes,
        names,
        availableNames,
        summaries: summaries,
        trend: trend,
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
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) {
            return null;
        }
        return parseUsageTopHistory(await response.text());
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
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
    return source ? renderUsageTopStatusSuffix(source.snapshot, source.stateNow) : ` | ${inactiveLabel}`;
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
function toUsageTopHistoryTrendPoint(point) {
    return {
        at: point.at.toISOString(),
        value: point.value,
    };
}
function formatHistoryLastChange(summary) {
    if (summary.lastChangeAt && summary.lastChangeDelta !== undefined) {
        return `${formatHistoryTime(summary.lastChangeAt)} ${formatHistorySignedCost(summary.lastChangeDelta)}`;
    }
    if (summary.lastResetAt) {
        return `${formatHistoryTime(summary.lastResetAt)} reset`;
    }
    return textDim("-");
}
function printUsageTopHistorySummary(summaries) {
    console.log();
    console.log(textBold("summary"));
    printTable([
        ["provider", "first", "now", "delta", "changes", "last change"],
        ...summaries.map((summary) => [
            colorName(summary.name),
            formatHistoryValue(summary.first),
            formatHistoryValue(summary.latest),
            formatHistoryDeltaCell(summary.delta, summary.reset),
            summary.changes.toString(),
            formatHistoryLastChange(summary),
        ]),
    ], ["left", "right", "right", "right", "right", "right"]);
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
function printUsageTopHistoryBuckets(buckets, names) {
    console.log();
    console.log(textBold("bucket changes"));
    const firstVisibleBucketIndex = buckets.findIndex((bucket) => !isUsageTopHistoryBucketEmpty(bucket));
    if (firstVisibleBucketIndex < 0) {
        console.log(textDim("no bucket changes yet"));
        return;
    }
    const visibleBuckets = buckets.slice(firstVisibleBucketIndex);
    printTable([
        ["time", "total", ...names],
        ...visibleBuckets.map((bucket) => [
            `${formatHistoryTime(bucket.start)}-${formatHistoryTime(bucket.end)}`,
            formatHistoryDeltaCell(bucket.total, bucket.reset),
            ...names.map((name) => {
                const delta = bucket.deltas.get(name);
                return formatHistoryDeltaCell(delta?.delta, delta?.reset);
            }),
        ]),
    ], ["left", "right", ...names.map(() => "right")]);
}
function printUsageTopHistoryPeakBuckets(buckets, names) {
    const peaks = buckets
        .filter((bucket) => bucket.total !== undefined && bucket.total > usageTopHistoryEpsilon)
        .sort((left, right) => (right.total ?? 0) - (left.total ?? 0))
        .slice(0, usageTopHistoryPeakLimit);
    if (peaks.length === 0) {
        return;
    }
    console.log();
    console.log(textBold("peak buckets"));
    printTable([
        ["time", "total", "top contributors"],
        ...peaks.map((bucket) => {
            const contributors = names
                .map((name) => ({ name, delta: bucket.deltas.get(name)?.delta ?? 0 }))
                .filter((entry) => entry.delta > usageTopHistoryEpsilon)
                .sort((left, right) => right.delta - left.delta)
                .slice(0, 3)
                .map((entry) => `${entry.name} ${formatHistorySignedCost(entry.delta)}`)
                .join(", ");
            return [
                `${formatHistoryTime(bucket.start)}-${formatHistoryTime(bucket.end)}`,
                formatHistoryDeltaCell(bucket.total),
                contributors || textDim("-"),
            ];
        }),
    ], ["left", "right", "left"]);
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
function buildUsageTopHistoryTrend(pointMap, names, buckets, windowStart) {
    if (names.length === 0) {
        return [];
    }
    return [
        { at: windowStart, value: 0 },
        ...buckets.flatMap((bucket) => {
            const total = readUsageTopHistoryTotalAt(pointMap, names, bucket.end.getTime(), windowStart);
            return total === null ? [] : [{ at: bucket.end, value: total }];
        }),
    ];
}
function printUsageTopHistoryChart(trend) {
    const points = trend
        .filter((point) => Number.isFinite(point.value) && !Number.isNaN(point.at.getTime()))
        .sort((left, right) => left.at.getTime() - right.at.getTime());
    console.log();
    console.log(textBold("total trend"));
    if (points.length < 2) {
        console.log(textDim("not enough history yet"));
        return;
    }
    const start = points[0].at;
    const mid = points[Math.floor(points.length / 2)].at;
    const end = points[points.length - 1].at;
    const series = points.map((point) => point.value);
    console.log(asciichart.plot(series, {
        height: 8,
        format: (value) => `${formatHistoryCost(value).padStart(7)} `,
    }));
    console.log(textDim(`         ${formatHistoryTime(start)}     ${formatHistoryTime(mid)}     ${formatHistoryTime(end)}`));
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
function toUsageTopTrendPoint(record) {
    return {
        at: parseUsageTopHistoryDate(record.at),
        value: record.value,
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
    const trend = source.history.trend.map(toUsageTopTrendPoint);
    console.log(`ccs usage history  today  bucket ${formatHistoryBucketWindow(source.history.bucketMinutes)}`);
    printKeyValue("source:", source.remote ? colorUrl(source.source) : colorPath(source.source), 7);
    printUsageTopHistorySummary(summaries);
    printUsageTopHistoryChart(trend);
    printUsageTopHistoryPeakBuckets(buckets, names);
    printUsageTopHistoryBuckets(buckets, names);
}
async function writeUsageTopStatusText(value) {
    const path = usageTopStatusTextPath();
    usageTopStatusWriteSequence += 1;
    const tmpPath = `${path}.${process.pid}.${usageTopStatusWriteSequence}.tmp`;
    try {
        await writeTextFile(tmpPath, value);
        await rename(tmpPath, path);
    }
    catch (error) {
        await rm(tmpPath, { force: true }).catch(() => undefined);
        throw error;
    }
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
    return {
        windowStart,
        windowEnd,
        bucketMinutes: parseUsageTopHistoryBucketMinutes(url.searchParams),
        profileName: url.searchParams.get("profile")?.trim() || undefined,
    };
}
async function runUsageTopStatusAgent(profiles) {
    let stopped = false;
    const writeStatus = async () => {
        const now = new Date();
        let line = `${formatStatusLineClock(now)} | ccs top unavailable`;
        try {
            line = `${formatStatusLineClock(now)}${await renderCurrentUsageTopStatusSuffix(profiles, now, "ccs top unavailable")}`;
            if (!stopped) {
                await writeUsageTopStatusText(line);
            }
        }
        catch {
            if (!stopped) {
                await writeUsageTopStatusText(line).catch(() => undefined);
            }
        }
        if (process.stdout.isTTY) {
            process.stdout.write(`\r\u001b[2K${line}`);
            return;
        }
        console.log(line);
    };
    await writeStatus();
    await new Promise((resolve) => {
        let timer = null;
        let cleanedUp = false;
        const schedule = () => {
            if (cleanedUp) {
                return;
            }
            timer = setTimeout(() => {
                timer = null;
                void (async () => {
                    await writeStatus();
                    schedule();
                })();
            }, usageTopTickMs);
        };
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            stopped = true;
            if (timer) {
                clearTimeout(timer);
            }
            await writeUsageTopStatusText(`${formatStatusLineClock(new Date())} | ccs top inactive`).catch(() => undefined);
            if (process.stdout.isTTY) {
                process.stdout.write("\n");
            }
            resolve();
        };
        schedule();
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
    let cleanedUp = false;
    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
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
            void (async () => {
                await refreshDueUsageTopRuntime(runtime, new Date(), false, "server");
                await publish();
                schedule();
            })();
        }, delay);
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
        if (request.method === "POST" && url.pathname === "/ccs/top/pause") {
            void (async () => {
                paused = true;
                clearTimer();
                await publish();
                sendUsageTopJson(response, 200, { ok: true, paused });
            })();
            return;
        }
        if (request.method === "POST" && url.pathname === "/ccs/top/resume") {
            void (async () => {
                paused = false;
                await resetPolling();
                sendUsageTopJson(response, 200, { ok: true, paused });
            })();
            return;
        }
        if (request.method === "POST" && url.pathname === "/ccs/top/reset") {
            void (async () => {
                await resetPolling();
                sendUsageTopJson(response, 200, { ok: true, paused });
            })();
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
    await new Promise((resolve) => {
        schedule();
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            clearTimer();
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
        if (options.once || !process.stdout.isTTY) {
            console.log(line);
            return;
        }
        process.stdout.write(`\r\u001b[2K${line}`);
        await writeUsageTopSnapshot(buildUsageTopSnapshot(runtime.entries, runtime.states, now, true));
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
        await runUsageTopStatusAgent(profiles);
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
        "  ccs PROFILE                          # show profile details and usage",
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
        "  ccs sync                             # preview, confirm, and sync config",
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
function printUsageHelp() {
    console.log(textDim("commands: ccs | PROFILE | [toggle|add|rm] [PROFILE] | top | config [push|pull] | s [line|agent|server|history|pause|resume|reset|wezterm] | list [-u] | usage | init | sync"));
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
    if (command === "config") {
        await runConfigSync(args);
        return;
    }
    const profiles = await readProfiles();
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
        assertExactArgs(args, "sync", 0);
        const previewPlan = await buildSyncPreviewPlan();
        printPreviewPlan(previewPlan, true);
        if (!(await confirmApply())) {
            return;
        }
        const backupDir = await backupCcsFiles(previewPlan.backupFiles);
        const synced = await syncProfiles();
        await syncCodexConfigFromTemplate();
        await syncCodexAgentsFromTemplate();
        if (backupDir) {
            console.log(`backup: ${textBlue(backupDir)}`);
        }
        console.log(`profiles synced: ${textGreen(profilesPath())}`);
        console.log(`codex config synced: ${textGreen(codexConfigPath())}`);
        console.log(`codex agents synced: ${textGreen(codexAgentsPath())}`);
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
