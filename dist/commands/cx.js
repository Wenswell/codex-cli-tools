import { spawn } from "node:child_process";
import { textRed } from "../lib/text.js";
import { isVersionArgument, printToolVersion, toolNameFromArgv } from "../lib/version.js";
export function runCodexSearch(args, options = {}) {
    const toolName = toolNameFromArgv();
    if (isVersionArgument(args[0])) {
        if (args.length !== 1) {
            console.error(`${textRed("error:")} usage: ${toolName} ${args[0]}`);
            process.exitCode = 1;
            return;
        }
        printToolVersion(toolName);
        return;
    }
    const codexArgs = ["--search"];
    if (options.bypassSandbox) {
        codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (options.remote) {
        codexArgs.push("--remote", "unix://");
    }
    if (options.resume) {
        codexArgs.push("resume");
    }
    codexArgs.push(...args);
    const child = spawn("codex", codexArgs, {
        stdio: "inherit",
    });
    child.on("error", (error) => {
        if (error.code === "ENOENT") {
            console.error(`${textRed("error:")} codex command not found. Install it with: pnpm add -g @openai/codex`);
            process.exit(127);
        }
        console.error(`${textRed("error:")} failed to run codex: ${error.message}`);
        process.exit(1);
    });
    child.on("exit", (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 1);
    });
}
