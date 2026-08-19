#!/usr/bin/env node
import { CimgCanceledError, runCimg } from "../commands/cimg.js";
import { textRed } from "../lib/text.js";

runCimg(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${textRed("cimg:")} ${message}`);
  process.exitCode = error instanceof CimgCanceledError ? 130 : 1;
});
