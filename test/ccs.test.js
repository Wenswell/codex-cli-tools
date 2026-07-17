import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCcs as runCcsCommand } from "../dist/commands/ccs.js";
import { shutdownProxyRuntime } from "../dist/commands/ccs-proxy.js";
import { captureStdout, execNodeScript, execNodeStdout, spawnNode, stdoutPropertiesScript } from "./helpers/terminal.js";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("ccs help lists the current proxy command surface", async () => {
  const output = await captureStdout(() => runCcsCommand(["help"]));
  assert.match(output, /ccs proxy \[watch\|mode\|config\|install\|restart\|restore\|serve\]/);
  assert.doesNotMatch(output, /proxy.*stop|proxy.*--once/);
});

test("ccs status footer separates direct commands from namespaces", async () => {
  const home = await writeProfiles({
    profiles: { input: { baseURL: "https://example.invalid", apiKey: "" } },
    current: "input",
  });
  try {
    const output = await runCcs(["dist/bin/ccs.js"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    assert.match(output, /^commands:/m);
    assert.match(output, /^namespaces:/m);
    assert.doesNotMatch(output, /^commands:.*\[/m);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs namespaces use compact footers and local help", async () => {
  const home = await writeProfiles({
    profiles: { input: { baseURL: "https://example.invalid", apiKey: "" } },
    current: "input",
  });
  const env = { XDG_CACHE_HOME: join(home, ".cache") };
  try {
    await writeUsageTopState(home, [{ name: "input", used: 1 }]);
    const configOutput = await runCcs(["dist/bin/ccs.js", "config"], home, env);
    const statusOutput = await runCcs(["dist/bin/ccs.js", "s"], home, env);
    const usageOutput = await runCcs(["dist/bin/ccs.js", "usage"], home, env);

    for (const output of [configOutput, statusOutput, usageOutput]) {
      assert.match(output, /--help/);
    }

    assert.match(await runCcs(["dist/bin/ccs.js", "config", "--help"], home, env), /ccs config push/);
    assert.match(await runCcs(["dist/bin/ccs.js", "s", "--help"], home, env), /ccs s server \[PORT\]/);
    assert.match(await runCcs(["dist/bin/ccs.js", "usage", "--help"], home, env), /ccs usage add \[PROFILE\]/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("tools print package version", async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const tools = ["ccs", "ccx", "ccxs", "clvm", "cx", "cxr", "cxx", "cxxr", "cxxs", "cxxsr", "senv", "codex-rename"];
  for (const tool of tools) {
    assert.equal(await runTool(tool, ["version"]), `${tool} ${packageJson.version}\n`);
    assert.equal(await runTool(tool, ["-v"]), `${tool} ${packageJson.version}\n`);
  }
});

test("remote Codex wrappers pass the current directory before resume", async () => {
  const binDir = await createFakeCodex("console.log(JSON.stringify(process.argv.slice(2)));\n");
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  const cwd = await mkdtemp(join(tmpdir(), "codex remote cwd "));
  try {
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, "dist/bin/cxr.js"), "hello"], { cwd, env })), [
      "--search", "--remote", "unix://", "-C", cwd, "hello",
    ]);
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, "dist/bin/cxxr.js"), "hello"], { cwd, env })), [
      "--search", "--dangerously-bypass-approvals-and-sandbox", "--remote", "unix://", "-C", cwd, "hello",
    ]);
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, "dist/bin/cxxsr.js"), "thread"], { cwd, env })), [
      "--search", "--dangerously-bypass-approvals-and-sandbox", "--remote", "unix://", "-C", cwd, "resume", "thread",
    ]);
  } finally {
    await rm(binDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ccs run selects its profile through an installed proxy", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "https://input.example.com", apiKey: "input-key" },
      ciii: { baseURL: "https://ciii.example.com", apiKey: "ciii-key" },
    },
    current: "ciii",
  });
  const stateRoot = join(home, ".cache", "codex-tools", "proxy");
  const proxyPort = await reservePort();
  const capturePath = join(home, "codex-run.json");
  const binDir = await createFakeCodex(`
    const { writeFileSync } = require("node:fs");
    writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2), apiKey: process.env.CCS_RUN_OPENAI_API_KEY }));
  `);
  const codexConfigPath = join(home, ".codex", "config.toml");
  const options = { codexConfigPath, listenHost: "127.0.0.1", listenPort: proxyPort, stateRoot };
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(codexConfigPath, [
      'model_provider = "codex"',
      "",
      "[model_providers.codex]",
      'base_url = "https://ciii.example.com"',
      'wire_api = "responses"',
      "",
    ].join("\n"), "utf8");
    await writeProxyStateForRunTest(home, stateRoot, proxyPort);

    await runCcs(["dist/bin/ccs.js", "run", "input", "exec", "hello"], home, {
      XDG_CACHE_HOME: join(home, ".cache"),
      CCS_PROXY_STATE_ROOT: stateRoot,
      CCS_PROXY_LISTEN_PORT: String(proxyPort),
      PATH: `${binDir}:${process.env.PATH}`,
      CAPTURE_PATH: capturePath,
    });

    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(captured.apiKey, "input-key");
    assert.deepEqual(captured.args, [
      "-c", `model_providers.codex.base_url="http://127.0.0.1:${proxyPort}"`,
      "-c", 'model_providers.codex.env_key="CCS_RUN_OPENAI_API_KEY"',
      "-c", 'model_providers.codex.http_headers.x-ccs-profile="input"',
      "exec", "hello",
    ]);
  } finally {
    await shutdownProxyRuntime(options).catch(() => null);
    await rm(binDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs r prints colored app-server daemon status and version", async () => {
  const binDir = await createFakeCodex(`console.log(JSON.stringify({
    status: "running",
    appServerVersion: "0.144.3",
  }));\n`);
  try {
    const script = `${stdoutPropertiesScript({ isTTY: true })}
      const { runCcs } = await import("./dist/commands/ccs.js");
      await runCcs(["r"]);
    `;
    const { stdout } = await execNodeScript(script, {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, NO_COLOR: "" },
    });
    assert.match(stdout, /status:\s+\u001b\[38;5;114mrunning\u001b\[0m/);
    assert.match(stdout, /version:\s+\u001b\[38;5;81m0\.144\.3\u001b\[0m/);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

test("ccs models lists every provider as a column", async () => {
  const requests = [];
  let home;
  const { server, baseUrl } = await startJsonServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization === "Bearer input-key") {
      res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5.5" }, { id: "gpt-5.5-mini" }] }));
      return;
    }
    res.end(JSON.stringify({ object: "list", data: [{ id: "claude-sonnet-4.5" }] }));
  });

  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: baseUrl, apiKey: "input-key" },
        ciii: { baseURL: `${baseUrl}/v1`, apiKey: "ciii-key" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "gpt-5.5": modelPriceFixture("ok"),
      "gpt-5.5-mini": modelPriceFixture("partial"),
    });
    const output = await runCcs(["dist/bin/ccs.js", "models"], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /^input\s+price\s+ciii\s+price/m);
    assert.match(output, /gpt-5\.5\s+ok\s+claude-sonnet-4\.5\s+missing/);
    assert.match(output, /gpt-5\.5-mini\s+partial/);
    requests.sort((left, right) => String(left.authorization).localeCompare(String(right.authorization)));
    assert.deepEqual(requests, [
      { url: "/v1/models", authorization: "Bearer ciii-key" },
      { url: "/v1/models", authorization: "Bearer input-key" },
    ]);
  } finally {
    await closeServer(server);
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs models keeps successful provider columns when another provider fails", async () => {
  let home;
  const { server, baseUrl } = await startJsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization === "Bearer ok-key") {
      res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5.5" }] }));
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ error: { message: "unauthorized" } }));
  });

  try {
    home = await writeProfiles({
      profiles: {
        ok: { baseURL: baseUrl, apiKey: "ok-key" },
        bad: { baseURL: baseUrl, apiKey: "bad-key" },
      },
      current: "ok",
    });
    await writeModelPriceCache(home, {
      "gpt-5.5": modelPriceFixture("ok"),
    });
    const output = await runCcs(["dist/bin/ccs.js", "models"], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /^ok\s+price\s+bad\s+price/m);
    assert.match(output, /gpt-5\.5\s+ok\s+http 401/);
  } finally {
    await closeServer(server);
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs models --json prints provider model results", async () => {
  let home;
  const { server, baseUrl } = await startJsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization === "Bearer ok-key") {
      res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5.5" }] }));
      return;
    }
    res.statusCode = 403;
    res.end(JSON.stringify({ error: { message: "forbidden" } }));
  });

  try {
    home = await writeProfiles({
      profiles: {
        ok: { baseURL: baseUrl, apiKey: "ok-key" },
        forbidden: { baseURL: baseUrl, apiKey: "forbidden-key" },
      },
      current: "ok",
    });
    await writeModelPriceCache(home, {
      "gpt-5.5": modelPriceFixture("ok"),
    });
    const output = await runCcs(["dist/bin/ccs.js", "models", "--json"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const payload = JSON.parse(output);

    assert.equal(payload.version, 1);
    assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(payload.pricing.speed, "standard");
    assert.equal(payload.pricing.source, "test");
    assert.equal(payload.pricing.fetchedAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(payload.profiles, [
      { name: "ok", models: ["gpt-5.5"], pricing: { "gpt-5.5": "ok" }, error: null },
      { name: "forbidden", models: [], pricing: {}, error: "http 403" },
    ]);
  } finally {
    await closeServer(server);
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs models shows per-provider configuration and response errors", async () => {
  let home;
  const { server, baseUrl } = await startJsonServer((_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end("not json");
  });

  try {
    home = await writeProfiles({
      profiles: {
        missing: { baseURL: baseUrl, apiKey: "" },
        invalid: { baseURL: "invalid-url", apiKey: "invalid-key" },
        text: { baseURL: baseUrl, apiKey: "text-key" },
      },
      current: "missing",
    });
    await writeModelPriceCache(home, {});
    const output = await runCcs(["dist/bin/ccs.js", "models"], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /^missing\s+price\s+invalid\s+price\s+text\s+price/m);
    assert.match(output, /missing apiKey\s+invalid baseURL\s+invalid response/);
  } finally {
    await closeServer(server);
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs cost daily reports missing pricing without failing", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {});
    await writeCodexCostFixture(home, "test-missing-model");

    const output = await runCcs([
      "dist/bin/ccs.js",
      "cost",
      "daily",
      "--since",
      "2026-01-01",
      "--until",
      "2026-01-01",
      "--timezone",
      "UTC",
    ], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /2026-01-01/);
    assert.match(output, /pricing/);
    assert.match(output, /missing 1/);
  } finally {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs cost status omits pricing commands", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: { input: { baseURL: "https://example.invalid", apiKey: "" } },
      current: "input",
    });
    const output = await runCcs(["dist/bin/ccs.js", "cost"], home, {
      XDG_CACHE_HOME: join(home, ".cache"),
    });
    assert.doesNotMatch(output, /ccs pricing/);
    await assert.rejects(
      runCcs(["dist/bin/ccs.js", "cost", "push", "daily"], home),
      /usage: ccs cost push/,
    );
  } finally {
    if (home) await rm(home, { recursive: true, force: true });
  }
});

