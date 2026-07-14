import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import {
  buildProxyStatusLines,
  ensureProxyRunning,
  formatProxyAttemptCosts,
  formatProxyAttemptTokens,
  formatProxyModel,
  formatProxyTokenCount,
  formatProxyUsd,
  installProxy,
  parseProxyStatusArgs,
  projectProxyUsageAttempts,
  proxyWatchKeyAction,
  proxyRequestTableColumns,
  readProxyState,
  restoreProxy,
  runProxyCommand,
  setProxyMode,
  shutdownProxyRuntime,
  stopProxy,
} from "../dist/commands/ccs-proxy.js";
import { captureStdout, execNodeScript, setStdoutProperties, spawnNode, stdoutPropertiesScript, stripAnsi, withStdoutProperties } from "./helpers/terminal.js";

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("proxy install replaces a direct current URL with the local proxy URL", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const listenPort = await reservePort();
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
        'service_tier = "priority"',
        "",
        "[model_providers.codex]",
        'name = "OpenAI"',
        'base_url = "https://codex.ciii.club"',
        'wire_api = "responses"',
        "",
        "[model_providers.other]",
        'base_url = "https://other.example.com"',
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
            input: { baseURL: "https://ai.input.im", apiKey: "input-key" },
            ciii: { baseURL: "https://codex.ciii.club", apiKey: "ciii-key" },
          },
          current: "ciii",
          toggle: ["input", "ciii"],
        },
        null,
        2,
      ),
      "utf8",
    );

    const options = {
      codexConfigPath,
      listenHost: "127.0.0.1",
      listenPort,
      stateRoot,
    };
    const preview = stripAnsi(await captureStdout(() => runProxyCommand(["install"], options)));
    assert.match(preview, /provider:\s+codex/);
    assert.match(preview, /current:\s+https:\/\/codex\.ciii\.club/);
    assert.match(preview, new RegExp(`local:\\s+http://127\\.0\\.0\\.1:${listenPort}`));
    assert.match(preview, /backup:\s+.*config-\d+\.toml/);
    assert.match(preview, /no changes are written unless you type yes/);
    assert.equal(await readProxyState(stateRoot), null);

    const installed = await installProxy(options);

    const state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.mode, "passthrough");
    assert.deepEqual(state.profile_order, ["ciii"]);
    assert.equal(state.codex_config_path, codexConfigPath);
    assert.equal(installed.runtime?.healthy, true);
    const installedConfig = await readFile(codexConfigPath, "utf8");
    assert.equal(installedConfig, [
      'model_provider = "codex"',
      'service_tier = "priority"',
      "",
      "[model_providers.codex]",
      'name = "OpenAI"',
      `base_url = "http://127.0.0.1:${listenPort}"`,
      'wire_api = "responses"',
      "",
      "[model_providers.other]",
      'base_url = "https://other.example.com"',
      "",
    ].join("\n"));
    assert.equal(await readFile(installed.backupPath, "utf8"), [
      'model_provider = "codex"',
      'service_tier = "priority"',
      "",
      "[model_providers.codex]",
      'name = "OpenAI"',
      'base_url = "https://codex.ciii.club"',
      'wire_api = "responses"',
      "",
      "[model_providers.other]",
      'base_url = "https://other.example.com"',
      "",
    ].join("\n"));
    await shutdownProxyRuntime({ codexConfigPath, listenHost: "127.0.0.1", listenPort, stateRoot });
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

test("proxy install keeps direct routing when proxy startup fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const listenPort = await reservePort();
  const blocked = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const stateRoot = join(home, ".cache", "codex-tools", "proxy");
  const codexConfigPath = join(home, ".codex", "config.toml");
  const sourceConfig = [
    'model_provider = "codex"',
    "",
    "[model_providers.codex]",
    'base_url = "https://codex.ciii.club"',
    "",
  ].join("\n");
  try {
    process.env.HOME = home;
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(codexConfigPath, sourceConfig, "utf8");
    await writeFile(
      join(home, ".config", "codex-tools", "profiles.json"),
      JSON.stringify({
        profiles: { ciii: { baseURL: "https://codex.ciii.club", apiKey: "ciii-key" } },
        current: "ciii",
      }),
      "utf8",
    );
    await listenServer(blocked, listenPort);

    await assert.rejects(
      installProxy({
        codexConfigPath,
        listenHost: "127.0.0.1",
        listenPort,
        stateRoot,
      }),
      /proxy did not become healthy/,
    );
    assert.equal(await readFile(codexConfigPath, "utf8"), sourceConfig);
    assert.equal(await readProxyState(stateRoot), null);
    assert.equal((await readdir(join(stateRoot, "backups"))).length, 1);
    assert.match(await readFile(join(stateRoot, "proxy-runtime.log"), "utf8"), /EADDRINUSE|address already in use/i);
  } finally {
    await closeServer(blocked);
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

test("proxy default state root lives under cache", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  try {
    process.env.HOME = home;
    process.env.XDG_CACHE_HOME = join(home, ".cache");
    delete process.env.CCS_PROXY_STATE_ROOT;
    const stateRoot = join(home, ".cache", "codex-tools", "proxy");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "proxy.json"),
      JSON.stringify(proxyStateFixture(), null, 2),
      "utf8",
    );

    const state = await readProxyState();
    assert.ok(state);
    assert.equal(state.proxy_base_url, "http://127.0.0.1:4610");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousXdgCacheHome;
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
    const active = proxyHistoryRecord({
      id: "active-1",
      started_at: "2026-01-01T00:00:03.000Z",
      completed_at: null,
      path: "/v1/chat/completions",
      status: null,
      upstream_status: null,
      client_status: null,
      final_action: "pending",
      upstream: null,
      attempts: 0,
      latency_ms: 0,
      request_bytes: 12,
      session: "019f0eca",
    });
    const success = proxyHistoryRecord({ id: "history-1", latency_ms: 120, response_bytes: 51 });
    const failure = proxyHistoryRecord({
      id: "history-2",
      started_at: "2026-01-01T00:00:01.000Z",
      completed_at: "2026-01-01T00:00:01.000Z",
      status: 500,
      upstream_status: 500,
      client_status: 500,
      final_action: "upstream_error",
      failure_summary: { type: "upstream_error", code: null, message: "capacity" },
      upstream: "ciii",
      attempts: 2,
      latency_ms: 180,
      response_bytes: 52,
      session: "019eb0ba",
    });
    await writeFile(statePath, JSON.stringify(proxyStateFixture({ active_requests: [active], recent_requests: [success, failure] }), null, 2), "utf8");

    const state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.metrics.total_requests, 2);
    assert.deepEqual(state.metrics.status_counts, { "200": 1, "500": 1 });
    assert.deepEqual(state.metrics.reasoning_token_counts, {});
    assert.equal(state.metrics.active_requests.length, 1);
    assert.deepEqual(state.metrics.active_requests[0], active);
    assert.equal(state.metrics.upstream_hit_counts.input, 1);
    assert.deepEqual(state.metrics.recent_requests, [success, failure]);
    assert.equal(state.metrics.latency_ms.last, 120);

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

test("proxy state rejects old and incomplete request records", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  try {
    const oldRecord = proxyHistoryRecord({ schema_version: 4 });
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "proxy.json"), JSON.stringify(proxyStateFixture({ recent_requests: [oldRecord] })), "utf8");
    await assert.rejects(readProxyState(home), /recent_requests\[0\]\.schema_version: expected number 5/);

    const incompleteRecord = proxyHistoryRecord();
    delete incompleteRecord.final_action;
    await writeFile(join(home, "proxy.json"), JSON.stringify(proxyStateFixture({ recent_requests: [incompleteRecord] })), "utf8");
    await assert.rejects(readProxyState(home), /recent_requests\[0\]\.final_action: expected string/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("proxy records active and history request lifecycle", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  let streamStartedResolve;
  const streamStarted = new Promise((resolve) => {
    streamStartedResolve = resolve;
  });
  let finishStream;
  const streamRelease = new Promise((resolve) => {
    finishStream = resolve;
  });
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith("/responses?case=slow")) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      }, 60);
      return;
    }
    if (req.url === "/responses?case=stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      streamStartedResolve();
      void streamRelease.then(() => {
        res.end("data: two\n\n");
      });
      return;
    }
    if (req.url === "/responses?case=client-error") {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "missing" }));
      return;
    }
    if (req.url === "/responses?case=server-error") {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "down" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "profiles.json"),
      JSON.stringify(
        {
          profiles: {
            input: { baseURL: `http://127.0.0.1:${upstreamPort}`, apiKey: "input-key" },
          },
          current: "input",
          toggle: ["input"],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(stateRoot, "proxy.json"),
      JSON.stringify(
        {
          installed_at: "2026-01-01T00:00:00.000Z",
          codex_config_path: join(home, ".codex", "config.toml"),
          provider_name: "codex",
          original_base_url: "https://proxy.example.com",
          proxy_base_url: `http://127.0.0.1:${proxyPort}`,
          mode: "recovery",
          listen_host: "127.0.0.1",
          listen_port: proxyPort,
          profile_order: ["input"],
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
        },
        null,
        2,
      ),
      "utf8",
    );

    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(upstreamPort, "127.0.0.1", resolve);
    });
    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const sessionId = "019eb0b9-af9f-79b3-9c25-a2f1d1aa0565";
    const requestPayload = JSON.stringify({ session_id: sessionId, input: "hello" });
    const okResponse = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=ok`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestPayload,
    });
    assert.equal(okResponse.status, 200);
    assert.deepEqual(await okResponse.json(), { ok: true });

    let state = await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.recent_requests[0]?.path === "/responses");
    assert.equal(state.metrics.active_requests.length, 0);
    assert.equal(state.metrics.recent_requests[0].status, 200);
    assert.equal(state.metrics.recent_requests[0].request_bytes, Buffer.byteLength(requestPayload));
    assert.equal(state.metrics.recent_requests[0].response_bytes, Buffer.byteLength(JSON.stringify({ ok: true })));
    assert.equal(state.metrics.recent_requests[0].session, "019eb0b9");

    await Promise.all(
      Array.from({ length: 6 }, (_, index) => fetch(`http://127.0.0.1:${proxyPort}/responses?case=slow&i=${index}`, { method: "POST", body: "{}" })
        .then(async (response) => {
          assert.equal(response.status, 200);
          await response.text();
        })),
    );
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.total_requests === 7);
    state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.metrics.total_requests, 7);
    assert.equal(state.metrics.status_counts["200"], 7);
    assert.equal(state.metrics.recent_requests.filter((record) => record.path === "/responses").length, 7);

    const streamFetch = fetch(`http://127.0.0.1:${proxyPort}/responses?case=stream`, { method: "POST", body: "{}" });
    await streamStarted;
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests[0]?.status === 200);
    state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.metrics.active_requests[0].path, "/responses");
    assert.equal(state.metrics.active_requests[0].completed_at, null);
    assert.equal(state.metrics.active_requests[0].status, 200);
    assert.equal(state.metrics.active_requests[0].upstream, "input");
    assert.equal(state.metrics.active_requests[0].attempts, 1);
    assert.equal(state.metrics.recent_requests[0].path, "/responses");

    finishStream();
    const streamResponse = await streamFetch;
    assert.equal(await streamResponse.text(), "data: one\n\ndata: two\n\n");
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.recent_requests[0].path === "/responses");

    const clientError = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=client-error`, { method: "POST", body: "{}" });
    assert.equal(clientError.status, 404);
    await clientError.text();
    const serverError = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=server-error`, { method: "POST", body: "{}" });
    assert.equal(serverError.status, 503);
    assert.deepEqual(await serverError.json(), { error: "down" });
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.total_requests === 10);

    state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.metrics.active_requests.length, 0);
    assert.deepEqual(state.metrics.status_counts, { "200": 8, "404": 1, "503": 1 });
    assert.equal(state.metrics.total_requests, 10);
    assert.equal(state.metrics.upstream_hit_counts.input, 10);
    assert.equal(state.metrics.recent_requests[0].status, 503);
    assert.equal(state.metrics.recent_requests[0].final_action, "upstream_error");
    assert.deepEqual(state.metrics.recent_requests[0].failure_summary, {
      type: "upstream_error",
      code: null,
      message: "down",
    });
    assert.equal(state.metrics.recent_requests[1].status, 404);
    assert.equal(state.metrics.recent_requests[1].final_action, "upstream_error");
    assert.deepEqual(state.metrics.recent_requests[1].failure_summary, {
      type: "upstream_error",
      code: null,
      message: "missing",
    });
    assert.equal(state.metrics.recent_requests[2].status, 200);

    const output = await captureConsole(() => runProxyCommand([], proxyOptions));
    assert.match(output, /proxy: http:\/\/127\.0\.0\.1:\d+\s+refresh: 1s/);
    assert.match(output, /state: ~\/\.config\/codex-tools\/proxy\.json/);
    assert.match(output, /requests: ~\/\.config\/codex-tools\/proxy-requests\.jsonl/);
    assert.match(output, /events: ~\/\.config\/codex-tools\/proxy\.log/);
    assert.match(output, /runtime: ~\/\.config\/codex-tools\/proxy-runtime\.log/);
    assert.match(output, /config: ~\/\.codex\/config\.toml/);
    assert.doesNotMatch(output, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output, /status total=10 active=0 200=8 404=1 503=1 upstreams=input=10/);
    assert.match(output, /reasoning total=0 max=-/);
    assert.doesNotMatch(output, /0=0|516=0|1034=0|1552=0|other=0/);
    assert.match(output, /latency last=\d+ms avg=\d+ms min=\d+ms max=\d+ms/);
    assert.match(output, /active\n\s+session\s+time\s+up\s+model\s+reas\.\/code\s+lat\.\s+size\s+error\n\s+no active requests/);
    assert.match(output, /history\n\s+session\s+time\s+up\s+model\s+reas\.\/code\s+lat\.\s+size\s+error/);
    assert.match(output, /-\s+-\/503\s+\d+ms\s+\d+B\s+down/);
    assert.match(output, /-\s+-\/404\s+\d+ms\s+\d+B\s+missing/);
    assert.doesNotMatch(output, /\bmethod\b/);
    assert.doesNotMatch(output, /requests: total|failed|rate|p50|p95/);
    assert.doesNotMatch(output.split("\n").find((line) => line.startsWith("status ")) ?? "", /\bok\b/);

    for (let index = 0; index < 91; index += 1) {
      const cappedResponse = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=cap-${index}`, { method: "POST", body: "{}" });
      assert.equal(cappedResponse.status, 200);
      await cappedResponse.text();
    }
    state = await waitForState(stateRoot, (candidate) => candidate.metrics.total_requests === 100);
    assert.equal(state.metrics.total_requests, 100);
    assert.equal(state.metrics.recent_requests.length, 100);
    assert.equal(state.metrics.recent_requests[0].path, "/responses");
    const requestHistoryLines = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8")).trim().split("\n");
    assert.equal(requestHistoryLines.length >= state.metrics.recent_requests.length, true);
    const requestHistory = requestHistoryLines.map((line) => JSON.parse(line));
    assert.equal(requestHistory[0].path, "/responses");
    assert.equal(requestHistory.at(-1).path, "/responses");
    assert.equal(requestHistory.at(-1).completed_at !== null, true);
    assert.equal(requestHistory.at(-1).status, 200);
  } finally {
    finishStream?.();
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy rejects unsupported paths without request history", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  let upstreamHits = 0;
  const upstream = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const rootResponse = await fetch(`http://127.0.0.1:${proxyPort}/?api_key=query-secret`);
    assert.equal(rootResponse.status, 404);
    assert.deepEqual(await rootResponse.json(), {
      error: {
        code: "unsupported_proxy_path",
        message: "unsupported proxy path",
      },
    });

    const otherResponse = await fetch(`http://127.0.0.1:${proxyPort}/anything`, { method: "POST", body: "{}" });
    assert.equal(otherResponse.status, 404);
    assert.deepEqual(await otherResponse.json(), {
      error: {
        code: "unsupported_proxy_path",
        message: "unsupported proxy path",
      },
    });

    await waitForLogIncludes(join(stateRoot, "proxy.log"), /"event":"ccs_proxy_unsupported_path"/);
    const events = (await readFile(join(stateRoot, "proxy.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), ["ccs_proxy_unsupported_path", "ccs_proxy_unsupported_path"]);
    assert.deepEqual(events.map((event) => event.path), ["/", "/anything"]);
    assert.doesNotMatch(await readFile(join(stateRoot, "proxy.log"), "utf8"), /query-secret|api_key/);
    assert.deepEqual(events.map((event) => event.status), [404, 404]);
    assert.equal(upstreamHits, 0);

    const state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.metrics.active_requests.length, 0);
    assert.equal(state.metrics.recent_requests.length, 0);
    assert.equal(state.metrics.total_requests, 0);
    assert.deepEqual(state.metrics.status_counts, {});
    assert.equal(await readTextOrEmpty(join(stateRoot, "proxy-requests.jsonl")), "");
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy records request and upstream model metadata for OpenAI paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const paths = [
    {
      path: "/v1/chat/completions",
      requestModel: "chat-request-v1",
      responseBody: { id: "chat-v1", model: "chat-upstream-v1" },
      upstreamModel: "chat-upstream-v1",
      source: "json.model",
      streamModel: "chat-stream-v1",
      streamSource: "sse.data.model",
    },
    {
      path: "/chat/completions",
      requestModel: "chat-request-root",
      responseBody: { id: "chat-root", model: "chat-upstream-root" },
      upstreamModel: "chat-upstream-root",
      source: "json.model",
      streamModel: "chat-stream-root",
      streamSource: "sse.data.model",
    },
    {
      path: "/v1/responses",
      requestModel: "responses-request-v1",
      responseBody: { id: "responses-v1", response: { model: "responses-upstream-v1" }, model: "ignored-root" },
      upstreamModel: "responses-upstream-v1",
      source: "json.response.model",
      streamModel: "responses-stream-v1",
      streamSource: "sse.data.response.model",
    },
    {
      path: "/responses",
      requestModel: "responses-request-root",
      responseBody: { id: "responses-root", model: "responses-upstream-root" },
      upstreamModel: "responses-upstream-root",
      source: "json.model",
      streamModel: "responses-stream-root",
      streamSource: "sse.data.model",
    },
  ];
  const pathByName = new Map(paths.map((entry) => [entry.path, entry]));
  const firstHold = holdControl();
  const secondHold = holdControl();

  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const spec = pathByName.get(url.pathname);
    if (!spec) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "missing" }));
      return;
    }

    if (url.searchParams.get("stream") === "1") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const payload = spec.streamSource === "sse.data.response.model"
        ? { response: { model: spec.streamModel }, delta: "hello" }
        : { model: spec.streamModel, choices: [] };
      res.write("event: message\n");
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const hold = url.searchParams.get("hold");
    if (hold === "1" || hold === "2") {
      const control = hold === "1" ? firstHold : secondHold;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: spec.streamModel })}\n\n`);
      control.markStarted();
      void control.release.then(() => {
        res.end("data: [DONE]\n\n");
      });
      return;
    }

    if (url.searchParams.get("missing") === "1") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ id: "missing-model" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(spec.responseBody));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    for (const spec of paths) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}${spec.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: spec.requestModel }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), spec.responseBody);
      const state = await waitForState(
        stateRoot,
        (candidate) => candidate.metrics.recent_requests[0]?.path === spec.path,
      );
      const record = state.metrics.recent_requests[0];
      assert.equal(record.request_model, spec.requestModel);
      assert.equal(record.upstream_model, spec.upstreamModel);
      assert.equal(record.upstream_model_source, spec.source);
    }

    for (const spec of paths) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}${spec.path}?stream=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${spec.requestModel}-stream` }),
      });
      assert.equal(response.status, 200);
      const expectedPayload = spec.streamSource === "sse.data.response.model"
        ? { response: { model: spec.streamModel }, delta: "hello" }
        : { model: spec.streamModel, choices: [] };
      const expectedBody = `event: message\ndata: ${JSON.stringify(expectedPayload)}\n\ndata: [DONE]\n\n`;
      assert.equal(await response.text(), expectedBody);
      const state = await waitForState(
        stateRoot,
        (candidate) => candidate.metrics.recent_requests[0]?.path === spec.path,
      );
      const record = state.metrics.recent_requests[0];
      assert.equal(record.request_model, `${spec.requestModel}-stream`);
      assert.equal(record.upstream_model, spec.streamModel);
      assert.equal(record.upstream_model_source, spec.streamSource);
    }

    const activeSpec = paths[0];
    const activeFetch = fetch(`http://127.0.0.1:${proxyPort}${activeSpec.path}?hold=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "active-request-model" }),
    });
    await firstHold.started;
    let state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests[0]?.path === activeSpec.path,
    );
    assert.equal(state.metrics.active_requests[0].request_model, "active-request-model");

    firstHold.finish();
    assert.equal(await (await activeFetch).text(), `data: ${JSON.stringify({ model: activeSpec.streamModel })}\n\ndata: [DONE]\n\n`);
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.recent_requests[0]?.path === activeSpec.path);

    const missingResponse = await fetch(`http://127.0.0.1:${proxyPort}/responses?missing=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "no model" }),
    });
    assert.equal(missingResponse.status, 200);
    await missingResponse.text();
    state = await waitForState(stateRoot, (candidate) => candidate.metrics.recent_requests[0]?.path === "/responses");
    assert.equal(state.metrics.recent_requests[0].request_model, null);
    assert.equal(state.metrics.recent_requests[0].upstream_model, null);
    assert.equal(state.metrics.recent_requests[0].upstream_model_source, null);

    const activeOutputFetch = fetch(`http://127.0.0.1:${proxyPort}${activeSpec.path}?hold=2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "active-output-model" }),
    });
    let activeOutputResolved = false;
    void activeOutputFetch.then(() => {
      activeOutputResolved = true;
    }, () => {
      activeOutputResolved = true;
    });
    await secondHold.started;
    state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests[0]?.upstream_model === activeSpec.streamModel,
    );
    assert.equal(state.metrics.active_requests[0].completed_at, null);
    assert.equal(state.metrics.active_requests[0].status, 200);
    assert.equal(state.metrics.active_requests[0].upstream, "input");
    assert.equal(state.metrics.active_requests[0].attempts, 1);
    assert.equal(state.metrics.active_requests[0].request_model, "active-output-model");
    assert.equal(state.metrics.active_requests[0].upstream_model, activeSpec.streamModel);
    assert.equal(state.metrics.active_requests[0].upstream_model_source, "sse.data.model");
    await delay(100);
    assert.equal(activeOutputResolved, false);

    const output = await captureConsole(() => runProxyCommand(["--once"], proxyOptions));
    assert.match(output, /session\s+time\s+up\s+model\s+reas\.\/code\s+lat\.\s+size\s+error/);
    assert.doesNotMatch(output, /\bnull\b/);
    assert.match(output, /active\n\s+session\s+time\s+up\s+model\s+reas\.\/code\s+lat\.\s+size\s+error/);
    assert.match(output, /chat-stre…/);
    assert.match(output, /\s-\s+-\/200/);
    assert.match(output, /responses…/);

    secondHold.finish();
    assert.equal(await (await activeOutputFetch).text(), `data: ${JSON.stringify({ model: activeSpec.streamModel })}\n\ndata: [DONE]\n\n`);
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.recent_requests[0]?.request_model === "active-output-model");
  } finally {
    firstHold.finish();
    secondHold.finish();
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy uses profiles.current only and passes upstream HTTP status bodies", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const currentPort = await reservePort();
  const otherPort = await reservePort();
  const statuses = [401, 403, 408, 429, 503];
  const currentHeaders = [];
  let currentHits = 0;
  let otherHits = 0;

  const current = createServer((req, res) => {
    currentHits += 1;
    currentHeaders.push({
      authorization: req.headers.authorization,
      apiKey: req.headers["api-key"],
      xApiKey: req.headers["x-api-key"],
    });
    const url = new URL(req.url ?? "/", "http://localhost");
    const status = Number(url.searchParams.get("status"));
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status, upstream: "current" }));
  });
  const other = createServer((_req, res) => {
    otherHits += 1;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ upstream: "other" }));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestStateWithProfiles(
      home,
      stateRoot,
      proxyPort,
      {
        input: { baseURL: `http://127.0.0.1:${otherPort}`, apiKey: "input-key" },
        ciii: { baseURL: `http://127.0.0.1:${currentPort}`, apiKey: "ciii-key" },
      },
      "ciii",
      ["input", "ciii"],
    );
    await listenServer(current, currentPort);
    await listenServer(other, otherPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    for (const status of statuses) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/responses?status=${status}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer stale-client-key",
          "api-key": "stale-api-key",
          "x-api-key": "stale-x-api-key",
        },
        body: "{}",
      });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { status, upstream: "current" });
    }

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests.length === 0
        && candidate.metrics.total_requests === statuses.length,
    );
    assert.equal(currentHits, statuses.length);
    assert.equal(otherHits, 0);
    assert.deepEqual(
      currentHeaders,
      statuses.map(() => ({
        authorization: "Bearer ciii-key",
        apiKey: undefined,
        xApiKey: undefined,
      })),
    );
    assert.deepEqual(state.metrics.status_counts, { "401": 1, "403": 1, "408": 1, "429": 1, "503": 1 });
    assert.equal(state.metrics.upstream_hit_counts.ciii, statuses.length);
    assert.equal(state.metrics.recent_requests[0].upstream, "ciii");
    assert.equal(state.metrics.recent_requests[0].attempts, 1);

    const output = await captureConsole(() => runProxyCommand(["--once"], proxyOptions));
    assert.match(output, /upstreams=ciii=5/);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(current);
    await closeServer(other);
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

