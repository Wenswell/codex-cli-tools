#!/usr/bin/env node
import { runCodexCommand } from "../commands/cx.js";
import { textRed } from "../lib/text.js";
runCodexCommand(process.argv.slice(2), { bypassSandbox: true, resume: true }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${textRed("cxxs:")} ${message}`);
    process.exitCode = 1;
});
