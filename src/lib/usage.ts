import { join } from "node:path";
import { codexToolsCacheDir } from "./paths.js";
import { appendBoundedJsonLineSync } from "./runtime-log.js";
import { packageVersion } from "./version.js";

export type UsageOutcome = "ok" | "error" | "cancelled" | "interrupted";

export type UsagePromptRecord = {
  prompt: string;
  outcome: "answered" | "cancelled";
  kept_default: boolean | null;
  selected?: number;
};

export type UsageRecord = {
  version: 1;
  recorded_at: string;
  tool: string;
  command: string;
  flags: string[];
  via: "argv" | "shortcut";
  tty: boolean;
  outcome: UsageOutcome;
  exit_code: number;
  duration_ms: number;
  package_version: string;
  prompts: UsagePromptRecord[];
};

type UsageSession = {
  tool: string;
  command: string;
  flags: string[];
  via: "argv" | "shortcut";
  startedAt: number;
  prompts: UsagePromptRecord[];
  cancelled: boolean;
  recorded: boolean;
};

const USAGE_MAX_BYTES = 16 * 1024 * 1024;
const USAGE_TRIM_BYTES = 12 * 1024 * 1024;

const CCS_COMMANDS = new Set(["version", "-v", "help", "-h", "--help", "models", "use", "list", "l", "sync", "add", "remove", "config", "stats"]);
const CCS_PROXY_COMMANDS = new Set([
  "help", "-h", "--help", "watch", "reroute", "cancel", "capture", "mode", "search", "compact", "config",
  "install", "restart", "restore",
]);
const TOOL_COMMANDS: Record<string, Set<string>> = {
  cimg: new Set(["config", "version", "-v", "help", "-h", "--help"]),
  clvm: new Set(["monitor", "config", "setup", "sync", "version", "-v", "help", "-h", "--help"]),
  senv: new Set(["version", "-v", "help", "-h", "--help"]),
  "codex-rename": new Set(["version", "-v", "help", "-h", "--help"]),
  cx: new Set(["run", "version", "-v", "help", "-h", "--help"]),
  cxx: new Set(["run", "version", "-v", "help", "-h", "--help"]),
  cxxs: new Set(["run", "version", "-v", "help", "-h", "--help"]),
  ccx: new Set(["version", "-v", "help", "-h", "--help"]),
  ccxs: new Set(["version", "-v", "help", "-h", "--help"]),
};
// Wrappers pass their arguments to codex or claude; those arguments are never recorded.
const WRAPPER_TOOLS = new Set(["cx", "cxx", "cxxs", "ccx", "ccxs"]);

let session: UsageSession | null = null;

export function usageLogPath(): string {
  return join(codexToolsCacheDir(), "usage.jsonl");
}

function flagNames(args: string[]): string[] {
  return [...new Set(args.filter((arg) => /^-/.test(arg) && arg !== "-" && arg !== "--").map((arg) => arg.split("=")[0]))].sort();
}

// Returns null for invocations that are not recorded, such as the background proxy process.
export function normalizeUsageCommand(tool: string, argv: string[]): { command: string; flags: string[] } | null {
  if (tool === "ccs") {
    const [first, second] = argv;
    if (first === "proxy") {
      if (second === "serve") return null;
      const sub = second === undefined || second.startsWith("--") && !CCS_PROXY_COMMANDS.has(second)
        ? []
        : [CCS_PROXY_COMMANDS.has(second) ? second : "<arg>"];
      return { command: ["ccs", "proxy", ...sub].join(" "), flags: flagNames(argv.slice(1)) };
    }
    const sub = first === undefined ? [] : [CCS_COMMANDS.has(first) ? first : first.startsWith("-") ? "<arg>" : "<profile>"];
    return { command: ["ccs", ...sub].join(" "), flags: flagNames(argv.slice(1)) };
  }
  const known = TOOL_COMMANDS[tool] ?? new Set<string>();
  const first = argv[0];
  const sub = first !== undefined && known.has(first) ? [first] : [];
  if (WRAPPER_TOOLS.has(tool)) {
    return { command: [tool, ...sub].join(" "), flags: [] };
  }
  return { command: [tool, ...sub].join(" "), flags: flagNames(argv) };
}

function outcomeFor(exitCode: number, current: UsageSession): UsageOutcome {
  if (exitCode === 130) return "interrupted";
  if (exitCode !== 0) return "error";
  return current.cancelled ? "cancelled" : "ok";
}

function writeUsage(exitCode: number, outcome?: UsageOutcome): void {
  const current = session;
  if (!current || current.recorded) return;
  current.recorded = true;
  try {
    const record: UsageRecord = {
      version: 1,
      recorded_at: new Date().toISOString(),
      tool: current.tool,
      command: current.command,
      flags: current.flags,
      via: current.via,
      tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      outcome: outcome ?? outcomeFor(exitCode, current),
      exit_code: exitCode,
      duration_ms: Date.now() - current.startedAt,
      package_version: packageVersion(),
      prompts: current.prompts,
    };
    appendBoundedJsonLineSync(usageLogPath(), record, { maxBytes: USAGE_MAX_BYTES, trimToBytes: USAGE_TRIM_BYTES });
  } catch {
    // Usage statistics never change a command's result or output.
  }
}

export function startUsage(tool: string, argv: string[]): void {
  if (process.env.CODEX_TOOLS_USAGE === "off") return;
  const normalized = normalizeUsageCommand(tool, argv);
  if (!normalized) return;
  session = { tool, ...normalized, via: "argv", startedAt: Date.now(), prompts: [], cancelled: false, recorded: false };
  process.once("exit", (code) => writeUsage(typeof code === "number" ? code : Number(process.exitCode ?? 0)));
}

// Shortcut navigation replaces the recorded command with the one that actually runs.
export function setUsageCommand(tool: string, argv: string[], via: "argv" | "shortcut"): void {
  const normalized = normalizeUsageCommand(tool, argv);
  if (!session || !normalized) return;
  session.command = normalized.command;
  session.flags = normalized.flags;
  session.via = via;
}

export function recordUsagePrompt(record: UsagePromptRecord): void {
  if (!session) return;
  session.prompts.push(record);
  if (record.outcome === "cancelled") session.cancelled = true;
}

// For paths that end the process by re-raising a signal, where exit handlers do not run.
export function flushUsage(exitCode: number, outcome: UsageOutcome): void {
  writeUsage(exitCode, outcome);
}