test("proxy retries upstream capacity error text and passes through ordinary 429", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  let capacityHits = 0;
  let exhaustedCapacityHits = 0;
  let plain429Hits = 0;

  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("case") === "capacity") {
      capacityHits += 1;
      if (capacityHits <= 3) {
        res.writeHead(429, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          error: {
            code: "model_at_capacity",
            message: "Selected model is at capacity. Please try a different model.",
          },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, capacityHits }));
      return;
    }

    if (url.searchParams.get("case") === "exhausted-capacity") {
      exhaustedCapacityHits += 1;
      res.writeHead(429, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        error: {
          code: "model_at_capacity",
          message: "Selected model is at capacity. Please try a different model.",
        },
      }));
      return;
    }

    plain429Hits += 1;
    res.writeHead(429, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "rate_limit", message: "ordinary rate limit" } }));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const capacity = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=capacity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "capacity-model" }),
    });
    assert.equal(capacity.status, 200);
    assert.deepEqual(await capacity.json(), { ok: true, capacityHits: 4 });

    let state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "capacity-model",
    );
    let record = state.metrics.recent_requests[0];
    assert.equal(capacityHits, 4);
    assert.equal(record.status, 200);
    assert.equal(record.attempts, 4);
    assert.equal(record.error, null);
    assert.deepEqual(record.retry_summary, {
      total: 3,
      reasoning_guard: 0,
      upstream_capacity: 3,
      transport: 0,
    });
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["internal_retry", "internal_retry", "internal_retry"]);
    assert.deepEqual(record.guard_actions.map((action) => action.status), [429, 429, 429]);
    assert.deepEqual(record.guard_actions.map((action) => action.reasoning_tokens), [null, null, null]);
    assert.match(record.guard_actions[0].error, /upstream_capacity: Selected model is at capacity/);
    await waitForLogIncludes(join(stateRoot, "proxy.log"), /"action":"internal_retry".*"status":429.*"error":"upstream_capacity: Selected model is at capacity/);

    const exhaustedCapacity = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=exhausted-capacity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "exhausted-capacity-model" }),
    });
    assert.equal(exhaustedCapacity.status, 429);
    assert.deepEqual(await exhaustedCapacity.json(), {
      error: {
        code: "model_at_capacity",
        message: "Selected model is at capacity. Please try a different model.",
      },
    });

    state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "exhausted-capacity-model",
    );
    record = state.metrics.recent_requests[0];
    assert.equal(exhaustedCapacityHits, 4);
    assert.equal(record.status, 429);
    assert.equal(record.final_action, "upstream_error");
    assert.equal(record.attempts, 4);
    assert.equal(record.error, null);
    assert.deepEqual(record.retry_summary, {
      total: 3,
      reasoning_guard: 0,
      upstream_capacity: 3,
      transport: 0,
    });
    assert.deepEqual(record.failure_summary, {
      type: "upstream_error",
      code: "model_at_capacity",
      message: "Selected model is at capacity. Please try a different model.",
    });
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["internal_retry", "internal_retry", "internal_retry"]);
    assert.deepEqual(record.guard_actions.map((action) => action.status), [429, 429, 429]);

    const plain429 = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=plain-429`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "plain-429-model" }),
    });
    assert.equal(plain429.status, 429);
    assert.deepEqual(await plain429.json(), { error: { code: "rate_limit", message: "ordinary rate limit" } });

    state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "plain-429-model",
    );
    record = state.metrics.recent_requests[0];
    assert.equal(plain429Hits, 1);
    assert.equal(record.status, 429);
    assert.equal(record.final_action, "upstream_error");
    assert.equal(record.attempts, 1);
    assert.equal(typeof record.client_ttfb_ms, "number");
    assert.equal(record.client_ttfb_ms >= 0, true);
    assert.equal(record.client_ttfb_ms <= record.latency_ms, true);
    assert.equal(record.error, null);
    assert.deepEqual(record.failure_summary, {
      type: "upstream_error",
      code: "rate_limit",
      message: "ordinary rate limit",
    });
    assert.deepEqual(record.guard_actions, []);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy records upstream http failures and client request attempts separately", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  let upstreamHits = 0;

  const upstream = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad gateway");
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const requestBody = JSON.stringify({ model: "retry-model", input: "same request" });
    const turnMetadata = JSON.stringify({ turn_id: "turn-client-retry" });
    const headers = {
      "content-type": "application/json",
      "x-codex-turn-metadata": turnMetadata,
    };

    const first = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers,
      body: requestBody,
    });
    assert.equal(first.status, 502);
    assert.equal(await first.text(), "bad gateway");
    await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.client_request_attempt === 1,
    );

    const second = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers,
      body: requestBody,
    });
    assert.equal(second.status, 502);
    assert.equal(await second.text(), "bad gateway");

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.client_request_attempt === 2,
    );
    assert.equal(upstreamHits, 2);
    const [latest, previous] = state.metrics.recent_requests;
    assert.equal(latest.status, 502);
    assert.equal(latest.upstream_status, 502);
    assert.equal(latest.final_action, "upstream_error");
    assert.equal(latest.error, null);
    assert.equal(latest.attempts, 1);
    assert.equal(latest.retry_summary.total, 0);
    assert.equal(latest.client_turn_id, "turn-client-retry");
    assert.equal(latest.client_request_attempt, 2);
    assert.equal(previous.client_request_attempt, 1);
    assert.deepEqual(latest.failure_summary, {
      type: "upstream_error",
      code: "upstream_http_502",
      message: "upstream returned HTTP 502",
    });

    const output = await withStdoutProperties(
      { isTTY: false, columns: 180, rows: 40 },
      () => captureConsole(() => runProxyCommand(["--once", "--history", "2"], proxyOptions)),
    );
    assert.match(output, /\[client:2\] upstream_http_502: upstream returned HTTP 502/);

    const jsonl = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(jsonl.map((record) => record.client_request_attempt), [1, 2]);
    assert.deepEqual(jsonl.map((record) => record.attempt_records[0].final_action), ["upstream_error", "upstream_error"]);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy rereads current profile and overwrites stale client api key", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const inputPort = await reservePort();
  const ciiiPort = await reservePort();
  const seen = [];

  const input = createServer((req, res) => {
    seen.push({ upstream: "input", authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ upstream: "input" }));
  });
  const ciii = createServer((req, res) => {
    seen.push({ upstream: "ciii", authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ upstream: "ciii" }));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    const profiles = {
      input: { baseURL: `http://127.0.0.1:${inputPort}`, apiKey: "input-key" },
      ciii: { baseURL: `http://127.0.0.1:${ciiiPort}`, apiKey: "ciii-key" },
    };
    await writeProxyTestStateWithProfiles(home, stateRoot, proxyPort, profiles, "input", ["input", "ciii"]);
    await listenServer(input, inputPort);
    await listenServer(ciii, ciiiPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const first = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stale-client-key",
      },
      body: JSON.stringify({ model: "gpt-test" }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { upstream: "input" });

    await writeFile(
      join(stateRoot, "profiles.json"),
      JSON.stringify({ profiles, current: "ciii", toggle: ["input", "ciii"] }, null, 2),
      "utf8",
    );

    const second = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer input-key",
      },
      body: JSON.stringify({ model: "gpt-test" }),
    });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { upstream: "ciii" });

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests.length === 0
        && candidate.metrics.total_requests === 2,
    );
    assert.deepEqual(seen, [
      { upstream: "input", authorization: "Bearer input-key" },
      { upstream: "ciii", authorization: "Bearer ciii-key" },
    ]);
    assert.deepEqual(state.metrics.upstream_hit_counts, { input: 1, ciii: 1 });
    assert.equal(state.metrics.recent_requests[0].upstream, "ciii");
    assert.equal(state.metrics.recent_requests[1].upstream, "input");
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(input);
    await closeServer(ciii);
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

