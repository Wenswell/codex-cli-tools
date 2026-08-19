#!/usr/bin/env node
import { runCimg } from "../commands/cimg.js";
import { textRed } from "../lib/text.js";
runCimg(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${textRed("cimg:")} ${message}`);
    process.exitCode = 1;
});
