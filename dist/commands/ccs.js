import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { ensureDir, readTextIfExists, writeTextFile, writeTextFileAtomic } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexAgentsPath, codexAuthPath, codexConfigPath, codexDir, profilesPath, } from "../lib/paths.js";
import { assertProfile, readProfiles, writeProfiles } from "../lib/profiles.js";
import { formatAgo, profileLastUsedMs, readProfileUsage, recordProfileUsage } from "../lib/profile-usage.js";
import { input, isInteractive, multiSelect, select } from "../lib/prompt.js";
import { maskSecret, textBlue, textBold, textDim, textGreen, textRed, textYellow, truncateVisible, } from "../lib/text.js";
import { colorHost, colorName, colorPath, colorUrl, printKeyValue, } from "../lib/output.js";
import { runCcsStats } from "./ccs-stats.js";
import { ensureProxyRunning, proxyStateExists, resolveProxyOptions as proxyOptions, resolveProxySwitchBaseUrl, runProxyCommand } from "./ccs-proxy.js";
import { syncTomlTemplate, readTomlBaseUrl, tomlLeafDifferences, updateTomlBaseUrl, } from "../lib/toml.js";
import { printTable } from "../lib/table.js";
import { formatCommandFooterLines } from "../lib/terminal.js";
import { isVersionArgument, printToolVersionIfRequested } from "../lib/version.js";
const execFile = promisify(execFileCallback);
const modelsHttpTimeoutMs = 5_000;
const configSyncUser = "ravvss";
const configSyncHost = "10.126.126.1";
const configSyncPort = "32753";
const configSyncRemotePath = "/home/ravvss/.config/codex-tools/profiles.json";
const configSyncRemoteDisplay = `${configSyncUser}@${configSyncHost}:${configSyncRemotePath}`;
async function readDefaultProfiles() {
    const path = fileURLToPath(new URL("../../config/ccs-profiles.json", import.meta.url));
    const content = await readFile(path, "utf-8");
    return parseJsonObject(content);
}
async function readDefaultCodexConfig() {
    const path = fileURLToPath(new URL("../../config/codex-config.toml", import.meta.url));
    return readFile(path, "utf-8");
}
async function readDefaultCodexAgents() {
    const path = fileURLToPath(new URL("../../config/codex-agents.md", import.meta.url));
    return readFile(path, "utf-8");
}
async function readCurrentCodexProfile() {
    const configText = (await readTextIfExists(codexConfigPath())) ?? "";
    const baseURL = readTomlBaseUrl(configText) ?? "";
    const authText = (await readTextIfExists(codexAuthPath())) ?? "";
    const authJson = authText ? parseJsonObject(authText) : {};
    const apiKey = typeof authJson.OPENAI_API_KEY === "string" ? authJson.OPENAI_API_KEY : "";
    return { baseURL, apiKey };
}
function getCcsBackupFiles() {
    return [
        { source: profilesPath(), target: `${profilesPath()}.bak` },
        { source: codexConfigPath(), target: `${codexConfigPath()}.bak` },
        { source: codexAuthPath(), target: `${codexAuthPath()}.bak` },
        { source: codexAgentsPath(), target: `${codexAgentsPath()}.bak` },
    ];
}
async function getExistingBackupFiles() {
    const existing = [];
    for (const file of getCcsBackupFiles()) {
        const exists = await readTextIfExists(file.source);
        if (exists !== null) {
            existing.push(file);
        }
    }
    return existing;
}
async function backupCcsFiles(files) {
    if (files.length === 0) {
        return null;
    }
    const timestamp = formatTimestamp(new Date());
    const backupDir = join(codexDir(), "backups", timestamp);
    await ensureDir(backupDir);
    for (const file of files) {
        const content = await readTextIfExists(file.source);
        if (content !== null) {
            await writeTextFile(join(backupDir, basename(file.source)), content);
        }
    }
    return backupDir;
}
function formatTimestamp(date) {
    const pad = (value) => value.toString().padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}
