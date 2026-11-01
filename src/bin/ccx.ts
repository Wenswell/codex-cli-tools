#!/usr/bin/env node
import { runClaude } from "../commands/ccx.js";
import { startUsage } from "../lib/usage.js";

startUsage("ccx", process.argv.slice(2));

runClaude(process.argv.slice(2));
