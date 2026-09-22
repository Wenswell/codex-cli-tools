import { spawn } from "node:child_process";
import { colorName, colorUrl, printKeyValue } from "../lib/output.js";
import { maskSecret, textBold, textDim, textRed } from "../lib/text.js";
import { isVersionArgument, printToolVersion, toolNameFromArgv } from "../lib/version.js";
import { resolveCodexProfileLaunch } from "./codex-profile.js";
function runCodexSearch(args, options = {}) {
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
    for (const override of options.configOverrides ?? []) {
        codexArgs.push("-c", override);
    }
    if (options.resume) {
        codexArgs.push("resume");
    }
    codexArgs.push(...args);
    const child = spawn("codex", codexArgs, {
        stdio: "inherit",
        env: options.env,
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
function isHelpArgument(value) {
    return value === "help" || value === "-h" || value === "--help";
}
function printHelp(toolName, resume) {
    const argumentName = resume ? "RESUME_ARGS" : "CODEX_ARGS";
    const commands = [
        [`${toolName} [ARGS...]`, "launch codex search"],
        [`${toolName} run PROFILE [${argumentName}...]`, "launch with one profile"],
        [`${toolName} version`, "print package version"],
        [`${toolName} -v`, "print package version"],
    ];
    const width = Math.max(...commands.map(([command]) => command.length));
    console.log([
        textBold("Usage:"),
        ...commands.map(([command, comment]) => `  ${command.padEnd(width)} # ${comment}`),
    ].join("\n"));
}
export async function runCodexCommand(args, options = {}) {
    const toolName = toolNameFromArgv();
    if (isHelpArgument(args[0]) || (args[0] === "run" && isHelpArgument(args[1]))) {
        printHelp(toolName, options.resume === true);
        return;
    }
    if (args[0] !== "run") {
        runCodexSearch(args, options);
        return;
    }
    const name = args[1];
    if (!name || name.startsWith("-")) {
        throw new Error(`${toolName} run requires PROFILE`);
    }
    const launch = await resolveCodexProfileLaunch(name);
    printKeyValue("profile:", `${colorName(name)}  ${colorUrl(launch.profile.baseURL)}  ${textDim(maskSecret(launch.profile.apiKey))}`);
    printKeyValue("mode:", "temporary codex launch; no files changed");
    runCodexSearch(args.slice(2), {
        ...options,
        configOverrides: launch.configOverrides,
        env: launch.env,
    });
}
