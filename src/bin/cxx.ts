#!/usr/bin/env node
import { runCodexCommand } from "../commands/cx.js";
import { textRed } from "../lib/text.js";
import { startUsage } from "../lib/usage.js";

startUsage("cxx", process.argv.slice(2));

runCodexCommand(process.argv.slice(2), { bypassSandbox: true }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${textRed("cxx:")} ${message}`);
  process.exitCode = 1;
});