test("proxy rejects current profile without api key before upstream request", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  let upstreamHits = 0;

  const upstream = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestStateWithProfiles(
      home,
      stateRoot,
      proxyPort,
      { input: { baseURL: `http://127.0.0.1:${upstreamPort}`, apiKey: "" } },
      "input",
      ["input"],
    );
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stale-client-key",
      },
      body: JSON.stringify({ model: "gpt-test" }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { message: "profiles.current input has no apiKey" } });

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests.length === 0
        && candidate.metrics.recent_requests[0]?.path === "/v1/responses",
    );
    assert.equal(upstreamHits, 0);
    assert.equal(state.metrics.recent_requests[0].status, 500);
    assert.equal(state.metrics.recent_requests[0].upstream, null);
    assert.equal(state.metrics.recent_requests[0].attempts, 0);
    assert.equal(state.metrics.recent_requests[0].error, "profiles.current input has no apiKey");
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy retries transport fetch failed once and records upstream_error", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  let connections = 0;
  let requestHits = 0;
  const upstream = createServer((_req, res) => {
    requestHits += 1;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, requestHits }));
  });
  upstream.on("connection", (socket) => {
    connections += 1;
    if (connections === 1) {
      socket.destroy();
    }
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=transport-retry`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, requestHits: 1 });

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.path === "/responses",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(record.status, 200);
    assert.equal(record.attempts, 2);
    assert.equal(record.error, null);
    assert.deepEqual(record.retry_summary, {
      total: 1,
      reasoning_guard: 0,
      upstream_capacity: 0,
      transport: 1,
    });
    assert.equal(record.guard_actions.length, 1);
    assert.equal(record.guard_actions[0].action, "upstream_error");
    assert.match(record.guard_actions[0].error, /upstream_fetch_failed: fetch failed/);
    const fullRecord = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(fullRecord.client_ttfb_ms, record.client_ttfb_ms);
    assert.deepEqual(fullRecord.attempt_records.map((attempt) => attempt.attempt), [1, 2]);
    assert.deepEqual(record.usage_attempts, fullRecord.attempt_records.map((attempt) => ({
      attempt: attempt.attempt,
      input_tokens: attempt.input_tokens,
      output_tokens: attempt.output_tokens,
      cached_input_tokens: attempt.cached_input_tokens,
      pricing_model: attempt.upstream_model ?? record.request_model,
      pricing_model_source: attempt.upstream_model ? "upstream_model" : record.request_model ? "request_model" : null,
      pricing_tier: attempt.service_tier,
      pricing_tier_source: attempt.service_tier ? "response" : null,
    })));
    assert.deepEqual(record.usage_attempts.map((attempt) => [
      attempt.input_tokens,
      attempt.output_tokens,
      attempt.cached_input_tokens,
    ]), [[null, null, null], [null, null, null]]);
    const eventLog = await waitForLogIncludes(join(stateRoot, "proxy.log"), /"action":"upstream_error".*"upstream_fetch_failed: fetch failed"/);
    const events = eventLog.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), ["ccs_proxy_guard_action"]);
    assert.equal(events[0].request_id, record.id);
    assert.equal(events[0].path, "/responses");
    assert.equal(events[0].action, "upstream_error");
    assert.equal(events[0].attempt, 1);
    assert.equal(events[0].status, null);
    assert.equal(events[0].reasoning_tokens, null);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy returns upstream_fetch_failed after repeated transport failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=transport-fail`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.type, "upstream_error");
    assert.equal(payload.error.code, "upstream_fetch_failed");

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.path === "/responses",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(record.status, 502);
    assert.equal(record.attempts, 2);
    assert.match(record.error, /upstream_fetch_failed: fetch failed/);
    assert.deepEqual(record.retry_summary, {
      total: 1,
      reasoning_guard: 0,
      upstream_capacity: 0,
      transport: 1,
    });
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["upstream_error", "upstream_error"]);
    assert.deepEqual(record.guard_actions.map((action) => action.status), [null, null]);
    const output = await withStdoutProperties(
      { isTTY: false, columns: 160, rows: 40 },
      () => captureConsole(() => runProxyCommand(["--once", "--history", "1"], proxyOptions)),
    );
    assert.match(output, /\[err:502 err:502\] upstream_fetch_failed: fetch failed/);
    await waitForLogIncludes(join(stateRoot, "proxy.log"), /"action":"upstream_error".*"upstream_fetch_failed: fetch failed"/);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
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

