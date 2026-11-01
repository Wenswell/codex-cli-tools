import { readFile, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTwoFilesPatch } from "diff";
import { confirmApply } from "../lib/confirm.js";
import { ensureDir, readTextIfExists, writeTextFile, writeTextFileAtomic } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import { codexAgentsPath, codexConfigPath, codexToolsConfigDir, profilesPath, } from "../lib/paths.js";
import { PLATFORM_LABELS, readPlatformConnection, writePlatformConnection } from "../lib/platforms.js";
import { PLATFORMS, assertProfile, currentProfileName, parseProfiles, profilePlatform, profilesOf, readProfiles, writeProfiles, } from "../lib/profiles.js";
import { formatAgo, profileLastUsedMs, readProfileUsage, recordProfileUsage } from "../lib/profile-usage.js";
import { formatShortcut, input, isInteractive, multiSelect, readShortcutKey, select } from "../lib/prompt.js";
import { parseSyncTarget, readRemoteProfiles, readSyncHosts, recordSyncHost, syncTargetError, writeRemoteProfiles, } from "../lib/remote-sync.js";
import { setUsageCommand } from "../lib/usage.js";
import { maskSecret, textBlue, textBold, textDim, textGreen, textRed, textYellow, truncateVisible, } from "../lib/text.js";
import { colorHost, colorName, colorPath, colorUrl, printKeyValue, } from "../lib/output.js";
import { runCcsStats } from "./ccs-stats.js";
import { ensureProxyRunning, proxyStateExists, readProxyState, resolveProxyOptions as proxyOptions, resolveProxySwitchBaseUrl, runProxyCommand } from "./ccs-proxy.js";
import { syncTomlTemplate, tomlLeafDifferences, } from "../lib/toml.js";
import { printTable } from "../lib/table.js";
import { formatCommandFooterLines } from "../lib/terminal.js";
import { isVersionArgument, printToolVersionIfRequested } from "../lib/version.js";
const modelsHttpTimeoutMs = 5_000;
// Matches the proxy URL that `ccs proxy install` writes; it is never imported as a provider profile.
const localProxyUrlPattern = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;
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
function formatBackupStamp(date) {
    const pad = (value, size = 2) => value.toString().padStart(size, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
        + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}
// Copies the current content of every existing preview target into one backup directory.
async function backupPreviewFiles(files, stamp) {
    const existing = files.filter((file) => file.current !== null);
    if (existing.length === 0) {
        return null;
    }
    const backupDir = join(codexToolsConfigDir(), "backups", `ccs-${stamp}`);
    await ensureDir(backupDir);
    for (const file of existing) {
        await writeTextFile(join(backupDir, basename(file.path)), file.current, 0o600);
    }
    return backupDir;
}
async function writeVerified(file) {
    if (file.path === profilesPath()) {
        await writeTextFileAtomic(file.path, file.next, 0o600);
    }
    else {
        await writeTextFile(file.path, file.next);
    }
    if ((await readTextIfExists(file.path)) !== file.next) {
        throw new Error(`write verification failed: ${file.path}`);
    }
}
async function readConfigFiles() {
    return {
        profiles: await readTextIfExists(profilesPath()),
        config: await readTextIfExists(codexConfigPath()),
        agents: await readTextIfExists(codexAgentsPath()),
    };
}
async function readConfigTemplates() {
    return {
        profiles: await readDefaultProfiles(),
        config: await readDefaultCodexConfig(),
        agents: await readDefaultCodexAgents(),
    };
}
function sameBaseUrl(left, right) {
    return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}
// A new profiles.json starts from the template. A direct Codex provider URL and key become a profile:
// a template profile with the same URL and an empty key receives the key, otherwise `imported` is added.
function planProfilesFromTemplate(template, codex) {
    const profiles = { ...(template.profiles ?? {}) };
    if (!codex || !codex.baseURL || !codex.apiKey || localProxyUrlPattern.test(codex.baseURL)) {
        return { profiles: { ...template, profiles }, imported: null };
    }
    const match = Object.entries(profiles).find(([, profile]) => (sameBaseUrl(profile.baseURL, codex.baseURL) && (!profile.apiKey || profile.apiKey === codex.apiKey)));
    let name = match?.[0];
    if (name) {
        profiles[name] = { ...profiles[name], apiKey: codex.apiKey };
    }
    else {
        name = "imported";
        for (let index = 1; profiles[name]; index += 1)
            name = `imported-${index}`;
        profiles[name] = codex;
    }
    return { profiles: { ...template, profiles, current: { ...template.current, codex: name } }, imported: name };
}
function missingTemplateProfiles(existing, template) {
    return Object.keys(template.profiles ?? {}).filter((name) => !existing.profiles?.[name]);
}
function missingConfigPaths(config, template) {
    return syncTomlTemplate(template, config, new Set()).updatedPaths;
}
function isProviderBaseUrlPath(path) {
    return /^model_providers\.[^.]+\.base_url$/.test(path);
}
function differingConfigValues(config, template) {
    return tomlLeafDifferences(template, config).filter((difference) => !isProviderBaseUrlPath(difference.path));
}
function listPreview(items, limit = 4) {
    return items.length <= limit ? items.join(", ") : `${items.slice(0, limit).join(", ")}, +${items.length - limit} more`;
}
// Additive changes start checked; replacing an existing value or file starts unchecked.
function configChoices(files, templates, codex, proxyInstalled) {
    const choices = [];
    if (files.profiles === null) {
        const { imported } = planProfilesFromTemplate(templates.profiles, codex);
        choices.push({
            value: "profiles",
            label: "profiles.json  create",
            hint: imported ? `template profiles + current Codex provider as ${imported}` : "template profiles",
            checked: true,
        });
    }
    else {
        for (const name of missingTemplateProfiles(parseProfiles(files.profiles), templates.profiles)) {
            choices.push({
                value: `profile:${name}`,
                label: `profiles.json  add ${name}`,
                hint: templates.profiles.profiles[name].baseURL,
                checked: true,
            });
        }
    }
    if (files.config === null) {
        choices.push({ value: "config:create", label: "config.toml    create", hint: "from the template", checked: true });
    }
    else {
        const missing = missingConfigPaths(files.config, templates.config);
        if (missing.length > 0) {
            choices.push({
                value: "config:add",
                label: "config.toml    add missing fields",
                hint: `${missing.length}: ${listPreview(missing)}`,
                checked: true,
            });
        }
        for (const difference of differingConfigValues(files.config, templates.config)) {
            choices.push({
                value: `config:set:${difference.path}`,
                label: `config.toml    ${difference.path}`,
                hint: `${truncateVisible(difference.current, 32)} -> ${truncateVisible(difference.template, 32)}`,
                disabled: difference.path === "model_provider" && proxyInstalled ? "proxy installed" : undefined,
            });
        }
    }
    if (files.agents === null) {
        choices.push({ value: "agents", label: "AGENTS.md      create", hint: "from the template", checked: true });
    }
    else if (files.agents !== templates.agents) {
        choices.push({ value: "agents", label: "AGENTS.md      replace", hint: "with the template; local edits are lost" });
    }
    return choices;
}
function planConfigWrites(selected, files, templates, codex) {
    const writes = [];
    if (selected.has("profiles")) {
        const { profiles } = planProfilesFromTemplate(templates.profiles, codex);
        writes.push({ label: "profiles.json", path: profilesPath(), current: null, next: stringifyJson(profiles) });
    }
    else if (files.profiles !== null) {
        const existing = parseProfiles(files.profiles);
        const added = missingTemplateProfiles(existing, templates.profiles).filter((name) => selected.has(`profile:${name}`));
        if (added.length > 0) {
            const profiles = { ...existing.profiles };
            for (const name of added)
                profiles[name] = templates.profiles.profiles[name];
            writes.push({
                label: "profiles.json",
                path: profilesPath(),
                current: files.profiles,
                next: stringifyJson({ ...existing, profiles, current: existing.current ?? { codex: added[0] } }),
            });
        }
    }
    if (selected.has("config:create")) {
        writes.push({ label: "config.toml", path: codexConfigPath(), current: null, next: templates.config });
    }
    else if (files.config !== null) {
        const replace = new Set([...selected].flatMap((value) => value.startsWith("config:set:") ? [value.slice("config:set:".length)] : []));
        const addMissing = selected.has("config:add");
        if (addMissing || replace.size > 0) {
            const next = syncTomlTemplate(templates.config, files.config, replace, { addMissing }).content;
            if (next !== files.config) {
                writes.push({ label: "config.toml", path: codexConfigPath(), current: files.config, next });
            }
        }
    }
    if (selected.has("agents")) {
        writes.push({ label: "AGENTS.md", path: codexAgentsPath(), current: files.agents, next: templates.agents });
    }
    return writes;
}
function printConfigStatus(files, templates) {
    const missing = textYellow("missing");
    const profilesState = () => {
        if (files.profiles === null)
            return missing;
        const existing = parseProfiles(files.profiles);
        const absent = missingTemplateProfiles(existing, templates.profiles);
        const count = `${Object.keys(existing.profiles ?? {}).length} profiles`;
        return absent.length > 0 ? `${count} · ${textYellow(`template adds ${absent.join(", ")}`)}` : textDim(count);
    };
    const configState = () => {
        if (files.config === null)
            return missing;
        const absent = missingConfigPaths(files.config, templates.config).length;
        const differing = differingConfigValues(files.config, templates.config).length;
        const parts = [
            ...(absent > 0 ? [textYellow(`${absent} missing fields`)] : []),
            ...(differing > 0 ? [`${differing} values differ`] : []),
        ];
        return parts.length > 0 ? parts.join(" · ") : textGreen("matches template");
    };
    const agentsState = files.agents === null ? missing
        : files.agents === templates.agents ? textGreen("matches template") : "differs from template";
    console.log(textBold("ccs config"));
    printTable([
        { key: "file", title: "" },
        { key: "path", title: "" },
        { key: "state", title: "" },
    ], [
        { file: "profiles.json", path: colorPath(formatDisplayPath(profilesPath())), state: profilesState() },
        { file: "config.toml", path: colorPath(formatDisplayPath(codexConfigPath())), state: configState() },
        { file: "AGENTS.md", path: colorPath(formatDisplayPath(codexAgentsPath())), state: agentsState },
    ], { header: false });
}
function printConfigHelp() {
    console.log([
        textBold("Usage:"),
        "  ccs config        # create or update profiles.json, config.toml, and AGENTS.md from the templates",
    ].join("\n"));
}
async function runConfig(args) {
    if (isHelpArgument(args[0])) {
        assertExactArgs(args.slice(1), "config help", 0);
        printConfigHelp();
        return;
    }
    assertExactArgs(args, "config", 0);
    const files = await readConfigFiles();
    const templates = await readConfigTemplates();
    // The current Codex provider only matters when profiles.json is being created.
    const codex = files.profiles === null ? await readPlatformConnection("codex") : null;
    const choices = configChoices(files, templates, codex, await proxyStateExists());
    printConfigStatus(files, templates);
    if (!choices.some((choice) => !choice.disabled)) {
        console.log(textDim("everything is up to date."));
        return;
    }
    if (!isInteractive()) {
        console.log(textDim("run in an interactive terminal to choose and apply changes."));
        return;
    }
    const selected = new Set(await multiSelect("Apply which changes?", choices));
    const writes = planConfigWrites(selected, files, templates, codex);
    if (writes.length === 0) {
        console.log(textDim("no changes."));
        return;
    }
    printPreviewSummary("ccs config", writes);
    for (const file of writes) {
        printDiffBlock(file);
    }
    if (!(await confirmApply())) {
        return;
    }
    const latest = await readConfigFiles();
    if (latest.profiles !== files.profiles || latest.config !== files.config || latest.agents !== files.agents) {
        throw new Error("files changed after preview; run ccs config again");
    }
    const backupDir = await backupPreviewFiles(writes, formatBackupStamp(new Date()));
    for (const file of writes) {
        await writeVerified(file);
    }
    if (backupDir) {
        console.log(`backup: ${textBlue(formatDisplayPath(backupDir))}`);
    }
    for (const file of writes) {
        console.log(`${file.current === null ? "created" : "updated"}: ${textGreen(formatDisplayPath(file.path))}`);
    }
}
// `current` is per device: each device keeps its own active profile.
function compareSyncedProfiles(local, remote) {
    const localProfiles = local.profiles ?? {};
    const remoteProfiles = remote.profiles ?? {};
    const settingKeys = new Set([...Object.keys(local), ...Object.keys(remote)].filter((key) => key !== "profiles" && key !== "current"));
    const field = (file, key) => JSON.stringify(file[key] ?? null);
    return {
        localOnly: Object.keys(localProfiles).filter((name) => !remoteProfiles[name]),
        remoteOnly: Object.keys(remoteProfiles).filter((name) => !localProfiles[name]),
        changed: Object.keys(localProfiles).filter((name) => (remoteProfiles[name] && JSON.stringify(localProfiles[name]) !== JSON.stringify(remoteProfiles[name]))),
        settings: [...settingKeys].filter((key) => field(local, key) !== field(remote, key)),
    };
}
function isInSync(comparison) {
    return comparison.localOnly.length + comparison.remoteOnly.length + comparison.changed.length + comparison.settings.length === 0;
}
// The source replaces the target file, except that the target keeps each platform's current profile
// while the source still has it.
function planSyncedProfiles(source, target) {
    const current = {};
    for (const platform of PLATFORMS) {
        const kept = currentProfileName(target ?? {}, platform);
        const name = kept && source.profiles?.[kept] ? kept : currentProfileName(source, platform);
        if (name)
            current[platform] = name;
    }
    return { ...source, ...(Object.keys(current).length > 0 ? { current } : {}) };
}
function formatCurrentMap(profiles) {
    const entries = PLATFORMS.flatMap((platform) => {
        const name = currentProfileName(profiles ?? {}, platform);
        return name ? [`${platform} ${colorName(name)}`] : [];
    });
    return entries.length > 0 ? entries.join(" · ") : textDim("none");
}
function formatSyncSide(label, text, profiles, mtime) {
    if (text === null)
        return `${label}  ${textYellow("missing")}`;
    const count = Object.keys(profiles?.profiles ?? {}).length;
    const when = mtime ? `  ${textDim(`modified ${formatAgo(mtime.getTime())}`)}` : "";
    return `${label}  ${textDim(`${count} profiles`)}  current ${formatCurrentMap(profiles)}${when}`;
}
function printSyncComparison(target, remote, local, remoteProfiles, comparison) {
    console.log(textBold(`ccs sync  ${colorHost(target.raw)}`));
    printKeyValue("local:", formatSyncSide(colorHost(formatSystemLabel()), local.text, local.profiles, local.mtime), 10);
    printKeyValue("remote:", formatSyncSide(colorHost(remote.host), remote.text, remoteProfiles, remote.mtime), 10);
    if (local.text === null || remote.text === null)
        return;
    const rows = [
        ["local only:", comparison.localOnly],
        ["remote only:", comparison.remoteOnly],
        ["differ:", comparison.changed],
        ["settings:", comparison.settings],
    ];
    for (const [label, names] of rows) {
        if (names.length > 0)
            printKeyValue(label, names.map(colorName).join(", "), 13);
    }
}
function syncHostHint(entry, nowMs) {
    const parts = [
        ...(entry.host ? [entry.host] : []),
        entry.synced_at ? `synced ${formatAgo(Date.parse(entry.synced_at), nowMs)} (${entry.direction ?? "?"})`
            : entry.connected_at ? `connected ${formatAgo(Date.parse(entry.connected_at), nowMs)}` : "never connected",
    ];
    return parts.join(" · ");
}
function sortedSyncHosts(hosts) {
    const time = (raw) => Date.parse(hosts[raw].connected_at ?? "") || 0;
    return Object.keys(hosts).sort((left, right) => time(right) - time(left));
}
async function chooseSyncTarget(hosts) {
    const nowMs = Date.now();
    const known = sortedSyncHosts(hosts);
    const picked = known.length === 0 ? null : await select("Sync with which device?", [
        ...known.map((raw) => ({ value: raw, label: raw, hint: syncHostHint(hosts[raw], nowMs) })),
        { value: null, label: "+ new device", hint: "user@host[:port] or an ssh config alias" },
    ]);
    const raw = picked ?? await input("Device (user@host[:port] or ssh alias)", { validate: (value) => syncTargetError(value) });
    return parseSyncTarget(raw);
}
function printSyncHelp() {
    console.log([
        textBold("Usage:"),
        "  ccs sync              # choose a remembered device or enter user@host, then pull or push profiles.json",
        "  ccs sync user@host    # sync with this device; user@host:port and ssh config aliases also work",
    ].join("\n"));
}
async function runDeviceSync(args) {
    if (isHelpArgument(args[0])) {
        assertExactArgs(args.slice(1), "sync help", 0);
        printSyncHelp();
        return;
    }
    assertMaxArgs(args, "sync [user@host]", 1);
    const hosts = await readSyncHosts();
    const interactive = isInteractive();
    if (!args[0] && !interactive) {
        console.log(textBold("ccs sync"));
        for (const raw of sortedSyncHosts(hosts)) {
            printKeyValue(`${raw}`, textDim(syncHostHint(hosts[raw], Date.now())));
        }
        console.log(textDim("run in an interactive terminal to choose a device, or pass user@host."));
        return;
    }
    const target = args[0] ? parseSyncTarget(args[0]) : await chooseSyncTarget(hosts);
    // Without a terminal ssh cannot ask for a password, so it fails instead of waiting.
    const remote = await readRemoteProfiles(target, { batch: !interactive });
    await recordSyncHost(target.raw, { connected_at: new Date().toISOString(), host: remote.host });
    const localText = await readTextIfExists(profilesPath());
    const localMtime = localText === null ? undefined : (await stat(profilesPath())).mtime;
    const localProfiles = localText === null ? null : parseProfiles(localText);
    const remoteProfiles = remote.text === null ? null : parseProfiles(remote.text, `remote profiles.json (${target.raw})`, true);
    if (!localProfiles && !remoteProfiles) {
        throw new Error(`profiles.json is missing on both devices; run ccs config first`);
    }
    const comparison = compareSyncedProfiles(localProfiles ?? {}, remoteProfiles ?? {});
    printSyncComparison(target, remote, { text: localText, profiles: localProfiles, mtime: localMtime }, remoteProfiles, comparison);
    if (localProfiles && remoteProfiles && isInSync(comparison)) {
        console.log(textGreen("in sync."));
        return;
    }
    if (!interactive) {
        console.log(textDim("run in an interactive terminal to pull or push."));
        return;
    }
    const remoteNewer = (remote.mtime?.getTime() ?? 0) > (localMtime?.getTime() ?? 0);
    const direction = await select("Direction", [
        { value: "pull", label: "pull", hint: `replace local profiles.json with ${remote.host}'s`, disabled: remoteProfiles ? undefined : "remote missing" },
        { value: "push", label: "push", hint: `replace ${remote.host}'s profiles.json with local`, disabled: localProfiles ? undefined : "local missing" },
    ], { default: !localProfiles || (remoteProfiles && remoteNewer) ? "pull" : "push" });
    const source = direction === "pull" ? remoteProfiles : localProfiles;
    const targetProfiles = direction === "pull" ? localProfiles : remoteProfiles;
    const next = planSyncedProfiles(source, targetProfiles);
    const nextText = stringifyJson(next);
    const preview = {
        label: "profiles.json",
        path: direction === "pull" ? profilesPath() : `${target.raw}:~/.config/codex-tools/profiles.json`,
        current: direction === "pull" ? localText : remote.text,
        next: nextText,
    };
    // Platforms whose current profile changes name or content on the receiving device.
    const affected = PLATFORMS.filter((platform) => {
        const before = currentProfileName(targetProfiles ?? {}, platform);
        const after = currentProfileName(next, platform);
        return Boolean(before) && (before !== after
            || JSON.stringify(targetProfiles?.profiles?.[before]) !== JSON.stringify(next.profiles?.[after ?? ""]));
    });
    const dropped = affected.filter((platform) => currentProfileName(next, platform) !== currentProfileName(targetProfiles ?? {}, platform));
    // After a pull, local client files follow the current profile when its URL or key changed.
    const refresh = direction === "pull"
        ? affected.filter((platform) => Boolean(next.profiles?.[currentProfileName(next, platform) ?? ""]?.apiKey))
        : [];
    console.log(textBold(`ccs sync ${direction}`));
    printDiffBlock(preview);
    for (const platform of dropped) {
        console.log(`${textYellow("warning:")} current ${platform} ${currentProfileName(targetProfiles ?? {}, platform)} is not in the incoming file; it becomes ${currentProfileName(next, platform) ?? "none"}`);
    }
    for (const platform of refresh) {
        console.log(textDim(`${PLATFORM_LABELS[platform]} settings will switch to ${currentProfileName(next, platform)} as ccs use does.`));
    }
    if (direction === "push" && affected.length > 0) {
        console.log(`${textYellow("note:")} run ccs use on ${remote.host} so its ${affected.map((platform) => PLATFORM_LABELS[platform]).join(" and ")} settings follow the new current profile`);
    }
    console.log(textDim("no changes are written unless you type yes at the prompt."));
    if (!(await confirmApply())) {
        return;
    }
    const stamp = formatBackupStamp(new Date());
    let backup;
    if (direction === "pull") {
        if ((await readTextIfExists(profilesPath())) !== localText) {
            throw new Error("local profiles.json changed after preview; run ccs sync again");
        }
        backup = await backupPreviewFiles([preview], stamp);
        await writeVerified(preview);
        for (const platform of refresh) {
            await switchProfile(currentProfileName(next, platform));
        }
    }
    else {
        backup = (await writeRemoteProfiles(target, nextText, remote.checksum, stamp)).backup;
    }
    await recordSyncHost(target.raw, { synced_at: new Date().toISOString(), direction });
    if (backup) {
        console.log(`backup: ${textBlue(direction === "pull" ? formatDisplayPath(backup) : `${remote.host}:${backup}`)}`);
    }
    console.log(`${direction === "pull" ? "pulled" : "pushed"}: ${textGreen(direction === "pull" ? formatDisplayPath(profilesPath()) : `${target.raw}`)}`);
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
function printPreviewSummary(title, files) {
    console.log(textBold(title));
    const backups = files.filter((file) => file.current !== null);
    if (backups.length > 0) {
        console.log(`backup: ${textBlue(backups.map((file) => file.label).join(", "))}`);
    }
    console.log(`files: ${textGreen(files.map((file) => file.label).join(", "))}`);
    console.log(textDim("no changes are written unless you type yes at the prompt."));
}
function printDiffBlock(file) {
    const currentNormalized = normalizePreviewContent(file.label, file.current ?? "");
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
    const platform = existing ? profilePlatform(existing) : await select("Platform", PLATFORMS.map((value) => ({
        value,
        label: value,
        hint: PLATFORM_LABELS[value],
    })));
    const baseURL = await input("baseURL", {
        default: existing?.baseURL,
        validate: (value) => value ? null : "baseURL is required",
    });
    const apiKey = await input("apiKey", {
        default: existing?.apiKey || undefined,
        defaultLabel: existing?.apiKey ? maskSecret(existing.apiKey) : undefined,
        mask: true,
    });
    const conversion = platform === "codex" && await select("Provider API", [
        { value: false, label: "Responses", hint: "send Codex Responses traffic unchanged" },
        { value: true, label: "Chat Completions only", hint: "convert Responses traffic to Chat Completions" },
    ], { default: existing?.routeConversion?.enabled ?? false });
    const profile = { baseURL, apiKey, ...(platform === "codex" ? {} : { platform }) };
    if (conversion)
        profile.routeConversion = { enabled: true };
    printKeyValue(existing ? "update:" : "add:", `${colorName(name)}  ${textDim(platform)}  ${colorUrl(profile.baseURL)}  ${formatApiKey(profile.apiKey)}`, 11);
    if (platform === "codex")
        printKeyValue("conversion:", formatRouteConversion(profile), 11);
    console.log(textDim("no changes are written unless you type yes at the prompt."));
    if (!(await confirmApply())) {
        return;
    }
    const latest = await readProfiles();
    if (JSON.stringify(latest) !== JSON.stringify(data)) {
        throw new Error("profiles.json changed after preview; run ccs add again");
    }
    // The first profile of a platform becomes its current profile.
    const current = currentProfileName(data, platform) ? data.current : { ...data.current, [platform]: name };
    await writeProfiles({ ...data, profiles: { ...profiles, [name]: profile }, current });
    console.log(`profile saved: ${textGreen(name)}`);
}
function printProfile(name, profiles) {
    const profile = profiles.profiles?.[name];
    if (!profile) {
        throw new Error(`profile not found: ${name}`);
    }
    printProfileDetails(name, assertProfile(profile, name));
}
function printProfileDetails(name, profile) {
    printProfileSummary("profile", name, profile);
    printKeyValue("platform:", profilePlatform(profile));
    if (profilePlatform(profile) === "codex")
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
    const isCurrent = (item) => currentProfileName(data, profilePlatform(data.profiles[item])) === item;
    const name = await select("Remove which profile?", names.map((item) => ({
        value: item,
        label: item,
        hint: `${profilePlatform(data.profiles[item])}  ${data.profiles[item].baseURL}${isCurrent(item) ? "  (current)" : ""}`,
    })));
    const platform = profilePlatform(data.profiles[name]);
    const replacement = profilesOf(data, platform).find((item) => item !== name);
    const current = { ...data.current };
    if (isCurrent(name)) {
        if (replacement)
            current[platform] = replacement;
        else
            delete current[platform];
    }
    printProfileSummary("remove", name, assertProfile(data.profiles[name], name));
    if (isCurrent(name)) {
        printKeyValue("current:", `${platform} ${textYellow(name)} -> ${replacement ? colorName(replacement) : textDim("none")}`);
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
    const platform = profilePlatform(normalized);
    // With proxy mode every platform points at the proxy, which picks the profile per request.
    await writePlatformConnection(platform, { baseURL: await resolveActiveBaseUrl(normalized.baseURL), apiKey: normalized.apiKey });
    await writeProfiles({
        ...data,
        current: { ...data.current, [platform]: name },
        profiles,
    });
    printProfileDetails(name, normalized);
    return normalized;
}
// With proxy mode the client must point at the proxy, which reads the profile itself.
async function platformFilesMatch(profile) {
    const active = await readPlatformConnection(profilePlatform(profile)).catch(() => null);
    if (!active || active.apiKey !== profile.apiKey)
        return false;
    const proxyBaseUrl = resolveProxySwitchBaseUrl(await readProxyState(proxyOptions().stateRoot));
    return sameBaseUrl(active.baseURL, proxyBaseUrl ?? profile.baseURL);
}
function isCurrentProfile(profiles, name) {
    return currentProfileName(profiles, profilePlatform(profiles.profiles?.[name])) === name;
}
function profileUsageHint(profiles, name, entry, nowMs) {
    const used = profileLastUsedMs(entry);
    const parts = [
        profilePlatform(profiles.profiles?.[name]),
        ...(isCurrentProfile(profiles, name) ? ["current"] : []),
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
            console.log(`${isCurrentProfile(profiles, name) ? textGreen("*") : " "} ${colorName(name)}  ${textDim(profileUsageHint(profiles, name, usage[name], nowMs))}`);
        }
        console.log(textDim("run in an interactive terminal to switch."));
        return;
    }
    const lastActive = (name) => Math.max(profileLastUsedMs(usage[name]) ?? 0, usage[name]?.switched_at ? Date.parse(usage[name].switched_at) : 0);
    const previous = names
        .filter((name) => !isCurrentProfile(profiles, name))
        .sort((left, right) => lastActive(right) - lastActive(left))[0];
    const name = await select("Switch to which profile?", names.map((item) => ({
        value: item,
        label: item,
        hint: profileUsageHint(profiles, item, usage[item], nowMs),
        disabled: profiles.profiles[item].apiKey ? undefined : "missing apiKey",
    })), { default: previous });
    const platform = profilePlatform(profiles.profiles[name]);
    const label = PLATFORM_LABELS[platform];
    if (isCurrentProfile(profiles, name)) {
        // Selecting the current profile re-applies it when the client files no longer match it,
        // for example after `ccs sync` pulled a new key.
        if (await platformFilesMatch(assertProfile(profiles.profiles[name], name))) {
            console.log(textDim("no changes."));
        }
        else {
            await switchProfile(name);
            printKeyValue("current:", `${colorName(name)}  ${textDim(`${label} files re-applied`)}`);
        }
        return;
    }
    const previousName = currentProfileName(profiles, platform);
    await switchProfile(name);
    await recordProfileUsage(name, "switched_at");
    printKeyValue("current:", `${textDim(platform)} ${previousName ? `${textYellow(previousName)} -> ` : ""}${colorName(name)}`);
}
// One line per platform that has profiles; Codex always shows.
async function printStatus() {
    const profiles = await readProfiles();
    const usage = await readProfileUsage();
    for (const platform of PLATFORMS) {
        const name = currentProfileName(profiles, platform);
        if (platform !== "codex" && !name && profilesOf(profiles, platform).length === 0)
            continue;
        const profile = name ? profiles.profiles?.[name] : undefined;
        if (!name || !profile) {
            printKeyValue(`${platform}:`, textDim(name ? `${name} (missing)` : "none"), 11);
            continue;
        }
        const normalized = assertProfile(profile, name);
        const switchedAt = usage[name]?.switched_at;
        printKeyValue(`${platform}:`, [
            colorName(name),
            colorUrl(normalized.baseURL),
            formatApiKey(normalized.apiKey),
            ...(platform === "codex" && normalized.routeConversion?.enabled ? [formatRouteConversion(normalized)] : []),
            ...(switchedAt ? [textDim(`switched ${formatAgo(Date.parse(switchedAt))}`)] : []),
        ].join("  "), 11);
    }
    printKeyValue("host:", colorHost(formatSystemLabel()), 11);
    printKeyValue("files:", colorPath(formatDisplayPath(profilesPath())), 11);
}
async function printProfileList(profiles) {
    const entries = Object.entries(profiles.profiles ?? {});
    const usage = await readProfileUsage();
    const nowMs = Date.now();
    const rows = entries.map(([name, profile]) => ({
        name,
        profile,
        marker: isCurrentProfile(profiles, name) ? textGreen("*") : "",
        conversion: profilePlatform(profile) === "codex" ? formatRouteConversion(profile) : textDim("-"),
    }));
    const columns = [
        { key: "marker", title: "" },
        { key: "name", title: "" },
        { key: "platform", title: "" },
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
            platform: textDim(profilePlatform(row.profile)),
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
    const name = options.profile ?? currentProfileName(profiles, "codex") ?? "test001";
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
        "  ccs list | l                         # list profiles",
        "  ccs config                           # create or update profiles.json, config.toml, and AGENTS.md from the templates",
        "  ccs sync [user@host]                 # pull or push profiles.json with another device over ssh",
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
const CCS_COMMAND_SHORTCUTS = [
    { key: "v", label: "version" },
    { key: "m", label: "models" },
    { key: "u", label: "use" },
    { key: "l", label: "list" },
    { key: "c", label: "config" },
    { key: "s", label: "sync" },
    { key: "a", label: "add" },
    { key: "r", label: "remove" },
    { key: "t", label: "stats", at: 1 },
];
const CCS_NAMESPACE_SHORTCUTS = [
    { key: "p", label: "proxy" },
    { key: "h", label: "help" },
];
function printUsageHelp() {
    if (!isInteractive()) {
        printCommandFooter([
            {
                label: "commands:",
                commands: ["version", "PROFILE", "models", ...CCS_COMMAND_SHORTCUTS.slice(2).map((shortcut) => shortcut.label)],
            },
            {
                label: "namespaces:",
                commands: ["proxy", "--help"],
            },
        ]);
        return;
    }
    const separator = textDim(" | ");
    console.log(`${textDim("commands:  ")} ${[
        formatShortcut(CCS_COMMAND_SHORTCUTS[0]),
        textDim("PROFILE"),
        ...CCS_COMMAND_SHORTCUTS.slice(1).map(formatShortcut),
    ].join(separator)}`);
    console.log(`${textDim("namespaces:")} ${CCS_NAMESPACE_SHORTCUTS.map(formatShortcut).join(separator)}`);
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
        await runConfig(args);
        return;
    }
    if (command === "sync") {
        await runDeviceSync(args);
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
        const key = await readShortcutKey([...CCS_COMMAND_SHORTCUTS, ...CCS_NAMESPACE_SHORTCUTS]);
        const shortcut = [...CCS_COMMAND_SHORTCUTS, ...CCS_NAMESPACE_SHORTCUTS].find((entry) => entry.key === key);
        if (!shortcut)
            return;
        setUsageCommand("ccs", [shortcut.label], "shortcut");
        await runCcs([shortcut.label]);
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
