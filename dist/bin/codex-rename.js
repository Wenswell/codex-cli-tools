#!/usr/bin/env node
import { runCodexRename } from "../commands/codex-rename.js";
import { textRed } from "../lib/text.js";
import { startUsage } from "../lib/usage.js";
startUsage("codex-rename", process.argv.slice(2));
runCodexRename(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${textRed("codex-rename:")} ${message}`);
    process.exitCode = 1;
});
