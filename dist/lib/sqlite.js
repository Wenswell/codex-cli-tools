import { execFile } from "node:child_process";
export function sqlString(value) {
    return `'${value.replaceAll("'", "''")}'`;
}
export async function sqliteJson(dbPath, sql) {
    const stdout = await sqliteExec(dbPath, ["-json"], sql);
    if (!stdout.trim()) {
        return [];
    }
    return JSON.parse(stdout);
}
export async function sqliteRun(dbPath, sql) {
    await sqliteExec(dbPath, [], sql);
}
function sqliteExec(dbPath, args, input) {
    return new Promise((resolve, reject) => {
        const child = execFile("sqlite3", [...args, dbPath], (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
                return;
            }
            resolve(stdout);
        });
        if (input !== undefined) {
            child.stdin?.end(input);
        }
    });
}
