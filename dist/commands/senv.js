import { copyFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename } from "node:path";
import { readTextIfExists, writeTextFile } from "../lib/fs.js";
import { colorCount, colorPath, printKeyValue } from "../lib/output.js";
import { textBlue, textBold, textDim, textGreen } from "../lib/text.js";
const envLinePattern = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
function parseArgs(argv) {
    if (argv.length === 0) {
        printHelp();
        process.exit(0);
    }
    const args = {
        source: ".env.example",
        target: ".env",
        backup: false,
        apply: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--source") {
            args.source = requireValue(argv, index);
            index += 1;
            continue;
        }
        if (arg === "--target") {
            args.target = requireValue(argv, index);
            index += 1;
            continue;
        }
        if (arg === "-b" || arg === "--backup") {
            args.backup = true;
            continue;
        }
        if (arg === "-y" || arg === "--yes") {
            args.apply = true;
            continue;
        }
        if (arg === "-n" || arg === "--dry-run") {
            args.apply = false;
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }
        throw new Error(`unknown argument: ${arg}`);
    }
    return args;
}
function requireValue(argv, index) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${argv[index]} requires a value`);
    }
    return value;
}
function printHelp() {
    console.log([
        "senv",
        "senv -y",
        "senv --source .env.example --target .env -y",
        "senv -b -y",
        "",
        "Default mode is dry-run. Use -y or --yes to write changes.",
    ].join("\n"));
}
function splitLines(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}
function parseTemplate(text) {
    const lines = splitLines(text);
    if (lines.at(-1) === "") {
        lines.pop();
    }
    return lines.map((line) => {
        const match = envLinePattern.exec(line);
        if (!match) {
            return { type: "raw", text: line };
        }
        return { type: "env", key: match[1], value: match[2] };
    });
}
function parseExisting(text) {
    const values = new Map();
    const lines = splitLines(text);
    if (lines.at(-1) === "") {
        lines.pop();
    }
    for (const line of lines) {
        const match = envLinePattern.exec(line);
        if (!match) {
            continue;
        }
        values.set(match[1], { key: match[1], value: match[2] });
    }
    return values;
}
function buildEnv(exampleText, existingText) {
    const template = parseTemplate(exampleText);
    const existing = parseExisting(existingText);
    const seen = new Set();
    const output = [];
    const summary = {
        added: [],
        filledDefaults: [],
        preserved: [],
        preservedEmpty: [],
        extra: [],
    };
    for (const entry of template) {
        if (entry.type === "raw") {
            output.push(entry.text);
            continue;
        }
        seen.add(entry.key);
        const current = existing.get(entry.key);
        if (!current) {
            output.push(`${entry.key}=${entry.value}`);
            summary.added.push(entry.key);
            continue;
        }
        if (current.value !== "") {
            output.push(`${entry.key}=${current.value}`);
            summary.preserved.push(entry.key);
            continue;
        }
        if (entry.value !== "") {
            output.push(`${entry.key}=${entry.value}`);
            summary.filledDefaults.push(entry.key);
            continue;
        }
        output.push(`${entry.key}=`);
        summary.preservedEmpty.push(entry.key);
    }
    const extras = [...existing.values()].filter((entry) => !seen.has(entry.key));
    if (extras.length > 0) {
        if (output.length > 0 && output.at(-1) !== "") {
            output.push("");
        }
        output.push("# Extra keys from existing .env");
        for (const extra of extras) {
            output.push(`${extra.key}=${extra.value}`);
            summary.extra.push(extra.key);
        }
    }
    return {
        text: `${output.join("\n")}\n`,
        summary,
    };
}
function timestamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "-",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
        "-",
        milliseconds,
    ].join("");
}
function printSummary(target, summary, apply) {
    printKeyValue("target:", `${apply ? textGreen("updated") : textBlue("would update")} ${colorPath(target)}`, 16);
    if (!apply) {
        console.log(textDim("dry-run only. Re-run with -y or --yes to apply changes."));
    }
    printKeyValue("added:", colorCount(String(summary.added.length)), 16);
    printKeyValue("filled defaults:", colorCount(String(summary.filledDefaults.length)), 16);
    printKeyValue("preserved:", textDim(String(summary.preserved.length)), 16);
    printKeyValue("preserved empty:", textDim(String(summary.preservedEmpty.length)), 16);
    printKeyValue("extra:", textBlue(String(summary.extra.length)), 16);
    printKeys("added keys", summary.added);
    printKeys("filled defaults keys", summary.filledDefaults);
    printKeys("extra keys", summary.extra);
}
function printPlan(target, summary) {
    printSummary(target, summary, false);
}
function printResult(target, summary) {
    console.log("");
    printSummary(target, summary, true);
}
function printKeys(label, keys) {
    if (keys.length === 0) {
        return;
    }
    console.log(textBold(`${label}:`));
    for (const key of keys) {
        console.log(`  ${textBlue(key)}`);
    }
}
async function createBackup(target) {
    const base = `${target}.backup-${timestamp()}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const backupPath = attempt === 0 ? base : `${base}-${attempt}`;
        try {
            await copyFile(target, backupPath, fsConstants.COPYFILE_EXCL);
            return backupPath;
        }
        catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }
        }
    }
    throw new Error(`failed to create unique backup for ${target}`);
}
export async function runEnvsync(argv) {
    const args = parseArgs(argv);
    const exampleText = await readTextIfExists(args.source);
    if (exampleText === null) {
        throw new Error(`source file not found: ${args.source}`);
    }
    const existingTargetText = await readTextIfExists(args.target);
    const existingText = existingTargetText ?? "";
    const result = buildEnv(exampleText, existingText);
    if (!args.apply) {
        printPlan(basename(args.target), result.summary);
        return;
    }
    printPlan(basename(args.target), result.summary);
    if (args.backup && existingTargetText !== null) {
        const backupPath = await createBackup(args.target);
        console.log(`backup: ${textBlue(backupPath)}`);
    }
    await writeTextFile(args.target, result.text);
    printResult(basename(args.target), result.summary);
}
