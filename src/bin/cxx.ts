#!/usr/bin/env node
import { runCodexCommand } from "../commands/cx.js";
import { textRed } from "../lib/text.js";

runCodexCommand(process.argv.slice(2), { bypassSandbox: true }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${textRed("cxx:")} ${message}`);
  process.exitCode = 1;
});
