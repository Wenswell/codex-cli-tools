import { execFile } from "node:child_process";

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function sqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const stdout = await sqliteExec(dbPath, ["-json"], sql);
  if (!stdout.trim()) {
    return [];
  }
  return JSON.parse(stdout) as T[];
}

export async function sqliteRun(dbPath: string, sql: string): Promise<void> {
  await sqliteExec(dbPath, [], sql);
}

function sqliteExec(dbPath: string, args: string[], input?: string): Promise<string> {
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
