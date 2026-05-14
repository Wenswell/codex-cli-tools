#!/usr/bin/env node
import { runCodexSearch } from "../commands/cxs.js";

runCodexSearch(process.argv.slice(2), true);