async function planCodexConfigSync(replacePaths = new Set()) {
    const defaults = await readDefaultCodexConfig();
    const existing = (await readTextIfExists(codexConfigPath())) ?? "";
    const syncResult = syncTomlTemplate(defaults, existing, replacePaths);
    return {
        nextContent: syncResult.content,
        differentPaths: syncResult.differentPaths,
        updatedPaths: syncResult.updatedPaths,
    };
}
async function syncCodexConfigFromTemplate() {
    const plan = await planCodexConfigSync();
    await ensureDir(codexDir());
    await writeTextFile(codexConfigPath(), plan.nextContent);
    return plan;
}
async function syncCodexAgentsFromTemplate() {
    const defaultAgents = await readDefaultCodexAgents();
    await ensureDir(codexDir());
    await writeTextFile(codexAgentsPath(), defaultAgents);
    return defaultAgents;
}
async function planInitProfilesFromCurrent() {
    const defaultProfiles = await readDefaultProfiles();
    const current = await readCurrentCodexProfile();
    const profiles = { ...(defaultProfiles.profiles ?? {}) };
    let currentName = defaultProfiles.current ?? "test001";
    if (!current.baseURL && !current.apiKey) {
        return {
            current: currentName,
            profiles,
        };
    }
    const existingEntry = Object.entries(profiles).find(([, profile]) => (profile.baseURL === current.baseURL && profile.apiKey === current.apiKey));
    if (existingEntry) {
        currentName = existingEntry[0];
    }
    else if (!profiles.test001) {
        profiles.test001 = current;
        currentName = "test001";
    }
    else {
        let index = 1;
        while (profiles[`test001-${index}`]) {
            index += 1;
        }
        currentName = `test001-${index}`;
        profiles[currentName] = current;
    }
    return {
        current: currentName,
        profiles,
    };
}
async function initProfilesFromCurrent() {
    const profiles = await planInitProfilesFromCurrent();
    await writeProfiles(profiles);
    return profiles;
}
async function planSyncProfiles() {
    const defaultProfiles = await readDefaultProfiles();
    const currentProfiles = await readProfiles();
    const profiles = { ...(currentProfiles.profiles ?? {}) };
    for (const [name, profile] of Object.entries(defaultProfiles.profiles ?? {})) {
        if (!profiles[name]) {
            profiles[name] = profile;
        }
    }
    const { toggle: _removedToggle, ...rest } = currentProfiles;
    return {
        ...rest,
        current: currentProfiles.current ?? defaultProfiles.current ?? Object.keys(profiles)[0] ?? "test001",
        profiles,
    };
}
function configFileHash(text) {
    return createHash("sha256").update(text).digest("hex");
}
function formatConfigSummary(summary) {
    if (!summary.exists) {
        return textDim("missing");
    }
    const sha = summary.sha256 ? summary.sha256.slice(0, 8) : "unknown";
    const size = summary.size !== undefined ? `${summary.size}B` : "unknown";
    return `${textBlue(sha)}  ${textDim(size)}`;
}
async function readLocalConfigText() {
    const content = await readTextIfExists(profilesPath());
    if (content === null) {
        throw new Error(`local profiles.json not found: ${profilesPath()}`);
    }
    return content;
}
async function localConfigSummary() {
    try {
        const fileStat = await stat(profilesPath());
        const content = await readFile(profilesPath(), "utf-8");
        return {
            exists: true,
            size: fileStat.size,
            sha256: configFileHash(content),
            mtime: fileStat.mtime,
        };
    }
    catch {
        return { exists: false };
    }
}
async function execConfigSyncFile(command, args) {
    try {
        return await execFile(command, args);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stderr = typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string"
            ? error.stderr.trim()
            : "";
        const detail = stderr || message;
        throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
    }
}
async function configSyncSsh(script) {
    const result = await execConfigSyncFile("ssh", [
        "-p",
        configSyncPort,
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        `${configSyncUser}@${configSyncHost}`,
        script,
    ]);
    return result.stdout;
}
async function configSyncScp(source, target) {
    await execConfigSyncFile("scp", [
        "-P",
        configSyncPort,
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        source,
        target,
    ]);
}
async function remoteConfigSummary() {
    const script = [
        `if [ -f "${configSyncRemotePath}" ]; then`,
        `  size=$(wc -c < "${configSyncRemotePath}")`,
        `  sha=$(sha256sum "${configSyncRemotePath}" | awk '{print $1}')`,
        `  mtime=$(stat -c %Y "${configSyncRemotePath}" 2>/dev/null || stat -f %m "${configSyncRemotePath}")`,
        `  echo "exists=true;$size;$sha;$mtime"`,
        "else",
        '  echo "exists=false"',
        "fi",
    ].join("\n");
    const output = (await configSyncSsh(script)).trim();
    if (output === "exists=false") {
        return { exists: false };
    }
    const [, size, sha256, mtime] = output.split(";");
    const mtimeSeconds = Number.parseInt(mtime ?? "", 10);
    return {
        exists: true,
        size: Number.parseInt(size ?? "", 10),
        sha256,
        mtime: Number.isNaN(mtimeSeconds) ? undefined : new Date(mtimeSeconds * 1000),
    };
}
async function readRemoteConfigTextIfExists(remote) {
    if (!remote.exists) {
        return null;
    }
    return configSyncSsh(`cat "${configSyncRemotePath}"`);
}
function printConfigSyncPlan(action, local, remote, localText, remoteText) {
    const source = action === "push" ? "local -> remote" : "remote -> local";
    console.log(textBold(`ccs config ${action}`));
    printKeyValue("direction:", source, 10);
    printKeyValue("local:", `${colorPath(profilesPath())}  ${formatConfigSummary(local)}`, 10);
    printKeyValue("remote:", `${colorPath(configSyncRemoteDisplay)}  ${formatConfigSummary(remote)}`, 10);
    if (action === "push" && !local.exists) {
        throw new Error(`local profiles.json not found: ${profilesPath()}`);
    }
    if (action === "pull" && !remote.exists) {
        throw new Error(`remote profiles.json not found: ${configSyncRemoteDisplay}`);
    }
    printConfigSyncDiff(action, localText, remoteText);
    console.log(textDim("no changes are written unless you type yes at the prompt."));
}
function printConfigSyncDiff(action, localText, remoteText) {
    const current = action === "push" ? remoteText : localText;
    const next = action === "push" ? localText : remoteText;
    const targetLabel = action === "push" ? "remote" : "local";
    if (current === next) {
        console.log(textDim(`${targetLabel} is already up to date`));
        return;
    }
    const patch = createTwoFilesPatch(`a/${targetLabel}`, `b/${targetLabel}`, redactPreviewSecrets(current ?? ""), redactPreviewSecrets(next ?? ""), "", "", { context: 3 });
    console.log(textDim(patch.trimEnd()));
}
function printConfigSyncStatus(local) {
    console.log(textBold("ccs config"));
    printKeyValue("local:", `${colorPath(profilesPath())}  ${formatConfigSummary(local)}`, 8);
    printKeyValue("remote:", colorPath(configSyncRemoteDisplay), 8);
}
function printConfigSyncHelp() {
    console.log([
        textBold("Usage:"),
        "  ccs config        # show sync endpoints, then choose push or pull, preview, and confirm",
    ].join("\n"));
}
async function pushConfigToServer(local, remote) {
    const localText = await readLocalConfigText();
    parseJsonObject(localText);
    const timestamp = formatTimestamp(new Date());
    const backupScript = [
        `if [ -f "${configSyncRemotePath}" ]; then`,
        `  mkdir -p "${configSyncRemotePath}.backups"`,
        `  cp "${configSyncRemotePath}" "${configSyncRemotePath}.backups/profiles.${timestamp}.json"`,
        `  echo "${configSyncRemotePath}.backups/profiles.${timestamp}.json"`,
        "fi",
    ].join("\n");
    const backupPath = (await configSyncSsh(backupScript)).trim();
    await configSyncSsh(`mkdir -p "$(dirname "${configSyncRemotePath}")"`);
    const remoteTarget = `${configSyncUser}@${configSyncHost}:${configSyncRemotePath}`;
    await configSyncScp(profilesPath(), remoteTarget);
    if (backupPath) {
        console.log(`remote backup: ${textBlue(backupPath)}`);
    }
    console.log(`config pushed: ${textGreen(configSyncRemoteDisplay)}`);
}
async function pullConfigFromServer(local, remote) {
    const remoteText = await readRemoteConfigTextIfExists(remote);
    if (remoteText === null) {
        throw new Error(`remote profiles.json not found: ${configSyncRemoteDisplay}`);
    }
    parseJsonObject(remoteText);
    const tempDir = await mkdtemp(join(tmpdir(), "ccs-config-pull-"));
    const tempPath = join(tempDir, "profiles.json");
    try {
        const remoteSource = `${configSyncUser}@${configSyncHost}:${configSyncRemotePath}`;
        await configSyncScp(remoteSource, tempPath);
        const pulledText = await readFile(tempPath, "utf-8");
        parseJsonObject(pulledText);
        const backupDir = await backupCcsFiles(await getExistingBackupFiles());
        await ensureDir(join(profilesPath(), ".."));
        await writeTextFileAtomic(profilesPath(), pulledText, 0o600);
        if (backupDir) {
            console.log(`backup: ${textBlue(backupDir)}`);
        }
        console.log(`config pulled: ${textGreen(profilesPath())}`);
    }
    finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}
