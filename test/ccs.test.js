import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execNodeStdout, spawnNode } from "./helpers/terminal.js";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("tools print package version", async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const tools = ["ccs", "ccx", "ccxs", "clvm", "cx", "cxx", "cxxs", "senv", "codex-rename"];
  for (const tool of tools) {
    assert.equal(await runTool(tool, ["version"]), `${tool} ${packageJson.version}\n`);
    assert.equal(await runTool(tool, ["-v"]), `${tool} ${packageJson.version}\n`);
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
      access(join(home, ".cache", "codex-tools", "model-prices.json")),
      /ENOENT/,
    );
  } finally {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing prints cache status", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
    });
    await writeModelPriceCache(home, {});

    const output = await runCcs(["dist/bin/ccs.js", "pricing"], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /pricing:\s+.*model-prices\.json/);
    assert.match(output, /watched:\s+none/);
    assert.match(output, /source:\s+test/);
    assert.match(output, /commands: ccs pricing list \| ccs pricing refresh \| ccs pricing watch MODEL_PATTERN\.\.\. \| ccs pricing unwatch MODEL_PATTERN\.\.\./);
  } finally {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing list prints watched model prices from local cache", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
      pricing: {
        models: ["gpt-5.*", "missing-model"],
      },
    });
    await writeModelPriceCache(home, {
      "gpt-5": modelPriceValueFixture(0.000001),
      "gpt-5.4": modelPriceValueFixture(0.000004),
      "gpt-5.5": modelPriceValueFixture(0.000005),
      "gpt-5x": modelPriceValueFixture(0.000009),
    });

    const output = await runCcs(["dist/bin/ccs.js", "pricing", "list"], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /model\s+status\s+input\/M\s+cache\/M\s+output\/M/);
    assert.match(output, /gpt-5\.4\s+ok\s+\$4\.00\s+\$0\.40\s+\$8\.00/);
    assert.match(output, /gpt-5\.5\s+ok\s+\$5\.00\s+\$0\.50\s+\$10\.00/);
    assert.match(output, /missing-model\s+missing\s+missing\s+missing\s+missing/);
    assert.doesNotMatch(output, /gpt-5x/);
    assert.doesNotMatch(output, /gpt-5\s+ok/);
  } finally {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing list all prints every local cached model price", async () => {
  let home;
  try {
    home = await writeProfiles({
      profiles: {
        input: { baseURL: "https://example.invalid", apiKey: "" },
      },
      current: "input",
      pricing: {
        models: ["gpt-5.5"],
      },
    });
    await writeModelPriceCache(home, {
      "claude-sonnet-4.5": modelPriceValueFixture(0.000006),
      "gpt-5.5": modelPriceValueFixture(0.000005),
    });

    const output = await runCcs(["dist/bin/ccs.js", "pricing", "list", "--all"], home, { XDG_CACHE_HOME: join(home, ".cache") });

    assert.match(output, /claude-sonnet-4\.5\s+ok\s+\$6\.00/);
    assert.match(output, /gpt-5\.5\s+ok\s+\$5\.00/);
  } finally {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("ccs pricing watch previews config edits without noninteractive writes", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "http://127.0.0.1:1", apiKey: "" },
    },
    current: "input",
  });
  try {
    const output = await runCcs(["dist/bin/ccs.js", "pricing", "watch", " gpt-5.* ", "glm-5.2"], home);
    const profiles = JSON.parse(await readFile(join(home, ".config", "codex-tools", "profiles.json"), "utf8"));

    assert.match(output, /ccs pricing watch/);
    assert.match(output, /gpt-5\.\*\s+watch/);
    assert.match(output, /glm-5\.2\s+watch/);
    assert.match(output, /not applied/);
    assert.equal(profiles.pricing, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs pricing refresh rejects report options", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "http://127.0.0.1:1", apiKey: "" },
    },
    current: "input",
  });
  try {
    await assert.rejects(
      runCcs(["dist/bin/ccs.js", "pricing", "refresh", "--json"], home),
      /unknown argument for ccs pricing refresh: --json/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs pricing refresh requires model patterns", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "http://127.0.0.1:1", apiKey: "" },
    },
    current: "input",
  });
  try {
    await assert.rejects(
      runCcs(["dist/bin/ccs.js", "pricing", "refresh"], home),
      /usage: ccs pricing refresh MODEL_PATTERN\.\.\. or add watched models with ccs pricing watch MODEL_PATTERN\.\.\./,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs cost pricing command is removed", async () => {
  const home = await writeProfiles({
    profiles: {
      input: { baseURL: "http://127.0.0.1:1", apiKey: "" },
    },
    current: "input",
  });
  try {
    await assert.rejects(
      runCcs(["dist/bin/ccs.js", "cost", "pricing"], home),
      /unknown argument for ccs cost: pricing/,
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
    await mkdir(join(cacheDir, "ccs-cost"), { recursive: true });
    await writeFile(join(cacheDir, "model-prices.json"), JSON.stringify({
      source: "test",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      models: {},
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
    assert.equal(statusResponse.version, 1);
    assert.deepEqual(statusResponse.machines[0].missingPricingModels, ["test-missing-model"]);
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

async function runTool(tool, args) {
  const home = await mkdtemp(join(tmpdir(), "ccs-version-home-"));
  try {
    return await runCcs([`dist/bin/${tool}.js`, ...args], home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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

async function writeProfiles(profiles) {
  const home = await mkdtemp(join(tmpdir(), "ccs-home-"));
  const configDir = join(home, ".config", "codex-tools");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  return home;
}

async function writeModelPriceCache(home, models) {
  const cacheDir = join(home, ".cache", "codex-tools");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, "model-prices.json"), JSON.stringify({
    source: "test",
    fetchedAt: "2026-01-01T00:00:00.000Z",
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

function modelPriceValueFixture(inputCostPerToken) {
  return {
    input_cost_per_token: inputCostPerToken,
    output_cost_per_token: inputCostPerToken * 2,
    cache_read_input_token_cost: inputCostPerToken / 10,
  };
}

async function writeCodexCostFixture(home, model) {
  const timestampMs = Date.parse("2026-01-01T12:00:00.000Z");
  const codexDir = join(home, ".codex");
  const sessionsDir = join(codexDir, "sessions", "2026", "01", "01");
  await mkdir(sessionsDir, { recursive: true });
  const rolloutPath = join(sessionsDir, "rollout-fixture.jsonl");
  await writeFile(rolloutPath, `${[
    taskStarted(uuidV7At(timestampMs), timestampMs),
    turnContext(uuidV7At(timestampMs + 1), "/tmp/ccs-cost-project", model),
    tokenCount("2026-01-01T12:00:02.000Z", model, { input: 100, output: 10 }),
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
