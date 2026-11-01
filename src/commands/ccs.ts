import { readFile, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTwoFilesPatch } from "diff";
import { confirmApply } from "../lib/confirm.js";
import { ensureDir, readTextIfExists, writeTextFile, writeTextFileAtomic } from "../lib/fs.js";
import { parseJsonObject, stringifyJson } from "../lib/json.js";
import {
  codexAgentsPath,
  codexAuthPath,
  codexConfigPath,
  codexDir,
  codexToolsConfigDir,
  profilesPath,
} from "../lib/paths.js";
import { assertProfile, parseProfiles, readProfiles, writeProfiles, type Profile, type ProfilesFile } from "../lib/profiles.js";
import { formatAgo, profileLastUsedMs, readProfileUsage, recordProfileUsage, type ProfileUsageEntry } from "../lib/profile-usage.js";
import { formatShortcut, input, isInteractive, multiSelect, readShortcutKey, select, type Choice, type Shortcut } from "../lib/prompt.js";
import {
  parseSyncTarget,
  readRemoteProfiles,
  readSyncHosts,
  recordSyncHost,
  syncTargetError,
  writeRemoteProfiles,
  type RemoteProfiles,
  type SyncDirection,
  type SyncHostEntry,
  type SyncTarget,
} from "../lib/remote-sync.js";
import { setUsageCommand } from "../lib/usage.js";
import {
  maskSecret,
  textBlue,
  textBold,
  textDim,
  textGreen,
  textRed,
  textYellow,
  truncateVisible,
} from "../lib/text.js";
import {
  colorHost,
  colorName,
  colorPath,
  colorUrl,
  printKeyValue,
} from "../lib/output.js";
import { runCcsStats } from "./ccs-stats.js";
import { ensureProxyRunning, proxyStateExists, resolveProxyOptions as proxyOptions, resolveProxySwitchBaseUrl, runProxyCommand } from "./ccs-proxy.js";
import {
  syncTomlTemplate,
  readTomlBaseUrl,
  tomlLeafDifferences,
  updateTomlBaseUrl,
  type TomlLeafDifference,
} from "../lib/toml.js";
import { printTable, type TableColumn } from "../lib/table.js";
import { formatCommandFooterLines, type CommandFooterRow } from "../lib/terminal.js";
import { isVersionArgument, printToolVersionIfRequested } from "../lib/version.js";

type PreviewFile = {
  label: string;
  path: string;
  current: string | null;
  next: string;
};

type ConfigFiles = {
  profiles: string | null;
  config: string | null;
  agents: string | null;
};

type ConfigTemplates = {
  profiles: ProfilesFile;
  config: string;
  agents: string;
};

type ProfilesPlan = {
  profiles: ProfilesFile;
  imported: string | null;
};

type ModelEntry = {
  id: string;
  ownedBy: string | null;
  created: number | null;
};

type ModelsOptions = {
  profile?: string;
  json: boolean;
};

const modelsHttpTimeoutMs = 5_000;
// Matches the proxy URL that `ccs proxy install` writes; it is never imported as a provider profile.
const localProxyUrlPattern = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

async function readDefaultProfiles(): Promise<ProfilesFile> {
  const path = fileURLToPath(new URL("../../config/ccs-profiles.json", import.meta.url));
  const content = await readFile(path, "utf-8");
  return parseJsonObject(content) as ProfilesFile;
}

async function readDefaultCodexConfig(): Promise<string> {
  const path = fileURLToPath(new URL("../../config/codex-config.toml", import.meta.url));
  return readFile(path, "utf-8");
}

async function readDefaultCodexAgents(): Promise<string> {
  const path = fileURLToPath(new URL("../../config/codex-agents.md", import.meta.url));
  return readFile(path, "utf-8");
}

