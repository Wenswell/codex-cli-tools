import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ensureDir, writeTextFile } from "../lib/fs.js";
import { codexDir } from "../lib/paths.js";
import { colorPath, printKeyValue } from "../lib/output.js";
import { sqliteJson, sqliteRun, sqlString } from "../lib/sqlite.js";
import { textBlue, textBold, textDim, textGreen, textRed } from "../lib/text.js";
function parseArgs(argv) {
    if (argv.includes("--help") || argv.includes("-h")) {
        printHelp();
        process.exit(0);
    }
    const positional = [];
    let prefix = false;
    let apply = false;
    let sessionsOnly = false;
    for (const arg of argv) {
        if (arg === "--prefix") {
            prefix = true;
            continue;
        }
        if (arg === "--sessions-only") {
            sessionsOnly = true;
            continue;
        }
        if (arg === "--apply") {
            apply = true;
            continue;
        }
        if (arg === "--dry-run") {
            apply = false;
            continue;
        }
        if (arg.startsWith("-")) {
            throw new Error(`unknown argument: ${arg}`);
        }
        positional.push(arg);
    }
    if (positional.length !== 2) {
        printHelp();
        throw new Error("expected OLD_PATH and NEW_PATH");
    }
    return {
        oldPath: normalizeInputPath(positional[0]),
        newPath: normalizeInputPath(positional[1]),
        prefix,
        apply,
        sessionsOnly,
    };
}
function normalizeInputPath(path) {
    const resolved = resolve(path);
    return resolved === "/" ? resolved : resolved.replace(/\/+$/, "");
}
function printHelp() {
    console.log([
        "Usage:",
        "  codex-rename OLD_PATH NEW_PATH                         # preview directory rename and exact session cwd update",
        "  codex-rename OLD_PATH NEW_PATH --prefix                # preview directory rename and child session cwd updates",
        "  codex-rename OLD_PATH NEW_PATH --apply                 # rename directory and update exact session cwd matches",
        "  codex-rename OLD_PATH NEW_PATH --prefix --apply        # rename directory and update child session cwd matches",
        "  codex-rename OLD_PATH NEW_PATH --sessions-only --prefix # update sessions only after directory was already renamed",
    ].join("\n"));
}
async function pathExists(path) {
    try {
        await access(path, constants.F_OK);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}
async function planDirectoryRename(args) {
    if (args.sessionsOnly) {
        return { action: "skip", oldPath: args.oldPath, newPath: args.newPath };
    }
    if (args.oldPath === "/" || args.newPath === "/") {
        throw new Error("refusing to rename filesystem root");
    }
    if (args.oldPath === args.newPath) {
        throw new Error("OLD_PATH and NEW_PATH must be different");
    }
    if (args.newPath.startsWith(`${args.oldPath}/`)) {
        throw new Error("NEW_PATH must not be inside OLD_PATH");
    }
    const oldExists = await pathExists(args.oldPath);
    const newExists = await pathExists(args.newPath);
    if (!oldExists) {
        throw new Error(`source path not found: ${args.oldPath}`);
    }
    const oldInfo = await lstat(args.oldPath);
    if (!oldInfo.isDirectory()) {
        throw new Error(`source path is not a directory: ${args.oldPath}`);
    }
    if (newExists) {
        throw new Error(`target path already exists: ${args.newPath}`);
    }
    await access(dirname(args.newPath), constants.W_OK);
    return { action: "rename", oldPath: args.oldPath, newPath: args.newPath };
}
async function applyDirectoryRename(plan) {
    if (plan.action === "skip") {
        return false;
    }
    await rename(plan.oldPath, plan.newPath);
    return true;
}
async function findStateDb() {
    const dir = codexDir();
    const entries = await readdir(dir);
    const candidates = await Promise.all(entries
        .filter((entry) => /^state.*\.sqlite$/.test(entry))
        .map(async (entry) => {
        const path = join(dir, entry);
        const info = await stat(path);
        return { path, mtimeMs: info.mtimeMs };
    }));
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = candidates[0];
    if (!latest) {
        throw new Error(`no state*.sqlite found in ${dir}`);
    }
    return latest.path;
}
function matchWhere(args) {
    const old = sqlString(args.oldPath);
    if (!args.prefix) {
        return `cwd = ${old}`;
    }
    const oldWithSlash = sqlString(`${args.oldPath}/`);
    return `(cwd = ${old} OR substr(cwd, 1, ${args.oldPath.length + 1}) = ${oldWithSlash})`;
}
async function loadMatches(dbPath, args) {
    const rows = await sqliteJson(dbPath, `select id, cwd, rollout_path from threads where ${matchWhere(args)} order by updated_at desc, id desc;`);
    return rows.map((row) => ({
        ...row,
        newCwd: args.prefix
            ? `${args.newPath}${row.cwd.slice(args.oldPath.length)}`
            : args.newPath,
    }));
}
async function countMatches(dbPath, args) {
    const rows = await sqliteJson(dbPath, `select count(*) as count from threads where ${matchWhere(args)};`);
    return rows[0]?.count ?? 0;
}
async function countNewCwds(dbPath, planned) {
    if (planned.length === 0) {
        return 0;
    }
    const values = planned.map((row) => sqlString(row.newCwd)).join(", ");
    const rows = await sqliteJson(dbPath, `select count(*) as count from threads where cwd in (${values});`);
    return rows[0]?.count ?? 0;
}
function uniqueRolloutPaths(rows) {
    return [...new Set(rows.map((row) => row.rollout_path))];
}
async function assertFileReadable(path) {
    try {
        await access(path, constants.R_OK);
    }
    catch {
        throw new Error(`rollout file is not readable: ${path}`);
    }
}
async function assertFileWritable(path) {
    try {
        await access(path, constants.W_OK);
    }
    catch {
        throw new Error(`rollout file is not writable: ${path}`);
    }
}
function parseFirstJsonLine(text, path) {
    const newlineIndex = text.indexOf("\n");
    const firstWithMaybeCr = newlineIndex === -1 ? text : text.slice(0, newlineIndex);
    const lineEnding = firstWithMaybeCr.endsWith("\r") ? "\r\n" : "\n";
    const first = firstWithMaybeCr.endsWith("\r") ? firstWithMaybeCr.slice(0, -1) : firstWithMaybeCr;
    const rest = newlineIndex === -1 ? "" : text.slice(newlineIndex + 1);
    try {
        const meta = JSON.parse(first);
        if (!meta || typeof meta !== "object" || !meta.payload || typeof meta.payload !== "object") {
            throw new Error("first JSON line is not session_meta payload");
        }
        return { meta, rest, lineEnding };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to parse first line of ${path}: ${reason}`);
    }
}
async function preflightRollouts(rows) {
    const byPath = new Map();
    for (const row of rows) {
        const group = byPath.get(row.rollout_path) ?? [];
        group.push(row);
        byPath.set(row.rollout_path, group);
    }
    for (const [path, group] of byPath) {
        await assertFileReadable(path);
        const text = await readFile(path, "utf8");
        const { meta } = parseFirstJsonLine(text, path);
        const first = group[0];
        if (meta.payload?.cwd !== first.cwd) {
            throw new Error(`rollout cwd mismatch: ${path} has ${String(meta.payload?.cwd)}, sqlite has ${first.cwd}`);
        }
    }
}
function backupDestination(backupDir, path) {
    const rel = relative(codexDir(), path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        return join(backupDir, rel);
    }
    return join(backupDir, "external", basename(path));
}
async function createBackup(dbPath, rolloutPaths) {
    const backupRoot = join(codexDir(), "backups");
    await ensureDir(backupRoot);
    const backupDir = await createUniqueBackupDir(backupRoot, `session-cwd-migration-${timestamp()}`);
    const dbBackup = join(backupDir, basename(dbPath));
    await copyFile(dbPath, dbBackup);
    for (const path of rolloutPaths) {
        const target = backupDestination(backupDir, path);
        await ensureDir(dirname(target));
        await copyFile(path, target);
    }
    return backupDir;
}
async function createUniqueBackupDir(parent, name) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const path = join(parent, attempt === 0 ? name : `${name}-${attempt}`);
        try {
            await mkdir(path);
            return path;
        }
        catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }
        }
    }
    throw new Error(`failed to create unique backup directory under ${parent}`);
}
function timestamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${milliseconds}`;
}
function buildUpdateSql(rows) {
    const statements = rows.map((row) => (`update threads set cwd = ${sqlString(row.newCwd)} where id = ${sqlString(row.id)};`));
    return ["begin immediate;", ...statements, "commit;"].join("\n");
}
function buildRollbackSql(rows) {
    const statements = rows.map((row) => (`update threads set cwd = ${sqlString(row.cwd)} where id = ${sqlString(row.id)};`));
    return ["begin immediate;", ...statements, "commit;"].join("\n");
}
function buildRolloutText(text, path, fromCwd, toCwd) {
    const { meta, rest, lineEnding } = parseFirstJsonLine(text, path);
    if (meta.payload?.cwd !== fromCwd) {
        throw new Error(`rollout cwd changed before write: ${path}`);
    }
    meta.payload.cwd = toCwd;
    return `${JSON.stringify(meta)}${lineEnding}${rest}`;
}
async function planRolloutWrites(rows) {
    const byPath = new Map();
    for (const row of rows) {
        const group = byPath.get(row.rollout_path) ?? [];
        group.push(row);
        byPath.set(row.rollout_path, group);
    }
    const planned = [];
    for (const [path, group] of byPath) {
        await assertFileReadable(path);
        await assertFileWritable(path);
        const row = group[0];
        if (group.some((item) => item.cwd !== row.cwd || item.newCwd !== row.newCwd)) {
            throw new Error(`matching threads share one rollout file with different cwd changes: ${path}`);
        }
        const text = await readFile(path, "utf8");
        planned.push({
            path,
            fromCwd: row.cwd,
            toCwd: row.newCwd,
            originalText: text,
            nextText: buildRolloutText(text, path, row.cwd, row.newCwd),
        });
    }
    return planned;
}
async function assertRolloutPlansFresh(plannedRollouts) {
    for (const rollout of plannedRollouts) {
        const text = await readFile(rollout.path, "utf8");
        buildRolloutText(text, rollout.path, rollout.fromCwd, rollout.toCwd);
    }
}
async function updateRollout(plan) {
    const text = await readFile(plan.path, "utf8");
    buildRolloutText(text, plan.path, plan.fromCwd, plan.toCwd);
    await writeTextFile(plan.path, plan.nextText);
}
async function applyMigration(dbPath, rows, plannedRollouts) {
    await assertRolloutPlansFresh(plannedRollouts);
    await sqliteRun(dbPath, buildUpdateSql(rows));
    let updated = 0;
    try {
        for (const rollout of plannedRollouts) {
            await updateRollout(rollout);
            updated += 1;
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
            await rollbackMigration(dbPath, rows, plannedRollouts.slice(0, updated));
        }
        catch (rollbackError) {
            const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(`JSONL update failed after SQLite update: ${message}; rollback incomplete: ${rollbackMessage}`);
        }
        throw new Error(`JSONL update failed after SQLite update; rolled back migrated state: ${message}`);
    }
    return updated;
}
async function rollbackMigration(dbPath, rows, writtenRollouts) {
    const failures = [];
    try {
        await sqliteRun(dbPath, buildRollbackSql(rows));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`sqlite rollback failed: ${message}`);
    }
    for (const rollout of writtenRollouts) {
        try {
            await writeTextFile(rollout.path, rollout.originalText);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(`jsonl rollback failed for ${rollout.path}: ${message}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(failures.join("; "));
    }
}
async function verifyRollouts(rows) {
    let synced = 0;
    for (const row of rows) {
        const text = await readFile(row.rollout_path, "utf8");
        const { meta } = parseFirstJsonLine(text, row.rollout_path);
        if (meta.payload?.cwd !== row.newCwd) {
            throw new Error(`verification failed for ${row.rollout_path}: expected ${row.newCwd}, got ${String(meta.payload?.cwd)}`);
        }
        synced += 1;
    }
    return synced;
}
function printDirectoryPlan(plan) {
    printKeyValue("directory:", textBlue(plan.action), 18);
    printKeyValue("from:", colorPath(plan.oldPath), 18);
    printKeyValue("to:", colorPath(plan.newPath), 18);
}
function printPlan(args, directoryPlan, dbPath, rows, dryRun) {
    printDirectoryPlan(directoryPlan);
    printKeyValue("mode:", textBlue(args.prefix ? "prefix" : "exact"), 18);
    printKeyValue("state:", colorPath(dbPath), 18);
    printKeyValue("old:", textRed(args.oldPath), 18);
    printKeyValue("new:", textGreen(args.newPath), 18);
    printKeyValue("matched sessions:", textGreen(String(rows.length)), 18);
    console.log("");
    console.log(textBold("will update:"));
    for (const row of rows) {
        console.log(`  ${textRed(row.cwd)} ${textDim("->")} ${textGreen(row.newCwd)}`);
    }
    console.log("");
    console.log(textBold("rollout files:"));
    for (const path of uniqueRolloutPaths(rows)) {
        console.log(`  ${textBlue(path)}`);
    }
    if (dryRun) {
        console.log("");
        console.log(textDim("dry-run only. Add --apply to write changes."));
    }
}
export async function runCodexRename(argv) {
    const args = parseArgs(argv);
    const directoryPlan = await planDirectoryRename(args);
    const dbPath = await findStateDb();
    const rows = await loadMatches(dbPath, args);
    if (rows.length === 0) {
        printDirectoryPlan(directoryPlan);
        printKeyValue("mode:", textBlue(args.prefix ? "prefix" : "exact"), 18);
        printKeyValue("state:", colorPath(dbPath), 18);
        printKeyValue("matched sessions:", textDim("0"), 18);
        if (args.apply) {
            const renamed = await applyDirectoryRename(directoryPlan);
            printKeyValue("directory changed:", renamed ? textGreen("yes") : textDim("no"), 18);
        }
        else if (!args.apply) {
            console.log("");
            console.log(textDim("dry-run only. Add --apply to write changes."));
        }
        return;
    }
    await preflightRollouts(rows);
    if (!args.apply) {
        printPlan(args, directoryPlan, dbPath, rows, true);
        return;
    }
    printPlan(args, directoryPlan, dbPath, rows, false);
    console.log("");
    const plannedRollouts = await planRolloutWrites(rows);
    const backupDir = await createBackup(dbPath, uniqueRolloutPaths(rows));
    const directoryRenamed = await applyDirectoryRename(directoryPlan);
    const jsonlUpdated = await applyMigration(dbPath, rows, plannedRollouts);
    const oldRemaining = await countMatches(dbPath, args);
    const threadsAtNewCwd = await countNewCwds(dbPath, rows);
    const synced = await verifyRollouts(rows);
    printKeyValue("backup:", colorPath(backupDir), 18);
    printKeyValue("directory changed:", directoryRenamed ? textGreen("yes") : textDim("no"), 18);
    printKeyValue("sqlite updated:", textGreen(String(rows.length)), 18);
    printKeyValue("jsonl updated:", textGreen(String(jsonlUpdated)), 18);
    printKeyValue("old cwd remaining:", oldRemaining === 0 ? textGreen("0") : textRed(String(oldRemaining)), 18);
    printKeyValue("threads at new cwd:", textGreen(String(threadsAtNewCwd)), 18);
    printKeyValue("jsonl synced:", textGreen(String(synced)), 18);
}
