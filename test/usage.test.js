import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeUsageCommand } from "../dist/lib/usage.js";
import { execNodeScript, execNodeStdout } from "./helpers/terminal.js";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), "usage-home-"));
  try {
    return await run(home, { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, ".cache"), NO_COLOR: "1", CODEX_TOOLS_USAGE: "" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const readRecords = async (home) => (await readFile(join(home, ".cache", "codex-tools", "usage.jsonl"), "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line));

test("usage commands keep known subcommands and flag names only", () => {
  const cases = [
    ["ccs", [], "ccs", []],
    ["ccs", ["secret-profile"], "ccs <profile>", []],
    ["ccs", ["models", "secret-profile", "--json"], "ccs models", ["--json"]],
    ["ccs", ["proxy"], "ccs proxy", []],
    ["ccs", ["proxy", "--history", "3"], "ccs proxy", ["--history"]],
    ["ccs", ["proxy", "watch", "--view=cost"], "ccs proxy watch", ["--view"]],
    ["ccs", ["proxy", "secret"], "ccs proxy <arg>", []],
    ["cimg", ["-p", "secret prompt", "-i", "/home/me/secret.png", "--ratio", "16:9"], "cimg", ["--ratio", "-i", "-p"]],
    ["cx", ["run", "secret-profile", "--model", "gpt", "do the secret thing"], "cx run", []],
    ["ccx", ["--resume", "secret"], "ccx", []],
    ["codex-rename", ["/old/secret", "/new/secret", "--prefix"], "codex-rename", ["--prefix"]],
  ];
  for (const [tool, argv, command, flags] of cases) {
    assert.deepEqual(normalizeUsageCommand(tool, argv), { command, flags }, `${tool} ${argv.join(" ")}`);
  }
  assert.equal(normalizeUsageCommand("ccs", ["proxy", "serve"]), null);
});

test("tools append one usage record per run without argument values", async () => {
  await withHome(async (home, env) => {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(join(home, ".config", "codex-tools", "profiles.json"), JSON.stringify({ profiles: {}, current: "test001" }), "utf8");
    await execNodeStdout([join(repoRoot, "dist/bin/ccs.js"), "list"], { cwd: repoRoot, env });
    await assert.rejects(() => execNodeStdout([join(repoRoot, "dist/bin/ccs.js"), "models", "missing-secret"], { cwd: repoRoot, env }));
    const text = await readFile(join(home, ".cache", "codex-tools", "usage.jsonl"), "utf8");
    assert.equal(text.includes("missing-secret"), false);
    const records = await readRecords(home);
    assert.deepEqual(records.map(({ tool, command, via, tty, outcome, exit_code: exitCode }) => ({ tool, command, via, tty, outcome, exitCode })), [
      { tool: "ccs", command: "ccs list", via: "argv", tty: false, outcome: "ok", exitCode: 0 },
      { tool: "ccs", command: "ccs models", via: "argv", tty: false, outcome: "error", exitCode: 1 },
    ]);
    assert.equal(records[0].version, 1);
    assert.ok(Number.isInteger(records[0].duration_ms));

    await execNodeStdout([join(repoRoot, "dist/bin/ccs.js"), "list"], { cwd: repoRoot, env: { ...env, CODEX_TOOLS_USAGE: "off" } });
    assert.equal((await readRecords(home)).length, 2);
  });
});

test("prompt answers record cancellation and kept defaults", async () => {
  await withHome(async (home, env) => {
    await execNodeScript(`
      import { PassThrough } from "node:stream";
      const input = new PassThrough();
      Object.defineProperty(input, "isTTY", { value: true });
      input.setRawMode = () => input;
      Object.defineProperty(process, "stdin", { value: input });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      const { startUsage } = await import(${JSON.stringify(join(repoRoot, "dist/lib/usage.js"))});
      const { select, input: ask } = await import(${JSON.stringify(join(repoRoot, "dist/lib/prompt.js"))});
      const { confirmApply } = await import(${JSON.stringify(join(repoRoot, "dist/lib/confirm.js"))});
      startUsage("ccs", ["use"]);
      setTimeout(() => input.write("\\r"), 20);
      await select("Pick one", [{ value: 1, label: "one" }, { value: 2, label: "two" }]);
      setTimeout(() => input.write("7\\r"), 20);
      await ask("Count", { default: "5" });
      setTimeout(() => input.write("no\\n"), 20);
      await confirmApply();
    `, { cwd: repoRoot, env });
    const [record] = await readRecords(home);
    assert.equal(record.outcome, "cancelled");
    assert.equal(record.tty, true);
    assert.deepEqual(record.prompts, [
      { prompt: "Pick one", outcome: "answered", kept_default: true },
      { prompt: "Count", outcome: "answered", kept_default: false },
      { prompt: "Apply changes?", outcome: "cancelled", kept_default: null },
    ]);
  });
});

test("ccs stats summarizes commands and prompts", async () => {
  await withHome(async (home, env) => {
    const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const record = (command, outcome, via, durationMs, prompts = []) => ({
      version: 1, recorded_at: at(5), tool: "ccs", command, flags: [], via, tty: true, outcome,
      exit_code: outcome === "error" ? 1 : 0, duration_ms: durationMs, package_version: "0.0.0", prompts,
    });
    const lines = [
      record("ccs use", "ok", "argv", 100, [{ prompt: "Switch to which profile?", outcome: "answered", kept_default: true }]),
      record("ccs use", "ok", "shortcut", 300, [{ prompt: "Switch to which profile?", outcome: "answered", kept_default: false }]),
      record("ccs use", "cancelled", "argv", 200, [{ prompt: "Switch to which profile?", outcome: "cancelled", kept_default: null }]),
      record("ccs list", "error", "argv", 10),
    ];
    await mkdir(join(home, ".cache", "codex-tools"), { recursive: true });
    await writeFile(join(home, ".cache", "codex-tools", "usage.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n`, "utf8");
    const output = await execNodeStdout([join(repoRoot, "dist/bin/ccs.js"), "stats"], { cwd: repoRoot, env: { ...env, CODEX_TOOLS_USAGE: "off" } });
    assert.match(output, /records:\s+4 since 5m ago/);
    assert.match(output, /ccs use\s+3\s+5m ago\s+2\s+0\s+1\s+200ms\s+33%/);
    assert.match(output, /ccs list\s+1\s+5m ago\s+0\s+1\s+0\s+10ms\s+0%/);
    assert.match(output, /Switch to which profile\?\s+ccs use\s+3\s+33%\s+50%/);
  });
});