test("proxy retries non-stream reasoning guard and reports exhausted guard", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  let successHits = 0;
  let exhaustedHits = 0;
  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const mode = url.searchParams.get("case");
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    if (mode === "json-success") {
      successHits += 1;
      const body = successHits <= 3
        ? reasoningJson("json-guarded", 516)
        : { ok: true, response: { model: "json-ok" }, usage: { output_tokens_details: { reasoning_tokens: 42 } } };
      body.usage.input_tokens_details = { cached_tokens: successHits <= 3 ? successHits : 0 };
      res.end(JSON.stringify(body));
      return;
    }
    exhaustedHits += 1;
    res.end(JSON.stringify(reasoningJson("json-exhausted", 1034)));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const success = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=json-success`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "json-success" }),
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), {
      ok: true,
      response: { model: "json-ok" },
      usage: {
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 42 },
      },
    });

    let state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "json-success",
    );
    let record = state.metrics.recent_requests[0];
    assert.equal(successHits, 4);
    assert.equal(record.attempts, 4);
    assert.deepEqual(record.retry_summary, {
      total: 3,
      reasoning_guard: 3,
      upstream_capacity: 0,
      transport: 0,
    });
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["internal_retry", "internal_retry", "internal_retry"]);
    assert.deepEqual(record.guard_actions.map((action) => action.reasoning_tokens), [516, 516, 516]);
    assert.equal(record.error, null);
    assert.equal(record.upstream_model, "json-ok");
    assert.equal(record.cached_input_tokens, 0);
    assert.equal(record.reasoning_tokens, 42);
    assert.equal(state.metrics.status_counts["200"], 4);
    assert.equal(state.metrics.reasoning_token_counts["42"], 1);
    assert.equal(state.metrics.reasoning_token_counts["516"], 3);
    const successJsonl = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.deepEqual(successJsonl.attempt_records.map((attempt) => attempt.cached_input_tokens), [1, 2, 3, 0]);
    assert.deepEqual(successJsonl.attempt_records.map((attempt) => attempt.attempt), [1, 2, 3, 4]);
    assert.deepEqual(record.usage_attempts, successJsonl.attempt_records.map((attempt) => ({
      attempt: attempt.attempt,
      input_tokens: attempt.input_tokens,
      output_tokens: attempt.output_tokens,
      cached_input_tokens: attempt.cached_input_tokens,
      pricing_model: attempt.upstream_model ?? record.request_model,
      pricing_model_source: attempt.upstream_model ? "upstream_model" : "request_model",
      pricing_tier: attempt.service_tier,
      pricing_tier_source: attempt.service_tier ? "response" : null,
    })));

    const exhausted = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=json-exhausted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "json-exhausted" }),
    });
    assert.equal(exhausted.status, 502);
    const exhaustedPayload = await exhausted.json();
    assert.equal(exhaustedPayload.error.code, "reasoning_guard_triggered");
    assert.equal(exhaustedPayload.error.reasoning_tokens, 1034);

    state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "json-exhausted",
    );
    record = state.metrics.recent_requests[0];
    assert.equal(exhaustedHits, 4);
    assert.equal(record.status, 502);
    assert.equal(record.attempts, 4);
    assert.deepEqual(record.retry_summary, {
      total: 3,
      reasoning_guard: 3,
      upstream_capacity: 0,
      transport: 0,
    });
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["internal_retry", "internal_retry", "internal_retry", "return_status_502"]);
    assert.deepEqual(record.guard_actions.map((action) => action.status), [200, 200, 200, 502]);
    assert.deepEqual(record.guard_actions.map((action) => action.reasoning_tokens), [1034, 1034, 1034, 1034]);
    assert.match(record.error, /reasoning_guard_triggered reasoning_tokens=1034/);
    assert.equal(record.upstream_model, "json-exhausted");
    assert.equal(record.reasoning_tokens, 1034);
    assert.equal(state.metrics.status_counts["200"], 7);
    assert.equal(state.metrics.status_counts["502"], 1);
    assert.equal(state.metrics.reasoning_token_counts["42"], 1);
    assert.equal(state.metrics.reasoning_token_counts["516"], 3);
    assert.equal(state.metrics.reasoning_token_counts["1034"], 4);
    await waitForLogIncludes(join(stateRoot, "proxy.log"), /"action":"return_status_502".*"reasoning_tokens":1034/);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy buffers SSE reasoning guard before client headers and retries", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const firstHold = holdControl();
  const secondHold = holdControl();
  let hits = 0;
  const successBody = `data: ${JSON.stringify({ ok: true, response: { model: "stream-ok" }, usage: { output_tokens_details: { reasoning_tokens: 42 } } })}\n\ndata: [DONE]\n\n`;
  const upstream = createServer((_req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(reasoningJson("stream-guarded", 1552))}\n\n`);
      firstHold.markStarted();
      void firstHold.release.then(() => {
        res.end("data: [DONE]\n\n");
      });
      return;
    }
    if (hits === 2) {
      secondHold.markStarted();
      void secondHold.release.then(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(successBody);
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(successBody);
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const streamFetch = fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=stream-guard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stream-guard" }),
    });
    let resolved = false;
    void streamFetch.then(() => {
      resolved = true;
    }, () => {
      resolved = true;
    });
    await firstHold.started;
    let state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests[0]?.upstream_model === "stream-guarded",
    );
    assert.equal(state.metrics.active_requests[0].status, 200);
    assert.equal(state.metrics.active_requests[0].attempts, 1);
    assert.equal(state.metrics.active_requests[0].reasoning_tokens, 1552);
    await delay(100);
    assert.equal(resolved, false);

    firstHold.finish();
    await secondHold.started;
    state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests[0]?.attempts === 2,
    );
    assert.equal(state.metrics.active_requests[0].status, null);
    assert.equal(state.metrics.active_requests[0].reasoning_tokens, null);
    assert.equal(state.metrics.active_requests[0].upstream_model, null);
    assert.deepEqual(state.metrics.active_requests[0].guard_actions.map((action) => action.reasoning_tokens), [1552]);
    await delay(100);
    assert.equal(resolved, false);

    secondHold.finish();
    const response = await streamFetch;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), successBody);

    state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "stream-guard",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(hits, 2);
    assert.equal(record.attempts, 2);
    assert.equal(record.upstream_model, "stream-ok");
    assert.equal(record.reasoning_tokens, 42);
    assert.equal(state.metrics.status_counts["200"], 2);
    assert.equal(state.metrics.reasoning_token_counts["1552"], 1);
    assert.equal(state.metrics.reasoning_token_counts["42"], 1);
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["internal_retry"]);
    assert.deepEqual(record.guard_actions.map((action) => action.reasoning_tokens), [1552]);
    await waitForLogIncludes(join(stateRoot, "proxy.log"), /"action":"internal_retry".*"reasoning_tokens":1552/);
  } finally {
    firstHold.finish();
    secondHold.finish();
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy recovers guarded Responses streams with continuation", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const requestBodies = [];
  let hits = 0;
  const upstream = createServer((req, res) => {
    void (async () => {
      requestBodies.push(JSON.parse(await readServerRequestBody(req)));
      hits += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (hits === 1) {
        res.end(`data: ${JSON.stringify({
          type: "response.output_item.done",
          item: { type: "reasoning", encrypted_content: "encrypted-one" },
          response: { model: "stream-guarded" },
          usage: { output_tokens_details: { reasoning_tokens: 1552 } },
        })}\n\ndata: [DONE]\n\n`);
        return;
      }
      res.end(`data: ${JSON.stringify({
        response: { model: "stream-ok" },
        output: [{ type: "reasoning", encrypted_content: "encrypted-final" }],
        usage: { output_tokens_details: { reasoning_tokens: 42 } },
      })}\n\ndata: [DONE]\n\n`);
    })().catch((error) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=continuation-success`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stream-continuation", stream: true, input: "hello" }),
    });
    assert.equal(response.status, 200);
    const responseText = await response.text();
    assert.doesNotMatch(responseText, /encrypted_content|encrypted-final/);
    assert.match(responseText, /"reasoning"/);

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "stream-continuation",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(hits, 2);
    assert.equal(requestBodies[0].include.includes("reasoning.encrypted_content"), true);
    assert.equal(requestBodies[1].include.includes("reasoning.encrypted_content"), true);
    assert.equal(requestBodies[1].input[0].content, "hello");
    assert.equal(requestBodies[1].input[1].encrypted_content, "encrypted-one");
    assert.equal(requestBodies[1].input.at(-1).content[0].text, "Continue thinking...");
    assert.equal(record.request_kind, "normal");
    assert.equal(record.attempts, 2);
    assert.equal(record.reasoning_tokens, 42);
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["continuation_recovery"]);
    assertCompleteProxyGuardAction(record.guard_actions[0], {
      action: "continuation_recovery",
      upstream: "input",
      attempt: 1,
      status: 200,
      reasoning_tokens: 1552,
      error: null,
    });
    assert.equal(Object.hasOwn(record, "attempt_records"), false);
    assert.equal(state.metrics.status_counts["200"], 2);
    assert.equal(state.metrics.reasoning_token_counts["1552"], 1);
    assert.equal(state.metrics.reasoning_token_counts["42"], 1);

    const jsonl = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const fullRecord = jsonl.at(-1);
    assert.equal(fullRecord.request_kind, "normal");
    assert.equal(fullRecord.attempt_records.length, 2);
    assert.deepEqual(fullRecord.attempt_records.map((attempt) => attempt.final_action), ["continuation_recovery", "passed"]);
    assertCompleteProxyAttemptRecord(fullRecord.attempt_records[0], {
      attempt: 1,
      upstream: "input",
      upstream_status: 200,
      upstream_model: "stream-guarded",
      upstream_model_source: "sse.data.response.model",
      reasoning_tokens: 1552,
      reasoning_tokens_source: "sse.data/usage/output_tokens_details/reasoning_tokens",
      reasoning_text_observed: false,
      reasoning_text_source: null,
      final_action: "continuation_recovery",
      failure_summary: null,
      remaining_retries: 2,
    });
    assertCompleteProxyAttemptRecord(fullRecord.attempt_records[1], {
      attempt: 2,
      upstream: "input",
      upstream_status: 200,
      upstream_model: "stream-ok",
      upstream_model_source: "sse.data.response.model",
      reasoning_tokens: 42,
      reasoning_tokens_source: "sse.data/usage/output_tokens_details/reasoning_tokens",
      reasoning_text_observed: false,
      reasoning_text_source: null,
      final_action: "passed",
      failure_summary: null,
      remaining_retries: null,
    });
    await waitForLogIncludes(
      join(stateRoot, "proxy.log"),
      /"path":"\/v1\/responses".*"action":"continuation_recovery".*"attempt":1.*"reasoning_tokens":1552/,
    );

    const output = await captureConsole(() => runProxyCommand(["--once"], proxyOptions));
    assert.match(output, /reasoning .*recovery=1 recovered=1 exhausted=0/);
    assert.match(output, /\[rec:1552\]/);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy mode intercept disables continuation recovery", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const requestBodies = [];
  let hits = 0;
  const upstream = createServer((req, res) => {
    void (async () => {
      requestBodies.push(JSON.parse(await readServerRequestBody(req)));
      hits += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "reasoning", encrypted_content: `encrypted-${hits}` },
        response: { model: "stream-intercept" },
        usage: { output_tokens_details: { reasoning_tokens: 1552 } },
      })}\n\ndata: [DONE]\n\n`);
    })().catch((error) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const modeResult = await setProxyMode(proxyOptions, "intercept");
    assert.equal(modeResult.mode, "intercept");
    assert.equal(modeResult.runtime?.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=intercept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stream-intercept", stream: true, input: "hello" }),
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.code, "reasoning_guard_triggered");
    assert.equal(payload.error.reasoning_tokens, 1552);

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "stream-intercept",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(hits, 4);
    assert.equal(record.mode, "intercept");
    assert.equal(record.attempts, 4);
    assert.equal(requestBodies.every((body) => body.include === undefined), true);
    assert.deepEqual(record.guard_actions.map((action) => action.action), [
      "internal_retry",
      "internal_retry",
      "internal_retry",
      "return_status_502",
    ]);
    assert.equal(record.guard_actions.some((action) => action.action === "continuation_recovery"), false);

    const jsonl = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const fullRecord = jsonl.at(-1);
    assert.equal(fullRecord.mode, "intercept");
    assert.deepEqual(fullRecord.attempt_records.map((attempt) => attempt.final_action), [
      "internal_retry",
      "internal_retry",
      "internal_retry",
      "blocked",
    ]);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy stop switches to passthrough and forwards the original request", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const requestBodies = [];
  let hits = 0;
  const upstream = createServer((req, res) => {
    void (async () => {
      requestBodies.push(JSON.parse(await readServerRequestBody(req)));
      hits += 1;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      const payload = req.url?.includes("case=passthrough-text")
        ? {
          response: {
            model: "passthrough-text",
            output: [{ content: [{ reasoning: "observed" }] }],
            service_tier: "priority",
          },
          usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
        }
        : reasoningJson("passthrough-guarded", 1552);
      payload.response.service_tier = "priority";
      payload.usage.input_tokens = 120;
      payload.usage.output_tokens = 30;
      payload.usage.input_tokens_details = { cached_tokens: 20 };
      res.end(JSON.stringify(payload));
    })().catch((error) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const modeResult = await stopProxy(proxyOptions);
    assert.equal(modeResult.mode, "passthrough");
    assert.equal(modeResult.runtime?.healthy, true);
    const health = await fetch(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);
    const healthPayload = await health.json();
    assert.equal(healthPayload.mode, "passthrough");

    const body = { model: "passthrough-guarded", stream: true, input: "hello" };
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=passthrough`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.response.model, "passthrough-guarded");
    assert.equal(payload.usage.output_tokens_details.reasoning_tokens, 1552);

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "passthrough-guarded",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(hits, 1);
    assert.deepEqual(requestBodies, [body]);
    assert.equal(record.mode, "passthrough");
    assert.equal(record.status, 200);
    assert.equal(record.attempts, 1);
    assert.equal(typeof record.client_ttfb_ms, "number");
    assert.equal(record.client_ttfb_ms >= 0, true);
    assert.equal(record.client_ttfb_ms <= record.latency_ms, true);
    assert.deepEqual(record.guard_actions, []);
    assert.equal(record.reasoning_tokens, 1552);
    assert.equal(record.reasoning_tokens_source, "/usage/output_tokens_details/reasoning_tokens");
    const fullRecord = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(fullRecord.client_ttfb_ms, record.client_ttfb_ms);
    assert.deepEqual(fullRecord.attempt_records.map((attempt) => attempt.attempt), [1]);
    assert.deepEqual(record.usage_attempts, [{
      attempt: 1,
      input_tokens: 120,
      output_tokens: 30,
      cached_input_tokens: 20,
      pricing_model: "passthrough-guarded",
      pricing_model_source: "upstream_model",
      pricing_tier: "priority",
      pricing_tier_source: "response",
    }]);
    assert.deepEqual(record.usage_attempts, fullRecord.attempt_records.map((attempt) => ({
      attempt: attempt.attempt,
      input_tokens: attempt.input_tokens,
      output_tokens: attempt.output_tokens,
      cached_input_tokens: attempt.cached_input_tokens,
      pricing_model: attempt.upstream_model ?? record.request_model,
      pricing_model_source: attempt.upstream_model ? "upstream_model" : "request_model",
      pricing_tier: attempt.service_tier,
      pricing_tier_source: attempt.service_tier ? "response" : null,
    })));

    const textResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=passthrough-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "passthrough-text", input: "hello" }),
    });
    assert.equal(textResponse.status, 200);
    await textResponse.arrayBuffer();
    const textState = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "passthrough-text",
    );
    const textRecord = textState.metrics.recent_requests[0];
    assert.equal(textRecord.reasoning_tokens, null);
    assert.equal(textRecord.reasoning_text_observed, true);
    assert.equal(textRecord.reasoning_text_source, "/response/output/0/content/0/reasoning");
    assert.deepEqual(textRecord.guard_actions, []);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy exhausts Responses continuation recovery before guard response", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({
      type: "response.output_item.done",
      item: { type: "reasoning", encrypted_content: `encrypted-${hits}` },
      response: { model: "stream-exhausted" },
      usage: { output_tokens_details: { reasoning_tokens: 1552 } },
    })}\n\ndata: [DONE]\n\n`);
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=continuation-exhausted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stream-continuation-exhausted", stream: true, input: "hello" }),
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.code, "reasoning_guard_triggered");
    assert.equal(payload.error.reasoning_tokens, 1552);

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "stream-continuation-exhausted",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(hits, 4);
    assert.equal(record.attempts, 4);
    assert.deepEqual(record.guard_actions.map((action) => action.action), [
      "continuation_recovery",
      "continuation_recovery",
      "continuation_recovery",
      "return_status_502",
    ]);
    record.guard_actions.forEach((action, index) => {
      assertCompleteProxyGuardAction(action, {
        action: index < 3 ? "continuation_recovery" : "return_status_502",
        upstream: "input",
        attempt: index + 1,
        status: index < 3 ? 200 : 502,
        reasoning_tokens: 1552,
        error: index < 3 ? null : "reasoning_guard_triggered reasoning_tokens=1552",
      });
    });
    assert.equal(state.metrics.status_counts["200"], 3);
    assert.equal(state.metrics.status_counts["502"], 1);
    assert.equal(state.metrics.reasoning_token_counts["1552"], 4);

    const jsonl = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const fullRecord = jsonl.at(-1);
    assert.deepEqual(fullRecord.attempt_records.map((attempt) => attempt.final_action), [
      "continuation_recovery",
      "continuation_recovery",
      "continuation_recovery",
      "blocked",
    ]);
    fullRecord.attempt_records.forEach((attempt, index) => {
      assertCompleteProxyAttemptRecord(attempt, {
        attempt: index + 1,
        upstream: "input",
        upstream_status: 200,
        upstream_model: "stream-exhausted",
        upstream_model_source: "sse.data.response.model",
        reasoning_tokens: 1552,
        reasoning_tokens_source: "sse.data/usage/output_tokens_details/reasoning_tokens",
        reasoning_text_observed: false,
        reasoning_text_source: null,
        final_action: index < 3 ? "continuation_recovery" : "blocked",
        failure_summary: index < 3 ? null : {
          type: "codex_proxy",
          code: "reasoning_guard_triggered",
          message: "reasoning_guard_triggered reasoning_tokens=1552",
        },
        remaining_retries: Math.max(0, 2 - index),
      });
    });

    const output = await captureConsole(() => runProxyCommand(["--once"], proxyOptions));
    assert.match(output, /reasoning .*recovery=3 recovered=0 exhausted=1/);
    assert.match(output, /\[rec:1552 rec:1552 rec:1552 block:1552\] reasoning_guard_triggered reasoning_tokens=1552/);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy records request kind from Codex headers and request fields", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const specs = [
      {
        model: "kind-header-request-kind",
        headers: { "x-codex-request-kind": "context_compaction" },
        body: {},
        expected: "context_compaction",
      },
      {
        model: "kind-header-purpose",
        headers: { "x-codex-purpose": "remote_compaction" },
        body: {},
        expected: "context_compaction",
      },
      {
        model: "kind-header-turn-metadata",
        headers: { "x-codex-turn-metadata": JSON.stringify({ purpose: "remote_compaction" }) },
        body: {},
        expected: "context_compaction",
      },
      {
        model: "kind-body-metadata",
        headers: {},
        body: { metadata: { purpose: "remote_compaction" } },
        expected: "context_compaction",
      },
      {
        model: "kind-body-codex-request-kind",
        headers: {},
        body: { codex_request_kind: "context_compaction" },
        expected: "context_compaction",
      },
      {
        model: "kind-body-request-kind",
        headers: {},
        body: { request_kind: "context_compaction" },
        expected: "context_compaction",
      },
      {
        model: "kind-body-purpose",
        headers: {},
        body: { purpose: "remote_compaction" },
        expected: "context_compaction",
      },
      {
        model: "kind-default-normal",
        headers: {},
        body: {},
        expected: "normal",
      },
    ];

    for (const spec of specs) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=${spec.model}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...spec.headers },
        body: JSON.stringify({ model: spec.model, ...spec.body }),
      });
      assert.equal(response.status, 200);
      await response.text();

      const state = await waitForState(
        stateRoot,
        (candidate) => candidate.metrics.recent_requests[0]?.request_model === spec.model,
      );
      assert.equal(state.metrics.recent_requests[0].request_kind, spec.expected);
      const jsonl = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(jsonl.at(-1).request_model, spec.model);
      assert.equal(jsonl.at(-1).request_kind, spec.expected);
    }
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy excludes context compaction from Responses continuation recovery", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const requestBodies = [];
  let hits = 0;
  const upstream = createServer((req, res) => {
    void (async () => {
      requestBodies.push(JSON.parse(await readServerRequestBody(req)));
      hits += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "reasoning", encrypted_content: `encrypted-${hits}` },
        response: { model: "stream-compaction" },
        usage: { output_tokens_details: { reasoning_tokens: 1552 } },
      })}\n\ndata: [DONE]\n\n`);
    })().catch((error) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=context-compaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "stream-context-compaction",
        stream: true,
        input: "compact",
        metadata: { purpose: "remote_compaction" },
      }),
    });
    assert.equal(response.status, 502);

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "stream-context-compaction",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(hits, 4);
    assert.equal(requestBodies.every((body) => body.include === undefined), true);
    assert.equal(record.request_kind, "context_compaction");
    assert.deepEqual(record.guard_actions.map((action) => action.action), [
      "internal_retry",
      "internal_retry",
      "internal_retry",
      "return_status_502",
    ]);
    record.guard_actions.forEach((action, index) => {
      assertCompleteProxyGuardAction(action, {
        action: index < 3 ? "internal_retry" : "return_status_502",
        upstream: "input",
        attempt: index + 1,
        status: index < 3 ? 200 : 502,
        reasoning_tokens: 1552,
        error: index < 3 ? null : "reasoning_guard_triggered reasoning_tokens=1552",
      });
    });

    const jsonl = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const fullRecord = jsonl.at(-1);
    assert.equal(fullRecord.request_kind, "context_compaction");
    assert.deepEqual(fullRecord.attempt_records.map((attempt) => attempt.final_action), [
      "internal_retry",
      "internal_retry",
      "internal_retry",
      "blocked",
    ]);
    fullRecord.attempt_records.forEach((attempt, index) => {
      assertCompleteProxyAttemptRecord(attempt, {
        attempt: index + 1,
        upstream: "input",
        upstream_status: 200,
        upstream_model: "stream-compaction",
        upstream_model_source: "sse.data.response.model",
        reasoning_tokens: 1552,
        reasoning_tokens_source: "sse.data/usage/output_tokens_details/reasoning_tokens",
        reasoning_text_observed: false,
        reasoning_text_source: null,
        final_action: index < 3 ? "internal_retry" : "blocked",
        failure_summary: index < 3 ? null : {
          type: "codex_proxy",
          code: "reasoning_guard_triggered",
          message: "reasoning_guard_triggered reasoning_tokens=1552",
        },
        remaining_retries: Math.max(0, 2 - index),
      });
    });
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy records client abort while buffering SSE before response headers", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const hold = holdControl();
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ response: { model: "stream-held" } })}\n\n`);
    hold.markStarted();
    void hold.release.then(() => {
      res.end("data: [DONE]\n\n");
    });
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const abortController = new AbortController();
    const streamFetch = fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=client-abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "client-abort" }),
      signal: abortController.signal,
    });
    const rejected = assert.rejects(streamFetch);
    await hold.started;
    let state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests[0]?.upstream_model === "stream-held",
    );
    assert.equal(state.metrics.active_requests[0].status, 200);
    assert.equal(state.metrics.active_requests[0].completed_at, null);

    abortController.abort();
    await rejected;
    state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests.length === 0
        && candidate.metrics.recent_requests[0]?.request_model === "client-abort",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(record.status, 499);
    assert.equal(record.upstream, "input");
    assert.equal(record.attempts, 1);
    assert.equal(record.error, "client closed response before upstream stream completed");
    assert.equal(record.response_bytes, 0);
    assert.equal(record.upstream_model, "stream-held");
  } finally {
    hold.finish();
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy returns reasoning_guard_triggered after exhausted SSE guard retries", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(reasoningJson("stream-exhausted", 1552))}\n\ndata: [DONE]\n\n`);
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=stream-exhausted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stream-exhausted" }),
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.code, "reasoning_guard_triggered");
    assert.equal(payload.error.reasoning_tokens, 1552);

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "stream-exhausted",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(hits, 4);
    assert.equal(record.status, 502);
    assert.equal(record.attempts, 4);
    assert.deepEqual(record.guard_actions.map((action) => action.status), [200, 200, 200, 502]);
    assert.equal(record.upstream_model, "stream-exhausted");
    assert.equal(record.reasoning_tokens, 1552);
    assert.equal(state.metrics.status_counts["200"], 3);
    assert.equal(state.metrics.status_counts["502"], 1);
    assert.equal(state.metrics.reasoning_token_counts["1552"], 4);
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["internal_retry", "internal_retry", "internal_retry", "return_status_502"]);
    assert.deepEqual(record.guard_actions.map((action) => action.reasoning_tokens), [1552, 1552, 1552, 1552]);
    await waitForLogIncludes(join(stateRoot, "proxy.log"), /"action":"return_status_502".*"reasoning_tokens":1552/);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy records reasoning token sources and reasoning text observations separately", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const mode = url.searchParams.get("case");
    if (mode === "json-plus") {
      res.writeHead(200, { "content-type": "application/problem+json; charset=utf-8" });
      res.end(JSON.stringify({
        model: "json-plus",
        usage: {
          prompt_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 42 },
        },
      }));
      return;
    }
    if (mode === "json-text") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        delta: { reasoning_content: "visible thinking" },
        usage: { output_tokens_details: { reasoning_tokens: -1 } },
        response: {
          model: "json-text",
          usage: { prompt_tokens_details: { cached_tokens: 13 } },
        },
      }));
      return;
    }
    if (mode === "sse-latest") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ response: { model: "sse-latest", usage: { input_tokens_details: { cached_tokens: 21 } } }, usage: { output_tokens_details: { reasoning_tokens: 41 } } })}\n\n`);
      res.write(`data: ${JSON.stringify({ usage: { input_tokens_details: { cached_tokens: 22 }, output_tokens_details: { reasoning_tokens: 42 } } })}\n\n`);
      res.write(`data: ${JSON.stringify({ usage: { input_tokens_details: { cached_tokens: -1 } } })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ model: "glm-5.2", choices: [{ delta: { reasoning_content: "plan" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    for (const [mode, path] of [
      ["json-plus", "/v1/chat/completions"],
      ["json-text", "/responses"],
      ["sse-latest", "/v1/responses"],
      ["glm-text", "/chat/completions"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}${path}?case=${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: mode }),
      });
      assert.equal(response.status, 200);
      await response.text();
    }

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests.length === 0
        && candidate.metrics.total_requests === 4,
    );
    const byModel = new Map(state.metrics.recent_requests.map((record) => [record.request_model, record]));

    const jsonPlus = byModel.get("json-plus");
    assert.ok(jsonPlus);
    assert.equal(jsonPlus.cached_input_tokens, 0);
    assert.equal(jsonPlus.reasoning_tokens, 42);
    assert.equal(jsonPlus.reasoning_tokens_source, "/usage/output_tokens_details/reasoning_tokens");
    assert.equal(jsonPlus.reasoning_text_observed, false);
    assert.equal(jsonPlus.reasoning_text_source, null);

    const jsonText = byModel.get("json-text");
    assert.ok(jsonText);
    assert.equal(jsonText.cached_input_tokens, 13);
    assert.equal(jsonText.reasoning_tokens, null);
    assert.equal(jsonText.reasoning_tokens_source, null);
    assert.equal(jsonText.reasoning_text_observed, true);
    assert.equal(jsonText.reasoning_text_source, "/delta/reasoning_content");

    const sseLatest = byModel.get("sse-latest");
    assert.ok(sseLatest);
    assert.equal(sseLatest.cached_input_tokens, 22);
    assert.equal(sseLatest.reasoning_tokens, 42);
    assert.equal(sseLatest.reasoning_tokens_source, "sse.data/usage/output_tokens_details/reasoning_tokens");
    assert.equal(state.metrics.reasoning_token_counts["41"], undefined);
    assert.equal(state.metrics.reasoning_token_counts["42"], 2);

    const glmText = byModel.get("glm-text");
    assert.ok(glmText);
    assert.equal(glmText.upstream_model, "glm-5.2");
    assert.equal(glmText.reasoning_tokens, null);
    assert.equal(glmText.reasoning_text_observed, true);
    assert.equal(glmText.reasoning_text_source, "sse.data/choices/0/delta/reasoning_content");

    const output = await captureConsole(() => runProxyCommand(["--once", "--history", "4"], proxyOptions));
    assert.match(output, /glm-5\.2\s+text\/200/);
    assert.match(output, /text\/200/);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy writes current request record facts with prompt and response text outside records", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const upstream = createServer((req, res) => {
    void (async () => {
      await readServerRequestBody(req);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        id: "resp-observed",
        model: "upstream-observed",
        system_fingerprint: "fp-observed",
        service_tier: "priority",
        output: [
          { type: "reasoning", encrypted_content: "encrypted-observed" },
          { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "do not store response text" }] },
        ],
        usage: {
          input_tokens: 11,
          input_tokens_details: { cached_tokens: 7 },
          output_tokens: 13,
          total_tokens: 24,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      }));
    })().catch((error) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const requestBody = JSON.stringify({
      model: "request-observed",
      reasoning: { effort: "high" },
      input: "sensitive prompt text",
    });
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: "Bearer secret",
        "x-api-key": "secret",
        "x-codex-purpose": "observability",
      },
      body: requestBody,
    });
    assert.equal(response.status, 200);
    await response.text();

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "request-observed",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(record.schema_version, 5);
    assert.equal(record.final_action, "passed");
    assert.equal(record.client_status, 200);
    assert.equal(record.upstream_status, 200);
    assert.equal(record.failure_summary, null);
    assert.equal(record.request_reasoning_effort, "high");
    assert.equal(record.request_body_sha256, createHash("sha256").update(requestBody).digest("hex"));
    assert.equal(record.upstream_model, "upstream-observed");
    assert.equal(record.final_response_model, "upstream-observed");
    assert.equal(record.system_fingerprint, "fp-observed");
    assert.equal(record.service_tier, "priority");
    assert.equal(record.input_tokens, 11);
    assert.equal(record.cached_input_tokens, 7);
    assert.equal(record.reasoning_tokens, 5);
    assert.equal(record.output_tokens, 13);
    assert.equal(record.total_tokens, 24);
    assert.equal(record.has_reasoning_item, true);
    assert.equal(record.has_final_answer, true);
    assert.equal(record.final_answer_only, false);
    assert.equal(record.has_commentary, false);
    assert.equal(record.has_tool_call, false);
    assert.equal(record.retry_summary.total, 0);
    assert.equal(typeof record.upstream_wait_ms, "number");
    assert.equal(record.time_to_first_chunk_ms, null);
    assert.equal(record.stream_duration_ms, null);
    assert.equal(Object.hasOwn(record, "attempt_records"), false);
    assert.equal(Object.hasOwn(record, "request_headers"), false);

    const jsonl = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const fullRecord = jsonl.at(-1);
    assert.equal(fullRecord.cached_input_tokens, 7);
    assert.equal(fullRecord.request_headers["content-type"], "application/json");
    assert.equal(fullRecord.request_headers.accept, "application/json");
    assert.equal(fullRecord.request_headers["x-codex-purpose"], "observability");
    assert.equal(Object.hasOwn(fullRecord.request_headers, "authorization"), false);
    assert.equal(Object.hasOwn(fullRecord.request_headers, "x-api-key"), false);
    assert.equal(fullRecord.attempt_records.length, 1);
    assertCompleteProxyAttemptRecord(fullRecord.attempt_records[0], {
      attempt: 1,
      upstream: "input",
      upstream_status: 200,
      upstream_model: "upstream-observed",
      upstream_model_source: "json.model",
      stream_model: null,
      final_response_model: "upstream-observed",
      system_fingerprint: "fp-observed",
      service_tier: "priority",
      input_tokens: 11,
      cached_input_tokens: 7,
      reasoning_tokens: 5,
      reasoning_tokens_source: "/usage/output_tokens_details/reasoning_tokens",
      output_tokens: 13,
      total_tokens: 24,
      reasoning_text_observed: false,
      reasoning_text_source: null,
      has_commentary: false,
      has_final_answer: true,
      final_answer_only: false,
      has_tool_call: false,
      has_reasoning_item: true,
      final_action: "passed",
      failure_summary: null,
      remaining_retries: null,
    });

    const fullRecordText = JSON.stringify(fullRecord);
    assert.doesNotMatch(fullRecordText, /sensitive prompt text/);
    assert.doesNotMatch(fullRecordText, /do not store response text/);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy keeps running when completed request logging fails after response headers", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();

  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await mkdir(join(stateRoot, "proxy-requests.jsonl"));
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "logging-failure" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "logging-failure",
    );
    assert.equal(state.metrics.active_requests.length, 0);
    assert.equal(state.metrics.recent_requests[0].status, 200);
    await waitForLogIncludes(join(stateRoot, "proxy.log"), /"event":"ccs_proxy_request_error".*proxy-requests\.jsonl/);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy forwards large request bodies", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  const upstreamPort = await reservePort();
  const bodySize = (10 * 1024 * 1024) + 1024;
  const upstream = createServer(async (req, res) => {
    let bytes = 0;
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ bytes }));
  });

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await writeProxyTestState(home, stateRoot, proxyPort, upstreamPort);
    await listenServer(upstream, upstreamPort);

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const runtime = await ensureProxyRunning(proxyOptions);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);

    const body = Buffer.alloc(bodySize, "a");
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=large-body`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { bytes: bodySize });

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests.length === 0
        && candidate.metrics.recent_requests[0]?.path === "/responses",
    );
    assert.equal(state.metrics.recent_requests[0].status, 200);
    assert.equal(state.metrics.recent_requests[0].request_bytes, bodySize);
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
    await closeServer(upstream);
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

test("proxy status table renders configured columns and compact units", () => {
  const stateRoot = "/tmp/codex-tools";
  const lines = buildProxyStatusLines(
    new Date("2026-01-01T00:00:00.000Z"),
    {
      installed_at: "2026-01-01T00:00:00.000Z",
      codex_config_path: "/home/test/.codex/config.toml",
      provider_name: "codex",
      original_base_url: "https://proxy.example.com",
      proxy_base_url: "http://127.0.0.1:4610",
      mode: "recovery",
      listen_host: "127.0.0.1",
      listen_port: 4610,
      profile_order: ["input"],
      backup_path: "/tmp/backup.toml",
      metrics: {
        total_requests: 2,
        active_requests: [
          proxyHistoryRecord({
            completed_at: null,
            started_at: "2026-01-01T00:00:00.000Z",
            status: 200,
            upstream: "input",
            latency_ms: 0,
            request_bytes: 2048,
            response_bytes: 0,
            request_model: "gpt-5.5",
            upstream_model: "gpt-5.5",
            reasoning_tokens: 42,
            path: "/active",
          }),
          proxyHistoryRecord({
            completed_at: null,
            started_at: "2026-01-01T00:00:00.000Z",
            status: null,
            upstream: "input",
            latency_ms: 0,
            request_bytes: 1024,
            response_bytes: 0,
            request_model: null,
            upstream_model: null,
            path: "/pending",
          }),
        ],
        status_counts: {},
        reasoning_token_counts: {},
        upstream_hit_counts: { input: 2 },
        latency_ms: { last: 56, count: 2, sum: 356, min: 56, max: 300 },
        recent_requests: [
          proxyHistoryRecord({
            session: "019f0df6",
            completed_at: "2026-01-01T00:00:05.000Z",
            upstream: "input",
            latency_ms: 56,
            response_bytes: 32 * 1024,
            request_model: "gpt-5.5",
            upstream_model: "gpt-5.5",
            reasoning_tokens: 42,
            path: "/same",
          }),
          proxyHistoryRecord({
            session: "019f0dfb",
            completed_at: "2026-01-01T00:00:01.500Z",
            upstream: "input",
            attempts: 3,
            status: 502,
            latency_ms: 300,
            response_bytes: 2048,
            request_model: "gpt-5.5",
            upstream_model: "gpt-5.5",
            path: "/retry",
            guard_actions: [
              { at: "2026-01-01T00:00:00.100Z", action: "upstream_error", upstream: "input", attempt: 1, status: null, reasoning_tokens: null, error: "upstream_fetch_failed" },
              { at: "2026-01-01T00:00:00.200Z", action: "upstream_error", upstream: "input", attempt: 2, status: null, reasoning_tokens: null, error: "upstream_fetch_failed" },
              { at: "2026-01-01T00:00:00.300Z", action: "internal_retry", upstream: "input", attempt: 3, status: 200, reasoning_tokens: 506, error: null },
            ],
            error: "reasoning_guard_triggered reasoning_tokens=506",
          }),
        ],
      },
    },
    ["input"],
    { healthy: true, started: false, pid: 1234, state: null, version: "0.1.12", protocol: 3 },
    {
      codexConfigPath: "/home/test/.codex/config.toml",
      listenHost: "127.0.0.1",
      listenPort: 4610,
      stateRoot,
    },
  ).join("\n");

  assert.match(lines, /session\s+time\s+up\s+model\s+reas\.\/code\s+lat\.\s+size\s+error/);
  assert.doesNotMatch(lines, /\bmethod\b/);
  assert.doesNotMatch(lines, /^\s+\d+\./m);
  assert.match(lines, /active\n\s+session\s+time\s+up\s+model\s+reas\.\/code\s+lat\.\s+size\s+error\n\s+019f0df6\s+\d\d:\d\d:00\s+input\s+o5\.5\s+42\/200\s+0ms\s+2\.00K/);
  assert.match(lines, /019f0df6\s+\d\d:\d\d:00\s+input\s+-\s+-\/-\s+0ms\s+1\.00K/);
  assert.match(lines, /019f0df6\s+\d\d:\d\d:05\s+input\s+o5\.5\s+42\/200\s+56ms\s+32\.0K/);
  assert.match(lines, /019f0dfb\s+\d\d:\d\d:01\s+input3\s+o5\.5\s+-\/502\s+300ms\s+2\.00K\s+\[err:502 err:502 guard:506\] reasoning_guard_triggered reasoning_tokens=506/);
  assert.doesNotMatch(lines, /gpt-5\.5/);
});

test("proxy status session column uses stable shallow colors in TTY output", async () => {
  const script = `
    ${stdoutPropertiesScript({ noColor: false, isTTY: true, columns: 180 })}
    const { buildProxyStatusLines } = await import("./dist/commands/ccs-proxy.js");
    const record = (id, session, completedAt) => ({
      id,
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: completedAt,
      method: "POST",
      path: "/responses",
      status: completedAt ? 200 : null,
      upstream: "input",
      attempts: 1,
      latency_ms: completedAt ? 50 : 0,
      request_bytes: 1024,
      response_bytes: completedAt ? 2048 : 0,
      session,
      request_kind: "normal",
      request_model: "gpt-5.5",
      upstream_model: "gpt-5.5",
        upstream_model_source: null,
        reasoning_tokens: null,
        reasoning_tokens_source: null,
        usage_attempts: [],
        reasoning_text_observed: false,
      reasoning_text_source: null,
      guard_actions: [],
      error: null,
    });
    const state = {
      installed_at: "2026-01-01T00:00:00.000Z",
      codex_config_path: "/home/test/.codex/config.toml",
      provider_name: "codex",
      original_base_url: "https://proxy.example.com",
      proxy_base_url: "http://127.0.0.1:4610",
      listen_host: "127.0.0.1",
      listen_port: 4610,
      profile_order: ["input"],
      backup_path: "/tmp/backup.toml",
      metrics: {
        total_requests: 3,
        active_requests: [record("active-same", "019f0df6", null)],
        status_counts: { "200": 2 },
        reasoning_token_counts: {},
        upstream_hit_counts: { input: 2 },
        latency_ms: { last: 50, count: 2, sum: 100, min: 50, max: 50 },
        recent_requests: [
          record("history-same", "019f0df6", "2026-01-01T00:00:02.000Z"),
          record("history-other", "019f0df7", "2026-01-01T00:00:01.000Z"),
          record("history-none", null, "2026-01-01T00:00:00.000Z"),
        ],
      },
    };
    const lines = buildProxyStatusLines(
      new Date("2026-01-01T00:00:03.000Z"),
      state,
      ["input"],
      { healthy: true, started: false, pid: 1234, state: null, version: "0.2.2", protocol: 3 },
      {
        codexConfigPath: "/home/test/.codex/config.toml",
        listenHost: "127.0.0.1",
        listenPort: 4610,
        stateRoot: "/tmp/codex-tools",
      },
    );
    process.stdout.write(JSON.stringify(lines));
  `;
  const { stdout } = await execNodeScript(script);
  const output = JSON.parse(stdout).join("\n");
  const sameSession = [...output.matchAll(/(\u001b\[[0-9;]*m019f0df6\u001b\[0m)/g)].map((match) => match[1]);
  const otherSession = output.match(/(\u001b\[[0-9;]*m019f0df7\u001b\[0m)/)?.[1];

  assert.equal(sameSession.length, 2);
  assert.equal(sameSession[0], sameSession[1]);
  assert.ok(otherSession);
  assert.notEqual(otherSession, sameSession[0]);
  assert.match(output, /\u001b\[2m-\u001b\[0m/);
});

test("proxy status error column stays single-line and expands with terminal width", () => {
  const stateRoot = "/tmp/codex-tools";
  const state = {
    installed_at: "2026-01-01T00:00:00.000Z",
    codex_config_path: "/home/test/.codex/config.toml",
    provider_name: "codex",
    original_base_url: "https://proxy.example.com",
    proxy_base_url: "http://127.0.0.1:4610",
    listen_host: "127.0.0.1",
    listen_port: 4610,
    profile_order: ["input"],
    backup_path: "/tmp/backup.toml",
    metrics: {
      total_requests: 1,
      active_requests: [],
      status_counts: { 502: 1 },
      reasoning_token_counts: {},
      upstream_hit_counts: { input: 1 },
      latency_ms: { last: 100, count: 1, sum: 100, min: 100, max: 100 },
      recent_requests: [
        proxyHistoryRecord({
          session: "019f0dfb",
          completed_at: "2026-01-01T00:00:01.000Z",
          upstream: "input",
          status: 502,
          latency_ms: 100,
          response_bytes: 2048,
          request_model: "gpt-5.5",
          upstream_model: "gpt-5.5",
          path: "/retry",
          error: "upstream_error: fetch failed after retry with diagnostic message",
        }),
      ],
    },
  };

  const render = (columns) => withStdoutProperties({ columns }, () => buildProxyStatusLines(
    new Date("2026-01-01T00:00:00.000Z"),
    state,
    ["input"],
    { healthy: true, started: false, pid: 1234, state: null, version: "0.1.12", protocol: 3 },
    {
      codexConfigPath: "/home/test/.codex/config.toml",
      listenHost: "127.0.0.1",
      listenPort: 4610,
      stateRoot,
    },
  ));

  const narrowLines = render(118).map(stripAnsi);
  const wideLines = render(150).map(stripAnsi);
  const narrowRow = narrowLines.find((line) => line.includes("upstream_error"));
  const wideRow = wideLines.find((line) => line.includes("upstream_error"));
  assert.ok(narrowRow);
  assert.ok(wideRow);
  assert.equal(narrowRow.length <= 118, true);
  assert.equal(wideRow.length <= 150, true);
  assert.equal(narrowRow.includes("diagnostic"), false);
  assert.equal(wideRow.includes("diagnostic"), true);
});

test("proxy status summary renders exact status counts", () => {
  const stateRoot = "/tmp/codex-tools";
  const lines = buildProxyStatusLines(
    new Date("2026-01-01T00:00:00.000Z"),
    {
      installed_at: "2026-01-01T00:00:00.000Z",
      codex_config_path: "/home/test/.codex/config.toml",
      provider_name: "codex",
      original_base_url: "https://proxy.example.com",
      proxy_base_url: "http://127.0.0.1:4610",
      listen_host: "127.0.0.1",
      listen_port: 4610,
      profile_order: ["input"],
      backup_path: "/tmp/backup.toml",
      metrics: {
        total_requests: 12,
        active_requests: [],
        status_counts: { "200": 11, "502": 1 },
        reasoning_token_counts: { "0": 1, "42": 5, "516": 2, "1034": 3, "1552": 1 },
        upstream_hit_counts: { input: 12 },
        latency_ms: { last: 56, count: 12, sum: 123, min: 56, max: 187200 },
        recent_requests: [
          proxyHistoryRecord({
            session: "019f0df6",
            completed_at: "2026-01-01T00:00:05.000Z",
            upstream: "input",
            latency_ms: 56,
            response_bytes: 32 * 1024,
            request_model: "gpt-5.5",
            upstream_model: "gpt-5.5",
            path: "/same",
          }),
        ],
      },
    },
    ["input"],
    { healthy: true, started: false, pid: 1234, state: null, version: "0.1.12", protocol: 3 },
    {
      codexConfigPath: "/home/test/.codex/config.toml",
      listenHost: "127.0.0.1",
      listenPort: 4610,
      stateRoot,
    },
  ).join("\n");

  assert.match(lines, /status total=1 active=0 200=1 upstreams=input=1/);
  assert.match(lines, /reasoning total=0 max=-/);
});

test("proxy status and reasoning summaries use event counts", () => {
  const stateRoot = "/tmp/codex-tools";
  const lines = buildProxyStatusLines(
    new Date("2026-01-01T00:00:00.000Z"),
    proxyStateFixture({
      recent_requests: [
        proxyHistoryRecord({
          id: "retry-success",
          completed_at: "2026-01-01T00:00:02.000Z",
          attempts: 4,
          reasoning_tokens: 42,
          guard_actions: [
            proxyGuardAction({ action: "internal_retry", attempt: 1, reasoning_tokens: 516 }),
            proxyGuardAction({ action: "internal_retry", attempt: 2, reasoning_tokens: 516 }),
            proxyGuardAction({ action: "internal_retry", attempt: 3, reasoning_tokens: 516 }),
          ],
        }),
        proxyHistoryRecord({
          id: "guard-exhausted",
          completed_at: "2026-01-01T00:00:01.000Z",
          status: 502,
          attempts: 4,
          reasoning_tokens: 1034,
          guard_actions: [
            proxyGuardAction({ action: "internal_retry", attempt: 1, reasoning_tokens: 1034 }),
            proxyGuardAction({ action: "internal_retry", attempt: 2, reasoning_tokens: 1034 }),
            proxyGuardAction({ action: "internal_retry", attempt: 3, reasoning_tokens: 1034 }),
            proxyGuardAction({ action: "return_status_502", attempt: 4, status: 502, reasoning_tokens: 1034 }),
          ],
        }),
        proxyHistoryRecord({
          id: "text-only",
          completed_at: "2026-01-01T00:00:00.000Z",
          reasoning_text_observed: true,
          reasoning_text_source: "/delta/reasoning_content",
        }),
      ],
    }),
    ["input"],
    { healthy: true, started: false, pid: 1234, state: null, version: "0.1.12", protocol: 3 },
    {
      codexConfigPath: "/home/test/.codex/config.toml",
      listenHost: "127.0.0.1",
      listenPort: 4610,
      stateRoot,
    },
  ).join("\n");

  assert.match(lines, /status total=9 active=0 200=8 502=1 upstreams=input=9/);
  assert.match(lines, /reasoning total=8 max=1034/);
  assert.match(lines, /516=3/);
  assert.match(lines, /1034=4/);
  assert.match(lines, /other=1/);
});

test("proxy status history count follows TTY rows, non-TTY default, and explicit override", () => {
  const stateRoot = "/tmp/codex-tools";
  const state = proxyStateFixture({
    total_requests: 12,
    status_counts: { "200": 12 },
    upstream_hit_counts: { input: 12 },
    latency_ms: { last: 10, count: 12, sum: 120, min: 10, max: 10 },
    recent_requests: Array.from({ length: 12 }, (_, index) => proxyHistoryRecord({
      id: `history-${index}`,
      completed_at: `2026-01-01T00:00:${String(59 - index).padStart(2, "0")}.000Z`,
      path: `/history-${index}`,
    })),
  });
  const render = (options, stdoutProperties) => withStdoutProperties(stdoutProperties, () => buildProxyStatusLines(
    new Date("2026-01-01T00:00:00.000Z"),
    state,
    ["input"],
    { healthy: true, started: false, pid: 1234, state: null, version: "0.1.12", protocol: 3 },
    {
      codexConfigPath: "/home/test/.codex/config.toml",
      listenHost: "127.0.0.1",
      listenPort: 4610,
      stateRoot,
      ...options,
    },
  ).join("\n"));

  const nonTty = render({}, { isTTY: false, columns: 140, rows: 40 });
  assert.equal(countHistoryRows(nonTty), 5);

  const ttyTall = render({}, { isTTY: true, columns: 140, rows: 24 });
  assert.equal(countHistoryRows(ttyTall), 9);

  const ttyTiny = render({}, { isTTY: true, columns: 140, rows: 8 });
  assert.equal(countHistoryRows(ttyTiny), 0);

  const explicit = render({ historyCount: 7 }, { isTTY: true, columns: 140, rows: 8 });
  assert.equal(countHistoryRows(explicit), 7);
});

test("proxy rejects invalid --history values", async () => {
  const options = {
    codexConfigPath: "/tmp/config.toml",
    listenHost: "127.0.0.1",
    listenPort: 4610,
    stateRoot: "/tmp/codex-tools",
  };
  for (const args of [
    ["--history"],
    ["--history", "abc"],
    ["--history", "1.5"],
    ["--history", "0"],
    ["--history", "-1"],
    ["--once", "--history", "0"],
    ["watch", "--history", "-1"],
  ]) {
    await assert.rejects(
      () => runProxyCommand(args, options),
      /ccs proxy --history requires a positive integer/,
    );
  }
  for (const args of [
    ["--history", "2", "watch"],
    ["--once", "watch"],
    ["watch", "--once"],
    ["watch", "--history", "2", "--once"],
    ["mode", "recovery", "extra"],
    ["install", "extra"],
    ["restore", "extra"],
  ]) {
    await assert.rejects(
      () => runProxyCommand(args, options),
      /unknown argument/,
    );
  }
  await assert.rejects(
    () => runProxyCommand(["mode", "passthrough"], options),
    /ccs proxy mode requires intercept or recovery/,
  );
  await assert.rejects(
    () => runProxyCommand(["install", "--yes"], options),
    /ccs proxy install no longer accepts -y\/--yes/,
  );
  await assert.rejects(
    () => runProxyCommand(["stop", "--yes"], options),
    /ccs proxy stop no longer accepts -y\/--yes/,
  );
});

test("proxy runtime restarts protocol mismatches", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const proxyPort = await reservePort();
  let oldProxy = null;

  try {
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), "", "utf8");
    await writeProxyStateFixture(home, stateRoot, proxyPort);

    oldProxy = spawnNode(
      [
        "--input-type=module",
        "-e",
        `
          import { createServer } from "node:http";

          const port = Number(process.env.CCS_TEST_PROXY_PORT);
          const server = createServer((req, res) => {
            if (req.url === "/__codex_proxy/health") {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ status: "ok", pid: process.pid, version: "0.1.0", protocol: 1, mode: "recovery" }));
              return;
            }
            res.writeHead(404);
            res.end();
          });

          const close = () => server.close(() => process.exit(0));
          process.once("SIGINT", close);
          process.once("SIGTERM", close);
          server.listen(port, "127.0.0.1", () => process.stdout.write("old-proxy-ready\\n"));
        `,
      ],
      {
        env: {
          ...process.env,
          CCS_TEST_PROXY_PORT: String(proxyPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await waitForChildStdout(oldProxy, /old-proxy-ready/);
    const oldProxyPid = oldProxy.pid;
    assert.ok(oldProxyPid);

    const options = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const oldHealth = await fetch(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);
    assert.equal((await oldHealth.json()).protocol, 1);

    const runtime = await ensureProxyRunning(options);
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    assert.equal(runtime.started, true);
    assert.equal(runtime.protocol, 4);
    assert.notEqual(runtime.pid, oldProxyPid);
    await waitForChildExit(oldProxy);
    oldProxy = null;

    const health = await fetch(`http://127.0.0.1:${proxyPort}/__codex_proxy/health`);
    const healthPayload = await health.json();
    assert.equal(healthPayload.protocol, 4);
    assert.equal(healthPayload.pid, runtime.pid);
    const eventLog = await waitForLogIncludes(join(stateRoot, "proxy.log"), /"event":"ccs_proxy_protocol_restart"/);
    const events = eventLog.trim().split("\n").map((line) => JSON.parse(line));
    const restartEvent = events.find((event) => event.event === "ccs_proxy_protocol_restart");
    assert.deepEqual(
      {
        server_protocol: restartEvent?.server_protocol,
        client_protocol: restartEvent?.client_protocol,
        pid: restartEvent?.pid,
      },
      {
        server_protocol: 1,
        client_protocol: 4,
        pid: oldProxyPid,
      },
    );
  } finally {
    if (oldProxy) {
      oldProxy.kill();
      await waitForChildExit(oldProxy).catch(() => null);
    }
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
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

test("proxy --history uses snapshot rows until explicit count needs JSONL tail", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const health = createServer((req, res) => {
    if (req.url === "/__codex_proxy/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: 1234, version: "0.1.12", protocol: 4 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await new Promise((resolve, reject) => {
      health.once("error", reject);
      health.listen(0, "127.0.0.1", resolve);
    });
    const address = health.address();
    assert.ok(address && typeof address === "object");
    const proxyPort = address.port;
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), "", "utf8");
    await writeProxyStateFixture(home, stateRoot, proxyPort, {
      total_requests: 8,
      status_counts: { "200": 8 },
      upstream_hit_counts: { input: 8 },
      latency_ms: { last: 10, count: 8, sum: 80, min: 10, max: 10 },
      recent_requests: Array.from({ length: 5 }, (_, index) => proxyHistoryRecord({
        id: `snapshot-${index}`,
        completed_at: `2026-01-01T00:00:${String(50 - index).padStart(2, "0")}.000Z`,
        path: `/snapshot-${index}`,
        request_model: `snapshot-${index}`,
      })),
    });
    const jsonlRecords = Array.from({ length: 8 }, (_, index) => proxyHistoryRecord({
      id: `jsonl-${index}`,
      completed_at: `2026-01-01T00:00:${String(10 + index).padStart(2, "0")}.000Z`,
      path: `/jsonl-${index}`,
      request_model: `jsonl-${index}`,
    }));
    await writeFile(
      join(stateRoot, "proxy-requests.jsonl"),
      `${jsonlRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const proxyOptions = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    const defaultOutput = await captureConsole(() => runProxyCommand([], proxyOptions));
    assert.equal(countHistoryRows(defaultOutput), 5);
    assert.match(defaultOutput, /snapshot-4/);
    assert.doesNotMatch(defaultOutput, /\/jsonl-/);

    const onceOutput = await captureConsole(() => runProxyCommand(["--once", "--history", "3"], proxyOptions));
    assert.equal(countHistoryRows(onceOutput), 3);
    assert.match(onceOutput, /snapshot-2/);
    assert.doesNotMatch(onceOutput, /snapshot-3/);

    const snapshotOutput = await captureConsole(() => runProxyCommand(["--history", "5"], proxyOptions));
    assert.equal(countHistoryRows(snapshotOutput), 5);
    assert.match(snapshotOutput, /snapshot-4/);
    assert.doesNotMatch(snapshotOutput, /\/jsonl-/);

    const jsonlOutput = await captureConsole(() => runProxyCommand(["--history", "7"], proxyOptions));
    assert.equal(countHistoryRows(jsonlOutput), 7);
    assert.match(jsonlOutput, /jsonl-7/);
    assert.match(jsonlOutput, /jsonl-1/);
    assert.doesNotMatch(jsonlOutput, /jsonl-0/);
    assert.doesNotMatch(jsonlOutput, /\/snapshot-/);

    await writeFile(
      join(stateRoot, "proxy-requests.jsonl"),
      `${JSON.stringify(proxyHistoryRecord({ schema_version: 4 }))}\n`,
      "utf8",
    );
    await assert.rejects(
      runProxyCommand(["--history", "7"], proxyOptions),
      /proxy-requests\.jsonl.*schema_version: expected number 5/,
    );
  } finally {
    await closeServer(health);
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

test("proxy watch uses terminal frame repaint and omits file path lines", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const health = createServer((req, res) => {
    if (req.url === "/__codex_proxy/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: 1234, version: "0.1.12", protocol: 4 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await new Promise((resolve, reject) => {
      health.once("error", reject);
      health.listen(0, "127.0.0.1", resolve);
    });
    const address = health.address();
    assert.ok(address && typeof address === "object");
    const proxyPort = address.port;
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), "", "utf8");
    await writeProxyTestStateWithProfiles(
      home,
      stateRoot,
      proxyPort,
      { input: { baseURL: `http://127.0.0.1:${proxyPort}`, apiKey: "input-key" } },
      "input",
      ["input"],
    );

    const output = await captureStdout(
      () => runProxyCommand(
        ["watch"],
        {
          codexConfigPath: join(home, ".codex", "config.toml"),
          listenHost: "127.0.0.1",
          listenPort: proxyPort,
          stateRoot,
        },
      ),
      {
        isTTY: true,
        columns: 180,
        onWrite: (output) => {
          if (output.includes("\u001b[J")) {
            setImmediate(() => process.emit("SIGINT"));
          }
        },
      },
    );

    assert.match(output, /^\u001b\[\?1049h\u001b\[\?25l\u001b\[H/);
    assert.match(output, /ccs proxy/);
    assert.match(output, /\u001b\[J\u001b\[\?25h\u001b\[\?1049l$/);
    assert.match(output, /proxy: http:\/\/127\.0\.0\.1:\d+\s+refresh: 1s/);
    assert.match(output, /session\s+time\s+up\s+model\s+reas\.\/code\s+lat\.\s+size\s+error/);
    assert.doesNotMatch(output, /^\u001b\[2K(state|requests|events|runtime|config):/m);
    assert.match(output, /view: overview\s+keys: v view\s+q\/Ctrl-C exit/);
  } finally {
    await closeServer(health);
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

test("proxy watch --history uses explicit history count", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const health = createServer((req, res) => {
    if (req.url === "/__codex_proxy/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: 1234, version: "0.1.12", protocol: 4 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await new Promise((resolve, reject) => {
      health.once("error", reject);
      health.listen(0, "127.0.0.1", resolve);
    });
    const address = health.address();
    assert.ok(address && typeof address === "object");
    const proxyPort = address.port;
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), "", "utf8");
    await writeProxyStateFixture(home, stateRoot, proxyPort, {
      total_requests: 5,
      status_counts: { "200": 5 },
      upstream_hit_counts: { input: 5 },
      latency_ms: { last: 10, count: 5, sum: 50, min: 10, max: 10 },
      recent_requests: Array.from({ length: 5 }, (_, index) => proxyHistoryRecord({
        id: `watch-history-${index}`,
        completed_at: `2026-01-01T00:00:${String(50 - index).padStart(2, "0")}.000Z`,
        path: `/h${index}`,
        request_model: `h${index}`,
      })),
    });

    const output = await captureStdout(
      () => runProxyCommand(
        ["watch", "--history", "3"],
        {
          codexConfigPath: join(home, ".codex", "config.toml"),
          listenHost: "127.0.0.1",
          listenPort: proxyPort,
          stateRoot,
        },
      ),
      {
        isTTY: true,
        columns: 120,
        rows: 8,
        onWrite: (output) => {
          if (output.includes("\u001b[J")) {
            setImmediate(() => process.emit("SIGINT"));
          }
        },
      },
    );

    assert.match(output, /h0/);
    assert.match(output, /h2/);
    assert.doesNotMatch(output, /h3/);
  } finally {
    await closeServer(health);
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

test("proxy watch repaints immediately on terminal resize", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const health = createServer((req, res) => {
    if (req.url === "/__codex_proxy/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: 1234, version: "0.1.12", protocol: 4 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await new Promise((resolve, reject) => {
      health.once("error", reject);
      health.listen(0, "127.0.0.1", resolve);
    });
    const address = health.address();
    assert.ok(address && typeof address === "object");
    const proxyPort = address.port;
    process.env.HOME = home;
    const stateRoot = join(home, ".config", "codex-tools");
    process.env.CCS_PROXY_STATE_ROOT = stateRoot;
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), "", "utf8");
    await writeProxyStateFixture(home, stateRoot, proxyPort, {
      total_requests: 12,
      status_counts: { "200": 12 },
      upstream_hit_counts: { input: 12 },
      latency_ms: { last: 10, count: 12, sum: 120, min: 10, max: 10 },
      recent_requests: Array.from({ length: 12 }, (_, index) => proxyHistoryRecord({
        id: `resize-${index}`,
        completed_at: `2026-01-01T00:00:${String(59 - index).padStart(2, "0")}.000Z`,
        path: `/resize-${index}`,
        request_model: `resize-${index}`,
      })),
    });

    let frameCount = 0;
    let resizeSent = false;
    const output = await captureStdout(
      () => runProxyCommand(
        ["watch"],
        {
          codexConfigPath: join(home, ".codex", "config.toml"),
          listenHost: "127.0.0.1",
          listenPort: proxyPort,
          stateRoot,
        },
      ),
      {
        isTTY: true,
        columns: 140,
        rows: 18,
        onWrite: (output) => {
          frameCount = output.split("\u001b[H").length - 1;
          if (frameCount === 1 && !resizeSent) {
            resizeSent = true;
            setStdoutProperties({ rows: 24 });
            setImmediate(() => process.stdout.emit("resize"));
            return;
          }
          if (frameCount >= 2) {
            setImmediate(() => process.emit("SIGINT"));
          }
        },
      },
    );

    assert.equal(frameCount >= 2, true);
    assert.match(output, /resize-3/);
    assert.match(output, /resize-8/);
  } finally {
    await closeServer(health);
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

test("proxy startup clears persisted active requests from older processes", async () => {
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
        'base_url = "http://127.0.0.1:4610"',
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
            input: { baseURL: "https://proxy.example.com", apiKey: "" },
          },
          current: "input",
          toggle: ["input"],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(stateRoot, "proxy.json"),
      JSON.stringify(
        {
          installed_at: "2026-01-01T00:00:00.000Z",
          codex_config_path: codexConfigPath,
          provider_name: "codex",
          original_base_url: "https://proxy.example.com",
          proxy_base_url: `http://127.0.0.1:${listenPort}`,
          listen_host: "127.0.0.1",
          listen_port: listenPort,
          profile_order: ["input"],
          backup_path: "/tmp/backup.toml",
          metrics: {
            total_requests: 3,
            active_requests: [
              proxyHistoryRecord({
                id: "stale-active",
                started_at: "2026-01-01T00:00:00.000Z",
                completed_at: null,
                path: "/responses",
                status: 200,
                upstream: "input",
                request_bytes: 123,
                response_bytes: 0,
                request_model: "gpt-5.4",
                upstream_model: "gpt-5.4",
              }),
            ],
            status_counts: {},
            reasoning_token_counts: {},
            upstream_hit_counts: { input: 3 },
            latency_ms: { last: 123, count: 3, sum: 456, min: 56, max: 200 },
            recent_requests: [
              proxyHistoryRecord({
                id: "history-1",
                completed_at: "2026-01-01T00:00:05.000Z",
                path: "/history",
              }),
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const runtime = await ensureProxyRunning({
      codexConfigPath,
      listenHost: "127.0.0.1",
      listenPort,
      stateRoot,
    });
    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    await waitForFetchOk(`http://127.0.0.1:${listenPort}/__codex_proxy/health`);

    const state = await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0);
    assert.equal(state.metrics.total_requests, 1);
    assert.equal(state.metrics.recent_requests.length, 1);
    assert.equal(state.metrics.recent_requests[0].path, "/history");
  } finally {
    await shutdownProxyRuntime({
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort,
      stateRoot: join(home, ".config", "codex-tools"),
    }).catch(() => null);
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

test("proxy restore uses the current profile and preserves unrelated config edits", async () => {
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

    await writeFile(join(stateRoot, "proxy-runtime.log"), Buffer.alloc((16 * 1024 * 1024) + 1024, "x"));
    const installed = await installProxy({
      codexConfigPath,
      listenHost: "127.0.0.1",
      listenPort,
      stateRoot,
    });

    const runtime = installed.runtime;
    const confirmedRuntime = await ensureProxyRunning({
      codexConfigPath,
      listenHost: "127.0.0.1",
      listenPort,
      stateRoot,
    });

    assert.ok(runtime);
    assert.equal(runtime.healthy, true);
    assert.equal(runtime.started, true);
    assert.ok(runtime.pid);
    assert.equal(confirmedRuntime?.started, false);

    const health = await fetch(`http://127.0.0.1:${listenPort}/__codex_proxy/health`);
    assert.equal(health.status, 200);
    const healthPayload = await health.json();
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(healthPayload.status, "ok");
    assert.equal(healthPayload.pid, runtime.pid);
    assert.equal(healthPayload.version, packageJson.version);
    assert.equal(healthPayload.protocol, 4);
    assert.equal(healthPayload.mode, "passthrough");
    await waitForLogIncludes(join(stateRoot, "proxy-runtime.log"), /proxy listening: http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(await readTextOrEmpty(join(stateRoot, "proxy.log")), "");
    assert.ok((await stat(join(stateRoot, "proxy-runtime.log"))).size <= 16 * 1024 * 1024);
    assert.equal((await stat(join(stateRoot, "proxy-runtime.log"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(stateRoot, "proxy.pid"))).mode & 0o777, 0o600);

    await writeFile(
      join(stateRoot, "profiles.json"),
      JSON.stringify(
        {
          profiles: {
            input: { baseURL: "https://ai.input.im", apiKey: "input-key" },
            switched: { baseURL: "https://switched.example.com/v1", apiKey: "switched-key" },
          },
          current: "switched",
          toggle: ["input", "switched"],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      codexConfigPath,
      [
        'model_provider = "other"',
        'service_tier = "priority"',
        "",
        "[model_providers.codex]",
        'name = "Locally edited"',
        `base_url = "http://127.0.0.1:${listenPort}"`,
        'wire_api = "responses"',
        "",
        "[model_providers.other]",
        'base_url = "https://unrelated.example.com"',
        "",
      ].join("\n"),
      "utf8",
    );

    const options = {
      codexConfigPath,
      listenHost: "127.0.0.1",
      listenPort,
      stateRoot,
    };
    const restorePreview = stripAnsi(await captureStdout(() => runProxyCommand(["restore"], options)));
    assert.match(restorePreview, new RegExp(`current:\\s+http://127\\.0\\.0\\.1:${listenPort}`));
    assert.match(restorePreview, /target:\s+https:\/\/switched\.example\.com\/v1/);
    assert.match(restorePreview, /profile:\s+switched/);
    assert.match(restorePreview, /backup:\s+.*config-restore-\d+\.toml/);
    assert.ok(await readProxyState(stateRoot));

    await unlink(join(stateRoot, "proxy.pid"));
    const stopped = await restoreProxy(options);
    assert.match(stopped, /Proxy stopped/);
    assert.equal(await readProxyState(stateRoot), null);
    assert.equal(await readFile(codexConfigPath, "utf8"), [
      'model_provider = "other"',
      'service_tier = "priority"',
      "",
      "[model_providers.codex]",
      'name = "Locally edited"',
      'base_url = "https://switched.example.com/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.other]",
      'base_url = "https://unrelated.example.com"',
      "",
    ].join("\n"));
    assert.equal((await readdir(join(stateRoot, "backups"))).length, 2);
    assert.equal(await readFile(installed.backupPath, "utf8"), [
      'model_provider = "codex"',
      "",
      "[model_providers.codex]",
      'name = "OpenAI"',
      'base_url = "https://proxy.example.com"',
      'wire_api = "responses"',
      "",
    ].join("\n"));

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

async function waitForFetchOk(url) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChildStdout(child, pattern) {
  if (!child.stdout) {
    throw new Error("child stdout is not readable");
  }
  const deadline = Date.now() + 5000;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  while (Date.now() < deadline) {
    if (pattern.test(stdout)) {
      return stdout;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child exited before stdout matched ${pattern}: ${stdout}${stderr}`);
    }
    await delay(50);
  }
  throw new Error(`child stdout did not match ${pattern}: ${stdout}${stderr}`);
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child process did not exit")), 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForLogIncludes(logPath, pattern) {
  const deadline = Date.now() + 5000;
  let lastText = "";
  while (Date.now() < deadline) {
    try {
      lastText = await readFile(logPath, "utf8");
      if (pattern.test(lastText)) {
        return lastText;
      }
    } catch {
      lastText = "";
    }
    await delay(50);
  }
  assert.fail(`proxy log did not include ${pattern}: ${lastText}`);
}

async function readTextOrEmpty(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readServerRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeProxyTestState(home, stateRoot, proxyPort, upstreamPort) {
  await writeProxyTestStateWithProfiles(
    home,
    stateRoot,
    proxyPort,
    {
      input: { baseURL: `http://127.0.0.1:${upstreamPort}`, apiKey: "input-key" },
    },
    "input",
    ["input"],
  );
}

async function writeProxyTestStateWithProfiles(home, stateRoot, proxyPort, profiles, current, toggle = [current]) {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    join(stateRoot, "profiles.json"),
    JSON.stringify(
      {
        profiles,
        current,
        toggle,
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(stateRoot, "proxy.json"),
    JSON.stringify(
      {
        installed_at: "2026-01-01T00:00:00.000Z",
        codex_config_path: join(home, ".codex", "config.toml"),
        provider_name: "codex",
        original_base_url: "https://proxy.example.com",
        proxy_base_url: `http://127.0.0.1:${proxyPort}`,
        listen_host: "127.0.0.1",
        listen_port: proxyPort,
        profile_order: [current],
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
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function writeProxyStateFixture(home, stateRoot, proxyPort, metrics = {}) {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    join(stateRoot, "profiles.json"),
    JSON.stringify(
      {
        profiles: {
          input: { baseURL: `http://127.0.0.1:${proxyPort}`, apiKey: "input-key" },
        },
        current: "input",
        toggle: ["input"],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(stateRoot, "proxy.json"),
    JSON.stringify(
      {
        ...proxyStateFixture(metrics),
        codex_config_path: join(home, ".codex", "config.toml"),
        proxy_base_url: `http://127.0.0.1:${proxyPort}`,
        listen_port: proxyPort,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function listenServer(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function waitForState(stateRoot, predicate) {
  const deadline = Date.now() + 5000;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await readProxyState(stateRoot);
    if (lastState && predicate(lastState)) {
      return lastState;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`proxy state did not match predicate: ${JSON.stringify(lastState?.metrics ?? null)}`);
}

async function captureConsole(run) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return `${lines.join("\n")}\n`;
}

function holdControl() {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let finish;
  const release = new Promise((resolve) => {
    finish = resolve;
  });
  return { started, release, markStarted, finish };
}

function proxyHistoryRecord(overrides) {
  return {
    schema_version: 5,
    id: overrides?.id ?? "history-record",
    started_at: overrides?.started_at ?? "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.000Z",
    mode: "recovery",
    method: "POST",
    path: "/responses",
    status: 200,
    upstream_status: 200,
    client_status: 200,
    final_action: "passed",
    failure_summary: null,
    upstream: "input",
    attempts: 1,
    latency_ms: 123,
    client_ttfb_ms: null,
    upstream_wait_ms: null,
    time_to_first_chunk_ms: null,
    stream_duration_ms: null,
    request_bytes: 0,
    response_bytes: 0,
    session: "019f0df6",
    client_turn_id: null,
    client_request_attempt: 1,
    request_kind: "normal",
    request_model: null,
    request_reasoning_effort: null,
    request_body_sha256: null,
    upstream_model: null,
    upstream_model_source: null,
    stream_model: null,
    final_response_model: null,
    system_fingerprint: null,
    service_tier: null,
    input_tokens: null,
    cached_input_tokens: null,
    reasoning_tokens: null,
    reasoning_tokens_source: null,
    output_tokens: null,
    total_tokens: null,
    usage_attempts: [],
    reasoning_text_observed: false,
    reasoning_text_source: null,
    has_commentary: false,
    has_final_answer: false,
    final_answer_only: false,
    has_tool_call: false,
    has_reasoning_item: false,
    guard_actions: [],
    retry_summary: {
      total: 0,
      reasoning_guard: 0,
      upstream_capacity: 0,
      transport: 0,
    },
    error: null,
    ...overrides,
  };
}

function proxyGuardAction(overrides) {
  return {
    at: "2026-01-01T00:00:00.000Z",
    action: "internal_retry",
    upstream: "input",
    attempt: 1,
    status: 200,
    reasoning_tokens: null,
    error: null,
    ...overrides,
  };
}

function assertCompleteProxyAttemptRecord(record, expected) {
  assert.deepEqual(Object.keys(record), [
    "attempt",
    "started_at",
    "headers_at",
    "completed_at",
    "duration_ms",
    "upstream",
    "upstream_status",
    "upstream_wait_ms",
    "time_to_first_chunk_ms",
    "stream_duration_ms",
    "upstream_model",
    "upstream_model_source",
    "stream_model",
    "final_response_model",
    "system_fingerprint",
    "service_tier",
    "input_tokens",
    "cached_input_tokens",
    "reasoning_tokens",
    "reasoning_tokens_source",
    "output_tokens",
    "total_tokens",
    "reasoning_text_observed",
    "reasoning_text_source",
    "has_commentary",
    "has_final_answer",
    "final_answer_only",
    "has_tool_call",
    "has_reasoning_item",
    "final_action",
    "failure_summary",
    "remaining_retries",
  ]);
  assertValidIsoTimestamp(record.started_at);
  assertValidIsoTimestamp(record.headers_at);
  assertValidIsoTimestamp(record.completed_at);
  assert.equal(typeof record.duration_ms, "number");
  assert.equal(record.duration_ms >= 0, true);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(record[key], value);
  }
}

function assertValidIsoTimestamp(value) {
  assert.equal(typeof value, "string");
  assert.equal(Number.isNaN(Date.parse(value)), false);
}

function assertCompleteProxyGuardAction(record, expected) {
  assert.deepEqual(Object.keys(record), [
    "at",
    "action",
    "upstream",
    "attempt",
    "status",
    "reasoning_tokens",
    "error",
  ]);
  assertValidIsoTimestamp(record.at);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(record[key], value);
  }
}

function proxyStateFixture(metrics = {}) {
  return {
    installed_at: "2026-01-01T00:00:00.000Z",
    codex_config_path: "/home/test/.codex/config.toml",
    provider_name: "codex",
    original_base_url: "https://proxy.example.com",
    proxy_base_url: "http://127.0.0.1:4610",
    listen_host: "127.0.0.1",
    listen_port: 4610,
    profile_order: ["input"],
    backup_path: "/tmp/backup.toml",
    metrics: {
      total_requests: 0,
      active_requests: [],
      status_counts: {},
      reasoning_token_counts: {},
      upstream_hit_counts: {},
      latency_ms: { last: null, count: 0, sum: 0, min: null, max: null },
      recent_requests: [],
      ...metrics,
    },
  };
}

function countHistoryRows(output) {
  const lines = output.split("\n").map(stripAnsi);
  const historyIndex = lines.indexOf("history");
  assert.ok(historyIndex >= 0);
  let count = 0;
  for (const line of lines.slice(historyIndex + 2)) {
    if (!line.startsWith("  ")) {
      break;
    }
    if (line.includes("no historical requests")) {
      continue;
    }
    if (line.trim().length > 0) {
      count += 1;
    }
  }
  return count;
}

function reasoningJson(model, reasoningTokens) {
  return {
    response: { model },
    usage: {
      output_tokens_details: {
        reasoning_tokens: reasoningTokens,
      },
    },
  };
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve) => server.close(resolve));
}

// Proxy view and pricing contracts.

test("proxy request views expose the confirmed column sets", () => {
  const titles = (view) => proxyRequestTableColumns(view).map((column) => column.title);
  assert.deepEqual(titles("overview"), ["session", "time", "up", "model", "reas./code", "lat.", "size", "error"]);
  assert.deepEqual(titles("tokens"), ["session", "time", "up", "model", "input", "output", "cached", "error"]);
  assert.deepEqual(titles("cost"), ["session", "time", "up", "model", "input$", "output$", "cached$", "total$", "error"]);
});

test("proxy view argument parsing accepts one initial view with optional history", () => {
  assert.deepEqual(parseProxyStatusArgs(["--view", "tokens"], "ccs proxy"), { historyCount: undefined, view: "tokens" });
  assert.deepEqual(parseProxyStatusArgs(["--history", "12", "--view", "cost"], "ccs proxy"), { historyCount: 12, view: "cost" });
  assert.deepEqual(parseProxyStatusArgs(["--view", "overview", "--history", "3"], "ccs proxy watch"), { historyCount: 3, view: "overview" });
  assert.throws(() => parseProxyStatusArgs(["--view", "other"], "ccs proxy"), /requires overview, tokens, or cost/);
  assert.throws(() => parseProxyStatusArgs(["--view"], "ccs proxy"), /requires overview, tokens, or cost/);
  assert.throws(() => parseProxyStatusArgs(["--view", "tokens", "--view", "cost"], "ccs proxy"), /unknown argument/);
});

test("proxy watch keys cycle views and exit", () => {
  const tokens = proxyWatchKeyAction("v", "overview");
  const cost = proxyWatchKeyAction("v", tokens.view);
  const overview = proxyWatchKeyAction("v", cost.view);
  assert.deepEqual([tokens, cost, overview], [
    { view: "tokens", action: "render" },
    { view: "cost", action: "render" },
    { view: "overview", action: "render" },
  ]);
  assert.deepEqual(proxyWatchKeyAction("q", "cost"), { view: "cost", action: "stop" });
  assert.deepEqual(proxyWatchKeyAction("x", "tokens"), { view: "tokens", action: "none" });
});

test("proxy model rendering compares raw values before abbreviation and truncation", async () => {
  withStdoutProperties({ isTTY: true, noColor: false, columns: 120 }, () => {
    assert.equal(stripAnsi(formatProxyModel(null, null)), "-");
    assert.equal(stripAnsi(formatProxyModel("gpt-5.6", null)), "o5.6");
    assert.equal(stripAnsi(formatProxyModel(null, "gpt-5.6-mini")), "o5.6-mini");
    assert.equal(stripAnsi(formatProxyModel("gpt-5.6", "gpt-5.6")), "o5.6");
    assert.equal(stripAnsi(formatProxyModel("gpt-5.6", "gpt-5.6-mini")), "o5.6-mini");
    assert.equal(stripAnsi(formatProxyModel("gpt-5.6-sol", "o5.6-sol")), "o5.6-sol");
    assert.equal(stripAnsi(formatProxyModel("request-model", "gpt-123456789012345")), `o12345678${String.fromCodePoint(0x2026)}`);
    assert.equal(stripAnsi(formatProxyModel("request-model", "gpt-123456789012345")).length, 10);
  });
  const script = `
    ${stdoutPropertiesScript({ noColor: false, isTTY: true, columns: 120 })}
    const { formatProxyModel } = await import("./dist/commands/ccs-proxy.js");
    process.stdout.write(JSON.stringify({
      equal: formatProxyModel("gpt-5.6", "gpt-5.6"),
      different: formatProxyModel("gpt-5.6", "gpt-5.6-mini"),
      displayCollision: formatProxyModel("gpt-5.6-sol", "o5.6-sol"),
      missing: formatProxyModel(null, null),
    }));
  `;
  const colors = JSON.parse((await execNodeScript(script)).stdout);
  assert.match(colors.equal, /\u001b\[38;5;114m/);
  assert.match(colors.different, /\u001b\[38;5;203m/);
  assert.match(colors.displayCollision, /\u001b\[38;5;203m/);
  assert.match(colors.missing, /\u001b\[2m/);
});

test("proxy usage attempts project every internal, transport, and passthrough attempt exactly once", () => {
  const attempt = (number, overrides = {}) => ({
    attempt: number,
    upstream_model: null,
    service_tier: null,
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    ...overrides,
  });
  const cases = [
    {
      name: "internal retry",
      attempts: [attempt(1), attempt(2), attempt(3), attempt(4, { upstream_model: "actual", service_tier: "priority", input_tokens: 10, output_tokens: 2, cached_input_tokens: 1 })],
    },
    { name: "transport retry", attempts: [attempt(1), attempt(2, { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 })] },
    { name: "passthrough", attempts: [attempt(1, { upstream_model: "pass", input_tokens: 7, output_tokens: 3, cached_input_tokens: 2 })] },
  ];
  for (const fixture of cases) {
    const projected = projectProxyUsageAttempts(fixture.attempts, "requested", "standard", "fast");
    assert.equal(projected.length, fixture.attempts.length, fixture.name);
    assert.deepEqual(projected.map((entry) => entry.attempt), fixture.attempts.map((entry) => entry.attempt), fixture.name);
    assert.equal(new Set(projected.map((entry) => entry.attempt)).size, projected.length, fixture.name);
  }
  const attributed = projectProxyUsageAttempts([
    attempt(1),
    attempt(2, { upstream_model: "actual", service_tier: "priority" }),
  ], "requested", "default", "fast");
  assert.deepEqual(attributed.map(({ pricing_model, pricing_model_source, pricing_tier, pricing_tier_source }) => ({
    pricing_model,
    pricing_model_source,
    pricing_tier,
    pricing_tier_source,
  })), [
    { pricing_model: "requested", pricing_model_source: "request_model", pricing_tier: "default", pricing_tier_source: "request" },
    { pricing_model: "actual", pricing_model_source: "upstream_model", pricing_tier: "priority", pricing_tier_source: "response" },
  ]);
});

test("proxy token formatting covers the confirmed boundaries and unknown attempt data", () => {
  for (const [value, expected] of [[0, "0"], [999, "999"], [1000, "1K"], [1200, "1.2K"], [312400, "312.4K"], [999900, "999.9K"]]) {
    assert.equal(formatProxyTokenCount(value), expected);
  }
  const usage = (input_tokens) => ({ input_tokens, output_tokens: 0, cached_input_tokens: 0 });
  assert.equal(stripAnsi(formatProxyAttemptTokens([usage(0), usage(1200)], "input_tokens")), "1.2K");
  assert.equal(stripAnsi(formatProxyAttemptTokens([usage(1000), usage(null)], "input_tokens")), "-");
  assert.equal(stripAnsi(formatProxyAttemptTokens([], "input_tokens")), "-");
  assert.equal(stripAnsi(formatProxyAttemptTokens([
    { input_tokens: 1200, cached_input_tokens: 200 },
    { input_tokens: 800, cached_input_tokens: 300 },
  ], "uncached_input_tokens")), "1.5K");
  assert.equal(stripAnsi(formatProxyAttemptTokens([
    { input_tokens: 1200, cached_input_tokens: null },
  ], "uncached_input_tokens")), "-");
  assert.equal(stripAnsi(formatProxyAttemptTokens([
    { input_tokens: 100, cached_input_tokens: 101 },
  ], "uncached_input_tokens")), "invalid");
});

test("proxy attempt costs use each model and tier, cached subtraction, and one final rounding", () => {
  const cache = {
    source: "test",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    patterns: [],
    providers: [],
    models: {
      standard_model: {
        input_cost_per_token: 0.000001,
        cache_read_input_token_cost: 0.0000005,
        output_cost_per_token: 0.000002,
      },
      tiered_model: {
        input_cost_per_token: 0.000001,
        cache_read_input_token_cost: 0.0000005,
        output_cost_per_token: 0.000002,
        input_cost_per_token_priority: 0.000002,
        cache_read_input_token_cost_priority: 0.000001,
        output_cost_per_token_priority: 0.000004,
      },
    },
  };
  const costs = formatProxyAttemptCosts([
    { attempt: 1, input_tokens: 100, cached_input_tokens: 20, output_tokens: 11, pricing_model: "standard_model", pricing_tier: "standard" },
    { attempt: 2, input_tokens: 200, cached_input_tokens: 50, output_tokens: 20, pricing_model: "tiered_model", pricing_tier: "fast" },
  ], cache);
  assert.deepEqual(Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, stripAnsi(value)])), {
    input_cost: "$0.0004",
    output_cost: "$0.0001",
    cached_cost: "<$0.0001",
    total_cost: "$0.0005",
  });
});

test("proxy attempt costs distinguish missing and invalid inputs", () => {
  const cache = {
    source: "test",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    patterns: [],
    providers: [],
    models: { known: { input_cost_per_token: 0.001, cache_read_input_token_cost: 0.0005, output_cost_per_token: 0.002 } },
  };
  const missing = formatProxyAttemptCosts([
    { attempt: 1, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, pricing_model: "missing", pricing_tier: "standard" },
  ], cache);
  assert.deepEqual(Object.fromEntries(Object.entries(missing).map(([key, value]) => [key, stripAnsi(value)])), {
    input_cost: "-", output_cost: "-", cached_cost: "-", total_cost: "-",
  });
  const invalid = formatProxyAttemptCosts([
    { attempt: 1, input_tokens: 2, cached_input_tokens: 3, output_tokens: 1, pricing_model: "known", pricing_tier: "default" },
  ], cache);
  assert.deepEqual(Object.fromEntries(Object.entries(invalid).map(([key, value]) => [key, stripAnsi(value)])), {
    input_cost: "invalid", output_cost: "$0.0020", cached_cost: "$0.0015", total_cost: "invalid",
  });
  const unsupportedTier = formatProxyAttemptCosts([
    { attempt: 1, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, pricing_model: "known", pricing_tier: "turbo" },
  ], cache);
  assert.equal(stripAnsi(unsupportedTier.total_cost), "-");
});

test("proxy USD formatting uses adaptive precision", () => {
  assert.equal(formatProxyUsd(0), "$0");
  assert.equal(formatProxyUsd(0.00001), "<$0.0001");
  assert.equal(formatProxyUsd(0.0001), "$0.0001");
  assert.equal(formatProxyUsd(0.00994), "$0.0099");
  assert.equal(formatProxyUsd(0.01), "$0.01");
  assert.equal(formatProxyUsd(1.239), "$1.24");
});
