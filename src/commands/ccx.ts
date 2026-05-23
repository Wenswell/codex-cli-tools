import { spawn } from "node:child_process";
import { textRed } from "../lib/text.js";

export function runClaude(args: string[], options: { resume?: boolean } = {}): void {
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
