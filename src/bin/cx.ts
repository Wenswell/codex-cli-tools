#!/usr/bin/env node
import { runCodexCommand } from "../commands/cx.js";
import { textRed } from "../lib/text.js";

runCodexCommand(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${textRed("cx:")} ${message}`);
  process.exitCode = 1;
});
