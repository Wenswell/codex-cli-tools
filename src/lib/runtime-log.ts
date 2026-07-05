import { createHash } from "node:crypto";
import { access, appendFile, chmod, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir, writeTextFileAtomic } from "./fs.js";

export type RuntimeRawReference = {
  sha256: string;
  bytes: number;
  path: string | null;
  stored: boolean;
  omitted_reason?: "payload_too_large";
  max_bytes?: number;
};

export type RuntimeRawWriteResult = {
  ref: RuntimeRawReference | null;
  retainedPath: string | null;
};

export type RuntimeRawArchiveOptions = {
  dir: string;
  maxPayloadBytes: number;
  maxFiles: number;
  maxBytes: number;
  mode?: number;
};

export type JsonLineRetentionOptions = {
  maxBytes: number;
  trimToBytes?: number;
  mode?: number;
};

export async function appendJsonLine(path: string, value: unknown, mode = 0o600): Promise<void> {
  await appendRuntimeLine(path, `${JSON.stringify(value)}\n`, mode);
}

export async function appendBoundedJsonLine(path: string, value: unknown, options: JsonLineRetentionOptions): Promise<void> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error("jsonl maxBytes must be a positive integer");
  }
  const trimToBytes = options.trimToBytes ?? Math.floor(options.maxBytes * 0.75);
  if (!Number.isSafeInteger(trimToBytes) || trimToBytes <= 0 || trimToBytes > options.maxBytes) {
    throw new Error("jsonl trimToBytes must be a positive integer less than or equal to maxBytes");
  }
  const mode = options.mode ?? 0o600;
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > options.maxBytes) {
    throw new Error(`jsonl record exceeds maxBytes: ${path}`);
  }
  await appendRuntimeLine(path, line, mode);
  await trimJsonLineFileToBytes(path, options.maxBytes, trimToBytes, mode);
}

async function appendRuntimeLine(path: string, line: string, mode: number): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, line, { encoding: "utf8", mode });
  await chmod(path, mode);
}

export async function writeJsonStateAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  await writeTextFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function writeRuntimeRawArchive(raw: unknown, options: RuntimeRawArchiveOptions): Promise<RuntimeRawWriteResult> {
  if (raw === null || raw === undefined) {
    return { ref: null, retainedPath: null };
  }

  const mode = options.mode ?? 0o600;
  const text = JSON.stringify(raw);
  const bytes = Buffer.byteLength(text, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  if (bytes > options.maxPayloadBytes) {
    return {
      ref: {
        sha256,
        bytes,
        path: null,
        stored: false,
        omitted_reason: "payload_too_large",
        max_bytes: options.maxPayloadBytes,
      },
      retainedPath: null,
    };
  }

  const path = join(options.dir, `${sha256}.json`);
  const created = !(await pathExists(path));
  if (created) {
    await writeTextFileAtomic(path, `${text}\n`, mode);
  }
  return {
    ref: {
      sha256,
      bytes,
      path,
      stored: true,
    },
    retainedPath: created ? path : null,
  };
}

export async function pruneRuntimeRawArchive(currentPath: string, options: RuntimeRawArchiveOptions): Promise<void> {
  let entries;
  try {
    entries = await readdir(options.dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      continue;
    }
    const path = join(options.dir, entry.name);
    const fileStat = await stat(path);
    files.push({
      path,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    });
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));

  const keep = new Set<string>([currentPath]);
  let keptFiles = 0;
  let keptBytes = 0;
  for (const file of files) {
    if (keep.has(file.path)) {
      keptFiles += 1;
      keptBytes += file.size;
      continue;
    }
    if (keptFiles < options.maxFiles && keptBytes + file.size <= options.maxBytes) {
      keep.add(file.path);
      keptFiles += 1;
      keptBytes += file.size;
    }
  }

  await Promise.all(files
    .filter((file) => !keep.has(file.path))
    .map((file) => rm(file.path, { force: true })));
}

async function trimJsonLineFileToBytes(path: string, maxBytes: number, trimToBytes: number, mode: number): Promise<void> {
  const fileStat = await stat(path);
  if (fileStat.size <= maxBytes) {
    return;
  }

  const text = await readFile(path, "utf8");
  const lines = text.split("\n").filter((line) => line.length > 0);
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = `${lines[index]}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes > 0 && bytes + lineBytes > trimToBytes) {
      break;
    }
    kept.push(lines[index]);
    bytes += lineBytes;
  }

  kept.reverse();
  await writeTextFileAtomic(path, kept.length === 0 ? "" : `${kept.join("\n")}\n`, mode);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
