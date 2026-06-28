import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { ensureProxyRunning, installProxy, readProxyState, restoreProxy } from "../dist/commands/ccs-proxy.js";

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("proxy install records toggle order as upstream priority", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;

    const codexDir = join(home, ".codex");
    await mkdir(codexDir, { recursive: true });
    const codexConfigPath = join(codexDir, "config.toml");
    await writeFile(
      codexConfigPath,
      [
        'model_provider = "codex"',
        "",
        "[model_providers.codex]",
        'name = "OpenAI"',
        'base_url = "https://proxy.example.com"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
      "utf8",
    );

    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "profiles.json"),
      JSON.stringify(
        {
          profiles: {
            input: { baseURL: "https://ai.input.im", apiKey: "" },
            ciii: { baseURL: "https://codex.ciii.club", apiKey: "" },
          },
          current: "input",
          toggle: ["input", "ciii"],
        },
        null,
        2,
      ),
      "utf8",
    );

    await installProxy({
      codexConfigPath,
      listenHost: "127.0.0.1",
      listenPort: 4610,
      stateRoot,
    });

    const state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.deepEqual(state.profile_order.slice(0, 2), ["input", "ciii"]);
    const restoredConfig = await readFile(codexConfigPath, "utf8");
    assert.match(restoredConfig, /base_url = "http:\/\/127\.0\.0\.1:4610"/);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousStateRoot === undefined) {
      delete process.env.CCS_PROXY_STATE_ROOT;
    } else {
      process.env.CCS_PROXY_STATE_ROOT = previousStateRoot;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("proxy state persists request metrics", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;

    const statePath = join(stateRoot, "proxy.json");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify(
        {
          installed_at: "2026-01-01T00:00:00.000Z",
          codex_config_path: "/home/test/.codex/config.toml",
          provider_name: "codex",
          original_base_url: "https://proxy.example.com",
          proxy_base_url: "http://127.0.0.1:4610",
          listen_host: "127.0.0.1",
          listen_port: 4610,
          profile_order: ["input", "ciii"],
          backup_path: "/tmp/backup.toml",
          metrics: {
            total_requests: 2,
            successful_requests: 1,
            failed_requests: 1,
            upstream_hit_counts: {
              input: 1,
              ciii: 1,
            },
            latency_ms: {
              count: 2,
              sum: 300,
              min: 100,
              max: 200,
              samples: [100, 200],
            },
            recent_requests: [
              {
                at: "2026-01-01T00:00:00.000Z",
                method: "POST",
                path: "/v1/responses",
                status: 200,
                upstream: "input",
                attempts: 1,
                latency_ms: 120,
                error: null,
              },
              {
                at: "2026-01-01T00:00:01.000Z",
                method: "POST",
                path: "/v1/responses",
                status: 502,
                upstream: "ciii",
                attempts: 2,
                latency_ms: 180,
                error: "fallback",
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.metrics.total_requests, 2);
    assert.equal(state.metrics.failed_requests, 1);
    assert.equal(state.metrics.upstream_hit_counts.input, 1);
    assert.equal(state.metrics.recent_requests[0].upstream, "input");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousStateRoot === undefined) {
      delete process.env.CCS_PROXY_STATE_ROOT;
    } else {
      process.env.CCS_PROXY_STATE_ROOT = previousStateRoot;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("proxy runtime starts in the background and restore stops it", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const previousListenHost = process.env.CCS_PROXY_LISTEN_HOST;
  const previousListenPort = process.env.CCS_PROXY_LISTEN_PORT;
  const listenPort = await reservePort();
  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    process.env.CCS_PROXY_LISTEN_HOST = "127.0.0.1";
    process.env.CCS_PROXY_LISTEN_PORT = String(listenPort);

    const codexDir = join(home, ".codex");
    await mkdir(codexDir, { recursive: true });
    const codexConfigPath = join(codexDir, "config.toml");
    await writeFile(
      codexConfigPath,
      [
        'model_provider = "codex"',
        "",
        "[model_providers.codex]",
        'name = "OpenAI"',
        'base_url = "https://proxy.example.com"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
      "utf8",
    );

    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "profiles.json"),
      JSON.stringify(
        {
          profiles: {
            input: { baseURL: "https://ai.input.im", apiKey: "" },
          },
          current: "input",
          toggle: ["input"],
        },
        null,
        2,
      ),
      "utf8",
    );

    await installProxy({
      codexConfigPath,
      listenHost: "127.0.0.1",
      listenPort,
      stateRoot,
    });

    const runtime = await ensureProxyRunning({
      codexConfigPath,
      listenHost: "127.0.0.1",
      listenPort,
      stateRoot,
    });

    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    assert.equal(runtime.started, true);
    assert.ok(runtime.pid);

    const health = await fetch(`http://127.0.0.1:${listenPort}/__codex_proxy/health`);
    assert.equal(health.status, 200);
    const healthPayload = await health.json();
    assert.equal(healthPayload.status, "ok");
    assert.equal(healthPayload.pid, runtime.pid);

    await unlink(join(stateRoot, "proxy.pid"));
    const stopped = await restoreProxy({
      codexConfigPath,
      listenHost: "127.0.0.1",
      listenPort,
      stateRoot,
    });
    assert.match(stopped, /Proxy stopped/);
    assert.equal(await readProxyState(stateRoot), null);

    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(
      fetch(`http://127.0.0.1:${listenPort}/__codex_proxy/health`, { signal: AbortSignal.timeout(500) }),
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousStateRoot === undefined) {
      delete process.env.CCS_PROXY_STATE_ROOT;
    } else {
      process.env.CCS_PROXY_STATE_ROOT = previousStateRoot;
    }
    if (previousListenHost === undefined) {
      delete process.env.CCS_PROXY_LISTEN_HOST;
    } else {
      process.env.CCS_PROXY_LISTEN_HOST = previousListenHost;
    }
    if (previousListenPort === undefined) {
      delete process.env.CCS_PROXY_LISTEN_PORT;
    } else {
      process.env.CCS_PROXY_LISTEN_PORT = previousListenPort;
    }
    await rm(home, { recursive: true, force: true });
  }
});
