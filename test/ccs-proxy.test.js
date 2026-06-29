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
                status: 502,
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
    assert.deepEqual(state.metrics.status_counts, { "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 1 });
    assert.equal(state.metrics.active_requests.length, 1);
    assert.equal(state.metrics.active_requests[0].session, "019f0eca");
    assert.equal(state.metrics.active_requests[0].request_model, null);
    assert.equal(state.metrics.upstream_hit_counts.input, 1);
    assert.equal(state.metrics.recent_requests[0].upstream, "input");
    assert.equal(state.metrics.recent_requests[0].completed_at, "2026-01-01T00:00:00.000Z");
    assert.equal(state.metrics.recent_requests[0].response_bytes, 51);
    assert.equal(state.metrics.recent_requests[0].request_model, null);
    assert.equal(state.metrics.recent_requests[0].upstream_model, null);
    assert.equal(state.metrics.recent_requests[0].upstream_model_source, null);
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
  let abortStreamStartedResolve;
  const abortStreamStarted = new Promise((resolve) => {
    abortStreamStartedResolve = resolve;
  });
  let finishAbortStream;
  const abortStreamRelease = new Promise((resolve) => {
    finishAbortStream = resolve;
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
    if (req.url === "/abort-stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      abortStreamStartedResolve();
      void abortStreamRelease.then(() => {
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
            status_counts: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
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
    assert.equal(state.metrics.status_counts["2xx"], 7);
    assert.equal(state.metrics.recent_requests.filter((record) => record.path === "/slow").length, 6);

    const streamFetch = fetch(`http://127.0.0.1:${proxyPort}/stream`, { method: "POST", body: "{}" });
    await streamStarted;
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 1);
    state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.metrics.active_requests[0].path, "/stream");
    assert.equal(state.metrics.recent_requests[0].path, "/slow");

    finishStream();
    const streamResponse = await streamFetch;
    assert.equal(await streamResponse.text(), "data: one\n\ndata: two\n\n");
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.recent_requests[0].path === "/stream");

    const abortController = new AbortController();
    const abortResponse = await fetch(`http://127.0.0.1:${proxyPort}/abort-stream`, {
      method: "POST",
      body: "{}",
      signal: abortController.signal,
    });
    assert.equal(abortResponse.status, 200);
    await abortStreamStarted;
    const abortReader = abortResponse.body.getReader();
    const abortChunk = await abortReader.read();
    assert.equal(Buffer.from(abortChunk.value).toString("utf8"), "data: one\n\n");
    abortController.abort();
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.recent_requests[0].path === "/abort-stream");
    finishAbortStream();
    state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.metrics.recent_requests[0].status, 499);
    assert.equal(state.metrics.recent_requests[0].error, "client closed response before upstream stream completed");

    const clientError = await fetch(`http://127.0.0.1:${proxyPort}/client-error`, { method: "POST", body: "{}" });
    assert.equal(clientError.status, 404);
    await clientError.text();
    const serverError = await fetch(`http://127.0.0.1:${proxyPort}/server-error`, { method: "POST", body: "{}" });
    assert.equal(serverError.status, 502);
    await serverError.text();
    await waitForState(stateRoot, (candidate) => candidate.metrics.active_requests.length === 0 && candidate.metrics.total_requests === 11);

    state = await readProxyState(stateRoot);
    assert.ok(state);
    assert.equal(state.metrics.active_requests.length, 0);
    assert.deepEqual(state.metrics.status_counts, { "2xx": 8, "3xx": 0, "4xx": 2, "5xx": 1 });
    assert.equal(state.metrics.total_requests, 11);
    assert.equal(state.metrics.upstream_hit_counts.input, 10);
    assert.equal(state.metrics.recent_requests[0].status, 502);
    assert.equal(state.metrics.recent_requests[1].status, 404);
    assert.equal(state.metrics.recent_requests[2].status, 499);

    const output = await captureConsole(() => runProxyCommand([], proxyOptions));
    assert.match(output, /status total=11 active=0 2xx=8 3xx=0 4xx=2 5xx=1 upstreams=input=10/);
    assert.match(output, /latency last=\d+ms avg=\d+ms min=\d+ms max=\d+ms/);
    assert.match(output, /active\n\s+session\s+time\s+up\s+code\s+ms\s+size\s+req_model\s+up_model\s+path\s+error\n\s+no active requests/);
    assert.match(output, /history\n\s+session\s+time\s+up\s+code\s+ms\s+size\s+req_model\s+up_model\s+path\s+error/);
    assert.doesNotMatch(output, /\bmethod\b/);
    assert.match(output, /\/abort-stream\s+client closed response …/);
    assertProxyHistoryColumnsAligned(output);
    assert.doesNotMatch(output, /requests: total|failed|rate|p50|p95/);
    assert.doesNotMatch(output.split("\n").find((line) => line.startsWith("status ")) ?? "", /\bok\b/);
  } finally {
    finishStream?.();
    finishAbortStream?.();
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
  let activeStreamResolve;
  const activeStreamStarted = new Promise((resolve) => {
    activeStreamResolve = resolve;
  });
  let releaseActiveStream;
  const activeStreamRelease = new Promise((resolve) => {
    releaseActiveStream = resolve;
  });

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

    if (url.searchParams.get("hold") === "1") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: spec.streamModel })}\n\n`);
      activeStreamResolve();
      void activeStreamRelease.then(() => {
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
    await activeStreamStarted;
    let state = await waitForState(
      stateRoot,
      (candidate) => candidate.metrics.active_requests[0]?.path === activeSpec.path,
    );
    assert.equal(state.metrics.active_requests[0].request_model, "active-request-model");

    releaseActiveStream();
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

    const output = await captureConsole(() => runProxyCommand([], proxyOptions));
    assert.match(output, /session\s+time\s+up\s+code\s+ms\s+size\s+req_model\s+up_model\s+path\s+error/);
    assert.doesNotMatch(output, /\bnull\b/);
    assert.match(output, /\[unknown\]\s+\[unknown\]\s+\/responses/);
    assert.match(output, /responses…\s+responses…\s+\/responses/);
    assertProxyHistoryColumnsAligned(output);
  } finally {
    releaseActiveStream?.();
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
        active_requests: [],
        status_counts: { "2xx": 5, "3xx": 0, "4xx": 0, "5xx": 0 },
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

  assert.match(lines, /session\s+time\s+up\s+code\s+ms\s+size\s+req_model\s+up_model\s+path\s+error/);
  assert.doesNotMatch(lines, /\bmethod\b/);
  assert.doesNotMatch(lines, /^\s+\d+\./m);
  assert.match(lines, /019f0df6\s+\d\d:\d\d:05\s+input\s+200\s+56ms\s+32\.0K\s+gpt-5\.5\s+\[same\]\s+\/same/);
  assert.match(lines, /019f0df7\s+\d\d:\d\d:04\s+input\s+200\s+123ms\s+982K\s+\[unknown\]\s+\[unknown\]\s+\/unknown/);
  assert.match(lines, /019f0df8\s+\d\d:\d\d:03\s+input\s+200\s+2\.34s\s+3\.41M\s+gpt-5\.5\s+gpt-5\.5-m…\s+\/seconds/);
  assert.match(lines, /019f0df9\s+\d\d:\d\d:02\s+input\s+200\s+43\.2s\s+76\.3M\s+gpt-5\.5\s+gpt-5\.5-m…\s+\/large/);
  assert.match(lines, /019f0dfa\s+\d\d:\d\d:01\s+input\s+200\s+3\.12m\s+1\.00K\s+gpt-5\.5\s+gpt-5\.5-m…\s+\/minutes/);
  assertProxyHistoryColumnsAligned(lines);
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

async function writeProxyTestState(home, stateRoot, proxyPort, upstreamPort) {
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
          status_counts: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
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
    error: null,
    ...overrides,
  };
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve) => server.close(resolve));
}

function assertProxyHistoryColumnsAligned(output) {
  const pathWidth = 30;
  const lines = output.split("\n").map(stripAnsi);
  const historyIndex = lines.indexOf("history");
  assert.ok(historyIndex >= 0);
  const header = lines[historyIndex + 1];
  const firstRow = lines.slice(historyIndex + 2).find((line) => /^\s+\S/.test(line) && !line.includes("no historical requests"));
  assert.ok(firstRow);
  const columns = ["session", "time", "up", "code", "ms", "size", "req_model", "up_model", "path", "error"];
  for (const column of columns) {
    assert.notEqual(header.indexOf(column), -1, column);
  }
  assert.equal(header.indexOf("method"), -1);
  const pathColumn = header.indexOf("path");
  const errorColumn = header.indexOf("error");
  const pathStart = errorColumn - pathWidth - 1;
  const firstSlash = firstRow.indexOf("/", pathStart);
  assert.equal(firstSlash >= pathStart && firstSlash < errorColumn, true);
  if (firstRow.includes("client closed")) {
    assert.equal(firstRow.indexOf("client closed"), errorColumn);
  }
  assert.equal(header.indexOf("session") < header.indexOf("time"), true);
  assert.equal(header.indexOf("up_model") < pathColumn, true);
  assert.equal(pathColumn < errorColumn, true);
}
