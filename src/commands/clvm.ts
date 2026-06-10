import { createTwoFilesPatch } from "diff";
import { basename } from "node:path";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { readTextIfExists, writeTextFile } from "../lib/fs.js";
import { printKeyValue } from "../lib/output.js";
import { clvmConfigPath } from "../lib/paths.js";
import {
  maskSecret,
  textBlue,
  textBold,
  textCyan,
  textDim,
  textGreen,
  textMagenta,
  textRed,
  textYellow,
} from "../lib/text.js";

const domainFields = [
  "host",
  "destinationHost",
  "sniffHost",
  "sni",
  "domain",
] as const;

const durationUnits = new Map([
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
]);

const closedHistoryLimit = 5;
const defaultBaseUrl = "http://127.0.0.1:9090";
const defaultInterval = "1s";
const setupFields = new Set([
  "baseUrl",
  "secret",
  "domains",
  "interval",
  "zeroSpeedThreshold",
  "closeZeroForSeconds",
]);

type CommandName = "status" | "monitor" | "config" | "setup" | "help";

type ClvmConfigFile = {
  baseUrl?: string;
  secret?: string;
  domains?: string[];
  interval?: string;
  zeroSpeedThreshold?: number;
  closeZeroForSeconds?: number | null;
};

type CommandOptions = {
  baseUrl?: string;
  secret?: string;
  domains?: string[];
  interval?: string;
  zeroSpeedThreshold?: number;
  closeZeroForSeconds?: number | null;
  json?: boolean;
  clear?: boolean;
  color?: boolean;
  once?: boolean;
};

type ParsedCommand = {
  command: CommandName;
  options: CommandOptions;
};

type RuntimeConfig = {
  baseUrl: string;
  secret: string;
  domains: string[];
  interval: string;
  intervalMs: number;
  zeroSpeedThreshold: number;
  closeZeroForSeconds: number | null;
  closeZeroForMs: number | null;
  autoCloseEnabled: boolean;
  once: boolean;
  json: boolean;
  clear: boolean;
  color: boolean;
};

type ConnectionState = {
  startMs: number;
  lastSeenMs: number;
  uploadTotal: number;
  downloadTotal: number;
  uploadBytesPerSecond: number | null;
  downloadBytesPerSecond: number | null;
  totalBytesPerSecond: number | null;
  zeroSpeedThreshold: number;
  isIdle: boolean;
  idleSinceMs: number | null;
  observedIdleMs: number;
};

type SpeedSample = {
  uploadBytesPerSecond: number | null;
  downloadBytesPerSecond: number | null;
  totalBytesPerSecond: number | null;
  coversPreviousInterval: boolean;
};

type DomainMatch = {
  domain: string;
  candidate: string;
};

type ConnectionEntry = {
  id: string;
  endpoint: string;
  process: string;
  rule: string;
  chains: string[];
  matchedDomain: string;
  matchedValue: string;
  ageMs: number;
  observedIdleMs: number;
  uploadTotal: number;
  downloadTotal: number;
  uploadBytesPerSecond: number | null;
  downloadBytesPerSecond: number | null;
  totalBytesPerSecond: number | null;
  isIdle: boolean;
  status: "unknown" | "active" | "zero";
};

type ClosedConnectionEntry = ConnectionEntry & {
  closedAt: string;
};

type MonitorResult = {
  timestamp: string;
  totalConnections: number;
  matchedConnections: ConnectionEntry[];
  closedConnections?: ConnectionEntry[];
  closedHistory?: ClosedConnectionEntry[];
  closedTotal?: number;
};

type Layout = {
  status: number;
  endpoint: number;
  age: number;
  zeroFor: number;
  up: number;
  down: number;
  upload: number;
  download: number;
  chain: number;
  rule: number;
};

type Style = {
  bold: (value: string) => string;
  blue: (value: string) => string;
  cyan: (value: string) => string;
  dim: (value: string) => string;
  green: (value: string) => string;
  magenta: (value: string) => string;
  red: (value: string) => string;
  yellow: (value: string) => string;
};

export class ClashApi {
  #baseUrl: URL;
  #secret: string;
  #fetch: typeof fetch;

