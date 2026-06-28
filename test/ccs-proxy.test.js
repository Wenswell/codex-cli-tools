import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installProxy, readProxyState } from "../dist/commands/ccs-proxy.js";

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
