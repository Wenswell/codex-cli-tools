#!/usr/bin/env node
import { runCcs } from "../commands/ccs.js";
import { PromptCancelledError } from "../lib/prompt.js";
import { textRed } from "../lib/text.js";
runCcs(process.argv.slice(2)).catch((error) => {
    if (error instanceof PromptCancelledError) {
        process.exitCode = error.interrupted ? 130 : 0;
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${textRed("ccs:")} ${message}`);
    process.exitCode = 1;
});
