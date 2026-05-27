import { copyFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename } from "node:path";
import { createTwoFilesPatch } from "diff";
import { readTextIfExists, writeTextFile } from "../lib/fs.js";
import { colorCount, colorPath, printKeyValue } from "../lib/output.js";
import { maskSecret, textBlue, textBold, textDim, textGreen, textRed } from "../lib/text.js";
const envLinePattern = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
function parseArgs(argv) {
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
        if (arg === "help" || arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }
        throw new Error(`unknown argument: ${arg}`);
    }
    return args;
}
function requireValue(argv, index) {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
        throw new Error(`${argv[index]} requires a value`);
    }
    return value;
}
function printHelp() {
    console.log([
        "Usage:",
        "  senv                                      # preview .env update from .env.example",
        "  senv -y                                  # update .env from .env.example",
        "  senv --source FILE --target FILE -y      # update a target env file from a source template",
        "  senv -b -y                               # back up target before writing",
        "  senv help                                # show this help",
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
        console.log(textDim("preview only. Re-run with -y or --yes to apply changes."));
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
function printPlan(target, current, next, summary) {
    printSummary(target, summary, false);
    printDiff(target, current, next);
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
function shouldMaskEnvKey(key) {
    return /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL)/i.test(key);
}
function redactEnvDiffContent(content) {
    return splitLines(content).map((line) => {
        const match = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*=)(.*)$/.exec(line);
        if (!match) {
            return line;
        }
        const key = match[2].slice(0, -1);
        const value = match[3];
        if (!value || !shouldMaskEnvKey(key)) {
            return line;
        }
        return `${match[1] ?? ""}${match[2]}${maskSecret(value)}`;
    }).join("\n");
}
function printDiff(target, current, next) {
    if (current === next) {
        return;
    }
    const patch = createTwoFilesPatch(`current/${target}`, `next/${target}`, redactEnvDiffContent(current), redactEnvDiffContent(next), "", "", { context: 3 });
    console.log("");
    console.log(`${textBold("File:")} ${textBlue(target)}`);
    for (const line of patch.split("\n")) {
        if (line.startsWith("===")) {
            continue;
        }
        if (line.startsWith("--- ") || line.startsWith("+++ ")) {
            console.log(textDim(`  ${line}`));
            continue;
        }
        if (line.startsWith("@@")) {
            console.log(textBlue(`  ${line}`));
            continue;
        }
        if (line.startsWith("+")) {
            console.log(textGreen(`  ${line}`));
            continue;
        }
        if (line.startsWith("-")) {
            console.log(textRed(`  ${line}`));
            continue;
        }
        console.log(textDim(`  ${line}`));
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
    const targetLabel = basename(args.target);
    if (!args.apply) {
        printPlan(targetLabel, existingText, result.text, result.summary);
        return;
    }
    printPlan(targetLabel, existingText, result.text, result.summary);
    if (args.backup && existingTargetText !== null) {
        const backupPath = await createBackup(args.target);
        console.log(`backup: ${textBlue(backupPath)}`);
    }
    await writeTextFile(args.target, result.text);
    printResult(targetLabel, result.summary);
}