test("ccs cost daily does not create a full pricing cache on missing prices", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeCodexCostFixture(home, "test-missing-model");

    const output = await runCcs([
      "dist/bin/ccs.js",
      "cost",
      "daily",
      "--since",
      "2026-01-01",
      "--until",
      "2026-01-01",
      "--timezone",
      "UTC",
    ], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /missing 1/);
    await assert.rejects(
      access(join(home, ".config", "codex-tools", "model-prices.json")),
      /ENOENT/,
    );
  } finally {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs cost models separates uncached input, output, cache, and component costs", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: { input: { baseURL: "https://example.invalid", apiKey: "" } },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "model-a": modelPriceValueFixture(0.000001),
      "model-b": modelPriceValueFixture(0.000002),
    });
    await writeCodexCostFixture(home, "model-a", [
      { model: "model-a", input: 100, cached: 40, output: 10 },
      { model: "model-b", input: 80, cached: 20, output: 5 },
    ]);

    const env = { XDG_CACHE_HOME: join(home, ".cache") };
    const json = JSON.parse(await runCcs([
      "dist/bin/ccs.js", "cost", "models", "--timezone", "UTC", "--json",
    ], home, env));

    assert.equal(json.version, 2);
    assert.deepEqual(json.rows, [
      {
        model: "model-b",
        inputTokens: 60,
        outputTokens: 5,
        cachedInputTokens: 20,
        inputCostUSD: 0.00012,
        outputCostUSD: 0.00002,
        cachedCostUSD: 0.000004,
        costUSD: 0.000144,
        missingPricingModels: [],
      },
      {
        model: "model-a",
        inputTokens: 60,
        outputTokens: 10,
        cachedInputTokens: 40,
        inputCostUSD: 0.00006,
        outputCostUSD: 0.00002,
        cachedCostUSD: 0.000004,
        costUSD: 0.000084,
        missingPricingModels: [],
      },
    ]);
    assert.deepEqual(json.totals, {
      inputTokens: 120,
      outputTokens: 15,
      cachedInputTokens: 60,
      inputCostUSD: 0.00018,
      outputCostUSD: 0.00004,
      cachedCostUSD: 0.000008,
      costUSD: 0.000228,
      missingPricingModels: [],
    });

    const terminal = await runCcs(["dist/bin/ccs.js", "cost", "models", "--timezone", "UTC", "--raw"], home, env);
    assert.match(terminal, /^model\s+input\s+output\s+cached\s+input\$\s+output\$\s+cached\$\s+total\$/m);
  } finally {
    if (home) await rm(home, { recursive: true, force: true });
  }
});

