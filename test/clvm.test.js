import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConnectionSampler,
  buildRuntimeConfig,
  closeExpiredConnections,
  backupClvmConfig,
  domainMatches,
  mergeClvmConfig,
  nextAlignedDelay,
  nextClvmRetryInterval,
  normalizeDomains,
  parseClvmConfig,
  parseDuration,
} from "../dist/commands/clvm.js";
import { visibleLength } from "../dist/lib/text.js";

test("normalizes and matches domains", () => {
  assert.deepEqual(normalizeDomains(["Example.com,*.API.Example.com", ".example.com"]), [
    "example.com",
    "api.example.com",
  ]);
  assert.equal(domainMatches("cdn.api.example.com", "api.example.com"), true);
  assert.equal(domainMatches("badexample.com", "example.com"), false);
});

test("builds runtime config from shared config and CLI overrides", () => {
  const template = {
    baseUrl: "http://127.0.0.1:9090",
    secret: "",
    domains: [],
    interval: "1s",
    zeroSpeedThreshold: 0,
    closeZeroForSeconds: null,
    rawArchive: false,
  };
  const runtime = buildRuntimeConfig(
    mergeClvmConfig(template, parseClvmConfig(JSON.stringify({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      domains: ["example.com"],
      interval: "2s",
      zeroSpeedThreshold: 10,
      closeZeroForSeconds: 300,
      rawArchive: true,
    }))),
    { domains: ["api.example.com"], interval: "500ms", closeZeroForSeconds: null },
    { autoCloseEnabled: false, clear: false, once: true },
  );

  assert.equal(runtime.baseUrl, "http://127.0.0.1:9090");
  assert.deepEqual(runtime.domains, ["api.example.com"]);
  assert.equal(runtime.intervalMs, 500);
  assert.equal(runtime.closeZeroForSeconds, null);
  assert.equal(runtime.autoCloseEnabled, false);
  assert.equal(runtime.rawArchive, true);
});

test("sync merges template defaults with local overrides", () => {
  const template = {
    baseUrl: "http://127.0.0.1:9090",
    secret: "",
    domains: [],
    interval: "1s",
    zeroSpeedThreshold: 0,
    closeZeroForSeconds: null,
    rawArchive: false,
  };
  const merged = mergeClvmConfig(template, {
    secret: "local-secret",
    domains: ["example.com"],
  });

  assert.deepEqual(merged, {
    baseUrl: "http://127.0.0.1:9090",
    secret: "local-secret",
    domains: ["example.com"],
    interval: "1s",
    zeroSpeedThreshold: 0,
    closeZeroForSeconds: null,
    rawArchive: false,
  });
});

