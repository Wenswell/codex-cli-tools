#!/usr/bin/env node
import { runEnvsync } from "../commands/senv.js";
import { textRed } from "../lib/text.js";

runEnvsync(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${textRed("senv:")} ${message}`);
  process.exitCode = 1;
});
