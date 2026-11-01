import { spawn } from "node:child_process";
import { readProfiles } from "../lib/profiles.js";
import { flushUsage } from "../lib/usage.js";
import { ensureProxyRunning, resolveProxyOptions, resolveProxySwitchBaseUrl } from "./ccs-proxy.js";
import { textBold, textRed } from "../lib/text.js";
import { isVersionArgument, printToolVersion, toolNameFromArgv } from "../lib/version.js";
// Placeholder credential: the proxy replaces it with the routed profile's key.
const PROXY_AUTH_TOKEN = "ccs-proxy";
// With proxy state and `proxy.claude` enabled, Claude Code talks to the local proxy. `--settings`
// outranks ~/.claude/settings.json, which stays unchanged, so plain `claude` remains direct.
async function proxySettingsArgs() {
    const profiles = await readProfiles();
    if (!profiles.proxy?.claude?.enabled)
        return [];
    const runtime = await ensureProxyRunning(resolveProxyOptions());
    const baseURL = runtime ? resolveProxySwitchBaseUrl(runtime.state) : null;
    if (!baseURL)
        return [];
    return ["--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_AUTH_TOKEN: PROXY_AUTH_TOKEN } })];
}
export async function runClaude(args, options = {}) {
    const toolName = toolNameFromArgv();
    if (isHelpArgument(args[0])) {
        if (args.length !== 1) {
            console.error(`${textRed("error:")} usage: ${toolName} ${args[0]}`);
            process.exitCode = 1;
            return;
        }
        printHelp(toolName, options.resume === true);
        return;
    }
    if (isVersionArgument(args[0])) {
        if (args.length !== 1) {
            console.error(`${textRed("error:")} usage: ${toolName} ${args[0]}`);
            process.exitCode = 1;
            return;
        }
        printToolVersion(toolName);
        return;
    }
    const claudeArgs = [...await proxySettingsArgs(), "--dangerously-skip-permissions"];
    if (options.resume) {
        claudeArgs.push("--resume");
    }
    claudeArgs.push(...args);
    const child = spawn("claude", claudeArgs, {
        stdio: "inherit",
    });
    child.on("error", (error) => {
        if (error.code === "ENOENT") {
            console.error(`${textRed("error:")} claude command not found.`);
            process.exit(127);
        }
        console.error(`${textRed("error:")} failed to run claude: ${error.message}`);
        process.exit(1);
    });
    child.on("exit", (code, signal) => {
        if (signal) {
            flushUsage(130, "interrupted");
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 1);
    });
}
function isHelpArgument(value) {
    return value === "help" || value === "-h" || value === "--help";
}
function printHelp(toolName, resume) {
    const commands = [
        [`${toolName} [CLAUDE_ARGS...]`, resume ? "resume Claude Code with permission checks skipped" : "launch Claude Code with permission checks skipped"],
        [`${toolName} version`, "print package version"],
        [`${toolName} -v`, "print package version"],
        [`${toolName} help | -h | --help`, "show this help"],
    ];
    const width = Math.max(...commands.map(([command]) => command.length));
    console.log([
        textBold("Usage:"),
        ...commands.map(([command, comment]) => `  ${command.padEnd(width)} # ${comment}`),
    ].join("\n"));
}
