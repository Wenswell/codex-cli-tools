#!/usr/bin/env node
import { runCodexSessionMove } from "../commands/codex-rename.js";
import { textRed } from "../lib/text.js";

runCodexSessionMove(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${textRed("codex-rename:")} ${message}`);
  process.exitCode = 1;
});