test("sync reports already synced when the merged config matches the local config", async () => {
  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    const templateText = await readFile(join(process.cwd(), "config", "clvm.json"), "utf8");
    await writeFile(join(home, ".config", "codex-tools", "clvm.json"), templateText);

    const stdout = await new Promise((resolve, reject) => {
      execFile("node", ["dist/bin/clvm.js", "sync"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });

    assert.match(stdout, /Will modify:\s+\(none\)/);
    assert.match(stdout, /target:\s+already synced .*clvm\.json/);
    assert.doesNotMatch(stdout, /would update/);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("backs up existing clvm config before sync writes", async () => {
  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    const configPath = join(home, ".config", "codex-tools", "clvm.json");
    await writeFile(configPath, `${JSON.stringify({ baseUrl: "http://127.0.0.1:9090" }, null, 2)}\n`);

    const backupDir = await backupClvmConfig(configPath);

    assert.ok(backupDir);
    const backupText = await readFile(join(backupDir, "clvm.json"), "utf8");
    assert.equal(backupText, `${JSON.stringify({ baseUrl: "http://127.0.0.1:9090" }, null, 2)}\n`);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("samples matched idle connections and closes expired entries in monitor mode", async () => {
  let now = new Date("2026-06-10T00:00:00.000Z");
  const sampler = new ConnectionSampler({ now: () => now });
  const payload = {
    connections: [
      {
        id: "abc",
        metadata: { host: "api.example.com", destinationPort: 443 },
        upload: 100,
        download: 200,
        start: "2026-06-09T23:59:00.000Z",
        chains: ["Proxy", "HK-01"],
        rule: "DOMAIN-SUFFIX",
        rulePayload: "example.com",
      },
    ],
  };

  sampler.sample(payload, { domains: ["example.com"], zeroSpeedThreshold: 0 });
  now = new Date("2026-06-10T00:00:01.000Z");
  const result = sampler.sample(payload, { domains: ["example.com"], zeroSpeedThreshold: 0 });

  assert.equal(result.matchedConnections.length, 1);
  assert.equal(result.matchedConnections[0].status, "zero");
  assert.equal(result.matchedConnections[0].observedIdleMs, 1000);

  const closed = [];
  const template = {
    baseUrl: "http://127.0.0.1:9090",
    secret: "",
    domains: ["example.com"],
    interval: "1s",
    zeroSpeedThreshold: 0,
    closeZeroForSeconds: null,
    rawArchive: false,
  };
  const config = buildRuntimeConfig(
    mergeClvmConfig(template, {
      closeZeroForSeconds: 0.5,
    }),
    {},
    { autoCloseEnabled: true, clear: false, once: true },
  );
  const closedConnections = await closeExpiredConnections(
    { closeConnection: async (id) => closed.push(id) },
    result,
    config,
  );

  assert.deepEqual(closed, ["abc"]);
  assert.equal(closedConnections.length, 1);

  const failedResult = {
    ...result,
    closedConnections: undefined,
    closeFailures: undefined,
  };
  const failedClosed = await closeExpiredConnections(
    {
      closeConnection: async () => {
        throw new Error("close failed");
      },
    },
    failedResult,
    config,
  );

  assert.deepEqual(failedClosed, []);
  assert.equal(failedResult.closeFailures.length, 1);
  assert.equal(failedResult.closeFailures[0].id, "abc");
  assert.equal(failedResult.closeFailures[0].error.code, "unknown_error");
});

test("parses duration and aligned delay", () => {
  assert.equal(parseDuration("1.5s"), 1500);
  assert.equal(nextAlignedDelay(1000, 1200), 800);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((attempt) => nextClvmRetryInterval(1000, attempt)), [
    1000,
    2000,
    5000,
    10000,
    30000,
    60000,
    300000,
  ]);
});

test("pads unknown speed columns", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        connections: [
          {
            id: "abc",
            metadata: { host: "api.example.com", destinationPort: 443 },
            upload: 100,
            download: 200,
            start: "2026-06-10T00:00:00.000Z",
            chains: ["Proxy", "HK-01"],
            rule: "DOMAIN-SUFFIX",
            rulePayload: "example.com",
          },
        ],
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
      }, null, 2)}\n`,
    );

    const stdout = await new Promise((resolve, reject) => {
      execFile("node", ["dist/bin/clvm.js", "--no-color"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });

    const row = stdout
      .split("\n")
      .find((line) => line.includes("api.example.com:443"));
    assert.ok(row);
    assert.match(row, /\/0ms\s+-\s+-\s+/);
    assert.doesNotMatch(row, /\[unknown\]/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("formats traffic numbers with three significant digits", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        connections: [
          {
            id: "abc",
            metadata: { host: "api.example.com", destinationPort: 443 },
            upload: 160 * 1024,
            download: 43.2 * 1024 * 1024,
            uploadSpeed: 160 * 1024,
            downloadSpeed: 43.2 * 1024 * 1024,
            start: "2026-06-10T00:00:00.000Z",
            chains: ["Proxy", "HK-01"],
            rule: "DOMAIN-SUFFIX",
            rulePayload: "example.com",
          },
        ],
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
        zeroSpeedThreshold: 160 * 1024,
      }, null, 2)}\n`,
    );

    const stdout = await new Promise((resolve, reject) => {
      execFile("node", ["dist/bin/clvm.js", "--no-color"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });

    assert.match(stdout, /zero speed:\s+160K\/s/);
    assert.match(stdout, /zero<=160K\/s/);
    const row = stdout
      .split("\n")
      .find((line) => line.includes("api.example.com:443") && line.includes("43.2M"));
    assert.ok(row);
    assert.match(row, /\b160K\b/);
    assert.match(row, /\b43\.2M\b/);
    assert.doesNotMatch(row, /\b160K\/s\b/);
    assert.doesNotMatch(row, /\b43\.2M\/s\b/);
    assert.doesNotMatch(stdout, /\bKB|MB|GB\b/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("records clvm status state and history", async () => {
  const rawPayload = {
    connections: [
      {
        id: "abc",
        metadata: { host: "api.example.com", destinationPort: 443 },
        upload: 100,
        download: 200,
        uploadSpeed: 10,
        downloadSpeed: 20,
        start: "2026-06-10T00:00:00.000Z",
        chains: ["Proxy", "HK-01"],
        rule: "DOMAIN-SUFFIX",
        rulePayload: "example.com",
      },
    ],
  };
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "x-api-key": "server-secret", "x-trace-id": "trace-1" });
      res.end(JSON.stringify(rawPayload));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
      }, null, 2)}\n`,
    );

    await new Promise((resolve, reject) => {
      execFile("node", ["dist/bin/clvm.js", "--no-color"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const state = JSON.parse(await readFile(join(home, ".cache", "codex-tools", "clvm-state.json"), "utf8"));
    assert.equal(state.version, 3);
    assert.equal(state.ok, true);
    assert.equal(state.status, "ok");
    assert.equal(state.source, "status");
    assert.equal(state.config.baseUrl, `http://127.0.0.1:${address.port}`);
    assert.deepEqual(state.config.domains, ["example.com"]);
    assert.equal(state.summary.totalConnections, 1);
    assert.equal(state.summary.matchedConnections, 1);
    assert.equal(state.summary.activeConnections, 1);
    assert.equal(state.summary.uploadBytesPerSecond, 10);
    assert.equal(state.summary.downloadBytesPerSecond, 20);
    assert.equal(state.result.matchedConnections[0].id, "abc");
    assert.equal(state.raw, undefined);
    assert.equal(state.config.rawArchive, false);
    assert.equal(state.raw_ref, null);

    const historyText = await readFile(join(home, ".cache", "codex-tools", "clvm-history.jsonl"), "utf8");
    assert.doesNotMatch(historyText, /api\.example\.com|HK-01|"abc"/);
    const history = historyText.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(history.length, 1);
    assert.equal(history[0].summary.matchedConnections, 1);
    assert.equal(history[0].result, undefined);
    assert.equal(history[0].raw, undefined);
    assert.equal(history[0].raw_ref, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("records clvm raw archive when enabled", async () => {
  const rawPayload = {
    connections: [
      {
        id: "abc",
        metadata: { host: "api.example.com", destinationPort: 443 },
        upload: 100,
        download: 200,
        uploadSpeed: 10,
        downloadSpeed: 20,
        start: "2026-06-10T00:00:00.000Z",
        chains: ["Proxy", "HK-01"],
        rule: "DOMAIN-SUFFIX",
        rulePayload: "example.com",
      },
    ],
  };
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "x-api-key": "server-secret", "x-trace-id": "trace-1" });
      res.end(JSON.stringify(rawPayload));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
        rawArchive: true,
      }, null, 2)}\n`,
    );

    await new Promise((resolve, reject) => {
      execFile("node", ["dist/bin/clvm.js", "--no-color"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const state = JSON.parse(await readFile(join(home, ".cache", "codex-tools", "clvm-state.json"), "utf8"));
    assert.equal(state.config.rawArchive, true);
    assert.equal(state.raw, undefined);
    assert.equal(typeof state.raw_ref.sha256, "string");
    assert.equal(state.raw_ref.stored, true);
    assert.match(state.raw_ref.path, /clvm-raw\/[a-f0-9]{64}\.json$/);

    const history = (await readFile(join(home, ".cache", "codex-tools", "clvm-history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(history[0].raw_ref, state.raw_ref);
    assert.equal(history[0].result, undefined);
    const raw = JSON.parse(await readFile(history[0].raw_ref.path, "utf8"));
    assert.equal(raw.method, "GET");
    assert.equal(raw.path, "/connections");
    assert.equal(raw.status, 200);
    assert.equal(raw.headers["x-api-key"], "[redacted]");
    assert.equal(raw.headers["x-trace-id"], "trace-1");
    assert.equal(raw.body, JSON.stringify(rawPayload));
    assert.equal(raw.bodyBytes, Buffer.byteLength(JSON.stringify(rawPayload), "utf8"));
    assert.deepEqual(JSON.parse(raw.body), rawPayload);
    assert.equal(state.raw_ref.bytes, Buffer.byteLength(JSON.stringify(raw), "utf8"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("records unavailable status when connections payload is invalid", async () => {
  const rawPayload = { error: "controller disabled" };
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rawPayload));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
      }, null, 2)}\n`,
    );

    const stdout = await new Promise((resolve, reject) => {
      execFile("node", ["dist/bin/clvm.js", "--no-color"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });

    assert.match(stdout, /status:\s+unavailable invalid_connections_payload/);
    assert.match(stdout, /\/connections response must contain a connections array/);

    const state = JSON.parse(await readFile(join(home, ".cache", "codex-tools", "clvm-state.json"), "utf8"));
    assert.equal(state.version, 3);
    assert.equal(state.ok, false);
    assert.equal(state.status, "unavailable");
    assert.equal(state.error.code, "invalid_connections_payload");
    assert.equal(state.raw, undefined);
    assert.equal(state.raw_ref, null);
    assert.equal(state.retry, undefined);

    const history = (await readFile(join(home, ".cache", "codex-tools", "clvm-history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(history.length, 1);
    assert.equal(history[0].ok, false);
    assert.equal(history[0].raw, undefined);
    assert.equal(history[0].raw_ref, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("omits clvm http error response body by default", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "secret controller detail" }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
      }, null, 2)}\n`,
    );

    const stdout = await new Promise((resolve, reject) => {
      execFile("node", ["dist/bin/clvm.js", "--no-color"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });

    assert.match(stdout, /status:\s+unavailable http_error/);
    assert.doesNotMatch(stdout, /secret controller detail/);

    const state = JSON.parse(await readFile(join(home, ".cache", "codex-tools", "clvm-state.json"), "utf8"));
    assert.equal(state.error.message, "GET /connections failed with 500 Internal Server Error");
    assert.equal(state.error.body, undefined);
    assert.equal(state.raw_ref, null);

    const history = (await readFile(join(home, ".cache", "codex-tools", "clvm-history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(history[0].error.body, undefined);
    assert.equal(history[0].raw_ref, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("omits oversized clvm raw archive payloads", async () => {
  const rawPayload = {
    note: "x".repeat(1024 * 1024),
    connections: [
      {
        id: "abc",
        metadata: { host: "api.example.com", destinationPort: 443 },
        upload: 100,
        download: 200,
        uploadSpeed: 10,
        downloadSpeed: 20,
        start: "2026-06-10T00:00:00.000Z",
        chains: ["Proxy"],
        rule: "DOMAIN-SUFFIX",
        rulePayload: "example.com",
      },
    ],
  };
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rawPayload));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
        rawArchive: true,
      }, null, 2)}\n`,
    );

    await new Promise((resolve, reject) => {
      execFile("node", ["dist/bin/clvm.js", "--no-color"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const state = JSON.parse(await readFile(join(home, ".cache", "codex-tools", "clvm-state.json"), "utf8"));
    assert.equal(state.raw, undefined);
    assert.equal(state.raw_ref.stored, false);
    assert.equal(state.raw_ref.path, null);
    assert.equal(state.raw_ref.omitted_reason, "payload_too_large");
    assert.equal(state.raw_ref.max_bytes, 1024 * 1024);
    assert.ok(state.raw_ref.bytes > 1024 * 1024);

    const history = (await readFile(join(home, ".cache", "codex-tools", "clvm-history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(history[0].raw_ref, state.raw_ref);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("prunes clvm raw archive files", async () => {
  const rawPayload = {
    connections: [
      {
        id: "abc",
        metadata: { host: "api.example.com", destinationPort: 443 },
        upload: 100,
        download: 200,
        uploadSpeed: 10,
        downloadSpeed: 20,
        start: "2026-06-10T00:00:00.000Z",
        chains: ["Proxy"],
        rule: "DOMAIN-SUFFIX",
        rulePayload: "example.com",
      },
    ],
  };
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rawPayload));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    const rawDir = join(home, ".cache", "codex-tools", "clvm-raw");
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await mkdir(rawDir, { recursive: true });
    for (let index = 0; index < 300; index += 1) {
      await writeFile(join(rawDir, `${index.toString(16).padStart(64, "0")}.json`), "{}\n", "utf8");
    }
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
        rawArchive: true,
      }, null, 2)}\n`,
    );

    await new Promise((resolve, reject) => {
      execFile("node", ["dist/bin/clvm.js", "--no-color"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const state = JSON.parse(await readFile(join(home, ".cache", "codex-tools", "clvm-state.json"), "utf8"));
    const files = await readdir(rawDir);
    assert.equal(state.raw_ref.stored, true);
    assert.ok(files.length <= 256);
    assert.ok(files.includes(state.raw_ref.path.split("/").at(-1)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("monitor retries unavailable connections with backoff", async () => {
  let requestCount = 0;
  const validPayload = {
    connections: [
      {
        id: "abc",
        metadata: { host: "api.example.com", destinationPort: 443 },
        upload: 100,
        download: 200,
        start: "2026-06-10T00:00:00.000Z",
        chains: ["Proxy", "HK-01"],
        rule: "DOMAIN-SUFFIX",
        rulePayload: "example.com",
      },
    ],
  };
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      requestCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(requestCount <= 2 ? { unavailable: true } : validPayload));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
        interval: "1ms",
      }, null, 2)}\n`,
    );

    const child = spawn("node", ["dist/bin/clvm.js", "monitor", "--no-color", "--no-clear"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sigintSent = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!sigintSent && stdout.includes("current=1")) {
        sigintSent = true;
        child.kill("SIGINT");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const watchdog = setTimeout(() => child.kill("SIGINT"), 5000);
    const exit = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(watchdog);

    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(stderr, "");
    assert.ok(requestCount >= 3);
    assert.match(stdout, /status=unavailable .*attempt=1 retry=1ms/);
    assert.match(stdout, /status=unavailable .*attempt=2 retry=2ms/);
    assert.match(stdout, /current=1/);

    const state = JSON.parse(await readFile(join(home, ".cache", "codex-tools", "clvm-state.json"), "utf8"));
    assert.equal(state.ok, true);
    assert.equal(state.status, "ok");

    const history = (await readFile(join(home, ".cache", "codex-tools", "clvm-history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(history[0].ok, false);
    assert.equal(history[0].retry.intervalMs, 1);
    assert.equal(history[1].ok, false);
    assert.equal(history[1].retry.intervalMs, 2);
    assert.ok(history.some((record) => record.ok === true));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("monitor skips duplicate idle runtime records", async () => {
  let requestCount = 0;
  let child;
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      requestCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ connections: [] }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
        interval: "1ms",
      }, null, 2)}\n`,
    );

    child = spawn("node", ["dist/bin/clvm.js", "monitor", "--no-color", "--no-clear"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let emptySamples = 0;
    let sigintSent = false;
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      emptySamples = (stdout.match(/no current connections/g) ?? []).length;
      if (emptySamples >= 3 && !sigintSent) {
        sigintSent = true;
        setTimeout(() => child.kill("SIGINT"), 20);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const watchdog = setTimeout(() => child.kill("SIGINT"), 5000);
    const exit = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(watchdog);

    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(stderr, "");
    assert.ok(requestCount >= 3);

    const state = JSON.parse(await readFile(join(home, ".cache", "codex-tools", "clvm-state.json"), "utf8"));
    assert.equal(state.ok, true);
    assert.equal(state.summary.totalConnections, 0);
    assert.equal(state.summary.matchedConnections, 0);

    const history = (await readFile(join(home, ".cache", "codex-tools", "clvm-history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(history.length, 1);
    assert.equal(history[0].summary.totalConnections, 0);
    assert.equal(history[0].summary.matchedConnections, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (child && !child.killed) {
      child.kill("SIGINT");
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("monitor uses alternate screen and repaints on resize in TTY clear mode", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ connections: [] }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
        interval: "10s",
      }, null, 2)}\n`,
    );

    const script = `
      process.env.NO_COLOR = "1";
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: 100 });
      const originalWrite = process.stdout.write.bind(process.stdout);
      let frames = 0;
      process.stdout.write = (chunk, encoding, callback) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const result = originalWrite(chunk, encoding, callback);
        if (text.includes("\\u001b[J")) {
          frames += 1;
          if (frames === 1) {
            setImmediate(() => {
              Object.defineProperty(process.stdout, "columns", { configurable: true, value: 80 });
              process.stdout.emit("resize");
            });
          }
          if (frames >= 2) {
            setImmediate(() => process.emit("SIGINT"));
          }
        }
        return result;
      };
      const { runClvm } = await import("./dist/commands/clvm.js");
      await runClvm(["monitor", "--no-color"]);
    `;
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, ["--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve(stdout);
      });
    });

    assert.match(stdout, /^\u001b\[\?1049h\u001b\[\?25l\u001b\[H/);
    assert.equal((stdout.match(/\u001b\[H/g) ?? []).length, 2);
    assert.match(stdout, /no current connections for configured domains/);
    assert.match(stdout, /\u001b\[J\u001b\[\?25h\u001b\[\?1049l$/);
    assert.doesNotMatch(stdout, /\u001b\[2J/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("fits connection tables to terminal width", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/connections" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        connections: [
          {
            id: "abc",
            metadata: {
              host: "ai.input.im",
              destinationPort: 443,
            },
            upload: 100,
            download: 200,
            uploadSpeed: 320,
            downloadSpeed: 55.5 * 1024,
            start: "2026-06-10T00:00:00.000Z",
            chains: ["Proxy", "Hong-Kong-Long-Node-Name", "Fallback-Long-Node-Name"],
            rule: "DOMAIN-SUFFIX",
            rulePayload: "example.com",
          },
        ],
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const home = await mkdtemp(join(tmpdir(), "clvm-home-"));
  try {
    await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
    await writeFile(
      join(home, ".config", "codex-tools", "clvm.json"),
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: "",
        domains: ["example.com"],
      }, null, 2)}\n`,
    );

    const stdout = await new Promise((resolve, reject) => {
      execFile("node", [
        "--input-type=module",
        "-e",
        [
          "Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });",
          "const { runClvm } = await import('./dist/commands/clvm.js');",
          "await runClvm(['--no-color']);",
        ].join(""),
      ], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });

    const lines = stdout.split("\n");
    const headerIndex = lines.findIndex((line) => line.includes("endpoint") && line.includes("age/zeroFor") && line.includes("up/s") && line.includes("down/s"));
    assert.notEqual(headerIndex, -1);
    const tableLines = lines.slice(headerIndex, headerIndex + 2);
    assert.equal(tableLines.length, 2);
    assert.ok(tableLines.every((line) => visibleLength(line) <= 80));
    assert.doesNotMatch(tableLines[0], /\bstatus\b/);
    assert.match(tableLines[0], /\brule\b/);
    assert.doesNotMatch(tableLines[0], /\bupload\b/);
    assert.doesNotMatch(tableLines[0], /\bdownload\b/);
    assert.match(tableLines[0], /up\/s\s+down\/s/);
    assert.match(tableLines[1], /\/0ms\b/);
    assert.match(tableLines[1], /\b320B\b/);
    assert.match(tableLines[1], /\b55\.5K\b/);
    assert.doesNotMatch(tableLines[1], /\b320B\/s\b|\b55\.5K\/s\b|\bactive\b|act…/);
    assert.doesNotMatch(tableLines[1], /320…|55\.5K…/);

    const commandsLine = lines.find((line) => line.startsWith("commands: "));
    assert.ok(commandsLine);
    assert.ok(visibleLength(commandsLine) <= 80);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
