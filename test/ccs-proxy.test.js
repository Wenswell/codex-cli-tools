import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { buildProxyStatusLines, ensureProxyRunning, installProxy, readProxyState, restoreProxy, runProxyCommand, stopProxy } from "../dist/commands/ccs-proxy.js";

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("proxy install records only the current profile as active upstream", async () => {
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
          current: "ciii",
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
    assert.deepEqual(state.profile_order, ["ciii"]);
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
            active_requests: [
              {
                id: "active-1",
                started_at: "2026-01-01T00:00:03.000Z",
                method: "POST",
                path: "/v1/chat/completions",
                request_bytes: 12,
                session: "019f0eca",
              },
            ],
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
                request_bytes: 43,
                response_bytes: 51,
                session: "019eb0b9",
                error: null,
              },
              {
                at: "2026-01-01T00:00:01.000Z",
                method: "POST",
                path: "/v1/responses",
                status: 500,
                upstream: "ciii",
                attempts: 2,
                latency_ms: 180,
                request_bytes: 44,
                response_bytes: 52,
                session: "019eb0ba",
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
    assert.deepEqual(state.metrics.status_counts, { "200": 1, "500": 1 });
    assert.deepEqual(state.metrics.reasoning_token_counts, {});
    assert.equal(state.metrics.active_requests.length, 1);
    assert.equal(state.metrics.active_requests[0].session, "019f0eca");
    assert.equal(state.metrics.active_requests[0].completed_at, null);
    assert.equal(state.metrics.active_requests[0].status, null);
    assert.equal(state.metrics.active_requests[0].upstream, null);
    assert.equal(state.metrics.active_requests[0].attempts, 0);
    assert.equal(state.metrics.active_requests[0].latency_ms, 0);
    assert.equal(state.metrics.active_requests[0].response_bytes, 0);
    assert.equal(state.metrics.active_requests[0].request_model, null);
    assert.equal(state.metrics.active_requests[0].upstream_model, null);
    assert.equal(state.metrics.active_requests[0].upstream_model_source, null);
    assert.equal(state.metrics.active_requests[0].reasoning_tokens, null);
    assert.equal(state.metrics.active_requests[0].reasoning_tokens_source, null);
    assert.equal(state.metrics.active_requests[0].reasoning_text_observed, false);
    assert.equal(state.metrics.active_requests[0].reasoning_text_source, null);
    assert.deepEqual(state.metrics.active_requests[0].guard_actions, []);
    assert.equal(state.metrics.active_requests[0].error, null);
    assert.equal(state.metrics.upstream_hit_counts.input, 1);
    assert.equal(state.metrics.recent_requests[0].upstream, "input");
    assert.equal(state.metrics.recent_requests[0].completed_at, "2026-01-01T00:00:00.000Z");
    assert.equal(state.metrics.recent_requests[0].response_bytes, 51);
    assert.equal(state.metrics.recent_requests[0].request_model, null);
    assert.equal(state.metrics.recent_requests[0].upstream_model, null);
    assert.equal(state.metrics.recent_requests[0].upstream_model_source, null);
    assert.equal(state.metrics.recent_requests[0].reasoning_tokens, null);
    assert.equal(state.metrics.recent_requests[0].reasoning_tokens_source, null);
    assert.equal(state.metrics.recent_requests[0].reasoning_text_observed, false);
    assert.equal(state.metrics.recent_requests[0].reasoning_text_source, null);
    assert.deepEqual(state.metrics.recent_requests[0].guard_actions, []);
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
    assert.equal(state.metrics.recent_requests[1].status, 404);
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
    assert.match(output, /active\n\s+session\s+time\s+up\s+reas\.\/code\s+lat\.\s+size\s+model\s+error\n\s+no active requests/);
    assert.match(output, /history\n\s+session\s+time\s+up\s+reas\.\/code\s+lat\.\s+size\s+model\s+error/);
    assert.doesNotMatch(output, /\bmethod\b/);
    assertProxyRequestColumnsAligned(output, "history");
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
    assert.equal(requestHistoryLines.length, 101);
    const requestHistory = requestHistoryLines.map((line) => JSON.parse(line));
    assert.equal(requestHistory[0].path, "/responses");
    assert.equal(requestHistory.at(-1).path, "/responses");
    assert.equal(requestHistory.at(-1).completed_at !== null, true);
    assert.equal(requestHistory.at(-1).status, 200);
  } finally {
    finishStream?.();
    await stopProxy({
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

    const rootResponse = await fetch(`http://127.0.0.1:${proxyPort}/`);
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
    await stopProxy({
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
    assert.match(output, /session\s+time\s+up\s+reas\.\/code\s+lat\.\s+size\s+model\s+error/);
    assert.doesNotMatch(output, /\bnull\b/);
    assert.match(output, /active\n\s+session\s+time\s+up\s+reas\.\/code\s+lat\.\s+size\s+model\s+error/);
    assert.match(output, /active-ou…\/chat-stre…/);
    assert.match(output, /-\/-/);
    assert.match(output, /responses…\/responses…/);
    assertProxyRequestColumnsAligned(output, "active");
    assertProxyRequestColumnsAligned(output, "history");

    secondHold.finish();
    assert.equal(await (await activeOutputFetch).text(), `data: ${JSON.stringify({ model: activeSpec.streamModel })}\n\ndata: [DONE]\n\n`);
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.recent_requests[0]?.request_model === "active-output-model");
  } finally {
    firstHold.finish();
    secondHold.finish();
    await stopProxy({
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
    await stopProxy({
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
    assert.equal(record.attempts, 4);
    assert.equal(record.error, null);
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
    assert.equal(record.attempts, 1);
    assert.equal(record.error, null);
    assert.deepEqual(record.guard_actions, []);
  } finally {
    await stopProxy({
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
    await stopProxy({
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
    await stopProxy({
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
    assert.equal(record.guard_actions.length, 1);
    assert.equal(record.guard_actions[0].action, "upstream_error");
    assert.match(record.guard_actions[0].error, /upstream_fetch_failed: fetch failed/);
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
    await stopProxy({
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
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["upstream_error", "upstream_error"]);
    await waitForLogIncludes(join(stateRoot, "proxy.log"), /"action":"upstream_error".*"upstream_fetch_failed: fetch failed"/);
  } finally {
    await stopProxy({
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
    assert.deepEqual(await success.json(), { ok: true, response: { model: "json-ok" }, usage: { output_tokens_details: { reasoning_tokens: 42 } } });

    let state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.request_model === "json-success",
    );
    let record = state.metrics.recent_requests[0];
    assert.equal(successHits, 4);
    assert.equal(record.attempts, 4);
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["internal_retry", "internal_retry", "internal_retry"]);
    assert.deepEqual(record.guard_actions.map((action) => action.reasoning_tokens), [516, 516, 516]);
    assert.equal(record.error, null);
    assert.equal(record.upstream_model, "json-ok");
    assert.equal(record.reasoning_tokens, 42);
    assert.equal(state.metrics.status_counts["200"], 4);
    assert.equal(state.metrics.reasoning_token_counts["42"], 1);
    assert.equal(state.metrics.reasoning_token_counts["516"], 3);

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
    await stopProxy({
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
    await stopProxy({
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
    assert.equal(Object.hasOwn(record, "attempt_records"), false);
    assert.equal(state.metrics.status_counts["200"], 2);
    assert.equal(state.metrics.reasoning_token_counts["1552"], 1);
    assert.equal(state.metrics.reasoning_token_counts["42"], 1);

    const jsonl = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const fullRecord = jsonl.at(-1);
    assert.equal(fullRecord.request_kind, "normal");
    assert.equal(fullRecord.attempt_records.length, 2);
    assert.deepEqual(fullRecord.attempt_records.map((attempt) => attempt.final_action), ["continuation_recovery", "passed"]);
    assert.equal(fullRecord.attempt_records[0].reasoning_tokens, 1552);
    assert.equal(fullRecord.attempt_records[1].reasoning_tokens, 42);
    await waitForLogIncludes(
      join(stateRoot, "proxy.log"),
      /"path":"\/v1\/responses".*"action":"continuation_recovery".*"attempt":1.*"reasoning_tokens":1552/,
    );

    const output = await captureConsole(() => runProxyCommand(["--once"], proxyOptions));
    assert.match(output, /reasoning .*recovery=1 recovered=1 exhausted=0/);
  } finally {
    await stopProxy({
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

    const output = await captureConsole(() => runProxyCommand(["--once"], proxyOptions));
    assert.match(output, /reasoning .*recovery=3 recovered=0 exhausted=1/);
  } finally {
    await stopProxy({
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

    const jsonl = (await readFile(join(stateRoot, "proxy-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const fullRecord = jsonl.at(-1);
    assert.equal(fullRecord.request_kind, "context_compaction");
    assert.deepEqual(fullRecord.attempt_records.map((attempt) => attempt.final_action), [
      "internal_retry",
      "internal_retry",
      "internal_retry",
      "blocked",
    ]);
  } finally {
    await stopProxy({
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
    await stopProxy({
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
    await stopProxy({
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
        response: { model: "json-plus" },
        usage: { output_tokens_details: { reasoning_tokens: 42 } },
      }));
      return;
    }
    if (mode === "json-text") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        response: { model: "json-text" },
        delta: { reasoning_content: "visible thinking" },
        usage: { output_tokens_details: { reasoning_tokens: -1 } },
      }));
      return;
    }
    if (mode === "sse-latest") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ response: { model: "sse-latest" }, usage: { output_tokens_details: { reasoning_tokens: 41 } } })}\n\n`);
      res.write(`data: ${JSON.stringify({ usage: { output_tokens_details: { reasoning_tokens: 42 } } })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ response: { model: "glm-5.2" }, choices: [{ delta: { reasoning_content: "plan" } }] })}\n\n`);
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

    for (const mode of ["json-plus", "json-text", "sse-latest", "glm-text"]) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?case=${mode}`, {
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
    assert.equal(jsonPlus.reasoning_tokens, 42);
    assert.equal(jsonPlus.reasoning_tokens_source, "/usage/output_tokens_details/reasoning_tokens");
    assert.equal(jsonPlus.reasoning_text_observed, false);
    assert.equal(jsonPlus.reasoning_text_source, null);

    const jsonText = byModel.get("json-text");
    assert.ok(jsonText);
    assert.equal(jsonText.reasoning_tokens, null);
    assert.equal(jsonText.reasoning_tokens_source, null);
    assert.equal(jsonText.reasoning_text_observed, true);
    assert.equal(jsonText.reasoning_text_source, "/delta/reasoning_content");

    const sseLatest = byModel.get("sse-latest");
    assert.ok(sseLatest);
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
    assert.match(output, /glm-text\s*\/glm-5\.2/);
    assert.match(output, /text\/200/);
  } finally {
    await stopProxy({
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

test("proxy forwards request bodies larger than the previous proxy cap", async () => {
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
    await stopProxy({
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
      listen_host: "127.0.0.1",
      listen_port: 4610,
      profile_order: ["input"],
      backup_path: "/tmp/backup.toml",
      metrics: {
        total_requests: 5,
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
        upstream_hit_counts: { input: 5 },
        latency_ms: { last: 56, count: 5, sum: 123, min: 56, max: 187200 },
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
            session: "019f0df7",
            completed_at: "2026-01-01T00:00:04.000Z",
            upstream: "input",
            latency_ms: 123,
            response_bytes: 982 * 1024,
            request_model: null,
            upstream_model: null,
            path: "/unknown",
          }),
          proxyHistoryRecord({
            session: "019f0df8",
            completed_at: "2026-01-01T00:00:03.000Z",
            upstream: "input",
            latency_ms: 2340,
            response_bytes: 3.41 * 1024 * 1024,
            request_model: "gpt-5.5",
            upstream_model: "gpt-5.5-mini",
            reasoning_tokens: 516,
            path: "/seconds",
          }),
          proxyHistoryRecord({
            session: "019f0df9",
            completed_at: "2026-01-01T00:00:02.000Z",
            upstream: "input",
            latency_ms: 43_200,
            response_bytes: 76.3 * 1024 * 1024,
            request_model: "gpt-5.5",
            upstream_model: "gpt-5.5-mini",
            reasoning_text_observed: true,
            reasoning_text_source: "sse.data/choices/0/delta/reasoning_content",
            path: "/large",
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
              { at: "2026-01-01T00:00:00.100Z", action: "upstream_error", upstream: "input", attempt: 1, status: 502, reasoning_tokens: null, error: "upstream_fetch_failed" },
              { at: "2026-01-01T00:00:00.200Z", action: "upstream_error", upstream: "input", attempt: 2, status: 502, reasoning_tokens: null, error: "upstream_fetch_failed" },
              { at: "2026-01-01T00:00:00.300Z", action: "internal_retry", upstream: "input", attempt: 3, status: 200, reasoning_tokens: 506, error: null },
            ],
            error: "reasoning_guard_triggered reasoning_tokens=506",
          }),
          proxyHistoryRecord({
            session: "019f0dfa",
            completed_at: "2026-01-01T00:00:01.000Z",
            upstream: "input",
            latency_ms: 187_200,
            response_bytes: 1024,
            request_model: "gpt-5.5",
            upstream_model: "gpt-5.5-mini",
            path: "/minutes",
          }),
        ],
      },
    },
    ["input"],
    { healthy: true, started: false, pid: 1234, state: null, version: "0.1.12", protocol: 1 },
    {
      codexConfigPath: "/home/test/.codex/config.toml",
      listenHost: "127.0.0.1",
      listenPort: 4610,
      stateRoot,
    },
  ).join("\n");

  assert.match(lines, /session\s+time\s+up\s+reas\.\/code\s+lat\.\s+size\s+model\s+error/);
  assert.doesNotMatch(lines, /\bmethod\b/);
  assert.doesNotMatch(lines, /^\s+\d+\./m);
  assert.match(lines, /active\n\s+session\s+time\s+up\s+reas\.\/code\s+lat\.\s+size\s+model\s+error\n\s+019f0df6\s+\d\d:\d\d:00\s+input\s+42\/200\s+0ms\s+2\.00K\s+gpt-5\.5\/\[same\]/);
  assert.match(lines, /019f0df6\s+\d\d:\d\d:00\s+input\s+-\/-\s+0ms\s+1\.00K\s+-\/-/);
  assert.match(lines, /019f0df6\s+\d\d:\d\d:05\s+input\s+42\/200\s+56ms\s+32\.0K\s+gpt-5\.5\/\[same\]/);
  assert.match(lines, /019f0df7\s+\d\d:\d\d:04\s+input\s+-\/200\s+123ms\s+982K\s+-\/-/);
  assert.match(lines, /019f0df8\s+\d\d:\d\d:03\s+input\s+516\/200\s+2\.34s\s+3\.41M\s+gpt-5\.5\/gpt-5\.5-m…/);
  assert.match(lines, /019f0df9\s+\d\d:\d\d:02\s+input\s+text\/200\s+43\.2s\s+76\.3M\s+gpt-5\.5\/gpt-5\.5-m…/);
  assert.match(lines, /019f0dfb\s+\d\d:\d\d:01\s+input3\s+-\/502\s+300ms\s+2\.00K\s+gpt-5\.5\/\[same\]\s+\[502 502 506\] reasoning_guard_triggered reasoning_tokens=506/);
  assertProxyRequestColumnsAligned(lines, "active");
  assertProxyRequestColumnsAligned(lines, "history");
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

  const render = (columns) => {
    const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    try {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: columns,
      });
      return buildProxyStatusLines(
        new Date("2026-01-01T00:00:00.000Z"),
        state,
        ["input"],
        { healthy: true, started: false, pid: 1234, state: null, version: "0.1.12", protocol: 1 },
        {
          codexConfigPath: "/home/test/.codex/config.toml",
          listenHost: "127.0.0.1",
          listenPort: 4610,
          stateRoot,
        },
      );
    } finally {
      if (originalColumns) {
        Object.defineProperty(process.stdout, "columns", originalColumns);
      } else {
        delete process.stdout.columns;
      }
    }
  };

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
    { healthy: true, started: false, pid: 1234, state: null, version: "0.1.12", protocol: 1 },
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
    proxyStateFixture(stateRoot, {
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
    { healthy: true, started: false, pid: 1234, state: null, version: "0.1.12", protocol: 1 },
    {
      codexConfigPath: "/home/test/.codex/config.toml",
      listenHost: "127.0.0.1",
      listenPort: 4610,
      stateRoot,
    },
  ).join("\n");

  assert.match(lines, /status total=9 active=0 200=8 502=1 upstreams=input=3/);
  assert.match(lines, /reasoning total=8 max=1034/);
  assert.match(lines, /516=3/);
  assert.match(lines, /1034=4/);
  assert.match(lines, /other=1/);
});

test("proxy status history count follows TTY rows, non-TTY default, and explicit override", () => {
  const stateRoot = "/tmp/codex-tools";
  const state = proxyStateFixture(stateRoot, {
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
    { healthy: true, started: false, pid: 1234, state: null, version: "0.1.12", protocol: 1 },
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
    ["install", "extra"],
    ["restore", "extra"],
  ]) {
    await assert.rejects(
      () => runProxyCommand(args, options),
      /unknown argument/,
    );
  }
  await assert.rejects(
    () => runProxyCommand(["install", "--yes"], options),
    /ccs proxy install no longer accepts -y\/--yes/,
  );
});

test("proxy status and watch reject protocol mismatches", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const health = createServer((req, res) => {
    if (req.url === "/__codex_proxy/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: 1234, version: "0.1.0", protocol: 999 }));
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
    await writeProxyStateFixture(home, stateRoot, proxyPort);

    const options = {
      codexConfigPath: join(home, ".codex", "config.toml"),
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      stateRoot,
    };
    await assert.rejects(
      () => runProxyCommand(["--once"], options),
      /proxy protocol mismatch: server=999 client=1; restart ccs proxy/,
    );
    await assert.rejects(
      () => runProxyCommand(["watch"], options),
      /proxy protocol mismatch: server=999 client=1; restart ccs proxy/,
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

test("proxy --history uses snapshot rows until explicit count needs JSONL tail", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const health = createServer((req, res) => {
    if (req.url === "/__codex_proxy/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: 1234, version: "0.1.12", protocol: 1 }));
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
      res.end(JSON.stringify({ status: "ok", pid: 1234, version: "0.1.12", protocol: 1 }));
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
    assert.match(output, /\u001b\[2Kccs proxy/);
    assert.match(output, /\u001b\[J\u001b\[\?25h\u001b\[\?1049l$/);
    assert.match(output, /proxy: http:\/\/127\.0\.0\.1:\d+\s+refresh: 1s/);
    assert.match(output, /session\s+time\s+up\s+reas\.\/code\s+lat\.\s+size\s+model\s+error/);
    assert.doesNotMatch(output, /^\u001b\[2K(state|requests|events|runtime|config):/m);
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
      res.end(JSON.stringify({ status: "ok", pid: 1234, version: "0.1.12", protocol: 1 }));
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
      res.end(JSON.stringify({ status: "ok", pid: 1234, version: "0.1.12", protocol: 1 }));
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
            Object.defineProperty(process.stdout, "rows", {
              configurable: true,
              value: 24,
            });
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
    assert.equal(output.split("\u001b[H").length - 1 >= 2, true);
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
    await stopProxy({
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
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(healthPayload.status, "ok");
    assert.equal(healthPayload.pid, runtime.pid);
    assert.equal(healthPayload.version, packageJson.version);
    assert.equal(healthPayload.protocol, 1);
    await waitForLogIncludes(join(stateRoot, "proxy-runtime.log"), /proxy listening: http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(await readTextOrEmpty(join(stateRoot, "proxy.log")), "");

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
        ...proxyStateFixture(stateRoot, metrics),
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

async function captureStdout(run, options = {}) {
  const originalWrite = process.stdout.write;
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  let output = "";
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: options.isTTY ?? process.stdout.isTTY,
  });
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: options.columns ?? process.stdout.columns,
  });
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: options.rows ?? process.stdout.rows,
  });
  process.stdout.write = (chunk, encoding, callback) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : "utf8") : String(chunk);
    options.onWrite?.(output);
    if (typeof encoding === "function") {
      encoding();
    }
    if (typeof callback === "function") {
      callback();
    }
    return true;
  };
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
    } else {
      delete process.stdout.isTTY;
    }
    if (originalColumns) {
      Object.defineProperty(process.stdout, "columns", originalColumns);
    } else {
      delete process.stdout.columns;
    }
    if (originalRows) {
      Object.defineProperty(process.stdout, "rows", originalRows);
    } else {
      delete process.stdout.rows;
    }
  }
  return output;
}

function withStdoutProperties(properties, run) {
  const descriptors = Object.fromEntries(
    Object.keys(properties).map((key) => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]),
  );
  try {
    for (const [key, value] of Object.entries(properties)) {
      Object.defineProperty(process.stdout, key, {
        configurable: true,
        value,
      });
    }
    return run();
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) {
        Object.defineProperty(process.stdout, key, descriptor);
      } else {
        delete process.stdout[key];
      }
    }
  }
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

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function proxyHistoryRecord(overrides) {
  return {
    id: overrides?.id ?? "history-record",
    started_at: overrides?.started_at ?? "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.000Z",
    method: "POST",
    path: "/responses",
    status: 200,
    upstream: "input",
    attempts: 1,
    latency_ms: 123,
    request_bytes: 0,
    response_bytes: 0,
    session: "019f0df6",
    request_kind: "normal",
    request_model: null,
    upstream_model: null,
    upstream_model_source: null,
    reasoning_tokens: null,
    reasoning_tokens_source: null,
    reasoning_text_observed: false,
    reasoning_text_source: null,
    guard_actions: [],
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

function proxyStateFixture(stateRoot, metrics = {}) {
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

function assertProxyRequestColumnsAligned(output, section) {
  const lines = output.split("\n").map(stripAnsi);
  const sectionIndex = lines.indexOf(section);
  assert.ok(sectionIndex >= 0);
  const header = lines[sectionIndex + 1];
  const emptyText = section === "active" ? "no active requests" : "no historical requests";
  const firstRow = lines.slice(sectionIndex + 2).find((line) => /^\s+\S/.test(line) && !line.includes(emptyText));
  assert.ok(firstRow);
  const columns = ["session", "time", "up", "reas./code", "lat.", "size", "model", "error"];
  for (const column of columns) {
    assert.notEqual(header.indexOf(column), -1, column);
  }
  assert.equal(header.indexOf("method"), -1);
  assert.equal(header.indexOf("path"), -1);
  assert.equal(header.indexOf("req_model"), -1);
  assert.equal(header.indexOf("up_model"), -1);
  const reasoningStatusColumn = header.indexOf("reas./code");
  const msColumn = header.indexOf("lat.");
  const modelColumn = header.indexOf("model");
  const errorColumn = header.indexOf("error");
  if (firstRow.includes("client closed")) {
    assert.equal(firstRow.indexOf("client closed"), errorColumn);
  }
  assert.equal(header.indexOf("session") < header.indexOf("time"), true);
  assert.equal(reasoningStatusColumn < msColumn, true);
  assert.equal(msColumn < modelColumn, true);
  assert.equal(modelColumn < errorColumn, true);
}