  constructor({
    baseUrl,
    secret,
    fetchImpl = globalThis.fetch,
  }: {
    baseUrl: string;
    secret: string;
    fetchImpl?: typeof fetch;
  }) {
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

  async getConnections(): Promise<unknown> {
    const response = await this.#request("/connections", "GET");
    return response.json();
  }

  async closeConnection(id: string): Promise<void> {
    await this.#request(`/connections/${encodeURIComponent(id)}`, "DELETE");
  }

  async #request(pathname: string, method: string): Promise<Response> {
    const response = await this.#fetch(new URL(pathname, this.#baseUrl), {
      method,
      headers: this.#headers(),
    });

    if (!response.ok) {
      const text = await response.text();
      const suffix = text ? `: ${text}` : "";
      throw new Error(`${method} ${pathname} failed with ${response.status} ${response.statusText}${suffix}`);
    }

    return response;
  }

  #headers(): Record<string, string> {
    return this.#secret ? { Authorization: `Bearer ${this.#secret}` } : {};
  }
}

export class ConnectionSampler {
  #states = new Map<string, ConnectionState>();
  #now: () => Date;

  constructor({ now = () => new Date() }: { now?: () => Date } = {}) {
    this.#now = now;
  }

  sample(payload: unknown, options: { domains: string[]; zeroSpeedThreshold: number }): MonitorResult {
    const now = this.#now();
    const nowMs = now.getTime();
    const connections = readConnections(payload);
    const nextIds = new Set<string>();
    const matched: ConnectionEntry[] = [];

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

  #updateState(connection: Record<string, unknown>, nowMs: number, zeroSpeedThreshold: number): ConnectionState {
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

export async function runClvm(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.command === "help") {
    printHelp();
    return;
  }

  if (parsed.command === "config") {
    const fileConfig = await readClvmConfig();
    const runtimeConfig = buildRuntimeConfig(fileConfig, {}, { autoCloseEnabled: false, clear: false, once: true });
    printConfigStatus(runtimeConfig, { includeCommands: true });
    return;
  }

  if (parsed.command === "setup") {
    await runSetup(parsed.options);
    return;
  }

  const fileConfig = await readClvmConfig();
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
    options.closeZeroForSeconds === undefined
  ) {
    throw new Error("clvm setup requires at least one config flag; run clvm config to view current config");
  }

