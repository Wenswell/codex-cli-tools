import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
export async function ensureDir(path) {
    await mkdir(path, { recursive: true });
}
export async function readTextIfExists(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
export async function writeTextFile(path, content, mode) {
    await ensureDir(dirname(path));
    await writeFile(path, content, "utf8");
    if (mode !== undefined) {
        await chmod(path, mode);
    }
}
