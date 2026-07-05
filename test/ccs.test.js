import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    const output = await execNode(["dist/bin/ccs.js", "models"], {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
    });

    assert.match(output, /^input\s+ciii/m);
    assert.match(output, /gpt-5\.5\s+claude-sonnet-4\.5/);
    assert.match(output, /gpt-5\.5-mini/);
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
    const output = await execNode(["dist/bin/ccs.js", "models"], {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
    });

    assert.match(output, /^ok\s+bad/m);
    assert.match(output, /gpt-5\.5\s+http 401/);
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
    const output = await execNode(["dist/bin/ccs.js", "models", "--json"], {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
    });
    const payload = JSON.parse(output);

    assert.equal(payload.version, 1);
    assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(payload.profiles, [
      { name: "ok", models: ["gpt-5.5"], error: null },
      { name: "forbidden", models: [], error: "http 403" },
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
    const output = await execNode(["dist/bin/ccs.js", "models"], {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
    });

    assert.match(output, /^missing\s+invalid\s+text/m);
    assert.match(output, /missing apiKey\s+invalid baseURL\s+invalid response/);
  } finally {
    await closeServer(server);
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
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
      execNode(["dist/bin/ccs.js", "models", "--raw"], {
        ...process.env,
        HOME: home,
        NO_COLOR: "1",
      }),
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
    const env = {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      NO_COLOR: "1",
    };

    await execNode(["dist/bin/ccs.js", "top", "--once"], env);
    await execNode(["dist/bin/ccs.js", "top", "--once"], env);

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
    child = spawn(process.execPath, ["dist/bin/ccs.js", "s", "server", String(port)], {
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

async function writeProfiles(profiles) {
  const home = await mkdtemp(join(tmpdir(), "ccs-home-"));
  const configDir = join(home, ".config", "codex-tools");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  return home;
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
