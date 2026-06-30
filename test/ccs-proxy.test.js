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
    if (req.url?.startsWith("/slow")) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      }, 60);
      return;
    }
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      streamStartedResolve();
      void streamRelease.then(() => {
        res.end("data: two\n\n");
      });
      return;
    }
    if (req.url === "/client-error") {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "missing" }));
      return;
    }
    if (req.url === "/server-error") {
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
            input: { baseURL: `http://127.0.0.1:${upstreamPort}`, apiKey: "" },
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
    const okResponse = await fetch(`http://127.0.0.1:${proxyPort}/ok`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestPayload,
    });
    assert.equal(okResponse.status, 200);
    assert.deepEqual(await okResponse.json(), { ok: true });

    let state = await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.recent_requests[0]?.path === "/ok");
    assert.equal(state.metrics.active_requests.length, 0);
    assert.equal(state.metrics.recent_requests[0].status, 200);
    assert.equal(state.metrics.recent_requests[0].request_bytes, Buffer.byteLength(requestPayload));
    assert.equal(state.metrics.recent_requests[0].response_bytes, Buffer.byteLength(JSON.stringify({ ok: true })));
    assert.equal(state.metrics.recent_requests[0].session, "019eb0b9");

    await Promise.all(
      Array.from({ length: 6 }, (_, index) => fetch(`http://127.0.0.1:${proxyPort}/slow?i=${index}`, { method: "POST", body: "{}" })
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
    assert.equal(state.metrics.recent_requests.filter((record) => record.path === "/slow").length, 6);

    const streamFetch = fetch(`http://127.0.0.1:${proxyPort}/stream`, { method: "POST", body: "{}" });
    await streamStarted;
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests[0]?.status === 200);
    state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.metrics.active_requests[0].path, "/stream");
    assert.equal(state.metrics.active_requests[0].completed_at, null);
    assert.equal(state.metrics.active_requests[0].status, 200);
    assert.equal(state.metrics.active_requests[0].upstream, "input");
    assert.equal(state.metrics.active_requests[0].attempts, 1);
    assert.equal(state.metrics.recent_requests[0].path, "/slow");

    finishStream();
    const streamResponse = await streamFetch;
    assert.equal(await streamResponse.text(), "data: one\n\ndata: two\n\n");
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.recent_requests[0].path === "/stream");

    const clientError = await fetch(`http://127.0.0.1:${proxyPort}/client-error`, { method: "POST", body: "{}" });
    assert.equal(clientError.status, 404);
    await clientError.text();
    const serverError = await fetch(`http://127.0.0.1:${proxyPort}/server-error`, { method: "POST", body: "{}" });
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
    assert.match(output, /log: ~\/\.config\/codex-tools\/proxy\.log/);
    assert.match(output, /config: ~\/\.codex\/config\.toml/);
    assert.doesNotMatch(output, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output, /status total=10 active=0 200=8 404=1 503=1 upstreams=input=10/);
    assert.match(output, /reasoning total=0 max=-/);
    assert.doesNotMatch(output, /0=0|516=0|1034=0|1552=0|other=0/);
    assert.match(output, /latency last=\d+ms avg=\d+ms min=\d+ms max=\d+ms/);
    assert.match(output, /active\n\s+session\s+time\s+up\s+code\s+reas\.\s+lat\.\s+size\s+req_model\s+up_model\s+path\s+error\n\s+no active requests/);
    assert.match(output, /history\n\s+session\s+time\s+up\s+code\s+reas\.\s+lat\.\s+size\s+req_model\s+up_model\s+path\s+error/);
    assert.doesNotMatch(output, /\bmethod\b/);
    assertProxyRequestColumnsAligned(output, "history");
    assert.doesNotMatch(output, /requests: total|failed|rate|p50|p95/);
    assert.doesNotMatch(output.split("\n").find((line) => line.startsWith("status ")) ?? "", /\bok\b/);
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
    assert.match(output, /session\s+time\s+up\s+code\s+reas\.\s+lat\.\s+size\s+req_model\s+up_model\s+path\s+error/);
    assert.doesNotMatch(output, /\bnull\b/);
    assert.match(output, /active\n\s+session\s+time\s+up\s+code\s+reas\.\s+lat\.\s+size\s+req_model\s+up_model\s+path\s+error/);
    assert.match(output, /active-ou…\s+chat-stre…\s+\/v1\/chat\/c…/);
    assert.match(output, /-\s+-\s+\/responses/);
    assert.match(output, /responses…\s+responses…\s+\/responses/);
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
  let currentHits = 0;
  let otherHits = 0;

  const current = createServer((req, res) => {
    currentHits += 1;
    const status = Number((req.url ?? "").split("/").pop());
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
        input: { baseURL: `http://127.0.0.1:${otherPort}`, apiKey: "" },
        ciii: { baseURL: `http://127.0.0.1:${currentPort}`, apiKey: "" },
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
      const response = await fetch(`http://127.0.0.1:${proxyPort}/status/${status}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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

    const response = await fetch(`http://127.0.0.1:${proxyPort}/transport-retry`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, requestHits: 1 });

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.path === "/transport-retry",
    );
    const record = state.metrics.recent_requests[0];
    assert.equal(record.status, 200);
    assert.equal(record.attempts, 2);
    assert.equal(record.error, null);
    assert.equal(record.guard_actions.length, 1);
    assert.equal(record.guard_actions[0].action, "upstream_error");
    assert.match(record.guard_actions[0].error, /upstream_fetch_failed: fetch failed/);
    await waitForLogIncludes(join(stateRoot, "proxy.log"), /"action":"upstream_error".*"upstream_fetch_failed: fetch failed"/);
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

    const response = await fetch(`http://127.0.0.1:${proxyPort}/transport-fail`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.type, "upstream_error");
    assert.equal(payload.error.code, "upstream_fetch_failed");

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.recent_requests[0]?.path === "/transport-fail",
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
    assert.equal(record.error, null);
    assert.equal(record.upstream_model, "json-ok");
    assert.equal(record.reasoning_tokens, 42);
    assert.equal(state.metrics.reasoning_token_counts["42"], 1);

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
    assert.match(record.error, /reasoning_guard_triggered reasoning_tokens=1034/);
    assert.equal(record.upstream_model, "json-exhausted");
    assert.equal(record.reasoning_tokens, 1034);
    assert.equal(state.metrics.reasoning_token_counts["42"], 1);
    assert.equal(state.metrics.reasoning_token_counts["1034"], 1);
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
    assert.equal(state.metrics.reasoning_token_counts["42"], 1);
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["internal_retry"]);
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
    assert.equal(record.upstream_model, "stream-exhausted");
    assert.equal(record.reasoning_tokens, 1552);
    assert.equal(state.metrics.reasoning_token_counts["1552"], 1);
    assert.deepEqual(record.guard_actions.map((action) => action.action), ["internal_retry", "internal_retry", "internal_retry", "return_status_502"]);
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
    const response = await fetch(`http://127.0.0.1:${proxyPort}/large-body`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { bytes: bodySize });

    const state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests.length === 0
        && candidate.metrics.recent_requests[0]?.path === "/large-body",
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
    { healthy: true, started: false, pid: 1234, state: null },
    {
      codexConfigPath: "/home/test/.codex/config.toml",
      listenHost: "127.0.0.1",
      listenPort: 4610,
      stateRoot,
    },
  ).join("\n");

  assert.match(lines, /session\s+time\s+up\s+code\s+reas\.\s+lat\.\s+size\s+req_model\s+up_model\s+path\s+error/);
  assert.doesNotMatch(lines, /\bmethod\b/);
  assert.doesNotMatch(lines, /^\s+\d+\./m);
  assert.match(lines, /active\n\s+session\s+time\s+up\s+code\s+reas\.\s+lat\.\s+size\s+req_model\s+up_model\s+path\s+error\n\s+019f0df6\s+\d\d:\d\d:00\s+input\s+200\s+42\s+0ms\s+2\.00K\s+gpt-5\.5\s+\[same\]\s+\/active/);
  assert.match(lines, /019f0df6\s+\d\d:\d\d:00\s+input\s+-\s+-\s+0ms\s+1\.00K\s+-\s+-\s+\/pending/);
  assert.match(lines, /019f0df6\s+\d\d:\d\d:05\s+input\s+200\s+42\s+56ms\s+32\.0K\s+gpt-5\.5\s+\[same\]\s+\/same/);
  assert.match(lines, /019f0df7\s+\d\d:\d\d:04\s+input\s+200\s+-\s+123ms\s+982K\s+-\s+-\s+\/unknown/);
  assert.match(lines, /019f0df8\s+\d\d:\d\d:03\s+input\s+200\s+516\s+2\.34s\s+3\.41M\s+gpt-5\.5\s+gpt-5\.5-m…\s+\/seconds/);
  assert.match(lines, /019f0df9\s+\d\d:\d\d:02\s+input\s+200\s+-\s+43\.2s\s+76\.3M\s+gpt-5\.5\s+gpt-5\.5-m…\s+\/large/);
  assert.match(lines, /019f0dfb\s+\d\d:\d\d:01\s+input3\s+502\s+-\s+300ms\s+2\.00K\s+gpt-5\.5\s+\[same\]\s+\/retry\s+\[502 502 506\] reasoning_guard_triggered reasoning_tokens=506/);
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
        { healthy: true, started: false, pid: 1234, state: null },
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
  const narrowRow = narrowLines.find((line) => line.includes("/retry"));
  const wideRow = wideLines.find((line) => line.includes("/retry"));
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
    { healthy: true, started: false, pid: 1234, state: null },
    {
      codexConfigPath: "/home/test/.codex/config.toml",
      listenHost: "127.0.0.1",
      listenPort: 4610,
      stateRoot,
    },
  ).join("\n");

  assert.match(lines, /status total=12 active=0 200=11 502=1 upstreams=input=12/);
  assert.match(lines, /reasoning total=12 max=1552 0=1 516=2 1034=3 1552=1 other=5/);
});

