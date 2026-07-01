import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  };
  const runtime = buildRuntimeConfig(
    mergeClvmConfig(template, parseClvmConfig(JSON.stringify({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      domains: ["example.com"],
      interval: "2s",
      zeroSpeedThreshold: 10,
      closeZeroForSeconds: 300,
    }))),
    { domains: ["api.example.com"], interval: "500ms", closeZeroForSeconds: null },
    { autoCloseEnabled: false, clear: false, once: true },
  );

  assert.equal(runtime.baseUrl, "http://127.0.0.1:9090");
  assert.deepEqual(runtime.domains, ["api.example.com"]);
  assert.equal(runtime.intervalMs, 500);
  assert.equal(runtime.closeZeroForSeconds, null);
  assert.equal(runtime.autoCloseEnabled, false);
});

test("sync merges template defaults with local overrides", () => {
  const template = {
    baseUrl: "http://127.0.0.1:9090",
    secret: "",
    domains: [],
    interval: "1s",
    zeroSpeedThreshold: 0,
    closeZeroForSeconds: null,
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
});

test("parses duration and aligned delay", () => {
  assert.equal(parseDuration("1.5s"), 1500);
  assert.equal(nextAlignedDelay(1000, 1200), 800);
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
      .find((line) => line.startsWith("unknown") || line.startsWith("[unknown]"));
    assert.ok(row);
    assert.match(row, /\[unknown\]\s{2}\[unknown\]/);
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
              host: "very-long-api-name.example.com",
              destinationPort: 443,
            },
            upload: 100,
            download: 200,
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
    const headerIndex = lines.findIndex((line) => line.startsWith("status ") && line.includes("endpoint"));
    assert.notEqual(headerIndex, -1);
    const tableLines = lines.slice(headerIndex, headerIndex + 2);
    assert.equal(tableLines.length, 2);
    assert.ok(tableLines.every((line) => visibleLength(line) <= 80));
    assert.match(tableLines[0], /\brule\b/);
    assert.doesNotMatch(tableLines[0], /\bupload\b/);
    assert.doesNotMatch(tableLines[0], /\bdownload\b/);

    const commandsLine = lines.find((line) => line.startsWith("commands: "));
    assert.ok(commandsLine);
    assert.ok(visibleLength(commandsLine) <= 80);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
