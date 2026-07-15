import { createTwoFilesPatch } from "diff";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { readTextIfExists, writeTextFile } from "../lib/fs.js";
import { printKeyValue } from "../lib/output.js";
import { clvmConfigPath, codexToolsConfigDir, formatHomePath } from "../lib/paths.js";
import { createLiveViewController } from "../lib/live-view.js";
import { createTextStyle, type TextStyle } from "../lib/style.js";
import { maskSecret, textBlue, textBold, textDim, textGreen, textRed } from "../lib/text.js";
import { fitCommandsLine as fitTerminalCommandsLine, terminalColumns } from "../lib/terminal.js";
import { printToolVersionIfRequested } from "../lib/version.js";
import { ClashApi } from "./clvm/api.js";
import {
  buildRuntimeConfig,
  domainMatches,
  formatDuration,
  formatSeconds,
  mergeClvmConfig,
  nextAlignedDelay,
  normalizeDomains,
  parseCloseZeroForSeconds,
  parseClvmConfig,
  parseDuration,
  parseNonNegativeNumber,
  parseRawArchiveMode,
  requireResolvedClvmConfig,
} from "./clvm/config.js";
import {
  buildMonitorFailure,
  buildRetryState,
  clvmHistoryPath,
  clvmRawDir,
  clvmStatePath,
  nextClvmRetryInterval,
  recordClvmFailure,
  recordClvmSample,
  recordClosedConnections,
} from "./clvm/records.js";
import {
  formatSpeed,
  formatUnavailableStatus,
  printMonitorFailure,
  printMonitorResult,
  renderMonitorFailureLines,
  renderMonitorResultLines,
} from "./clvm/render.js";
import { closeExpiredConnections, ConnectionSampler, sampleConnections } from "./clvm/sampler.js";
import type {
  ClosedConnectionEntry,
  ClvmConfig,
  ClvmConfigFile,
  ClvmRuntimeRecordDedupe,
  CommandName,
  CommandOptions,
  ParsedCommand,
  RuntimeConfig,
} from "./clvm/types.js";

export {
  buildRuntimeConfig,
  closeExpiredConnections,
  ConnectionSampler,
  domainMatches,
  mergeClvmConfig,
  nextAlignedDelay,
  nextClvmRetryInterval,
  normalizeDomains,
  parseClvmConfig,
  parseDuration,
  renderMonitorFailureLines,
  renderMonitorResultLines,
};

const commandsLine = "commands: clvm | clvm version | clvm -v | clvm monitor | clvm config | clvm setup --domain DOMAIN | clvm sync | clvm help";
const compactCommandsLine = "commands: clvm | version|-v | monitor | config | setup | sync | help";

function clvmTemplatePath(): string {
  return fileURLToPath(new URL("../../config/clvm.json", import.meta.url));
}

