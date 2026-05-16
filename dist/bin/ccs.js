#!/usr/bin/env node
import { runCcs } from "../commands/ccs.js";
runCcs(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ccs: ${message}`);
    process.exitCode = 1;
});
