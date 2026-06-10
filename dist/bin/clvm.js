#!/usr/bin/env node
import { runClvm } from "../commands/clvm.js";
import { textRed } from "../lib/text.js";
runClvm(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${textRed("clvm:")} ${message}`);
    process.exitCode = 1;
});