test("ccs cost reports incomplete component and total costs as null", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: { input: { baseURL: "https://example.invalid", apiKey: "" } },
      current: "input",
    });
    await writeModelPriceCache(home, {
      partial: { output_cost_per_token: 0.000002, cache_read_input_token_cost: 0.0000001 },
    });
    await writeCodexCostFixture(home, "partial", [
      { model: "partial", input: 100, cached: 40, output: 10 },
    ]);

    const json = JSON.parse(await runCcs([
      "dist/bin/ccs.js", "cost", "models", "--timezone", "UTC", "--json",
    ], home, { XDG_CACHE_HOME: join(home, ".cache") }));
    assert.equal(json.totals.inputCostUSD, null);
    assert.equal(json.totals.outputCostUSD, 0.00002);
    assert.equal(json.totals.cachedCostUSD, 0.000004);
    assert.equal(json.totals.costUSD, null);
    assert.deepEqual(json.totals.missingPricingModels, ["partial"]);
    const terminal = await runCcs([
      "dist/bin/ccs.js", "cost", "models", "--timezone", "UTC", "--raw",
    ], home, { XDG_CACHE_HOME: join(home, ".cache") });
    assert.match(terminal, /partial\s+60\s+10\s+40\s+-/);
    assert.match(terminal, /missing 1/);
  } finally {
    if (home) await rm(home, { recursive: true, force: true });
  }
});

test("ccs cost models sorts by unrounded total cost", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: { input: { baseURL: "https://example.invalid", apiKey: "" } },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "a-tiny": modelPriceValueFixture(0.0000004),
      "z-tiny": modelPriceValueFixture(0.000000245),
    });
    await writeCodexCostFixture(home, "z-tiny", [
      { model: "a-tiny", input: 1, output: 0 },
      { model: "z-tiny", input: 2, output: 0 },
    ]);

    const json = JSON.parse(await runCcs([
      "dist/bin/ccs.js", "cost", "models", "--timezone", "UTC", "--json",
    ], home, { XDG_CACHE_HOME: join(home, ".cache") }));
    assert.deepEqual(json.rows.map((row) => row.model), ["z-tiny", "a-tiny"]);
    assert.deepEqual(json.rows.map((row) => row.costUSD), [0, 0]);
  } finally {
    if (home) await rm(home, { recursive: true, force: true });
  }
});

