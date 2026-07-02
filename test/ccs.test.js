import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("tools print package version", async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const tools = ["ccs", "ccx", "ccxs", "clvm", "cx", "cxx", "cxxs", "senv", "codex-rename"];
  for (const tool of tools) {
    assert.equal(await runTool(tool, ["version"]), `${tool} ${packageJson.version}\n`);
    assert.equal(await runTool(tool, ["-v"]), `${tool} ${packageJson.version}\n`);
  }
});

async function runTool(tool, args) {
  const home = await mkdtemp(join(tmpdir(), "ccs-version-home-"));
  try {
    return await execNode([`dist/bin/${tool}.js`, ...args], {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function execNode(args, env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: repoRoot, env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
