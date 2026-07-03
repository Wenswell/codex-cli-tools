import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
