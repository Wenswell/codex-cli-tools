import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeTextFile(path: string, content: string, mode?: number): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
  if (mode !== undefined) {
    await chmod(path, mode);
  }
}