test("ccs pricing prints local selection status", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "gpt-5.5": modelPriceValueFixture(0.000005),
    }, { patterns: ["gpt-5.*"], providers: ["openai"] });

    const output = await runCcs(["dist/bin/ccs.js", "pricing"], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /pricing:\s+.*model-prices\.json/);
    assert.match(output, /patterns:\s+1/);
    assert.match(output, /providers:\s+1/);
    assert.match(output, /models:\s+1/);
    assert.match(output, /source:\s+test/);
  } finally {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing list shows local prices without a network request", async () => {
  let home;
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "gpt-5": modelPriceValueFixture(0.000001),
      "gpt-5.4": modelPriceValueFixture(0.000004),
      "gpt-5.5": modelPriceValueFixture(0.000005),
      "gpt-5x": modelPriceValueFixture(0.000009),
    });
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response("{}", { status: 200 });
    };

    const output = await runCcsDirect(["pricing", "list"], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /model\s+status\s+input\/M\s+cache\/M\s+output\/M/);
    assert.match(output, /gpt-5\.4\s+ok\s+\$4\.00\s+\$0\.40\s+\$8\.00/);
    assert.match(output, /gpt-5\.5\s+ok\s+\$5\.00\s+\$0\.50\s+\$10\.00/);
    assert.match(output, /gpt-5x\s+ok\s+\$9\.00\s+\$0\.90\s+\$18\.00/);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing list remote filters to watched providers", async () => {
  let home;
  const previousFetch = globalThis.fetch;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {}, { providers: ["openai"] });
    globalThis.fetch = async () => new Response(JSON.stringify({
      "claude-sonnet-4.5": modelPriceValueFixture(0.000006, "anthropic"),
      "gpt-5.5": modelPriceValueFixture(0.000005),
      fallback_generalizations: { rules: [] },
    }), { status: 200 });

    const output = await runCcsDirect(["pricing", "list", "--remote"], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /remote:\s+https:\/\/raw\.githubusercontent\.com/);
    assert.match(output, /gpt-5\.5\s+ok\s+\$5\.00/);
    assert.doesNotMatch(output, /claude-sonnet-4\.5/);
    assert.doesNotMatch(output, /fallback_generalizations/);
  } finally {
    globalThis.fetch = previousFetch;
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing pattern watch previews provider-filtered remote prices", async () => {
  const previousFetch = globalThis.fetch;
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "http://127.0.0.1:1", apiKey: "" },
    },
    current: "input",
  });
  try {
    await writeModelPriceCache(home, {}, { providers: ["openai"] });
    globalThis.fetch = async () => new Response(JSON.stringify({
      "gpt-5.4": modelPriceValueFixture(0.000004),
      "gpt-5.5": modelPriceValueFixture(0.000005),
      "azure/gpt-5.5": modelPriceValueFixture(0.000006, "azure"),
    }), { status: 200 });
    const output = await runCcsDirect(["pricing", "pattern", "watch", " gpt-5.* "], home);
    const cache = JSON.parse(await readFile(join(home, ".config", "codex-tools", "model-prices.json"), "utf8"));

    assert.match(output, /ccs pricing pattern watch/);
    assert.match(output, /model\s+status\s+input\/M\s+cache\/M\s+output\/M/);
    assert.match(output, /gpt-5\.4\s+ok\s+\$4\.00\s+\$0\.40\s+\$8\.00/);
    assert.match(output, /gpt-5\.5\s+ok\s+\$5\.00\s+\$0\.50\s+\$10\.00/);
    assert.doesNotMatch(output, /azure\/gpt-5\.5/);
    assert.match(output, /not applied/);
    assert.deepEqual(cache.patterns, []);
    assert.deepEqual(cache.models, {});
  } finally {
    globalThis.fetch = previousFetch;
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs pricing pattern watch confirmation rebuilds the selected cache", async () => {
  let home;
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "kept-model": modelPriceValueFixture(0.000003),
    }, { patterns: ["existing-*"], providers: ["openai"] });
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({
        "gpt-5.4": modelPriceValueFixture(0.000004),
        "gpt-5.5": modelPriceValueFixture(0.000005),
        "azure/gpt-5.5": modelPriceValueFixture(0.000006, "azure"),
      }), { status: 200 });
    };

    const output = await runCcsWithConfirmation(["pricing", "pattern", "watch", "gpt-5.*"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const cache = JSON.parse(await readFile(join(home, ".config", "codex-tools", "model-prices.json"), "utf8"));

    assert.match(output, /pricing cache updated/);
    assert.deepEqual(cache.patterns, ["existing-*", "gpt-5.*"]);
    assert.deepEqual(cache.providers, ["openai"]);
    assert.equal(cache.models["gpt-5.4"].input_cost_per_token, 0.000004);
    assert.equal(cache.models["gpt-5.5"].input_cost_per_token, 0.000005);
    assert.equal(cache.models["kept-model"], undefined);
    assert.equal(cache.models["azure/gpt-5.5"], undefined);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing pattern unwatch rebuilds remote matches", async () => {
  let home;
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "gpt-5.5": modelPriceValueFixture(0.000005),
      "claude-sonnet-4.5": modelPriceValueFixture(0.000003, "anthropic"),
    }, { patterns: ["claude-*", "gpt-5.*"], providers: ["anthropic", "openai"] });
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({
        "gpt-5.5": modelPriceValueFixture(0.000005),
        "claude-sonnet-4.5": modelPriceValueFixture(0.000003, "anthropic"),
      }), { status: 200 });
    };

    const output = await runCcsWithConfirmation(["pricing", "pattern", "unwatch", "gpt-5.*"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const cache = JSON.parse(await readFile(join(home, ".config", "codex-tools", "model-prices.json"), "utf8"));

    assert.match(output, /ccs pricing pattern unwatch/);
    assert.match(output, /claude-sonnet-4\.5\s+ok\s+\$3\.00/);
    assert.doesNotMatch(output, /gpt-5\.5/);
    assert.deepEqual(cache.patterns, ["claude-*"]);
    assert.deepEqual(Object.keys(cache.models), ["claude-sonnet-4.5"]);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing remote list and pattern updates leave local state on remote failure", async () => {
  let home;
  const previousFetch = globalThis.fetch;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "gpt-5.5": modelPriceValueFixture(0.000005),
    }, { patterns: ["gpt-5.*"], providers: ["openai"] });
    globalThis.fetch = async () => {
      throw new Error("offline");
    };

    const listOutput = await runCcsDirect(["pricing", "list", "--remote"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const watchOutput = await runCcsDirect(["pricing", "pattern", "watch", "claude-*"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const cache = JSON.parse(await readFile(join(home, ".config", "codex-tools", "model-prices.json"), "utf8"));

    assert.match(listOutput, /remote:\s+unavailable \(fetch failed\)/);
    assert.match(watchOutput, /remote:\s+unavailable \(fetch failed\)/);
    assert.doesNotMatch(watchOutput, /Apply changes/);
    assert.deepEqual(cache.patterns, ["gpt-5.*"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing pattern shows local match counts without a network request", async () => {
  let home;
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "gpt-5.4": modelPriceValueFixture(0.000004),
      "gpt-5.5": modelPriceValueFixture(0.000005),
      "claude-sonnet-4.5": modelPriceValueFixture(0.000003, "anthropic"),
    }, { patterns: ["claude-*", "gpt-5.*"], providers: ["anthropic", "openai"] });
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response("{}", { status: 200 });
    };

    const output = await runCcsDirect(["pricing", "pattern"], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /pattern\s+models/);
    assert.match(output, /claude-\*\s+1/);
    assert.match(output, /gpt-5\.\*\s+2/);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing provider commands modify local filters and prune local models", async () => {
  let home;
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "gpt-5.5": modelPriceValueFixture(0.000005),
      "azure/gpt-5.5": modelPriceValueFixture(0.000006, "azure"),
    }, { patterns: ["*"], providers: ["azure", "openai"] });
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response("{}", { status: 200 });
    };

    const statusOutput = await runCcsDirect(["pricing", "provider"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const addOutput = await runCcsWithConfirmation(["pricing", "provider", "add", "anthropic"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const output = await runCcsWithConfirmation(["pricing", "provider", "remove", "azure"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const cache = JSON.parse(await readFile(join(home, ".config", "codex-tools", "model-prices.json"), "utf8"));

    assert.match(statusOutput, /provider/);
    assert.match(statusOutput, /azure/);
    assert.match(statusOutput, /openai/);
    assert.match(addOutput, /providers:\s+2 -> 3/);
    assert.match(output, /providers:\s+3 -> 2/);
    assert.deepEqual(cache.providers, ["anthropic", "openai"]);
    assert.deepEqual(Object.keys(cache.models), ["gpt-5.5"]);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing refresh rebuilds every selected model and price", async () => {
  let home;
  const previousFetch = globalThis.fetch;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {
      "stale-model": modelPriceValueFixture(0.000003),
    }, { patterns: ["gpt-5.*"], providers: ["openai"] });
    globalThis.fetch = async () => new Response(JSON.stringify({
      "gpt-5.5": modelPriceValueFixture(0.000005),
      "gpt-5.6": modelPriceValueFixture(0.000006),
      "azure/gpt-5.5": modelPriceValueFixture(0.000007, "azure"),
    }), { status: 200 });

    const output = await runCcsWithConfirmation(["pricing", "refresh"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const cache = JSON.parse(await readFile(join(home, ".config", "codex-tools", "model-prices.json"), "utf8"));

    assert.match(output, /ccs pricing refresh/);
    assert.match(output, /model\s+status\s+input\/M\s+cache\/M\s+output\/M/);
    assert.deepEqual(Object.keys(cache.models), ["gpt-5.5", "gpt-5.6"]);
    assert.equal(cache.models["stale-model"], undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing list rejects unsupported options", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "http://127.0.0.1:1", apiKey: "" },
    },
    current: "input",
  });
  try {
    await assert.rejects(
      runCcsDirect(["pricing", "list", "--json"], home),
      /unknown argument for ccs pricing list: --json/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs pricing refresh rejects arguments", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "http://127.0.0.1:1", apiKey: "" },
    },
    current: "input",
  });
  try {
    await assert.rejects(
      runCcs(["dist/bin/ccs.js", "pricing", "refresh", "--json"], home),
      /usage: ccs pricing refresh/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs pricing refresh requires watched patterns and providers", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "http://127.0.0.1:1", apiKey: "" },
    },
    current: "input",
  });
  try {
    await assert.rejects(
      runCcs(["dist/bin/ccs.js", "pricing", "refresh"], home),
      /ccs pricing refresh requires watched patterns and providers/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs pricing rejects unknown subcommands", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "http://127.0.0.1:1", apiKey: "" },
    },
    current: "input",
  });
  try {
    await assert.rejects(
      runCcs(["dist/bin/ccs.js", "pricing", "unknown"], home),
      /unknown argument for ccs pricing: unknown/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs cost rejects unknown report commands", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "http://127.0.0.1:1", apiKey: "" },
    },
    current: "input",
  });
  try {
    await assert.rejects(
      runCcs(["dist/bin/ccs.js", "cost", "unknown"], home),
      /unknown argument for ccs cost: unknown/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs models rejects unknown arguments", async () => {
  const home = await writeProfiles({
    profiles: {
      ok: { baseURL: "http://127.0.0.1:1", apiKey: "ok-key" },
    },
    current: "ok",
  });
  try {
    await assert.rejects(
      runCcs(["dist/bin/ccs.js", "models", "--raw"], home),
      /unknown argument for ccs models: --raw/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs top once appends history and writes private runtime files", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    const env = { XDG_CACHE_HOME: join(home, ".cache") };

    await runCcs(["dist/bin/ccs.js", "top", "--once"], home, env);
    await runCcs(["dist/bin/ccs.js", "top", "--once"], home, env);

    const cacheDir = join(home, ".cache", "codex-tools");
    const statePath = join(cacheDir, "ccs-top-state.json");
    const historyPath = join(cacheDir, "ccs-top-history.jsonl");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const history = (await readFile(historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(state.version, 1);
    assert.equal(state.active, true);
    assert.equal(state.entries[0].name, "input");
    assert.equal(history.length, 2);
    assert.equal(history[0].entries[0].name, "input");
    assert.equal(history[1].entries[0].name, "input");
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
  } finally {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs status marks the current switching profile", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: {
        aaa: { baseURL: "https://example.invalid", apiKey: "" },
        bbb: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "bbb",
    });
    const env = { XDG_CACHE_HOME: join(home, ".cache") };
    await writeUsageTopState(home, [
      { name: "aaa", used: 123.5 },
      { name: "bbb", used: 321.5 },
    ]);

    const output = await runCcs(["dist/bin/ccs.js", "s", "line"], home, env);

    assert.match(output, /\| aaa 123\.5 \| \*bbb 321\.5/);
    assert.doesNotMatch(output, /\*aaa/);

    await replaceJson(join(home, ".config", "codex-tools", "profiles.json"), {
      profiles: {
        aaa: { baseURL: "https://example.invalid", apiKey: "" },
        bbb: { baseURL: "https://example.invalid", apiKey: "" },
      },
      usage: {
        ccc: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "ccc",
    });
    await writeUsageTopState(home, [
      { name: "aaa", used: 123.5 },
      { name: "bbb", used: 321.5 },
    ]);
    const unmatchedOutput = await runCcs(["dist/bin/ccs.js", "s", "line"], home, env);
    assert.doesNotMatch(unmatchedOutput, /\*/);
  } finally {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs status agent reloads the current switching profile", async () => {
  let home;
  let child;
  let server;
  try {
    const endpoint = await startJsonServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        usage: {
          today: {
            actual_cost: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            requests: 0,
          },
        },
      }));
    });
    server = endpoint.server;
    const profiles = {
      profiles: {
        aaa: { baseURL: endpoint.baseUrl, apiKey: "aaa-key" },
        bbb: { baseURL: endpoint.baseUrl, apiKey: "bbb-key" },
      },
      current: "aaa",
    };
    home = await writeProfiles(profiles);
    const cacheHome = join(home, ".cache");
    const statusPath = join(cacheHome, "codex-tools", "ccs-top-status.txt");
    await writeUsageTopState(home, [
      { name: "aaa", used: 123.5 },
      { name: "bbb", used: 321.5 },
    ]);
    child = spawnNode(["dist/bin/ccs.js", "s", "agent"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: cacheHome,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForFileMatch(statusPath, /\| \*aaa 123\.5 \| bbb 321\.5/);
    await runCcs(["dist/bin/ccs.js", "toggle", "bbb"], home, { XDG_CACHE_HOME: cacheHome });
    await writeUsageTopState(home, [
      { name: "aaa", used: 123.5 },
      { name: "bbb", used: 321.5 },
    ]);

    await waitForFileMatch(statusPath, /\| aaa 123\.5 \| \*bbb 321\.5/);
  } finally {
    if (child) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
    }
    if (server) {
      await closeServer(server);
    }
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs top history server rejects oversized windows", async () => {
  let home;
  let child;
  const port = await reservePort();
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    child = spawnNode(["dist/bin/ccs.js", "s", "server", String(port)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, ".cache"),
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForHttpOk(`http://127.0.0.1:${port}/health`);
    const response = await fetch(`http://127.0.0.1:${port}/ccs/top/history?since=2026-01-01T00:00:00.000Z&until=2026-01-03T00:00:00.000Z&bucketMinutes=1`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "history window must be 24h30m or shorter" });
  } finally {
    if (child) {
      child.kill("SIGINT");
      await new Promise((resolve) => child.on("exit", resolve));
    }
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs top server starts when central cost pricing is incomplete", async () => {
  let home;
  let child;
  const port = await reservePort();
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    const cacheDir = join(home, ".cache", "codex-tools");
    const configDir = join(home, ".config", "codex-tools");
    await mkdir(join(cacheDir, "ccs-cost"), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "model-prices.json"), JSON.stringify({
      source: "test",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      patterns: [],
      providers: [],
      models: {
        "test-missing-model": { output_cost_per_token: 0.000002 },
        "known-model": modelPriceValueFixture(0.000001),
      },
    }), "utf8");
    await writeFile(join(cacheDir, "ccs-cost", "fixture.json"), JSON.stringify({
      version: 1,
      machine: "fixture",
      sourceHost: "fixture-host",
      sourceUser: "fixture-user",
      sourceCodexDir: "/tmp/codex",
      generatedAt: "2026-01-01T00:00:00.000Z",
      timezone: "UTC",
      speed: "standard",
      events: [{
        timestampMs: Date.UTC(2026, 0, 1, 12, 0, 0),
        project: "/tmp/project",
        model: "test-missing-model",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 15,
        },
      }, {
        timestampMs: Date.UTC(2026, 0, 1, 13, 0, 0),
        project: "/tmp/project",
        model: "known-model",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 10,
          reasoningOutputTokens: 0,
          totalTokens: 110,
        },
      }],
    }), "utf8");

    child = spawnNode(["dist/bin/ccs.js", "s", "server", String(port)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, ".cache"),
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForHttpOk(`http://127.0.0.1:${port}/health`);
    const response = await fetch(`http://127.0.0.1:${port}/ccs/top/state`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.active, true);
    const statusResponse = await waitForJsonOk(`http://127.0.0.1:${port}/ccs/cost/status`);
    assert.equal(statusResponse.version, 2);
    assert.equal(statusResponse.machines[0].inputTokens, 70);
    assert.equal(statusResponse.machines[0].outputCostUSD, 0.00003);
    assert.equal(statusResponse.machines[0].cachedInputTokens, 40);
    assert.equal(statusResponse.machines[0].cachedCostUSD, 0.000004);
    assert.equal(statusResponse.machines[0].costUSD, null);
    assert.deepEqual(statusResponse.machines[0].missingPricingModels, ["test-missing-model"]);
    const modelsResponse = await waitForJsonOk(
      `http://127.0.0.1:${port}/ccs/cost/report?report=models&timezone=UTC&speed=auto`,
    );
    assert.equal(modelsResponse.version, 2);
    assert.equal(modelsResponse.report, "models");
    assert.deepEqual(modelsResponse.rows.map((row) => row.key), ["known-model", "test-missing-model"]);
    assert.equal(modelsResponse.rows[0].inputTokens, 60);
    assert.equal(modelsResponse.rows[0].cachedInputTokens, 40);
    assert.equal(modelsResponse.rows[0].costUSD, 0.000084);
    assert.equal(modelsResponse.rows[1].inputCostUSD, null);
    assert.equal(modelsResponse.rows[1].outputCostUSD, 0.00001);
    assert.equal(modelsResponse.rows[1].costUSD, null);
  } finally {
    if (child) {
      child.kill("SIGINT");
      await new Promise((resolve) => child.on("exit", resolve));
    }
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs sync stays additive by default and reports complete field summaries", async () => {
  const home = await writeSyncFixture([
    'model_provider = "codex"',
    'model = "local-model"',
    'local_only = true',
    '',
    '[model_providers.codex]',
    'base_url = "https://local.example"',
    '',
    '[features]',
    'goals = false',
    '',
  ].join("\n"));
  try {
    const output = await runCcsWithConfirmation(["sync"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const config = await readFile(join(home, ".codex", "config.toml"), "utf8");
    assert.match(output, /^different:\s+\d+\s+.*model.*features\.goals/m);
    assert.match(output, /^update:\s+\d+\s+/m);
    assert.match(config, /model = "local-model"/);
    assert.match(config, /goals = false/);
    assert.match(config, /local_only = true/);
    assert.match(config, /personality = "pragmatic"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs sync replaces repeated exact leaf paths once and applies its preview", async () => {
  const home = await writeSyncFixture([
    'model_provider = "codex"',
    'model = "local-model"',
    '',
    '[model_providers.codex]',
    'base_url = "https://local.example"',
    '',
    '[features]',
    'goals = false',
    '',
  ].join("\n"));
  try {
    const output = await runCcsWithConfirmation([
      "sync", "--replace", "model", "--replace", "features.goals", "--replace", "model",
    ], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const config = await readFile(join(home, ".codex", "config.toml"), "utf8");
    const updateLine = output.split("\n").find((line) => line.startsWith("update:"));
    assert.ok(updateLine);
    assert.equal((updateLine.match(/(?:^|, )model(?:,|$)/g) ?? []).length, 1);
    assert.match(config, /model = "gpt-5\.6-sol"/);
    assert.match(config, /goals = true/);
    assert.match(config, /base_url = "https:\/\/local\.example"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs sync --replace all preserves provider base URLs and local-only fields", async () => {
  const home = await writeSyncFixture([
    'model_provider = "codex"',
    'model = "local-model"',
    'local_only = true',
    '',
    '[model_providers.codex]',
    'base_url = "https://local.example"',
    'wire_api = "chat"',
    '',
  ].join("\n"));
  try {
    await runCcsWithConfirmation(["sync", "--replace", "all"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    const config = await readFile(join(home, ".codex", "config.toml"), "utf8");
    assert.match(config, /model = "gpt-5\.6-sol"/);
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /base_url = "https:\/\/local\.example"/);
    assert.match(config, /local_only = true/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs sync rejects invalid replacement selections before preview", async () => {
  const home = await writeSyncFixture('model_provider = "codex"\n');
  try {
    const cases = [
      [["sync", "--replace", "missing.path"], /unknown TOML path/],
      [["sync", "--replace", "features"], /non-leaf TOML path/],
      [["sync", "--replace", "model_providers.codex.base_url"], /cannot replace proxy routing field/],
      [["sync", "--replace", "all", "--replace", "model"], /cannot be combined/],
    ];
    for (const [args, pattern] of cases) {
      await assert.rejects(() => runCcsDirect(args, home, { XDG_CACHE_HOME: join(home, ".cache") }), pattern);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs sync preserves proxy routing by rejecting a model_provider change", async () => {
  const home = await writeSyncFixture('model_provider = "other"\n');
  try {
    const stateRoot = join(home, ".cache", "codex-tools", "proxy");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "proxy.json"), JSON.stringify({
      state_schema_version: 1,
      installed_at: "2026-01-01T00:00:00.000Z",
      codex_config_path: join(home, ".codex", "config.toml"),
      provider_name: "codex",
      original_base_url: "https://proxy.example.com",
      proxy_base_url: "http://127.0.0.1:4610",
      mode: "recovery",
      listen_host: "127.0.0.1",
      listen_port: 4610,
      latency_guard: {
        enabled: false,
        first_progress_timeout_ms: 0,
        first_progress_action: "return_502",
        total_timeout_ms: 0,
      },
      profile_order: ["input"],
      backup_path: join(stateRoot, "config.toml.backup"),
      metrics: {
        total_requests: 0,
        active_requests: [],
        status_counts: {},
        reasoning_token_counts: {},
        upstream_hit_counts: {},
        latency_ms: { last: null, count: 0, sum: 0, min: null, max: null },
        recent_requests: [],
      },
    }), "utf8");
    await assert.rejects(
      () => runCcsDirect(["sync", "--replace", "model_provider"], home, { XDG_CACHE_HOME: join(home, ".cache") }),
      /cannot replace model_provider while proxy state exists/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs sync summaries compare TOML values semantically", async () => {
  const template = await readFile(join(repoRoot, "config", "codex-config.toml"), "utf8");
  const config = template.replace('model_provider = "codex"', "model_provider = 'codex' # local style");
  const home = await writeSyncFixture(config);
  try {
    const output = await runCcsWithConfirmation(
      ["sync", "--replace", "model_provider"],
      home,
      { XDG_CACHE_HOME: join(home, ".cache") },
    );
    assert.match(output, /^different:\s+0$/m);
    assert.match(output, /^update:\s+0$/m);
    assert.match(await readFile(join(home, ".codex", "config.toml"), "utf8"), /model_provider = 'codex' # local style/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function runTool(tool, args) {
  const home = await mkdtemp(join(tmpdir(), "ccs-version-home-"));
  try {
    return await runCcs([`dist/bin/${tool}.js`, ...args], home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function createFakeCodex(source) {
  const binDir = await mkdtemp(join(tmpdir(), "fake-codex-bin-"));
  const codexPath = join(binDir, "codex");
  await writeFile(codexPath, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(codexPath, 0o755);
  return binDir;
}

async function writeSyncFixture(config) {
  const home = await mkdtemp(join(tmpdir(), "ccs-sync-home-"));
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), config, "utf8");
  await writeFile(
    join(home, ".codex", "AGENTS.md"),
    await readFile(join(repoRoot, "config", "codex-agents.md"), "utf8"),
    "utf8",
  );
  await writeFile(
    join(home, ".config", "codex-tools", "profiles.json"),
    await readFile(join(repoRoot, "config", "ccs-profiles.json"), "utf8"),
    "utf8",
  );
  return home;
}

function runCcs(args, home, env = {}) {
  return execNodeStdout(args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      ...env,
    },
  });
}

async function runCcsDirect(args, home, env = {}, isTTY = false) {
  const values = {
    HOME: home,
    NO_COLOR: "1",
    ...env,
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await captureStdout(() => runCcsCommand(args), { isTTY });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function runCcsWithConfirmation(args, home, env = {}) {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  const timer = setTimeout(() => input.end("yes\n"), 10);
  try {
    return await runCcsDirect(args, home, env, true);
  } finally {
    clearTimeout(timer);
    if (stdinDescriptor) {
      Object.defineProperty(process, "stdin", stdinDescriptor);
    }
  }
}

async function writeProfiles(profiles) {
  const home = await mkdtemp(join(tmpdir(), "ccs-home-"));
  const configDir = join(home, ".config", "codex-tools");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  return home;
}

async function writeProxyStateForRunTest(home, stateRoot, proxyPort) {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "proxy.json"), JSON.stringify({
    state_schema_version: 1,
    installed_at: "2026-01-01T00:00:00.000Z",
    codex_config_path: join(home, ".codex", "config.toml"),
    provider_name: "codex",
    original_base_url: "https://ciii.example.com",
    proxy_base_url: `http://127.0.0.1:${proxyPort}`,
    mode: "passthrough",
    latency_guard: {
      enabled: false,
      first_progress_timeout_ms: 0,
      first_progress_action: "return_502",
      total_timeout_ms: 0,
    },
    listen_host: "127.0.0.1",
    listen_port: proxyPort,
    profile_order: ["ciii"],
    backup_path: "/tmp/backup.toml",
    metrics: {
      total_requests: 0,
      active_requests: [],
      status_counts: {},
      reasoning_token_counts: {},
      upstream_hit_counts: {},
      latency_ms: { last: null, count: 0, sum: 0, min: null, max: null },
      recent_requests: [],
    },
  }, null, 2), "utf8");
}

async function replaceJson(path, value) {
  const temporaryPath = `${path}.test.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  await rename(temporaryPath, path);
}

async function writeUsageTopState(home, entries) {
  const cacheDir = join(home, ".cache", "codex-tools");
  await mkdir(cacheDir, { recursive: true });
  await replaceJson(join(cacheDir, "ccs-top-state.json"), {
    version: 1,
    active: true,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    entries,
  });
}

async function waitForFileMatch(path, pattern) {
  const deadline = Date.now() + 5000;
  let lastValue = "";
  while (Date.now() < deadline) {
    try {
      lastValue = await readFile(path, "utf8");
      if (pattern.test(lastValue)) {
        return;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${path} to match ${pattern}; last value: ${lastValue}`);
}

async function writeModelPriceCache(home, models, { patterns = [], providers = [] } = {}) {
  const configDir = join(home, ".config", "codex-tools");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "model-prices.json"), JSON.stringify({
    source: "test",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    patterns,
    providers,
    models,
  }, null, 2), "utf8");
}

function modelPriceFixture(kind) {
  return {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
    ...(kind === "ok" ? { cache_read_input_token_cost: 0.0000001 } : {}),
  };
}

function modelPriceValueFixture(inputCostPerToken, provider = "openai") {
  return {
    litellm_provider: provider,
    input_cost_per_token: inputCostPerToken,
    output_cost_per_token: inputCostPerToken * 2,
    cache_read_input_token_cost: inputCostPerToken / 10,
  };
}

async function writeCodexCostFixture(home, model, usages = [{ model, input: 100, output: 10 }]) {
  const timestampMs = Date.parse("2026-01-01T12:00:00.000Z");
  const codexDir = join(home, ".codex");
  const sessionsDir = join(codexDir, "sessions", "2026", "01", "01");
  await mkdir(sessionsDir, { recursive: true });
  const rolloutPath = join(sessionsDir, "rollout-fixture.jsonl");
  await writeFile(rolloutPath, `${[
    taskStarted(uuidV7At(timestampMs), timestampMs),
    turnContext(uuidV7At(timestampMs + 1), "/tmp/ccs-cost-project", model),
    ...usages.map((usage, index) => tokenCount(
      new Date(timestampMs + 2000 + index * 1000).toISOString(),
      usage.model,
      usage,
    )),
  ].map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  await sqliteRun(join(codexDir, "state.sqlite"), `
    create table threads (
      id text primary key,
      rollout_path text not null,
      created_at integer not null,
      updated_at integer not null,
      cwd text not null,
      model text,
      created_at_ms integer,
      updated_at_ms integer
    );
    insert into threads values (
      'thread-fixture',
      '${sqlString(rolloutPath)}',
      ${Math.floor(timestampMs / 1000)},
      ${Math.floor((timestampMs + 120000) / 1000)},
      '/tmp/ccs-cost-project',
      '${sqlString(model)}',
      ${timestampMs},
      ${timestampMs + 120000}
    );
  `);
}

function taskStarted(turnId, timestampMs) {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turnId,
      started_at: Math.floor(timestampMs / 1000),
    },
  };
}

function turnContext(turnId, cwd, model) {
  return {
    timestamp: new Date(uuidV7TimestampMs(turnId)).toISOString(),
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd,
      model,
    },
  };
}

function tokenCount(timestamp, model, usage) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      model,
      info: {
        total_token_usage: tokenUsage(usage),
        last_token_usage: tokenUsage(usage),
      },
    },
  };
}

function tokenUsage(usage) {
  return {
    input_tokens: usage.input,
    cached_input_tokens: usage.cached ?? 0,
    output_tokens: usage.output,
    reasoning_output_tokens: usage.reasoning ?? 0,
    total_tokens: usage.input + usage.output,
  };
}

async function startJsonServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await closeServer(server);
  return port;
}

async function waitForHttpOk(url) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

async function waitForJsonOk(url) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

function sqliteRun(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = execFile("sqlite3", [dbPath], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolve();
    });
    child.stdin?.end(sql);
  });
}

function sqlString(value) {
  return value.replaceAll("'", "''");
}

function uuidV7At(timestampMs) {
  const prefix = Math.floor(timestampMs).toString(16).padStart(12, "0");
  return `${prefix.slice(0, 8)}-${prefix.slice(8, 12)}-7000-8000-000000000000`;
}

function uuidV7TimestampMs(value) {
  return Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16);
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