export async function runClvm(argv: string[]): Promise<void> {
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

function parseArgs(argv: string[]): ParsedCommand {
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

function parseRunOptions(argv: string[], command: string): CommandOptions {
  const options: CommandOptions = {};
  const domains: string[] = [];

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
    if (arg === "--raw-archive") {
      options.rawArchive = parseRawArchiveMode(requireValue(argv, index));
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

function parseConfigOptions(argv: string[]): CommandOptions {
  if (argv.length === 0) {
    return {};
  }
  if (argv.length === 1 && isHelpArg(argv[0])) {
    printHelp();
    process.exit(0);
  }
  throw new Error(`unknown argument for clvm config: ${argv[0]}`);
}

function parseSetupOptions(argv: string[]): CommandOptions {
  if (argv.length === 1 && isHelpArg(argv[0])) {
    printSetupHelp();
    process.exit(0);
  }

  const options = parseRunOptions(argv, "setup");
  if (options.json !== undefined || options.clear !== undefined || options.color !== undefined || options.once !== undefined) {
    throw new Error("clvm setup accepts config flags only");
  }
  if (
    options.baseUrl === undefined &&
    options.secret === undefined &&
    options.domains === undefined &&
    options.interval === undefined &&
    options.zeroSpeedThreshold === undefined &&
    options.closeZeroForSeconds === undefined &&
    options.rawArchive === undefined
  ) {
    throw new Error("clvm setup requires at least one config flag; run clvm config to view current config");
  }

  return options;
}

function parseSyncOptions(argv: string[]): CommandOptions {
  if (argv.length === 0) {
    return {};
  }
  if (argv.length === 1 && isHelpArg(argv[0])) {
    printSyncHelp();
    process.exit(0);
  }
  throw new Error(`unknown argument for clvm sync: ${argv[0]}`);
}

function isHelpArg(arg: string | undefined): boolean {
  return arg === "help" || arg === "--help" || arg === "-h";
}

function assertExactArgs(args: string[], command: string, expected: number): void {
  if (args.length !== expected) {
    throw new Error(`${command} accepts ${expected} argument${expected === 1 ? "" : "s"}`);
  }
}

function requireValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${argv[index]} requires a value`);
  }
  return value;
}

function printHelp(): void {
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
    "  --raw-archive on|off                      # write bounded raw /connections archives",
    "  --json                                    # print JSON samples",
    "  --no-clear                                # append samples in monitor mode",
    "  --no-color                                # disable clvm output colors",
    "  --once                                    # poll once when used with monitor",
  ].join("\n"));
}

function printSetupHelp(): void {
  console.log([
    "Usage:",
    "  clvm setup --domain DOMAIN                # preview, confirm, back up, and write clvm.json",
    "  clvm setup --base-url URL --secret SECRET # preview, confirm, back up, and update API config",
    "  clvm setup --interval 1s                  # preview, confirm, back up, and update monitor interval",
    "  clvm setup --close-zero-for-seconds off   # preview, confirm, back up, and disable automatic close",
    "  clvm setup --raw-archive on               # preview, confirm, back up, and enable raw archives",
  ].join("\n"));
}

function printSyncHelp(): void {
  console.log([
    "Usage:",
    "  clvm sync                                 # preview, confirm, back up, and sync config/clvm.json to ~/.config/codex-tools/clvm.json",
    "  clvm sync help                            # show this help",
  ].join("\n"));
}

async function runSetup(options: CommandOptions): Promise<void> {
  const configPath = clvmConfigPath();
  const existingText = await readTextIfExists(configPath);
  const currentText = existingText ?? "";
  const currentConfig = await loadActiveClvmConfig();
  const nextConfig = buildSetupConfig(currentConfig, options);
  const nextText = renderConfigJson(nextConfig);

  printSetupPlan(
    configPath,
    currentText,
    nextText,
    existingText !== null,
    buildRuntimeConfig(nextConfig, {}, {
      autoCloseEnabled: false,
      clear: false,
      once: true,
    }),
  );

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

async function runSync(): Promise<void> {
  const configPath = clvmConfigPath();
  const templatePath = clvmTemplatePath();
  const existingText = await readTextIfExists(configPath);
  const currentText = existingText ?? "";
  const templateConfig = await readClvmTemplateConfig();
  const localConfig = await readClvmConfig();
  const nextConfig = mergeClvmConfig(templateConfig, localConfig);
  const nextText = renderConfigJson(nextConfig);

  printSyncPlan(
    templatePath,
    configPath,
    currentText,
    nextText,
    existingText !== null,
    buildRuntimeConfig(nextConfig, {}, { autoCloseEnabled: false, clear: false, once: true }),
  );

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

function buildSetupConfig(current: ClvmConfig, options: CommandOptions): ClvmConfig {
  return mergeClvmConfig(current, {
    baseUrl: options.baseUrl,
    secret: options.secret,
    domains: options.domains !== undefined ? normalizeDomains(options.domains) : undefined,
    interval: options.interval,
    zeroSpeedThreshold: options.zeroSpeedThreshold,
    closeZeroForSeconds: options.closeZeroForSeconds,
    rawArchive: options.rawArchive,
  });
}

function printSetupPlan(
  configPath: string,
  currentText: string,
  nextText: string,
  currentExists: boolean,
  runtimeConfig: RuntimeConfig,
): void {
  printWritePlanSummary("clvm setup", configPath, currentText, nextText, currentExists);
  printKeyValue("target:", `${textBlue("would update")} ${textBlue(configPath)}`, 12);
  printConfigValues(runtimeConfig);
  printConfigDiff(configPath, currentText, nextText);
}

function printSyncPlan(
  sourcePath: string,
  configPath: string,
  currentText: string,
  nextText: string,
  currentExists: boolean,
  runtimeConfig: RuntimeConfig,
): void {
  printWritePlanSummary("clvm sync", configPath, currentText, nextText, currentExists);
  printKeyValue("source:", textBlue(sourcePath), 12);
  const targetLabel = currentText === nextText ? textDim("already synced") : textBlue("would update");
  printKeyValue("target:", `${targetLabel} ${textBlue(configPath)}`, 12);
  printConfigValues(runtimeConfig);
  printConfigDiff(configPath, currentText, nextText);
}

function printWritePlanSummary(title: string, configPath: string, currentText: string, nextText: string, currentExists: boolean): void {
  const changed = currentText !== nextText;
  const label = basename(configPath);
  console.log(textBold(`Plan: ${title}`));
  console.log(textDim("no changes are written unless you type yes at the prompt."));
  console.log(`Will modify: ${textBlue(changed ? label : "(none)")}`);
  console.log(`Will back up: ${textBlue(changed && currentExists ? label : "(none)")}`);
  console.log(`Warnings: ${textDim("0")}`);
}

export async function backupClvmConfig(configPath: string): Promise<string | null> {
  const currentText = await readTextIfExists(configPath);
  if (currentText === null) {
    return null;
  }

  const backupDir = join(codexToolsConfigDir(), "backups", `clvm-${formatTimestamp(new Date())}`);
  await writeTextFile(join(backupDir, basename(configPath)), currentText, 0o600);
  return backupDir;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
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

function printConfigStatus(runtimeConfig: RuntimeConfig, { includeCommands }: { includeCommands: boolean }): void {
  const style = createTextStyle(runtimeConfig.color);
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

function printConfigValues(config: RuntimeConfig, style = createTextStyle(config.color)): void {
  printKeyValue("base URL:", style.cyan(config.baseUrl), 12);
  printKeyValue("secret:", config.secret ? style.green(maskSecret(config.secret)) : style.dim("empty"), 12);
  printKeyValue("domains:", config.domains.length > 0 ? config.domains.join(",") : style.yellow("missing"), 12);
  printKeyValue("interval:", formatDuration(config.intervalMs), 12);
  printKeyValue("zero speed:", formatSpeed(config.zeroSpeedThreshold), 12);
  printKeyValue("auto close:", config.closeZeroForSeconds === null ? style.dim("off") : style.red(`${formatSeconds(config.closeZeroForSeconds)}`), 12);
  printKeyValue("raw archive:", config.rawArchive ? style.yellow("on") : style.dim("off"), 12);
}

function printCommands(style: TextStyle): void {
  console.log(style.dim(fitTerminalCommandsLine(commandsLine, compactCommandsLine, terminalColumns(process.stdout))));
}

function printConfigDiff(configPath: string, currentText: string, nextText: string): void {
  if (currentText === nextText) {
    return;
  }

  const label = basename(configPath);
  const patch = createTwoFilesPatch(
    `current/${label}`,
    `next/${label}`,
    redactConfigText(currentText),
    redactConfigText(nextText),
    "",
    "",
    { context: 3 },
  );

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

function redactConfigText(text: string): string {
  return text.replace(/("secret"\s*:\s*)"((?:\\.|[^"\\])*)"/gu, (match, prefix: string, raw: string) => {
    try {
      const value = JSON.parse(`"${raw}"`) as string;
      return `${prefix}${JSON.stringify(maskSecret(value))}`;
    } catch {
      return match;
    }
  });
}

async function runStatus(config: RuntimeConfig): Promise<void> {
  const style = createTextStyle(config.color);
  if (config.json) {
    if (config.domains.length === 0) {
      throw new Error("domains are required for JSON status; run clvm setup --domain DOMAIN or use --domain DOMAIN");
    }
    try {
      printMonitorResult(await sampleOnce(config), config);
    } catch (error) {
      const failure = buildMonitorFailure(error, undefined, config.rawArchive);
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
  } catch (error) {
    const failure = buildMonitorFailure(error, undefined, config.rawArchive);
    await recordClvmFailure("status", config, failure);
    printKeyValue("status:", formatUnavailableStatus(failure, style), 12);
  }
  printCommands(style);
}

async function runMonitor(config: RuntimeConfig): Promise<void> {
  if (config.domains.length === 0) {
    throw new Error(`domains are required; run clvm setup --domain DOMAIN or use --domain DOMAIN`);
  }

  const api = new ClashApi({
    baseUrl: config.baseUrl,
    secret: config.secret,
  });
  const sampler = new ConnectionSampler();
  const closedIds = new Set<string>();
  const closedHistory: ClosedConnectionEntry[] = [];
  let closedTotal = 0;
  let stopped = false;
  let historyVisible = true;
  let retryAttempt = 0;
  let stopDelay: (() => void) | null = null;
  let renderLatestFrame: (() => void) | null = null;
  const runtimeDedupe: ClvmRuntimeRecordDedupe = { lastFingerprint: null };
  const liveView = createLiveViewController({
    enabled: config.clear && Boolean(process.stdout.isTTY),
    pinFooter: true,
    onStop: () => {
      stopped = true;
      stopDelay?.();
    },
    onKey: (key, controls) => {
      if (key === "q") {
        controls.stop();
      } else if (key === "t") {
        historyVisible = !historyVisible;
        controls.render();
      }
    },
  });
  liveView.setResizeRender(() => {
    renderLatestFrame?.();
  });
  liveView.start();

  const wait = async (milliseconds: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, milliseconds);
      stopDelay = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    stopDelay = null;
  };

  try {
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
        await recordClvmSample("monitor", config, result, payload.raw, runtimeDedupe);
        if (liveView.enabled) {
          renderLatestFrame = () => liveView.writeFrame(renderMonitorResultLines(result, config, { historyVisible, interactive: true }));
          renderLatestFrame();
        } else {
          printMonitorResult(result, config);
        }
        retryAttempt = 0;

        if (config.once) {
          break;
        }

        await wait(nextAlignedDelay(config.intervalMs));
      } catch (error) {
        retryAttempt += 1;
        const retryIntervalMs = nextClvmRetryInterval(config.intervalMs, retryAttempt);
        const failure = buildMonitorFailure(error, buildRetryState(retryAttempt, retryIntervalMs), config.rawArchive);
        await recordClvmFailure("monitor", config, failure, runtimeDedupe);
        if (liveView.enabled) {
          renderLatestFrame = () => liveView.writeFrame(renderMonitorFailureLines(failure, config, { historyVisible, interactive: true }));
          renderLatestFrame();
        } else {
          printMonitorFailure(failure, config);
        }

        if (config.once) {
          break;
        }

        await wait(retryIntervalMs);
      }
    }
  } finally {
    liveView.stop();
  }
}

async function sampleOnce(config: RuntimeConfig) {
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

async function readClvmConfig(): Promise<ClvmConfigFile> {
  const path = clvmConfigPath();
  const text = await readTextIfExists(path);
  if (text === null) {
    return {};
  }
  return parseClvmConfig(text, path);
}

async function readClvmTemplateConfig(): Promise<ClvmConfig> {
  const path = clvmTemplatePath();
  const text = await readTextIfExists(path);
  if (text === null) {
    throw new Error(`default clvm config template not found: ${path}`);
  }

  return requireResolvedClvmConfig(parseClvmConfig(text, path), path);
}

async function loadActiveClvmConfig(): Promise<ClvmConfig> {
  const templateConfig = await readClvmTemplateConfig();
  const localConfig = await readClvmConfig();

  return mergeClvmConfig(templateConfig, localConfig);
}

function renderConfigJson(config: ClvmConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