  return options;
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
    "  clvm monitor                              # refresh matched connections from mihomo /connections",
    "  clvm config                               # print active config",
    "  clvm setup --domain DOMAIN [OPTIONS]      # preview, confirm, and write config",
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

function printSetupHelp(): void {
  console.log([
    "Usage:",
    "  clvm setup --domain DOMAIN                # preview, confirm, and write clvm.json",
    "  clvm setup --base-url URL --secret SECRET # preview, confirm, and update API config",
    "  clvm setup --interval 1s                  # preview, confirm, and update monitor interval",
    "  clvm setup --close-zero-for-seconds off   # preview, confirm, and disable automatic close",
  ].join("\n"));
}

async function runSetup(options: CommandOptions): Promise<void> {
  const configPath = clvmConfigPath();
  const currentText = (await readTextIfExists(configPath)) ?? "";
  const currentConfig = currentText ? parseClvmConfig(currentText, configPath) : {};
  const nextConfig = buildSetupConfig(currentConfig, options);
  const nextText = renderConfigJson(nextConfig);

  printSetupPlan(configPath, currentText, nextText, buildRuntimeConfig(nextConfig, {}, {
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

  await writeTextFile(configPath, nextText, 0o600);
  console.log("");
  printKeyValue("target:", `${textGreen("updated")} ${textBlue(configPath)}`, 12);
}

function buildSetupConfig(current: ClvmConfigFile, options: CommandOptions): Required<ClvmConfigFile> {
  const next: ClvmConfigFile = { ...current };

  if (options.baseUrl !== undefined) {
    next.baseUrl = options.baseUrl;
  }
  if (options.secret !== undefined) {
    next.secret = options.secret;
  }
  if (options.domains !== undefined) {
    next.domains = normalizeDomains(options.domains);
  }
  if (options.interval !== undefined) {
    next.interval = options.interval;
  }
  if (options.zeroSpeedThreshold !== undefined) {
    next.zeroSpeedThreshold = options.zeroSpeedThreshold;
  }
  if (options.closeZeroForSeconds !== undefined) {
    next.closeZeroForSeconds = options.closeZeroForSeconds;
  }

  const runtime = buildRuntimeConfig(next, {}, { autoCloseEnabled: false, clear: false, once: true });
  return {
    baseUrl: runtime.baseUrl,
    secret: runtime.secret,
    domains: runtime.domains,
    interval: runtime.interval,
    zeroSpeedThreshold: runtime.zeroSpeedThreshold,
    closeZeroForSeconds: runtime.closeZeroForSeconds,
  };
}

function printSetupPlan(configPath: string, currentText: string, nextText: string, runtimeConfig: RuntimeConfig): void {
  printKeyValue("target:", `${textBlue("would update")} ${textBlue(configPath)}`, 12);
  console.log(textDim("no changes are written unless you type yes at the prompt."));
  printConfigValues(runtimeConfig);
  printConfigDiff(configPath, currentText, nextText);
}

function printConfigStatus(runtimeConfig: RuntimeConfig, { includeCommands }: { includeCommands: boolean }): void {
  const style = createStyle(runtimeConfig);
  console.log(style.bold("clvm config"));
  printKeyValue("path:", style.blue(clvmConfigPath()), 12);
  printConfigValues(runtimeConfig, style);
  if (includeCommands) {
    printCommands(style);
  }
}

function printConfigValues(config: RuntimeConfig, style = createStyle(config)): void {
  printKeyValue("base URL:", style.cyan(config.baseUrl), 12);
  printKeyValue("secret:", config.secret ? style.green(maskSecret(config.secret)) : style.dim("empty"), 12);
  printKeyValue("domains:", config.domains.length > 0 ? config.domains.join(",") : style.yellow("missing"), 12);
  printKeyValue("interval:", formatDuration(config.intervalMs), 12);
  printKeyValue("zero speed:", `${config.zeroSpeedThreshold}B/s`, 12);
  printKeyValue("auto close:", config.closeZeroForSeconds === null ? style.dim("off") : style.red(`${formatSeconds(config.closeZeroForSeconds)}`), 12);
}

function printCommands(style: Style): void {
  console.log(style.dim("commands: clvm | clvm monitor | clvm config | clvm setup --domain DOMAIN | clvm help"));
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
  const style = createStyle(config);
  if (config.json) {
    if (config.domains.length === 0) {
      throw new Error("domains are required for JSON status; run clvm setup --domain DOMAIN or use --domain DOMAIN");
    }
    printMonitorResult(await sampleOnce(config), config);
    return;
  }

  printConfigStatus(config, { includeCommands: false });
  if (config.domains.length === 0) {
    printKeyValue("status:", style.yellow("missing domains"), 12);
    printCommands(style);
    return;
  }

  const result = await sampleOnce(config);
  printKeyValue("status:", `${style.green("ok")} total=${style.green(String(result.totalConnections))} current=${style.green(String(result.matchedConnections.length))}`, 12);
  console.log("");
  printMonitorResult(result, config);
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

  process.once("SIGINT", () => {
    stopped = true;
  });

  while (!stopped) {
    const payload = await api.getConnections();
    const result = sampler.sample(payload, {
      domains: config.domains,
      zeroSpeedThreshold: config.zeroSpeedThreshold,
    });
    const closedConnections = await closeExpiredConnections(api, result, config, closedIds);

    if (closedConnections.length > 0) {
      closedTotal += closedConnections.length;
      recordClosedConnections(closedHistory, closedConnections);
    }

    result.closedHistory = closedHistory;
    result.closedTotal = closedTotal;
    printMonitorResult(result, config);

    if (config.once) {
      break;
    }

    await delay(nextAlignedDelay(config.intervalMs));
  }
}

async function sampleOnce(config: RuntimeConfig): Promise<MonitorResult> {
  const api = new ClashApi({
    baseUrl: config.baseUrl,
    secret: config.secret,
  });
  const sampler = new ConnectionSampler();
  const payload = await api.getConnections();
  const result = sampler.sample(payload, {
    domains: config.domains,
    zeroSpeedThreshold: config.zeroSpeedThreshold,
  });
  result.closedConnections = [];
  result.closedHistory = [];
  result.closedTotal = 0;
  return result;
}

function recordClosedConnections(closedHistory: ClosedConnectionEntry[], closedConnections: ConnectionEntry[]): void {
  const closedAt = new Date().toISOString();

  for (const connection of closedConnections) {
    closedHistory.unshift({
      ...connection,
      closedAt,
    });
  }

  closedHistory.length = Math.min(closedHistory.length, closedHistoryLimit);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function closeExpiredConnections(
  api: ClashApi,
  result: MonitorResult,
  config: RuntimeConfig,
  closedIds = new Set<string>(),
): Promise<ConnectionEntry[]> {
  result.closedConnections = [];

  if (!config.autoCloseEnabled || config.closeZeroForMs === null) {
    return result.closedConnections;
  }

  const currentIds = new Set(result.matchedConnections.map((connection) => connection.id));
  for (const id of closedIds) {
    if (!currentIds.has(id)) {
      closedIds.delete(id);
    }
  }

  const targets = result.matchedConnections.filter(
    (connection) => connection.isIdle && connection.observedIdleMs > config.closeZeroForMs! && !closedIds.has(connection.id),
  );

  for (const connection of targets) {
    await api.closeConnection(connection.id);
    closedIds.add(connection.id);
    result.closedConnections.push(connection);
  }

  return result.closedConnections;
}

async function readClvmConfig(): Promise<ClvmConfigFile> {
  const path = clvmConfigPath();
  const text = await readTextIfExists(path);
  if (text === null) {
    return {};
  }
  return parseClvmConfig(text, path);
}

export function parseClvmConfig(text: string, path = "clvm.json"): ClvmConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
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

  const config: ClvmConfigFile = {};
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
    } else {
      if (typeof parsed.closeZeroForSeconds !== "number") {
        throw new Error(`${path} closeZeroForSeconds must be a number or null`);
      }
      config.closeZeroForSeconds = parsePositiveSeconds(parsed.closeZeroForSeconds, "closeZeroForSeconds");
    }
  }

  return config;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildRuntimeConfig(
  fileConfig: ClvmConfigFile,
  options: CommandOptions,
  mode: { autoCloseEnabled: boolean; clear: boolean; once: boolean },
): RuntimeConfig {
  const baseUrl = options.baseUrl ?? fileConfig.baseUrl ?? defaultBaseUrl;
  const secret = options.secret ?? fileConfig.secret ?? "";
  const domains = options.domains !== undefined
    ? normalizeDomains(options.domains)
    : normalizeDomains(fileConfig.domains ?? []);
  const interval = options.interval ?? fileConfig.interval ?? defaultInterval;
  const intervalMs = parseDuration(interval, "interval");
  const zeroSpeedThreshold = options.zeroSpeedThreshold ?? fileConfig.zeroSpeedThreshold ?? 0;
  const closeZeroForSeconds = options.closeZeroForSeconds !== undefined
    ? options.closeZeroForSeconds
    : fileConfig.closeZeroForSeconds ?? null;

  new URL(baseUrl);

  if (intervalMs <= 0) {
    throw new Error("interval must be greater than 0");
  }

  if (!Number.isFinite(zeroSpeedThreshold) || zeroSpeedThreshold < 0) {
    throw new Error("zero speed threshold must be a non-negative number");
  }

  if (closeZeroForSeconds !== null && (!Number.isFinite(closeZeroForSeconds) || closeZeroForSeconds <= 0)) {
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

function renderConfigJson(config: Required<ClvmConfigFile>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function readConnections(payload: unknown): Record<string, unknown>[] {
  if (!isPlainObject(payload) || !Array.isArray(payload.connections)) {
    throw new Error("/connections response must contain a connections array");
  }
  return payload.connections.filter(isPlainObject);
}

function readObjectValue(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

export function normalizeDomains(values: unknown[]): string[] {
  const domains = values
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => normalizeHost(value))
    .filter(Boolean);

  return [...new Set(domains)];
}

export function getDomainCandidates(connection: Record<string, unknown>): string[] {
  const metadataValue = connection.metadata;
  const metadata = isPlainObject(metadataValue) ? metadataValue : {};
  const candidates = domainFields.map((field) => metadata[field]);

  if (String(connection.rule ?? "").toUpperCase().includes("DOMAIN")) {
    candidates.push(connection.rulePayload);
  }

  return normalizeDomains(candidates);
}

export function findDomainMatch(connection: Record<string, unknown>, domains: string[]): DomainMatch | null {
  const candidates = getDomainCandidates(connection);

  for (const candidate of candidates) {
    const domain = domains.find((target) => domainMatches(candidate, target));
    if (domain) {
      return { domain, candidate };
    }
  }

  return null;
}

export function domainMatches(candidate: unknown, target: unknown): boolean {
  const normalizedCandidate = normalizeHost(candidate);
  const normalizedTarget = normalizeHost(target);

  if (!normalizedCandidate || !normalizedTarget) {
    return false;
  }

  return normalizedCandidate === normalizedTarget || normalizedCandidate.endsWith(`.${normalizedTarget}`);
}

export function parseDuration(value: unknown, name = "duration"): number {
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
  return Math.round(amount * durationUnits.get(unit)!);
}

export function nextAlignedDelay(intervalMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("interval must be a positive finite number");
  }

  const nextTick = Math.ceil((nowMs + 1) / intervalMs) * intervalMs;
  return Math.max(0, nextTick - nowMs);
}

export function formatDuration(milliseconds: number): string {
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

function parseCloseZeroForSeconds(value: string): number | null {
  if (value === "off") {
    return null;
  }
  return parsePositiveSeconds(value, "close zero-for seconds");
}

function parsePositiveSeconds(value: unknown, name: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive number of seconds`);
  }
  return seconds;
}

function parseNonNegativeNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return number;
}

function endpointLabel(connection: Record<string, unknown>): string {
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

function normalizeHost(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\*\./u, "")
    .replace(/^\+\./u, "")
    .replace(/^\./u, "")
    .replace(/\.$/u, "");
}

function statusFor(entry: Omit<ConnectionEntry, "status">): ConnectionEntry["status"] {
  if (entry.totalBytesPerSecond === null) {
    return "unknown";
  }
  return entry.isIdle ? "zero" : "active";
}

function toEntry(connection: Record<string, unknown>, state: ConnectionState, domainMatch: DomainMatch): Omit<ConnectionEntry, "status"> {
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

function readSpeeds(
  connection: Record<string, unknown>,
  previous: ConnectionState | undefined,
  { elapsedSeconds, uploadTotal, downloadTotal }: { elapsedSeconds: number; uploadTotal: number; downloadTotal: number },
): SpeedSample {
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

function parseStartTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(1).replace(/\.0$/u, "");
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${formatNumber(seconds)}s`;
  }
  return `${formatNumber(seconds / 60)}m`;
}

function printMonitorResult(result: MonitorResult, config: RuntimeConfig, stream = process.stdout): void {
  if (config.json) {
    stream.write(`${JSON.stringify(toJsonResult(result))}\n`);
    return;
  }

  if (config.clear) {
    stream.write("\x1B[2J\x1B[H");
  }

  const closed = result.closedConnections ?? [];
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
  } else {
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
    if (closedTotal > 0) {
      header.push(style.dim(`closedTotal=${closedTotal}`));
    }
  }

  stream.write(`${header.join(" ")}\n`);

  const layout = buildLayout(stream);
  if (shownConnections.length === 0) {
    stream.write("no current connections for configured domains\n");
  } else {
    printCurrentConnections(shownConnections, layout, style, stream);
  }

  printClosedHistory(closedHistory, layout, style, stream);
}

function printCurrentConnections(shownConnections: ConnectionEntry[], layout: Layout, style: Style, stream: NodeJS.WriteStream): void {
  const headerLine = `${pad("status", layout.status)} ${pad("endpoint", layout.endpoint)} ${pad("age", layout.age)} ${pad("zeroFor", layout.zeroFor)} ${pad("up/s", layout.up)} ${pad("down/s", layout.down)} ${pad("upload", layout.upload)} ${pad("download", layout.download)} ${pad("chain", layout.chain)} rule`;

  stream.write(`${style.bold(headerLine)}\n`);

  for (const connection of shownConnections) {
    stream.write(
      [
        statusCell(connection.status, layout.status, style),
        style.cyan(pad(truncate(connection.endpoint, layout.endpoint), layout.endpoint)),
        pad(formatDuration(connection.ageMs), layout.age),
        pad(formatDuration(connection.observedIdleMs), layout.zeroFor),
        speedCell(connection.uploadBytesPerSecond, layout.up, style),
        speedCell(connection.downloadBytesPerSecond, layout.down, style),
        bytesCell(connection.uploadTotal, layout.upload, style),
        bytesCell(connection.downloadTotal, layout.download, style),
        style.magenta(pad(truncate(connection.chains.join(" > "), layout.chain), layout.chain)),
        style.dim(truncate(connection.rule, layout.rule)),
      ].join(" ") + "\n",
    );
  }
}

function printClosedHistory(closedHistory: ClosedConnectionEntry[], layout: Layout, style: Style, stream: NodeJS.WriteStream): void {
  if (closedHistory.length === 0) {
    return;
  }

  const headerLine = `${pad("closedAt", 19)} ${pad("endpoint", layout.endpoint)} ${pad("zeroFor", layout.zeroFor)} ${pad("upload", layout.upload)} ${pad("download", layout.download)} ${pad("chain", layout.chain)} rule`;

  stream.write(`\n${style.bold("recent closed")}\n`);
  stream.write(`${style.bold(headerLine)}\n`);

  for (const connection of closedHistory) {
    stream.write(
      [
        pad(formatLocalTimestamp(connection.closedAt), 19),
        style.cyan(pad(truncate(connection.endpoint, layout.endpoint), layout.endpoint)),
        pad(formatDuration(connection.observedIdleMs), layout.zeroFor),
        bytesCell(connection.uploadTotal, layout.upload, style),
        bytesCell(connection.downloadTotal, layout.download, style),
        style.magenta(pad(truncate(connection.chains.join(" > "), layout.chain), layout.chain)),
        style.dim(truncate(connection.rule, layout.rule)),
      ].join(" ") + "\n",
    );
  }
}

function toJsonResult(result: MonitorResult): Record<string, unknown> {
  return {
    timestamp: result.timestamp,
    totalConnections: result.totalConnections,
    matchedConnections: result.matchedConnections,
    closedConnections: result.closedConnections ?? [],
    closedHistory: result.closedHistory ?? [],
    closedTotal: result.closedTotal ?? 0,
  };
}

function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) {
    return "[unknown]";
  }
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)}B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)}KB/s`;
  }
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)}MB/s`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "[unknown]";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function formatLocalTimestamp(value: string): string {
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

function sortConnections(connections: ConnectionEntry[]): ConnectionEntry[] {
  return [...connections].sort((left, right) => {
    const statusOrder = statusRank(left.status) - statusRank(right.status);
    if (statusOrder !== 0) {
      return statusOrder;
    }
    return right.observedIdleMs - left.observedIdleMs || right.ageMs - left.ageMs;
  });
}

function statusRank(status: ConnectionEntry["status"]): number {
  return {
    zero: 0,
    unknown: 1,
    active: 2,
  }[status] ?? 4;
}

function statusCell(status: ConnectionEntry["status"], width: number, style: Style): string {
  const text = pad(formatStatus(status), width);
  if (status === "zero") {
    return style.yellow(text);
  }
  if (status === "active") {
    return style.green(text);
  }
  return style.dim(text);
}

function speedCell(bytesPerSecond: number | null, width: number, style: Style): string {
  const text = pad(formatSpeed(bytesPerSecond), width);
  if (bytesPerSecond === null || bytesPerSecond === 0) {
    return style.dim(text);
  }
  return style.green(text);
}

function bytesCell(bytes: number | null, width: number, style: Style): string {
  const text = pad(formatBytes(bytes), width);
  if (bytes === null || bytes === 0) {
    return style.dim(text);
  }
  return text;
}

function buildLayout(stream: NodeJS.WriteStream): Layout {
  const columns = Number.isFinite(stream.columns) ? stream.columns : (process.stdout.columns ?? 120);
  const fixed = {
    status: 9,
    age: 7,
    zeroFor: 7,
    up: 8,
    down: 8,
    upload: 8,
    download: 8,
  };
  const separators = 9;
  const fixedWidth =
    fixed.status +
    fixed.age +
    fixed.zeroFor +
    fixed.up +
    fixed.down +
    fixed.upload +
    fixed.download +
    separators;
  const flexibleWidth = Math.max(54, columns - fixedWidth);
  const rule = clamp(Math.round(flexibleWidth * 0.34), 18, 36);
  const remainingWidth = flexibleWidth - rule;
  const endpoint = clamp(Math.round(remainingWidth * 0.64), 22, 44);
  const chain = Math.max(14, remainingWidth - endpoint);

  return {
    ...fixed,
    endpoint,
    chain,
    rule,
  };
}

function formatStatus(status: ConnectionEntry["status"]): string {
  return status === "unknown" ? "[unknown]" : status;
}

function createStyle(config: RuntimeConfig): Style {
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

function identity(value: string): string {
  return value;
}

function padNumber(value: number): string {
  return String(value).padStart(2, "0");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pad(value: unknown, width: number): string {
  return String(value).padEnd(width, " ");
}

function truncate(value: unknown, width: number): string {
  const text = String(value ?? "");
  if (text.length <= width) {
    return text;
  }
  return `${text.slice(0, Math.max(0, width - 3))}...`;
}
