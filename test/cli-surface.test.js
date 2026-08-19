import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execNodeStdout } from "./helpers/terminal.js";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const publicTools = Object.entries(packageJson.bin).sort(([left], [right]) => left.localeCompare(right));

test("all public tools support shared package version commands", async () => {
  for (const [tool, entrypoint] of publicTools) {
    for (const argument of ["version", "-v"]) {
      assert.equal(await runTool(entrypoint, [argument]), `${tool} ${packageJson.version}\n`);
    }
  }
});

test("all public tools support dedicated help commands", async () => {
  for (const [tool, entrypoint] of publicTools) {
    for (const argument of ["help", "-h", "--help"]) {
      const output = await runTool(entrypoint, [argument]);
      assert.match(output, /^Usage:/m, `${tool} ${argument} must print Usage`);
      assert.match(output, new RegExp(`^  ${escapeRegExp(tool)}(?: |$)`, "m"), `${tool} ${argument} must name its own command`);
      assert.match(output, /# /, `${tool} ${argument} must comment its commands`);
    }
  }
});

test("Claude wrappers keep their no-argument forwarding behavior", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "cli-surface-claude-bin-"));
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
  await chmod(claudePath, 0o755);
  try {
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, NO_COLOR: "1" };
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, packageJson.bin.ccx)], { cwd: repoRoot, env })), [
      "--dangerously-skip-permissions",
    ]);
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, packageJson.bin.ccxs)], { cwd: repoRoot, env })), [
      "--dangerously-skip-permissions",
      "--resume",
    ]);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

async function runTool(entrypoint, args) {
  const home = await mkdtemp(join(tmpdir(), "cli-surface-home-"));
  try {
    return await execNodeStdout([join(repoRoot, entrypoint), ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, ".cache"),
        NO_COLOR: "1",
      },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
