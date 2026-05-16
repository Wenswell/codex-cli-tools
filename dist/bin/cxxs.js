#!/usr/bin/env node
import { runCodexSearch } from "../commands/cx.js";
runCodexSearch(process.argv.slice(2), { bypassSandbox: true, resume: true });