test("proxy watch uses terminal frame repaint and omits file path lines", async () => {
  const home = await mkdtemp(join(tmpdir(), "ccs-proxy-home-"));
  const previousHome = process.env.HOME;
  const previousStateRoot = process.env.CCS_PROXY_STATE_ROOT;
  const health = createServer((req, res) => {
    if (req.url === "/__codex_proxy/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: 1234 }));
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
      { input: { baseURL: `http://127.0.0.1:${proxyPort}`, apiKey: "" } },
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
        columns: 120,
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
    assert.match(output, /session\s+time\s+up\s+code\s+reas\.\s+lat\.\s+size\s+req_model\s+up_model\s+path\s+error/);
    assert.doesNotMatch(output, /state:|log:|config:/);
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
    assert.equal(state.metrics.total_requests, 3);
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

async function writeProxyTestState(home, stateRoot, proxyPort, upstreamPort) {
  await writeProxyTestStateWithProfiles(
    home,
    stateRoot,
    proxyPort,
    {
      input: { baseURL: `http://127.0.0.1:${upstreamPort}`, apiKey: "" },
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
  let output = "";
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: options.isTTY ?? process.stdout.isTTY,
  });
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: options.columns ?? process.stdout.columns,
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
  }
  return output;
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
    request_model: null,
    upstream_model: null,
    upstream_model_source: null,
    reasoning_tokens: null,
    guard_actions: [],
    error: null,
    ...overrides,
  };
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
  const pathWidth = 18;
  const lines = output.split("\n").map(stripAnsi);
  const sectionIndex = lines.indexOf(section);
  assert.ok(sectionIndex >= 0);
  const header = lines[sectionIndex + 1];
  const emptyText = section === "active" ? "no active requests" : "no historical requests";
  const firstRow = lines.slice(sectionIndex + 2).find((line) => /^\s+\S/.test(line) && !line.includes(emptyText));
  assert.ok(firstRow);
  const columns = ["session", "time", "up", "code", "reas.", "lat.", "size", "req_model", "up_model", "path", "error"];
  for (const column of columns) {
    assert.notEqual(header.indexOf(column), -1, column);
  }
  assert.equal(header.indexOf("method"), -1);
  const codeColumn = header.indexOf("code");
  const reasoningColumn = header.indexOf("reas.");
  const msColumn = header.indexOf("lat.");
  const pathColumn = header.indexOf("path");
  const errorColumn = header.indexOf("error");
  const pathStart = errorColumn - pathWidth - 1;
  const firstSlash = firstRow.indexOf("/", pathStart);
  assert.equal(firstSlash >= pathStart && firstSlash < errorColumn, true);
  if (firstRow.includes("client closed")) {
    assert.equal(firstRow.indexOf("client closed"), errorColumn);
  }
  assert.equal(header.indexOf("session") < header.indexOf("time"), true);
  assert.equal(codeColumn < reasoningColumn, true);
  assert.equal(reasoningColumn < msColumn, true);
  assert.equal(header.indexOf("up_model") < pathColumn, true);
  assert.equal(pathColumn < errorColumn, true);
}
