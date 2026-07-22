import { spawn } from "node:child_process";
import { colorName, colorUrl, printKeyValue } from "../lib/output.js";
import { maskSecret, textBold, textDim, textRed } from "../lib/text.js";
import { isVersionArgument, printToolVersion, toolNameFromArgv } from "../lib/version.js";
import { resolveCodexProfileLaunch } from "./codex-profile.js";

type CodexSearchOptions = {
  bypassSandbox?: boolean;
  resume?: boolean;
  forceLocal?: boolean;
  configOverrides?: string[];
  env?: NodeJS.ProcessEnv;
};

export function runCodexSearch(
  args: string[],
  options: CodexSearchOptions = {},
): void {
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

  const local = options.forceLocal || args[0] === "local";
  const forwardedArgs = !options.forceLocal && args[0] === "local" ? args.slice(1) : args;
  const codexArgs = ["--search"];
  if (options.bypassSandbox) {
    codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
  }
  for (const override of options.configOverrides ?? []) {
    codexArgs.push("-c", override);
  }
  if (!local) {
    codexArgs.push("--remote", "unix://", "-C", process.cwd());
  }
  if (options.resume) {
    codexArgs.push("resume");
  }
  codexArgs.push(...forwardedArgs);

  const child = spawn("codex", codexArgs, {
    stdio: "inherit",
    env: options.env,
  });

  child.on("error", (error: NodeJS.ErrnoException) => {
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

function isHelpArgument(value: string | undefined): boolean {
  return value === "help" || value === "-h" || value === "--help";
}

function printHelp(toolName: string, resume: boolean): void {
  const argumentName = resume ? "RESUME_ARGS" : "CODEX_ARGS";
  const commands = [
    [`${toolName} [ARGS...]`, "launch through the local app-server daemon"],
    [`${toolName} local [ARGS...]`, "launch a local Codex process"],
    [`${toolName} run PROFILE [${argumentName}...]`, "launch locally with one profile"],
    [`${toolName} version`, "print package version"],
    [`${toolName} -v`, "print package version"],
  ];
  const width = Math.max(...commands.map(([command]) => command.length));
  console.log([
    textBold("Usage:"),
    ...commands.map(([command, comment]) => `  ${command.padEnd(width)} # ${comment}`),
  ].join("\n"));
}

export async function runCodexCommand(
  args: string[],
  options: Pick<CodexSearchOptions, "bypassSandbox" | "resume"> = {},
): Promise<void> {
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
  printKeyValue("mode:", "temporary local codex launch; no files changed");
  runCodexSearch(args.slice(2), {
    ...options,
    forceLocal: true,
    configOverrides: launch.configOverrides,
    env: launch.env,
  });
}
