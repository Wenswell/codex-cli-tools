import { spawn } from "node:child_process";

export function runCodexSearch(args: string[], options: { bypassSandbox?: boolean; resume?: boolean } = {}): void {
  const codexArgs = ["--search"];
  if (options.bypassSandbox) {
    codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (options.resume) {
    codexArgs.push("resume");
  }
  codexArgs.push(...args);

  const child = spawn("codex", codexArgs, {
    stdio: "inherit",
  });

  child.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      console.error("codex command not found. Install it with: pnpm add -g @openai/codex");
      process.exit(127);
    }

    console.error(`failed to run codex: ${error.message}`);
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
