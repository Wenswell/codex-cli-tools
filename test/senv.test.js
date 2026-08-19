import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execNodeStdout } from "./helpers/terminal.js";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const senvPath = join(repoRoot, "dist/bin/senv.js");

test("senv discovers one env example and derives its target", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "senv-discovery-"));
  try {
    await writeFile(join(cwd, "runtime.env.example"), "API_URL=https://example.com\n", "utf8");
    await writeFile(join(cwd, "runtime.env"), "API_URL=\n", "utf8");

    const output = await execNodeStdout([senvPath], { cwd });

    assert.match(output, /target:\s+would update runtime\.env/);
    assert.match(output, /not applied/);
    assert.equal(await readFile(join(cwd, "runtime.env"), "utf8"), "API_URL=\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("senv rejects ambiguous automatic source discovery", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "senv-ambiguous-"));
  try {
    await writeFile(join(cwd, ".env.example"), "A=1\n", "utf8");
    await writeFile(join(cwd, "runtime.env.example"), "B=2\n", "utf8");

    await assert.rejects(
      () => execNodeStdout([senvPath], { cwd }),
      /multiple source files found: \.env\.example, runtime\.env\.example; use --source and --target/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
