#!/usr/bin/env node
import { runEnvsync } from "../commands/senv.js";
runEnvsync(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`senv: ${message}`);
    process.exitCode = 1;
});