async function readCurrentCodexProfile(): Promise<Profile> {
  const configText = (await readTextIfExists(codexConfigPath())) ?? "";
  const baseURL = readTomlBaseUrl(configText) ?? "";
  const authText = (await readTextIfExists(codexAuthPath())) ?? "";
  const authJson = authText ? parseJsonObject(authText) : {};
  const apiKey = typeof authJson.OPENAI_API_KEY === "string" ? authJson.OPENAI_API_KEY : "";

  return { baseURL, apiKey };
}

function formatBackupStamp(date: Date): string {
  const pad = (value: number, size = 2): string => value.toString().padStart(size, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

// Copies the current content of every existing preview target into one backup directory.
async function backupPreviewFiles(files: PreviewFile[], stamp: string): Promise<string | null> {
  const existing = files.filter((file) => file.current !== null);
  if (existing.length === 0) {
    return null;
  }
  const backupDir = join(codexToolsConfigDir(), "backups", `ccs-${stamp}`);
  await ensureDir(backupDir);
  for (const file of existing) {
    await writeTextFile(join(backupDir, basename(file.path)), file.current!, 0o600);
  }
  return backupDir;
}

async function writeVerified(file: PreviewFile): Promise<void> {
  if (file.path === profilesPath()) {
    await writeTextFileAtomic(file.path, file.next, 0o600);
  } else {
    await writeTextFile(file.path, file.next);
  }
  if ((await readTextIfExists(file.path)) !== file.next) {
    throw new Error(`write verification failed: ${file.path}`);
  }
}

async function readConfigFiles(): Promise<ConfigFiles> {
  return {
    profiles: await readTextIfExists(profilesPath()),
    config: await readTextIfExists(codexConfigPath()),
    agents: await readTextIfExists(codexAgentsPath()),
  };
}

async function readConfigTemplates(): Promise<ConfigTemplates> {
  return {
    profiles: await readDefaultProfiles(),
    config: await readDefaultCodexConfig(),
    agents: await readDefaultCodexAgents(),
  };
}

function sameBaseUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

// A new profiles.json starts from the template. A direct Codex provider URL and key become a profile:
// a template profile with the same URL and an empty key receives the key, otherwise `imported` is added.
function planProfilesFromTemplate(template: ProfilesFile, codex: Profile | null): ProfilesPlan {
  const profiles = { ...(template.profiles ?? {}) };
  if (!codex || !codex.baseURL || !codex.apiKey || localProxyUrlPattern.test(codex.baseURL)) {
    return { profiles: { ...template, profiles }, imported: null };
  }
  const match = Object.entries(profiles).find(([, profile]) => (
    sameBaseUrl(profile.baseURL, codex.baseURL) && (!profile.apiKey || profile.apiKey === codex.apiKey)
  ));
  let name = match?.[0];
  if (name) {
    profiles[name] = { ...profiles[name], apiKey: codex.apiKey };
  } else {
    name = "imported";
    for (let index = 1; profiles[name]; index += 1) name = `imported-${index}`;
    profiles[name] = codex;
  }
  return { profiles: { ...template, profiles, current: name }, imported: name };
}

function missingTemplateProfiles(existing: ProfilesFile, template: ProfilesFile): string[] {
  return Object.keys(template.profiles ?? {}).filter((name) => !existing.profiles?.[name]);
}

function missingConfigPaths(config: string, template: string): string[] {
  return syncTomlTemplate(template, config, new Set()).updatedPaths;
}

function isProviderBaseUrlPath(path: string): boolean {
  return /^model_providers\.[^.]+\.base_url$/.test(path);
}

function differingConfigValues(config: string, template: string): TomlLeafDifference[] {
  return tomlLeafDifferences(template, config).filter((difference) => !isProviderBaseUrlPath(difference.path));
}

function listPreview(items: string[], limit = 4): string {
  return items.length <= limit ? items.join(", ") : `${items.slice(0, limit).join(", ")}, +${items.length - limit} more`;
}

// Additive changes start checked; replacing an existing value or file starts unchecked.
function configChoices(
  files: ConfigFiles,
  templates: ConfigTemplates,
  codex: Profile | null,
  proxyInstalled: boolean,
): Choice<string>[] {
  const choices: Choice<string>[] = [];
  if (files.profiles === null) {
    const { imported } = planProfilesFromTemplate(templates.profiles, codex);
    choices.push({
      value: "profiles",
      label: "profiles.json  create",
      hint: imported ? `template profiles + current Codex provider as ${imported}` : "template profiles",
      checked: true,
    });
  } else {
    for (const name of missingTemplateProfiles(parseProfiles(files.profiles), templates.profiles)) {
      choices.push({
        value: `profile:${name}`,
        label: `profiles.json  add ${name}`,
        hint: templates.profiles.profiles![name].baseURL,
        checked: true,
      });
    }
  }
  if (files.config === null) {
    choices.push({ value: "config:create", label: "config.toml    create", hint: "from the template", checked: true });
  } else {
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
  } else if (files.agents !== templates.agents) {
    choices.push({ value: "agents", label: "AGENTS.md      replace", hint: "with the template; local edits are lost" });
  }
  return choices;
}

function planConfigWrites(
  selected: ReadonlySet<string>,
  files: ConfigFiles,
  templates: ConfigTemplates,
  codex: Profile | null,
): PreviewFile[] {
  const writes: PreviewFile[] = [];
  if (selected.has("profiles")) {
    const { profiles } = planProfilesFromTemplate(templates.profiles, codex);
    writes.push({ label: "profiles.json", path: profilesPath(), current: null, next: stringifyJson(profiles) });
  } else if (files.profiles !== null) {
    const existing = parseProfiles(files.profiles);
    const added = missingTemplateProfiles(existing, templates.profiles).filter((name) => selected.has(`profile:${name}`));
    if (added.length > 0) {
      const profiles = { ...existing.profiles };
      for (const name of added) profiles[name] = templates.profiles.profiles![name];
      writes.push({
        label: "profiles.json",
        path: profilesPath(),
        current: files.profiles,
        next: stringifyJson({ ...existing, profiles, current: existing.current ?? added[0] }),
      });
    }
  }
  if (selected.has("config:create")) {
    writes.push({ label: "config.toml", path: codexConfigPath(), current: null, next: templates.config });
  } else if (files.config !== null) {
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

function printConfigStatus(files: ConfigFiles, templates: ConfigTemplates): void {
  const missing = textYellow("missing");
  const profilesState = (): string => {
    if (files.profiles === null) return missing;
    const existing = parseProfiles(files.profiles);
    const absent = missingTemplateProfiles(existing, templates.profiles);
    const count = `${Object.keys(existing.profiles ?? {}).length} profiles`;
    return absent.length > 0 ? `${count} · ${textYellow(`template adds ${absent.join(", ")}`)}` : textDim(count);
  };
  const configState = (): string => {
    if (files.config === null) return missing;
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

function printConfigHelp(): void {
  console.log([
    textBold("Usage:"),
    "  ccs config        # create or update profiles.json, config.toml, and AGENTS.md from the templates",
  ].join("\n"));
}

async function runConfig(args: string[]): Promise<void> {
  if (isHelpArgument(args[0])) {
    assertExactArgs(args.slice(1), "config help", 0);
    printConfigHelp();
    return;
  }
  assertExactArgs(args, "config", 0);
  const files = await readConfigFiles();
  const templates = await readConfigTemplates();
  // The current Codex provider only matters when profiles.json is being created.
  const codex = files.profiles === null ? await readCurrentCodexProfile() : null;
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

type ProfilesComparison = {
  localOnly: string[];
  remoteOnly: string[];
  changed: string[];
  settings: string[];
};

// `current` is per device: each device keeps its own active profile.
function compareSyncedProfiles(local: ProfilesFile, remote: ProfilesFile): ProfilesComparison {
  const localProfiles = local.profiles ?? {};
  const remoteProfiles = remote.profiles ?? {};
  const settingKeys = new Set([...Object.keys(local), ...Object.keys(remote)].filter((key) => key !== "profiles" && key !== "current"));
  const field = (file: ProfilesFile, key: string): string => JSON.stringify((file as Record<string, unknown>)[key] ?? null);
  return {
    localOnly: Object.keys(localProfiles).filter((name) => !remoteProfiles[name]),
    remoteOnly: Object.keys(remoteProfiles).filter((name) => !localProfiles[name]),
    changed: Object.keys(localProfiles).filter((name) => (
      remoteProfiles[name] && JSON.stringify(localProfiles[name]) !== JSON.stringify(remoteProfiles[name])
    )),
    settings: [...settingKeys].filter((key) => field(local, key) !== field(remote, key)),
  };
}

function isInSync(comparison: ProfilesComparison): boolean {
  return comparison.localOnly.length + comparison.remoteOnly.length + comparison.changed.length + comparison.settings.length === 0;
}

// The source replaces the target file, except that the target keeps its own `current` when the source still has it.
function planSyncedProfiles(source: ProfilesFile, target: ProfilesFile | null): ProfilesFile {
  const keep = target?.current && source.profiles?.[target.current] ? target.current : source.current;
  return { ...source, ...(keep ? { current: keep } : {}) };
}

function formatSyncSide(label: string, text: string | null, profiles: ProfilesFile | null, mtime: Date | undefined): string {
  if (text === null) return `${label}  ${textYellow("missing")}`;
  const count = Object.keys(profiles?.profiles ?? {}).length;
  const when = mtime ? `  ${textDim(`modified ${formatAgo(mtime.getTime())}`)}` : "";
  return `${label}  ${textDim(`${count} profiles`)}  current ${colorName(profiles?.current ?? "-")}${when}`;
}

function printSyncComparison(
  target: SyncTarget,
  remote: RemoteProfiles,
  local: { text: string | null; profiles: ProfilesFile | null; mtime?: Date },
  remoteProfiles: ProfilesFile | null,
  comparison: ProfilesComparison,
): void {
  console.log(textBold(`ccs sync  ${colorHost(target.raw)}`));
  printKeyValue("local:", formatSyncSide(colorHost(formatSystemLabel()), local.text, local.profiles, local.mtime), 10);
  printKeyValue("remote:", formatSyncSide(colorHost(remote.host), remote.text, remoteProfiles, remote.mtime), 10);
  if (local.text === null || remote.text === null) return;
  const rows: Array<[string, string[]]> = [
    ["local only:", comparison.localOnly],
    ["remote only:", comparison.remoteOnly],
    ["differ:", comparison.changed],
    ["settings:", comparison.settings],
  ];
  for (const [label, names] of rows) {
    if (names.length > 0) printKeyValue(label, names.map(colorName).join(", "), 13);
  }
}

function syncHostHint(entry: SyncHostEntry, nowMs: number): string {
  const parts = [
    ...(entry.host ? [entry.host] : []),
    entry.synced_at ? `synced ${formatAgo(Date.parse(entry.synced_at), nowMs)} (${entry.direction ?? "?"})`
      : entry.connected_at ? `connected ${formatAgo(Date.parse(entry.connected_at), nowMs)}` : "never connected",
  ];
  return parts.join(" · ");
}

function sortedSyncHosts(hosts: Record<string, SyncHostEntry>): string[] {
  const time = (raw: string): number => Date.parse(hosts[raw].connected_at ?? "") || 0;
  return Object.keys(hosts).sort((left, right) => time(right) - time(left));
}

async function chooseSyncTarget(hosts: Record<string, SyncHostEntry>): Promise<SyncTarget> {
  const nowMs = Date.now();
  const known = sortedSyncHosts(hosts);
  const picked = known.length === 0 ? null : await select<string | null>("Sync with which device?", [
    ...known.map((raw) => ({ value: raw, label: raw, hint: syncHostHint(hosts[raw], nowMs) })),
    { value: null, label: "+ new device", hint: "user@host[:port] or an ssh config alias" },
  ]);
  const raw = picked ?? await input("Device (user@host[:port] or ssh alias)", { validate: (value) => syncTargetError(value) });
  return parseSyncTarget(raw);
}

function printSyncHelp(): void {
  console.log([
    textBold("Usage:"),
    "  ccs sync              # choose a remembered device or enter user@host, then pull or push profiles.json",
    "  ccs sync user@host    # sync with this device; user@host:port and ssh config aliases also work",
  ].join("\n"));
}

async function runDeviceSync(args: string[]): Promise<void> {
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
  const direction = await select<SyncDirection>("Direction", [
    { value: "pull", label: "pull", hint: `replace local profiles.json with ${remote.host}'s`, disabled: remoteProfiles ? undefined : "remote missing" },
    { value: "push", label: "push", hint: `replace ${remote.host}'s profiles.json with local`, disabled: localProfiles ? undefined : "local missing" },
  ], { default: !localProfiles || (remoteProfiles && remoteNewer) ? "pull" : "push" });

  const source = direction === "pull" ? remoteProfiles! : localProfiles!;
  const targetProfiles = direction === "pull" ? localProfiles : remoteProfiles;
  const next = planSyncedProfiles(source, targetProfiles);
  const nextText = stringifyJson(next);
  const preview: PreviewFile = {
    label: "profiles.json",
    path: direction === "pull" ? profilesPath() : `${target.raw}:~/.config/codex-tools/profiles.json`,
    current: direction === "pull" ? localText : remote.text,
    next: nextText,
  };
  const currentName = targetProfiles?.current;
  const currentChanged = Boolean(currentName && targetProfiles?.profiles?.[currentName]
    && JSON.stringify(targetProfiles.profiles[currentName]) !== JSON.stringify(next.profiles?.[next.current ?? ""]));
  const currentDropped = Boolean(currentName && next.current !== currentName);
  // After a pull, the local Codex files follow the current profile when its URL or key changed.
  const refresh = direction === "pull" && (currentChanged || currentDropped)
    && Boolean(next.current && next.profiles?.[next.current]?.apiKey);

  console.log(textBold(`ccs sync ${direction}`));
  printDiffBlock(preview);
  if (currentDropped) {
    console.log(`${textYellow("warning:")} current ${currentName} is not in the incoming file; current becomes ${next.current ?? "none"}`);
  }
  if (refresh) {
    console.log(textDim(`~/.codex/config.toml and auth.json will switch to ${next.current} as ccs use does.`));
  } else if (direction === "push" && (currentChanged || currentDropped)) {
    console.log(`${textYellow("note:")} run ccs use on ${remote.host} so its Codex files follow the new current profile`);
  }
  console.log(textDim("no changes are written unless you type yes at the prompt."));
  if (!(await confirmApply())) {
    return;
  }

  const stamp = formatBackupStamp(new Date());
  let backup: string | null;
  if (direction === "pull") {
    if ((await readTextIfExists(profilesPath())) !== localText) {
      throw new Error("local profiles.json changed after preview; run ccs sync again");
    }
    backup = await backupPreviewFiles([preview], stamp);
    await writeVerified(preview);
    if (refresh) {
      await switchProfile(next.current!);
    }
  } else {
    backup = (await writeRemoteProfiles(target, nextText, remote.checksum, stamp)).backup;
  }
  await recordSyncHost(target.raw, { synced_at: new Date().toISOString(), direction });
  if (backup) {
    console.log(`backup: ${textBlue(direction === "pull" ? formatDisplayPath(backup) : `${remote.host}:${backup}`)}`);
  }
  console.log(`${direction === "pull" ? "pulled" : "pushed"}: ${textGreen(direction === "pull" ? formatDisplayPath(profilesPath()) : `${target.raw}`)}`);
}

function assertMaxArgs(argv: string[], command: string, count: number): void {
  if (argv.length > count) {
    throw new Error(`usage: ccs ${command}`);
  }
}

function assertExactArgs(argv: string[], command: string, count: number): void {
  if (argv.length !== count) {
    throw new Error(`usage: ccs ${command}`);
  }
}

function printPreviewSummary(title: string, files: PreviewFile[]): void {
  console.log(textBold(title));
  const backups = files.filter((file) => file.current !== null);
  if (backups.length > 0) {
    console.log(`backup: ${textBlue(backups.map((file) => file.label).join(", "))}`);
  }
  console.log(`files: ${textGreen(files.map((file) => file.label).join(", "))}`);
  console.log(textDim("no changes are written unless you type yes at the prompt."));
}

function printDiffBlock(file: PreviewFile): void {
  const currentNormalized = normalizePreviewContent(file.label, file.current ?? "");
  const nextNormalized = normalizePreviewContent(file.label, file.next);
  const patch = createTwoFilesPatch(
    `a/${file.label}`,
    `b/${file.label}`,
    currentNormalized,
    nextNormalized,
    "",
    "",
    { context: 3 },
  );

  console.log();
  console.log(textBold(file.label));
  console.log(textDim(file.path));
  console.log(textDim(patch.trimEnd()));
}

function redactPreviewSecrets(content: string): string {
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

function maskSecretValue(value: string): string {
  if (!value) {
    return value;
  }
  return maskSecret(value);
}

function normalizePreviewContent(label: string, content: string): string {
  const redacted = redactPreviewSecrets(content);
  if (label.endsWith(".json")) {
    return normalizeJsonPreview(redacted);
  }
  if (label.endsWith(".toml")) {
    return normalizeTomlPreview(redacted);
  }
  return redacted;
}

function normalizeJsonPreview(content: string): string {
  if (!content.trim()) {
    return "";
  }
  try {
    return `${stringifyJson(parseJsonObject(content))}\n`;
  } catch {
    return content;
  }
}

function normalizeTomlPreview(content: string): string {
  if (!content.trim()) {
    return "";
  }

  const lines = content.split("\n");
  const normalized: string[] = [];
  let currentComment: string | null = null;

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
      } else {
        currentComment = null;
        continue;
      }
    }

    normalized.push(stripTomlInlineComment(line));
  }

  return normalized.join("\n");
}

function stripTomlInlineComment(line: string): string {
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

function printWarnings(warnings: string[]): void {
  if (warnings.length === 0) {
    return;
  }
  console.log();
  for (const warning of warnings) {
    console.log(`${textYellow("warning:")} ${warning}`);
  }
}

async function addProfile(): Promise<void> {
  if (!isInteractive()) {
    throw new Error("ccs add requires an interactive terminal");
  }
  const data = await readProfiles();
  const profiles = data.profiles ?? {};
  const target = await select<string | null>("Add or edit which profile?", [
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
  const conversion = await select<boolean>("Provider API", [
    { value: false, label: "Responses", hint: "send Codex Responses traffic unchanged" },
    { value: true, label: "Chat Completions only", hint: "convert Responses traffic to Chat Completions" },
  ], { default: existing?.routeConversion?.enabled ?? false });

  const profile: Profile = { baseURL, apiKey };
  if (conversion) profile.routeConversion = { enabled: true };
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

function printProfile(name: string, profiles: ProfilesFile): void {
  const profile = profiles.profiles?.[name];
  if (!profile) {
    throw new Error(`profile not found: ${name}`);
  }
  const normalized = assertProfile(profile, name);
  printProfileSummary("profile", name, normalized);
  printKeyValue("conversion:", formatRouteConversion(normalized));
}

function printProfileDetails(name: string, profile: Profile): void {
  printProfileSummary("profile", name, profile);
  printKeyValue("conversion:", formatRouteConversion(profile));
}

async function resolveRunRoute(profileBaseUrl: string): Promise<{ baseURL: string; proxy: boolean }> {
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

async function resolveActiveBaseUrl(profileBaseUrl: string): Promise<string> {
  return (await resolveRunRoute(profileBaseUrl)).baseURL;
}

function formatApiKey(apiKey: string): string {
  return apiKey ? textDim(maskSecret(apiKey)) : textDim("(empty)");
}

function formatSystemLabel(): string {
  const username = process.env.USER || process.env.LOGNAME || userInfo().username || "unknown";
  const host = (process.env.HOSTNAME || hostname() || "unknown").split(".")[0] || "unknown";
  return `${username}@${host}`;
}

function formatDisplayPath(path: string): string {
  const home = process.env.HOME;
  if (!home) {
    return path;
  }
  if (path === home) {
    return "~";
  }
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function printProfileSummary(label: string, name: string, profile: Profile): void {
  printKeyValue(`${label}:`, `${colorName(name)}  ${colorUrl(profile.baseURL)}  ${formatApiKey(profile.apiKey)}`);
}

function formatRouteConversion(profile: Profile): string {
  return profile.routeConversion?.enabled ? textGreen("responses→chat") : textDim("off");
}

async function removeProfile(): Promise<void> {
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
    hint: `${data.profiles![item].baseURL}${item === data.current ? "  (current)" : ""}`,
  })), { default: data.current });
  const remaining = names.filter((item) => item !== name);
  const current = data.current === name ? remaining[0] : data.current;
  printProfileSummary("remove", name, assertProfile(data.profiles![name], name));
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

async function switchProfile(name: string): Promise<Profile> {
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

// With proxy mode the provider URL points at the proxy, which reads the profile itself; only the key is compared.
async function codexFilesMatch(profile: Profile): Promise<boolean> {
  const codex = await readCurrentCodexProfile().catch(() => null);
  if (!codex || codex.apiKey !== profile.apiKey) return false;
  return (await proxyStateExists()) || sameBaseUrl(codex.baseURL, profile.baseURL);
}

function profileUsageHint(name: string, current: string | undefined, entry: ProfileUsageEntry | undefined, nowMs: number): string {
  const used = profileLastUsedMs(entry);
  const parts = [
    ...(name === current ? ["current"] : []),
    used === null ? "never used" : `used ${formatAgo(used, nowMs)}`,
    ...(entry?.switched_at ? [`switched ${formatAgo(Date.parse(entry.switched_at), nowMs)}`] : []),
  ];
  return parts.join(" · ");
}

async function useProfile(profiles: ProfilesFile): Promise<void> {
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
  const lastActive = (name: string): number => Math.max(
    profileLastUsedMs(usage[name]) ?? 0,
    usage[name]?.switched_at ? Date.parse(usage[name].switched_at!) : 0,
  );
  const previous = names
    .filter((name) => name !== profiles.current)
    .sort((left, right) => lastActive(right) - lastActive(left))[0];
  const name = await select("Switch to which profile?", names.map((item) => ({
    value: item,
    label: item,
    hint: profileUsageHint(item, profiles.current, usage[item], nowMs),
    disabled: profiles.profiles![item].apiKey ? undefined : "missing apiKey",
  })), { default: previous ?? profiles.current });
  if (name === profiles.current) {
    // Selecting the current profile re-applies it when the Codex files no longer match it,
    // for example after `ccs sync` pulled a new key.
    if (await codexFilesMatch(assertProfile(profiles.profiles![name], name))) {
      console.log(textDim("no changes."));
    } else {
      await switchProfile(name);
      printKeyValue("current:", `${colorName(name)}  ${textDim("Codex files re-applied")}`);
    }
    return;
  }
  const previousName = profiles.current;
  await switchProfile(name);
  await recordProfileUsage(name, "switched_at");
  printKeyValue("current:", `${previousName ? `${textYellow(previousName)} -> ` : ""}${colorName(name)}`);
}

async function printStatus(): Promise<Profile | null> {
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

async function printProfileList(profiles: ProfilesFile): Promise<void> {
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

  const columns: TableColumn[] = [
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

function buildModelsUrl(baseURL: string): string | null {
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
  } catch {
    return null;
  }
}

function parseModelsResponse(value: unknown): ModelEntry[] | null {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (!Array.isArray(root.data)) {
    return null;
  }

  const models: ModelEntry[] = [];
  for (const item of root.data) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
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

async function fetchModels(name: string, profile: Profile): Promise<{ url: string; models: ModelEntry[] }> {
  if (!profile.apiKey) {
    throw new Error(`profile ${name} has no apiKey`);
  }
  const url = buildModelsUrl(profile.baseURL);
  if (!url) {
    throw new Error(`profile ${name} has an invalid baseURL: ${profile.baseURL || "(empty)"}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), modelsHttpTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${profile.apiKey}` },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`GET ${url} timed out after ${modelsHttpTimeoutMs / 1000}s`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GET ${url} failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`GET ${url} returned invalid JSON`);
  }

  const models = parseModelsResponse(payload);
  if (!models) {
    throw new Error(`GET ${url} returned an invalid model list`);
  }
  return { url, models };
}

function formatModelCreated(value: number | null): string {
  if (value === null) {
    return "-";
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString().slice(0, 10);
}

function parseModelsArgs(args: string[]): ModelsOptions {
  let profile: string | undefined;
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

async function printModels(profiles: ProfilesFile, args: string[]): Promise<void> {
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

  const columns: TableColumn[] = [
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

function printModelsHelp(): void {
  console.log([
    textBold("Usage:"),
    "  ccs models                 # list models for the current profile",
    "  ccs models PROFILE         # list models for one profile",
    "  ccs models PROFILE --json  # print the model list as JSON",
  ].join("\n"));
}

function usageLines(): string[] {
  return [
    "  ccs                                  # show current profile",
    "  ccs version                          # print package version",
    "  ccs -v                               # print package version",
    "  ccs PROFILE                          # show profile details",
    "  ccs models [PROFILE] [--json]        # list models from the profile v1/models endpoint",
    "  ccs proxy [--view overview|tokens|cost] # show proxy status with the selected request view",
    "  ccs proxy [watch|reroute|cancel|capture|mode|search|compact|claude|config|install|restart|restore|serve] # manage proxy state and runtime",
    "  ccs use                              # choose the current profile; shows last use and switch times",
    "  ccs list | l                         # list profiles",
    "  ccs config                           # create or update profiles.json, config.toml, and AGENTS.md from the templates",
    "  ccs sync [user@host]                 # pull or push profiles.json with another device over ssh",
    "  ccs add                              # choose a profile to edit or create, then enter its values",
    "  ccs remove                           # choose a profile to remove",
    "  ccs stats                            # summarize local command and prompt usage",
  ];
}

function printHelp(): void {
  console.log([
    textBold("Usage:"),
    ...usageLines(),
  ].join("\n"));
}

function isHelpArgument(value: string | undefined): boolean {
  return value === "help" || value === "--help" || value === "-h";
}

function printCommandFooter(rows: CommandFooterRow[]): void {
  console.log(formatCommandFooterLines(rows).map(textDim).join("\n"));
}

const CCS_COMMAND_SHORTCUTS: Shortcut[] = [
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
const CCS_NAMESPACE_SHORTCUTS: Shortcut[] = [
  { key: "p", label: "proxy" },
  { key: "h", label: "help" },
];

function printUsageHelp(): void {
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

export async function runCcs(argv: string[]): Promise<void> {
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
    if (!shortcut) return;
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
