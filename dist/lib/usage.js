import { join } from "node:path";
import { codexToolsCacheDir } from "./paths.js";
import { appendBoundedJsonLineSync } from "./runtime-log.js";
import { packageVersion } from "./version.js";
const USAGE_MAX_BYTES = 16 * 1024 * 1024;
const USAGE_TRIM_BYTES = 12 * 1024 * 1024;
const CCS_COMMANDS = new Set(["version", "-v", "help", "-h", "--help", "models", "use", "list", "l", "sync", "add", "remove", "config", "stats"]);
const CCS_PROXY_COMMANDS = new Set([
    "help", "-h", "--help", "watch", "reroute", "cancel", "capture", "search", "compact", "config",
    "install", "restart", "restore",
]);
const TOOL_COMMANDS = {
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
let session = null;
export function usageLogPath() {
    return join(codexToolsCacheDir(), "usage.jsonl");
}
function flagNames(args) {
    return [...new Set(args.filter((arg) => /^-/.test(arg) && arg !== "-" && arg !== "--").map((arg) => arg.split("=")[0]))].sort();
}
// Returns null for invocations that are not recorded, such as the background proxy process.
export function normalizeUsageCommand(tool, argv) {
    if (tool === "ccs") {
        const [first, second] = argv;
        if (first === "proxy") {
            if (second === "serve")
                return null;
            const sub = second === undefined || second.startsWith("--") && !CCS_PROXY_COMMANDS.has(second)
                ? []
                : [CCS_PROXY_COMMANDS.has(second) ? second : "<arg>"];
            return { command: ["ccs", "proxy", ...sub].join(" "), flags: flagNames(argv.slice(1)) };
        }
        const sub = first === undefined ? [] : [CCS_COMMANDS.has(first) ? first : first.startsWith("-") ? "<arg>" : "<profile>"];
        return { command: ["ccs", ...sub].join(" "), flags: flagNames(argv.slice(1)) };
    }
    const known = TOOL_COMMANDS[tool] ?? new Set();
    const first = argv[0];
    const sub = first !== undefined && known.has(first) ? [first] : [];
    if (WRAPPER_TOOLS.has(tool)) {
        return { command: [tool, ...sub].join(" "), flags: [] };
    }
    return { command: [tool, ...sub].join(" "), flags: flagNames(argv) };
}
function outcomeFor(exitCode, current) {
    if (exitCode === 130)
        return "interrupted";
    if (exitCode !== 0)
        return "error";
    return current.cancelled ? "cancelled" : "ok";
}
function writeUsage(exitCode, outcome) {
    const current = session;
    if (!current || current.recorded)
        return;
    current.recorded = true;
    try {
        const record = {
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
    }
    catch {
        // Usage statistics never change a command's result or output.
    }
}
export function startUsage(tool, argv) {
    if (process.env.CODEX_TOOLS_USAGE === "off")
        return;
    const normalized = normalizeUsageCommand(tool, argv);
    if (!normalized)
        return;
    session = { tool, ...normalized, via: "argv", startedAt: Date.now(), prompts: [], cancelled: false, recorded: false };
    process.once("exit", (code) => writeUsage(typeof code === "number" ? code : Number(process.exitCode ?? 0)));
}
// Shortcut navigation replaces the recorded command with the one that actually runs.
export function setUsageCommand(tool, argv, via) {
    const normalized = normalizeUsageCommand(tool, argv);
    if (!session || !normalized)
        return;
    session.command = normalized.command;
    session.flags = normalized.flags;
    session.via = via;
}
export function recordUsagePrompt(record) {
    if (!session)
        return;
    session.prompts.push(record);
    if (record.outcome === "cancelled")
        session.cancelled = true;
}
// For paths that end the process by re-raising a signal, where exit handlers do not run.
export function flushUsage(exitCode, outcome) {
    writeUsage(exitCode, outcome);
}
