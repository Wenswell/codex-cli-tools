import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendBoundedJsonLine } from "../dist/lib/runtime-log.js";

test("appendBoundedJsonLine keeps newest complete lines within byte limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-log-"));
  const path = join(dir, "history.jsonl");
  try {
    await appendBoundedJsonLine(path, { index: 1, value: "first" }, { maxBytes: 80, mode: 0o600 });
    await appendBoundedJsonLine(path, { index: 2, value: "second" }, { maxBytes: 80, mode: 0o600 });
    await appendBoundedJsonLine(path, { index: 3, value: "third" }, { maxBytes: 80, mode: 0o600 });

    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.index), [2, 3]);
    assert.ok((await stat(path)).size <= 80);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendBoundedJsonLine keeps a newest record that is larger than trim target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-log-"));
  const path = join(dir, "history.jsonl");
  try {
    await appendBoundedJsonLine(path, { index: 1, value: "older" }, { maxBytes: 120, trimToBytes: 60, mode: 0o600 });
    await appendBoundedJsonLine(path, { index: 2, value: "x".repeat(85) }, { maxBytes: 120, trimToBytes: 60, mode: 0o600 });

    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.index), [2]);
    assert.ok((await stat(path)).size <= 120);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
