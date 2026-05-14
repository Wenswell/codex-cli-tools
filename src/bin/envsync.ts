#!/usr/bin/env node
import { runEnvsync } from "../commands/envsync.js";

runEnvsync(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`envsync: ${message}`);
  process.exitCode = 1;
});
