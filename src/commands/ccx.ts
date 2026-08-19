import { spawn } from "node:child_process";
import { textBold, textRed } from "../lib/text.js";
import { isVersionArgument, printToolVersion, toolNameFromArgv } from "../lib/version.js";

export function runClaude(args: string[], options: { resume?: boolean } = {}): void {
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

  const claudeArgs = ["--dangerously-skip-permissions"];
  if (options.resume) {
    claudeArgs.push("--resume");
  }
  claudeArgs.push(...args);

  const child = spawn("claude", claudeArgs, {
    stdio: "inherit",
  });

  child.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      console.error(`${textRed("error:")} claude command not found.`);
      process.exit(127);
    }

    console.error(`${textRed("error:")} failed to run claude: ${error.message}`);
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

function isHelpArgument(value: string | undefined): boolean {
  return value === "help" || value === "-h" || value === "--help";
}

function printHelp(toolName: string, resume: boolean): void {
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
