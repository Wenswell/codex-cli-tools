#!/usr/bin/env node
import { runCodexRename } from "../commands/codex-rename.js";
import { textRed } from "../lib/text.js";

runCodexRename(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${textRed("codex-rename:")} ${message}`);
  process.exitCode = 1;
});
