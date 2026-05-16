#!/usr/bin/env node
import { runCodexSessionMove } from "../commands/codex-rename.js";
runCodexSessionMove(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`codex-rename: ${message}`);
    process.exitCode = 1;
});
