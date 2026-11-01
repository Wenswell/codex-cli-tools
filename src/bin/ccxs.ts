#!/usr/bin/env node
import { runClaude } from "../commands/ccx.js";
import { textRed } from "../lib/text.js";
import { startUsage } from "../lib/usage.js";

startUsage("ccxs", process.argv.slice(2));

runClaude(process.argv.slice(2), { resume: true }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${textRed("ccxs:")} ${message}`);
  process.exitCode = 1;
});