async function runConfigSync(args) {
    if (isHelpArgument(args[0])) {
        assertExactArgs(args.slice(1), "config help", 0);
        printConfigSyncHelp();
        return;
    }
    if (args.length > 0) {
        throw new Error(`unknown argument for ccs config: ${args[0]}`);
    }
    const local = await localConfigSummary();
    printConfigSyncStatus(local);
    if (!isInteractive()) {
        printKeyValue("note:", "run in an interactive terminal to push or pull", 8);
        return;
    }
    const action = await select("Sync profiles.json", [
        { value: "pull", label: "pull", hint: "replace the local file with the LAN server copy" },
        { value: "push", label: "push", hint: "replace the LAN server copy with the local file" },
    ]);
    const remote = await remoteConfigSummary();
    const localText = await readTextIfExists(profilesPath());
    const remoteText = await readRemoteConfigTextIfExists(remote);
    printConfigSyncPlan(action, local, remote, localText, remoteText);
    if (!(await confirmApply())) {
        return;
    }
    if (action === "push") {
        await pushConfigToServer(local, remote);
        return;
    }
    await pullConfigFromServer(local, remote);
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
function printPreviewSummary(title, labels, backupFiles) {
    console.log(textBold(title));
    if (backupFiles.length > 0) {
        console.log(`backup: ${textBlue(backupFiles.map((file) => basename(file.source)).join(", "))}`);
    }
    console.log(`files: ${textGreen(labels.join(", "))}`);
    console.log(textDim("no changes are written unless you type yes at the prompt."));
}
function collectChangedPreviewFiles(files) {
    return files.filter((file) => file.current !== file.next);
}
async function collectExistingBackupFilesForPaths(paths) {
    const targetPaths = new Set(paths);
    const files = await getExistingBackupFiles();
    return files.filter((file) => targetPaths.has(file.source));
}
function printDiffBlock(file) {
    const currentNormalized = normalizePreviewContent(file.label, file.current);
    const nextNormalized = normalizePreviewContent(file.label, file.next);
    const patch = createTwoFilesPatch(`a/${file.label}`, `b/${file.label}`, currentNormalized, nextNormalized, "", "", { context: 3 });
    console.log();
    console.log(textBold(file.label));
    console.log(textDim(file.path));
    console.log(textDim(patch.trimEnd()));
}
function redactPreviewSecrets(content) {
    const lines = content.split("\n");
    return lines.map((line) => {
        const jsonMatch = line.match(/^(\s*"OPENAI_API_KEY"\s*:\s*")([^"]+)(".*)$/);
        if (jsonMatch) {
            return `${jsonMatch[1]}${maskSecretValue(jsonMatch[2] ?? "")}${jsonMatch[3]}`;
        }
        const tomlMatch = line.match(/^(\s*api_key\s*=\s*")([^"]+)(".*)$/);
        if (tomlMatch) {
            return `${tomlMatch[1]}${maskSecretValue(tomlMatch[2] ?? "")}${tomlMatch[3]}`;
        }
        const profileApiKeyMatch = line.match(/^(\s*"apiKey"\s*:\s*")([^"]+)(".*)$/);
        if (profileApiKeyMatch) {
            return `${profileApiKeyMatch[1]}${maskSecretValue(profileApiKeyMatch[2] ?? "")}${profileApiKeyMatch[3]}`;
        }
        return line;
    }).join("\n");
}
function maskSecretValue(value) {
    if (!value) {
        return value;
    }
    return maskSecret(value);
}
function normalizePreviewContent(label, content) {
    const redacted = redactPreviewSecrets(content);
    if (label.endsWith(".json")) {
        return normalizeJsonPreview(redacted);
    }
    if (label.endsWith(".toml")) {
        return normalizeTomlPreview(redacted);
    }
    return redacted;
}
function normalizeJsonPreview(content) {
    if (!content.trim()) {
        return "";
    }
    try {
        return `${stringifyJson(parseJsonObject(content))}\n`;
    }
    catch {
        return content;
    }
}
function normalizeTomlPreview(content) {
    if (!content.trim()) {
        return "";
    }
    const lines = content.split("\n");
    const normalized = [];
    let currentComment = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) {
            currentComment = line;
            continue;
        }
        if (currentComment !== null) {
            if (trimmed) {
                normalized.push(currentComment);
                currentComment = null;
            }
            else {
                currentComment = null;
                continue;
            }
        }
        normalized.push(stripTomlInlineComment(line));
    }
    return normalized.join("\n");
}
function stripTomlInlineComment(line) {
    let insideString = false;
    let quote = "";
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (!insideString && (char === '"' || char === "'")) {
            insideString = true;
            quote = char;
            continue;
        }
        if (insideString && char === quote && line[index - 1] !== "\\") {
            insideString = false;
            continue;
        }
        if (!insideString && char === "#") {
            return line.slice(0, index).trimEnd();
        }
    }
    return line;
}
function printWarnings(warnings) {
    if (warnings.length === 0) {
        return;
    }
    console.log();
    for (const warning of warnings) {
        console.log(`${textYellow("warning:")} ${warning}`);
    }
}
async function buildInitPreviewPlan() {
    const plannedProfiles = await planInitProfilesFromCurrent();
    const nextProfilesText = `${stringifyJson(plannedProfiles)}\n`;
    const currentProfilesText = (await readTextIfExists(profilesPath())) ?? "";
    const configSync = await planCodexConfigSync();
    const currentConfigText = (await readTextIfExists(codexConfigPath())) ?? "";
    const defaultAgentsText = await readDefaultCodexAgents();
    const currentAgentsText = (await readTextIfExists(codexAgentsPath())) ?? "";
    const previewFiles = collectChangedPreviewFiles([
        {
            label: "profiles.json",
            path: profilesPath(),
            current: currentProfilesText,
            next: nextProfilesText,
        },
        {
            label: "config.toml",
            path: codexConfigPath(),
            current: currentConfigText,
            next: configSync.nextContent,
        },
        {
            label: "AGENTS.md",
            path: codexAgentsPath(),
            current: currentAgentsText,
            next: defaultAgentsText,
        },
    ]);
    const backupFiles = await collectExistingBackupFilesForPaths(previewFiles.map((file) => file.path));
    const warnings = [];
    if (currentProfilesText) {
        warnings.push(`profiles.json already exists: ${profilesPath()}`);
    }
    if (currentConfigText) {
        warnings.push(`config.toml already exists: ${codexConfigPath()}`);
    }
    if (currentAgentsText) {
        warnings.push(`AGENTS.md already exists: ${codexAgentsPath()}`);
    }
    return {
        title: "ccs init",
        previewFiles,
        backupFiles,
        warnings,
    };
}
async function selectSyncReplacePaths() {
    const defaults = await readDefaultCodexConfig();
    const existing = (await readTextIfExists(codexConfigPath())) ?? "";
    const differences = tomlLeafDifferences(defaults, existing).filter((difference) => !isProviderBaseUrlPath(difference.path));
    if (differences.length === 0 || !isInteractive())
        return [];
    const proxyInstalled = await proxyStateExists();
    const choices = differences.map((difference) => ({
        value: difference.path,
        label: difference.path,
        hint: `${truncateVisible(difference.current, 32)} -> ${truncateVisible(difference.template, 32)}`,
        disabled: difference.path === "model_provider" && proxyInstalled ? "proxy installed" : undefined,
    }));
    if (choices.every((choice) => choice.disabled))
        return [];
    console.log(textDim("missing template fields are always added; existing values change only when selected."));
    return multiSelect("Replace which existing values with the template?", choices);
}
async function buildSyncPreviewPlan(replacePaths) {
    const nextProfiles = await planSyncProfiles();
    const configPlan = await planCodexConfigSync(new Set(replacePaths));
    if (replacePaths.includes("model_provider") && configPlan.differentPaths.includes("model_provider") && await proxyStateExists()) {
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
function formatSyncFieldSummary(label, paths) {
    if (paths.length === 0) {
        return `${label.padEnd(11)}0`;
    }
    return `${label.padEnd(11)}${paths.length}  ${paths.join(", ")}`.trimEnd();
}
function printPreviewPlan(plan, dryRun) {
    printPreviewSummary(plan.title, plan.previewFiles.map((file) => file.label), plan.backupFiles);
    for (const file of plan.previewFiles) {
        printDiffBlock(file);
    }
    printWarnings(plan.warnings);
}
async function addProfile() {
    if (!isInteractive()) {
        throw new Error("ccs add requires an interactive terminal");
    }
    const data = await readProfiles();
    const profiles = data.profiles ?? {};
    const target = await select("Add or edit which profile?", [
        { value: null, label: "+ new profile" },
        ...Object.entries(profiles).map(([name, profile]) => ({ value: name, label: name, hint: profile.baseURL })),
    ]);
    const name = target ?? await input("Profile name", {
        validate: (value) => !value ? "a name is required"
            : /\s/.test(value) ? "names cannot contain spaces"
                : profiles[value] ? `profile ${value} exists; choose it from the list to edit` : null,
    });
    const existing = target ? assertProfile(profiles[target], target) : undefined;
    const baseURL = await input("baseURL", {
        default: existing?.baseURL,
        validate: (value) => value ? null : "baseURL is required",
    });
    const apiKey = await input("apiKey", {
        default: existing?.apiKey || undefined,
        defaultLabel: existing?.apiKey ? maskSecret(existing.apiKey) : undefined,
        mask: true,
    });
    const conversion = await select("Provider API", [
        { value: false, label: "Responses", hint: "send Codex Responses traffic unchanged" },
        { value: true, label: "Chat Completions only", hint: "convert Responses traffic to Chat Completions" },
    ], { default: existing?.routeConversion?.enabled ?? false });
    const profile = { baseURL, apiKey };
    if (conversion)
        profile.routeConversion = { enabled: true };
    printKeyValue(existing ? "update:" : "add:", `${colorName(name)}  ${colorUrl(profile.baseURL)}  ${formatApiKey(profile.apiKey)}`, 11);
    printKeyValue("conversion:", formatRouteConversion(profile), 11);
    console.log(textDim("no changes are written unless you type yes at the prompt."));
    if (!(await confirmApply())) {
        return;
    }
    const latest = await readProfiles();
    if (JSON.stringify(latest) !== JSON.stringify(data)) {
        throw new Error("profiles.json changed after preview; run ccs add again");
    }
    await writeProfiles({ ...data, profiles: { ...profiles, [name]: profile }, current: data.current ?? name });
    console.log(`profile saved: ${textGreen(name)}`);
}
function printProfile(name, profiles) {
    const profile = profiles.profiles?.[name];
    if (!profile) {
        throw new Error(`profile not found: ${name}`);
    }
    const normalized = assertProfile(profile, name);
    printProfileSummary("profile", name, normalized);
    printKeyValue("conversion:", formatRouteConversion(normalized));
}
function printProfileDetails(name, profile) {
    printProfileSummary("profile", name, profile);
    printKeyValue("conversion:", formatRouteConversion(profile));
}
async function resolveRunRoute(profileBaseUrl) {
    const runtime = await ensureProxyRunning(proxyOptions());
    if (!runtime) {
        return { baseURL: profileBaseUrl, proxy: false };
    }
    const baseURL = resolveProxySwitchBaseUrl(runtime.state);
    if (!baseURL) {
        throw new Error("proxy state has no base URL");
    }
    return { baseURL, proxy: true };
}
async function resolveActiveBaseUrl(profileBaseUrl) {
    return (await resolveRunRoute(profileBaseUrl)).baseURL;
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
function formatRouteConversion(profile) {
    return profile.routeConversion?.enabled ? textGreen("responses→chat") : textDim("off");
}
async function removeProfile() {
    const data = await readProfiles();
    const names = Object.keys(data.profiles ?? {});
    if (names.length === 0) {
        console.log(textDim("no profiles to remove."));
        return;
    }
    if (!isInteractive()) {
        throw new Error("ccs remove requires an interactive terminal");
    }
    const name = await select("Remove which profile?", names.map((item) => ({
        value: item,
        label: item,
        hint: `${data.profiles[item].baseURL}${item === data.current ? "  (current)" : ""}`,
    })), { default: data.current });
    const remaining = names.filter((item) => item !== name);
    const current = data.current === name ? remaining[0] : data.current;
    printProfileSummary("remove", name, assertProfile(data.profiles[name], name));
    if (current !== data.current) {
        printKeyValue("current:", `${textYellow(name)} -> ${current ? colorName(current) : textDim("none")}`);
    }
    console.log(textDim("no changes are written unless you type yes at the prompt."));
    if (!(await confirmApply())) {
        return;
    }
    const latest = await readProfiles();
    if (JSON.stringify(latest) !== JSON.stringify(data)) {
        throw new Error("profiles.json changed after preview; run ccs remove again");
    }
    const profiles = { ...data.profiles };
    delete profiles[name];
    await writeProfiles({ ...data, profiles, current });
    console.log(`profile removed: ${textRed(name)}`);
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
function profileUsageHint(name, current, entry, nowMs) {
    const used = profileLastUsedMs(entry);
    const parts = [
        ...(name === current ? ["current"] : []),
        used === null ? "never used" : `used ${formatAgo(used, nowMs)}`,
        ...(entry?.switched_at ? [`switched ${formatAgo(Date.parse(entry.switched_at), nowMs)}`] : []),
    ];
    return parts.join(" · ");
}
async function useProfile(profiles) {
    const names = Object.keys(profiles.profiles ?? {});
    if (names.length === 0) {
        console.log(textDim("no profiles; run ccs add first."));
        return;
    }
    const usage = await readProfileUsage();
    const nowMs = Date.now();
    if (!isInteractive()) {
        for (const name of names) {
            console.log(`${name === profiles.current ? textGreen("*") : " "} ${colorName(name)}  ${textDim(profileUsageHint(name, profiles.current, usage[name], nowMs))}`);
        }
        console.log(textDim("run in an interactive terminal to switch."));
        return;
    }
    const lastActive = (name) => Math.max(profileLastUsedMs(usage[name]) ?? 0, usage[name]?.switched_at ? Date.parse(usage[name].switched_at) : 0);
    const previous = names
        .filter((name) => name !== profiles.current)
        .sort((left, right) => lastActive(right) - lastActive(left))[0];
    const name = await select("Switch to which profile?", names.map((item) => ({
        value: item,
        label: item,
        hint: profileUsageHint(item, profiles.current, usage[item], nowMs),
        disabled: profiles.profiles[item].apiKey ? undefined : "missing apiKey",
    })), { default: previous ?? profiles.current });
    if (name === profiles.current) {
        console.log(textDim("no changes."));
        return;
    }
    const previousName = profiles.current;
    await switchProfile(name);
    await recordProfileUsage(name, "switched_at");
    printKeyValue("current:", `${previousName ? `${textYellow(previousName)} -> ` : ""}${colorName(name)}`);
}
async function printStatus() {
    const profiles = await readProfiles();
    const current = profiles.current ?? "test001";
    const profile = profiles.profiles?.[current];
    const systemLabel = formatSystemLabel();
    if (!profile) {
        printKeyValue("current:", `${textDim("none")}  ${colorHost(systemLabel)}`);
        printKeyValue("files:", `${colorPath(formatDisplayPath(profilesPath()))}  ${colorPath(formatDisplayPath(codexConfigPath()))}`);
        return null;
    }
    const normalized = assertProfile(profile, current);
    const usage = (await readProfileUsage())[current];
    const switched = usage?.switched_at ? textDim(`switched ${formatAgo(Date.parse(usage.switched_at))}`) : "";
    printKeyValue("current:", `${colorName(current)}  ${colorHost(systemLabel)}${switched ? `  ${switched}` : ""}`);
    printKeyValue("api:", `${colorUrl(normalized.baseURL)}  ${formatApiKey(normalized.apiKey)}`);
    printKeyValue("conversion:", formatRouteConversion(normalized));
    printKeyValue("files:", `${colorPath(formatDisplayPath(profilesPath()))}  ${colorPath(formatDisplayPath(codexConfigPath()))}`);
    return normalized;
}
async function printProfileList(profiles) {
    const entries = Object.entries(profiles.profiles ?? {});
    const current = profiles.current ?? "";
    const usage = await readProfileUsage();
    const nowMs = Date.now();
    const rows = entries.map(([name, profile]) => ({
        name,
        profile,
        marker: name === current ? textGreen("*") : "",
        conversion: formatRouteConversion(profile),
    }));
    const columns = [
        { key: "marker", title: "" },
        { key: "name", title: "" },
        { key: "url", title: "" },
        { key: "key", title: "" },
        { key: "conversion", title: "" },
        { key: "used", title: "" },
        { key: "switched", title: "" },
    ];
    printTable(columns, rows.map((row) => {
        const switchedAt = usage[row.name]?.switched_at;
        return {
            marker: row.marker,
            name: colorName(row.name),
            url: colorUrl(row.profile.baseURL),
            key: row.profile.apiKey ? textDim(maskSecret(row.profile.apiKey)) : textDim("(empty)"),
            conversion: row.conversion,
            used: textDim(`used ${formatAgo(profileLastUsedMs(usage[row.name]), nowMs)}`),
            switched: textDim(`switched ${formatAgo(switchedAt ? Date.parse(switchedAt) : null, nowMs)}`),
        };
    }));
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
        models.push({
            id: id.trim(),
            ownedBy: typeof record.owned_by === "string" && record.owned_by.trim() ? record.owned_by.trim() : null,
            created: typeof record.created === "number" && Number.isFinite(record.created) ? record.created : null,
        });
    }
    return models;
}
async function fetchModels(name, profile) {
    if (!profile.apiKey) {
        throw new Error(`profile ${name} has no apiKey`);
    }
    const url = buildModelsUrl(profile.baseURL);
    if (!url) {
        throw new Error(`profile ${name} has an invalid baseURL: ${profile.baseURL || "(empty)"}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), modelsHttpTimeoutMs);
    let response;
    try {
        response = await fetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${profile.apiKey}` },
            signal: controller.signal,
        });
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`GET ${url} timed out after ${modelsHttpTimeoutMs / 1000}s`);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`GET ${url} failed: ${message}`);
    }
    finally {
        clearTimeout(timeout);
    }
    if (!response.ok) {
        throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    }
    let payload;
    try {
        payload = await response.json();
    }
    catch {
        throw new Error(`GET ${url} returned invalid JSON`);
    }
    const models = parseModelsResponse(payload);
    if (!models) {
        throw new Error(`GET ${url} returned an invalid model list`);
    }
    return { url, models };
}
function formatModelCreated(value) {
    if (value === null) {
        return "-";
    }
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? "-" : date.toISOString().slice(0, 10);
}
function parseModelsArgs(args) {
    let profile;
    let json = false;
    for (const arg of args) {
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg.startsWith("-")) {
            throw new Error(`unknown argument for ccs models: ${arg}`);
        }
        if (profile !== undefined) {
            throw new Error("usage: ccs models [PROFILE] [--json]");
        }
        profile = arg;
    }
    return { profile, json };
}
async function printModels(profiles, args) {
    if (isHelpArgument(args[0])) {
        assertExactArgs(args.slice(1), "models help", 0);
        printModelsHelp();
        return;
    }
    const options = parseModelsArgs(args);
    const name = options.profile ?? profiles.current ?? "test001";
    const profile = profiles.profiles?.[name];
    if (!profile) {
        throw new Error(`profile not found: ${name}`);
    }
    const { url, models } = await fetchModels(name, assertProfile(profile, name));
    if (options.json) {
        console.log(stringifyJson({
            version: 1,
            profile: name,
            url,
            models: models.map((model) => ({
                id: model.id,
                owned_by: model.ownedBy,
                created: model.created,
            })),
        }).trimEnd());
        return;
    }
    printKeyValue("profile:", `${colorName(name)}  ${colorUrl(url)}`);
    if (models.length === 0) {
        console.log(textDim("no models reported"));
        return;
    }
    const columns = [
        { key: "id", title: "model" },
        { key: "ownedBy", title: "owned_by" },
        { key: "created", title: "created" },
    ];
    printTable(columns, models.map((model) => ({
        id: colorName(model.id),
        ownedBy: model.ownedBy ? textDim(model.ownedBy) : textDim("-"),
        created: textDim(formatModelCreated(model.created)),
    })));
}
function printModelsHelp() {
    console.log([
        textBold("Usage:"),
        "  ccs models                 # list models for the current profile",
        "  ccs models PROFILE         # list models for one profile",
        "  ccs models PROFILE --json  # print the model list as JSON",
    ].join("\n"));
}
function usageLines() {
    return [
        "  ccs                                  # show current profile",
        "  ccs version                          # print package version",
        "  ccs -v                               # print package version",
        "  ccs PROFILE                          # show profile details",
        "  ccs models [PROFILE] [--json]        # list models from the profile v1/models endpoint",
        "  ccs proxy [--view overview|tokens|cost] # show proxy status with the selected request view",
        "  ccs proxy [watch|reroute|cancel|capture|mode|search|compact|config|install|restart|restore|serve] # manage proxy state and runtime",
        "  ccs use                              # choose the current profile; shows last use and switch times",
        "  ccs config                           # choose push or pull, preview, and sync profiles.json with LAN server",
        "  ccs list | l                         # list profiles",
        "  ccs init                             # preview, confirm, and create config",
        "  ccs sync                             # add missing template fields; choose existing values to replace",
        "  ccs add                              # choose a profile to edit or create, then enter its values",
        "  ccs remove                           # choose a profile to remove",
        "  ccs stats                            # summarize local command and prompt usage",
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
function printCommandFooter(rows) {
    console.log(formatCommandFooterLines(rows).map(textDim).join("\n"));
}
function printUsageHelp() {
    printCommandFooter([
        {
            label: "commands:",
            commands: ["version", "PROFILE", "models", "use", "list", "init", "sync", "add", "remove", "config", "stats"],
        },
        {
            label: "namespaces:",
            commands: ["proxy", "--help"],
        },
    ]);
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
    if (command === "stats") {
        await runCcsStats(args);
        return;
    }
    const profiles = await readProfiles();
    if (!command) {
        await printStatus();
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
        const previewPlan = await buildSyncPreviewPlan(await selectSyncReplacePaths());
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
        assertExactArgs(args, "list", 0);
        await printProfileList(profiles);
        return;
    }
    if (command === "models") {
        await printModels(profiles, args);
        return;
    }
    if (command === "proxy") {
        await runProxyCommand(args, proxyOptions());
        return;
    }
    if (command === "add") {
        assertExactArgs(args, "add", 0);
        await addProfile();
        return;
    }
    if (command === "remove") {
        assertExactArgs(args, "remove", 0);
        await removeProfile();
        return;
    }
    if (command === "use") {
        assertExactArgs(args, "use", 0);
        await useProfile(profiles);
        return;
    }
    if (profiles.profiles?.[command]) {
        assertExactArgs(args, command, 0);
        printProfile(command, profiles);
        return;
    }
    console.error(`${textRed("unknown command:")} ${basename(command)}`);
    process.exitCode = 1;
}
