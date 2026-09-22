import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { ensureDir, readTextIfExists, writeTextFile, writeTextFileAtomic } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexAgentsPath, codexAuthPath, codexConfigPath, codexDir, profilesPath, } from "../lib/paths.js";
import { assertProfile, readProfiles, writeProfiles } from "../lib/profiles.js";
import { maskSecret, textBlue, textBold, textDim, textGreen, textRed, textYellow, } from "../lib/text.js";
import { colorHost, colorName, colorPath, colorUrl, printKeyValue, } from "../lib/output.js";
import { ensureProxyRunning, proxyStateExists, resolveProxyOptions as proxyOptions, resolveProxySwitchBaseUrl, runProxyCommand } from "./ccs-proxy.js";
import { syncTomlTemplate, readTomlBaseUrl, updateTomlBaseUrl, } from "../lib/toml.js";
import { printTable } from "../lib/table.js";
import { formatCommandFooterLines } from "../lib/terminal.js";
import { isVersionArgument, printToolVersionIfRequested } from "../lib/version.js";
const execFile = promisify(execFileCallback);
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
    let currentName = defaultProfiles.current ?? "input";
    if (!current.baseURL && !current.apiKey) {
        return {
            current: currentName,
            profiles,
            toggle: defaultProfiles.toggle ?? Object.keys(profiles).slice(0, 2),
        };
    }
    const existingEntry = Object.entries(profiles).find(([, profile]) => (profile.baseURL === current.baseURL && profile.apiKey === current.apiKey));
    if (existingEntry) {
        currentName = existingEntry[0];
    }
    else if (!profiles.input) {
        profiles.input = current;
        currentName = "input";
    }
    else {
        let index = 1;
        while (profiles[`input-${index}`]) {
            index += 1;
        }
        currentName = `input-${index}`;
        profiles[currentName] = current;
    }
    return {
        current: currentName,
        profiles,
        toggle: defaultProfiles.toggle ?? Object.keys(profiles).slice(0, 2),
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
    return {
        ...currentProfiles,
        current: currentProfiles.current ?? defaultProfiles.current ?? Object.keys(profiles)[0] ?? "input",
        profiles,
        toggle: currentProfiles.toggle ?? defaultProfiles.toggle ?? Object.keys(profiles).slice(0, 2),
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
    printCommandFooter([{
            label: "commands:",
            commands: ["push", "pull", "--help"],
        }]);
}
function printConfigSyncHelp() {
    console.log([
        textBold("Usage:"),
        "  ccs config        # show local and remote config sync endpoints",
        "  ccs config push   # preview, confirm, and copy profiles.json to LAN server",
        "  ccs config pull   # preview, confirm, and copy profiles.json from LAN server",
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
    if (args.length === 0) {
        return { action: "status" };
    }
    const action = args[0];
    if (action === "push" || action === "pull") {
        assertExactArgs(args.slice(1), `config ${action}`, 0);
        return { action };
    }
    throw new Error(`unknown argument for ccs config: ${action}`);
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
    if (selectedPaths.includes("model_provider") && configPlan.differentPaths.includes("model_provider") && await proxyStateExists()) {
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
async function addProfile(defaultName) {
    const data = await readProfiles();
    const profiles = data.profiles ?? {};
    const input = createPrompt();
    let name = "";
    try {
        name = await askRequired(input, "name", defaultName);
        const existing = profiles[name];
        const baseURL = await askRequired(input, "baseURL", existing?.baseURL);
        const apiKey = await askOptional(input, "apiKey", existing?.apiKey);
        const enableConversion = await askYesNo(input, "Provider only supports Chat Completions (convert Responses → Chat)", existing?.routeConversion?.enabled ?? false);
        const profile = { baseURL, apiKey };
        if (enableConversion) {
            profile.routeConversion = { enabled: true };
            console.log(textDim("  → Codex Responses traffic will use the provider's Chat Completions endpoint"));
        }
        profiles[name] = profile;
    }
    finally {
        input.close();
    }
    await writeProfiles({ ...data, profiles, current: data.current ?? name });
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
async function askYesNo(input, label, defaultValue) {
    const defaultText = defaultValue ? "Y/n" : "y/N";
    const value = await input.question(`${label} [${defaultText}]: `);
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "") {
        return defaultValue;
    }
    if (trimmed === "y" || trimmed === "yes") {
        return true;
    }
    if (trimmed === "n" || trimmed === "no") {
        return false;
    }
    return defaultValue;
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
    printKeyValue("conversion:", formatRouteConversion(normalized));
    printKeyValue("files:", `${colorPath(formatDisplayPath(profilesPath()))}  ${colorPath(formatDisplayPath(codexConfigPath()))}`);
    return normalized;
}
async function printProfileList(profiles) {
    const entries = Object.entries(profiles.profiles ?? {});
    const current = profiles.current ?? "";
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
    ];
    printTable(columns, rows.map((row) => ({
        marker: row.marker,
        name: colorName(row.name),
        url: colorUrl(row.profile.baseURL),
        key: row.profile.apiKey ? textDim(maskSecret(row.profile.apiKey)) : textDim("(empty)"),
        conversion: row.conversion,
    })));
}
function usageLines() {
    return [
        "  ccs                                  # show current profile",
        "  ccs version                          # print package version",
        "  ccs -v                               # print package version",
        "  ccs PROFILE                          # show profile details",
        "  ccs proxy [--view overview|tokens|cost] # show proxy status with the selected request view",
        "  ccs proxy [watch|reroute|cancel|mode|config|install|restart|restore|serve] # manage proxy state and runtime",
        "  ccs toggle [PROFILE]                 # switch profile",
        "  ccs config [push|pull]                # preview, confirm, and sync profiles.json with LAN server",
        "  ccs list | l                         # list profiles",
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
function printCommandFooter(rows) {
    console.log(formatCommandFooterLines(rows).map(textDim).join("\n"));
}
function printUsageHelp() {
    printCommandFooter([
        {
            label: "commands:",
            commands: ["version", "PROFILE", "toggle", "list", "init", "sync", "add", "remove"],
        },
        {
            label: "namespaces:",
            commands: ["proxy", "config", "--help"],
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
        assertExactArgs(args, "list", 0);
        await printProfileList(profiles);
        return;
    }
    if (command === "proxy") {
        await runProxyCommand(args, proxyOptions());
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
            await switchProfile(args[0]);
            return;
        }
        const toggle = profiles.toggle ?? [];
        if (toggle.length < 2) {
            throw new Error("toggle requires at least two profile names in profiles.json toggle");
        }
        const index = Math.max(0, toggle.indexOf(profiles.current ?? ""));
        const next = toggle[(index + 1) % toggle.length];
        await switchProfile(next);
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
