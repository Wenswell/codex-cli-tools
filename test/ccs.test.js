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
import { captureStdout, execNodeScript, execNodeStdout, spawnNode, stdoutPropertiesScript, stripAnsi } from "./helpers/terminal.js";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("ccs help lists the current proxy command surface", async () => {
  const output = await captureStdout(() => runCcsCommand(["help"]));
  assert.match(output, /ccs proxy \[watch\|reroute\|cancel\|mode\|config\|install\|restart\|restore\|serve\]/);
  assert.doesNotMatch(output, /proxy.*stop|proxy.*--once/);
  assert.doesNotMatch(output, /ccs run/);
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

test("ccs exposes route conversion in current, list, and profile views", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "https://input.example.test", apiKey: "input-key", routeConversion: { enabled: true } },
      direct: { baseURL: "https://direct.example.test", apiKey: "direct-key" },
    },
    current: "input",
  });
  const env = { XDG_CACHE_HOME: join(home, ".cache") };
  try {
    const status = await runCcs(["dist/bin/ccs.js"], home, env);
    const list = await runCcs(["dist/bin/ccs.js", "list"], home, env);
    const profile = await runCcs(["dist/bin/ccs.js", "input"], home, env);

    assert.match(status, /^conversion:\s+responses→chat$/m);
    assert.match(list, /input\s+https:\/\/input\.example\.test.*responses→chat/);
    assert.match(list, /direct\s+https:\/\/direct\.example\.test.*off/);
    assert.match(profile, /^conversion:\s+responses→chat$/m);
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
    const configOutput = await runCcs(["dist/bin/ccs.js", "config"], home, env);
    assert.match(configOutput, /--help/);
    assert.match(await runCcs(["dist/bin/ccs.js", "config", "--help"], home, env), /ccs config push/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex wrappers execute standard codex directly", async () => {
  const binDir = await createFakeCodex("console.log(JSON.stringify(process.argv.slice(2)));\n");
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  const cwd = await mkdtemp(join(tmpdir(), "codex cwd "));
  try {
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, "dist/bin/cx.js"), "hello"], { cwd, env })), [
      "--search", "hello",
    ]);
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, "dist/bin/cxx.js"), "hello"], { cwd, env })), [
      "--search", "--dangerously-bypass-approvals-and-sandbox", "hello",
    ]);
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, "dist/bin/cxxs.js"), "thread"], { cwd, env })), [
      "--search", "--dangerously-bypass-approvals-and-sandbox", "resume", "thread",
    ]);
  } finally {
    await rm(binDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Codex wrapper help documents profile launches", async () => {
  for (const tool of ["cx", "cxx", "cxxs"]) {
    const output = await runTool(tool, ["--help"]);
    assert.match(output, new RegExp(`${tool} run PROFILE`));
    assert.doesNotMatch(output, new RegExp(`${tool} local`));
  }
});

test("Codex wrappers launch with a selected profile through an installed proxy", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "https://input.example.com", apiKey: "input-key" },
      ciii: { baseURL: "https://ciii.example.com", apiKey: "ciii-key" },
    },
    current: "ciii",
  });
  const stateRoot = join(home, ".cache", "codex-tools", "proxy");
  const proxyPort = await reservePort();
  const capturePath = join(home, "codex-profile-run.json");
  const binDir = await createFakeCodex(`
    const { writeFileSync } = require("node:fs");
    writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2), apiKey: process.env.CODEX_TOOLS_PROFILE_API_KEY }));
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

    const cases = [
      { tool: "cx", args: ["hello"], prefix: ["--search"] },
      { tool: "cxx", args: ["hello"], prefix: ["--search", "--dangerously-bypass-approvals-and-sandbox"] },
      { tool: "cxxs", args: ["thread"], prefix: ["--search", "--dangerously-bypass-approvals-and-sandbox"] },
    ];
    for (const entry of cases) {
      await runCcs([`dist/bin/${entry.tool}.js`, "run", "input", ...entry.args], home, {
        XDG_CACHE_HOME: join(home, ".cache"),
        CCS_PROXY_STATE_ROOT: stateRoot,
        CCS_PROXY_LISTEN_PORT: String(proxyPort),
        PATH: `${binDir}:${process.env.PATH}`,
        CAPTURE_PATH: capturePath,
      });

      const captured = JSON.parse(await readFile(capturePath, "utf8"));
      assert.equal(captured.apiKey, "input-key");
      assert.deepEqual(captured.args, [
        ...entry.prefix,
        "-c", `model_providers.codex.base_url="http://127.0.0.1:${proxyPort}"`,
        "-c", 'model_providers.codex.env_key="CODEX_TOOLS_PROFILE_API_KEY"',
        "-c", 'model_providers.codex.http_headers.x-ccs-profile="input"',
        ...(entry.tool === "cxxs" ? ["resume"] : []),
        ...entry.args,
      ]);
      assert.equal(captured.args.includes("--remote"), false);
    }
  } finally {
    await shutdownProxyRuntime(options).catch(() => null);
    await rm(binDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex profile launch uses the direct URL and rejects unknown profiles", async () => {
  const home = await writeProfiles({
    profiles: { input: { baseURL: "https://input.example.com", apiKey: "input-key" } },
    current: "input",
  });
  const capturePath = join(home, "codex-direct-profile-run.json");
  const binDir = await createFakeCodex(`
    const { writeFileSync } = require("node:fs");
    writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2), apiKey: process.env.CODEX_TOOLS_PROFILE_API_KEY }));
  `);
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), 'model_provider = "codex"\n', "utf8");
    const env = {
      XDG_CACHE_HOME: join(home, ".cache"),
      PATH: `${binDir}:${process.env.PATH}`,
      CAPTURE_PATH: capturePath,
    };

    await runCcs(["dist/bin/cx.js", "run", "input", "hello"], home, env);
    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(captured.apiKey, "input-key");
    assert.deepEqual(captured.args, [
      "--search",
      "-c", 'model_providers.codex.base_url="https://input.example.com"',
      "-c", 'model_providers.codex.env_key="CODEX_TOOLS_PROFILE_API_KEY"',
      "hello",
    ]);
    await assert.rejects(
      () => runCcs(["dist/bin/cx.js", "run", "missing"], home, env),
      /profile not found: missing/,
    );
  } finally {
    await rm(binDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
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
      state_schema_version: 4,
      installed_at: "2026-01-01T00:00:00.000Z",
      codex_config_path: join(home, ".codex", "config.toml"),
      provider_name: "codex",
      original_base_url: "https://proxy.example.com",
      proxy_base_url: "http://127.0.0.1:4610",
      mode: "recovery",
      status_retry: {
        enabled: false,
        total_window_ms: 3_600_000,
        backoff_base_ms: 1000,
        backoff_max_ms: 30_000,
      },
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
    state_schema_version: 4,
    installed_at: "2026-01-01T00:00:00.000Z",
    codex_config_path: join(home, ".codex", "config.toml"),
    provider_name: "codex",
    original_base_url: "https://ciii.example.com",
    proxy_base_url: `http://127.0.0.1:${proxyPort}`,
    mode: "passthrough",
    status_retry: {
      enabled: false,
      total_window_ms: 3_600_000,
      backoff_base_ms: 1000,
      backoff_max_ms: 30_000,
    },
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
