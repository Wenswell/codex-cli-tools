import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCcs as runCcsCommand } from "../dist/commands/ccs.js";
import { shutdownProxyRuntime } from "../dist/commands/ccs-proxy.js";
import { captureStdout, execNodeScript, execNodeStdout, KEYS, runInteractive, spawnNode, stdoutPropertiesScript, stripAnsi } from "./helpers/terminal.js";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("ccs help lists the current proxy command surface", async () => {
  const output = await captureStdout(() => runCcsCommand(["help"]));
  assert.match(output, /ccs proxy \[watch\|reroute\|cancel\|capture\|mode\|search\|compact\|config\|install\|restart\|restore\|serve\]/);
  assert.match(output, /ccs models \[PROFILE\] \[--json\]/);
  assert.doesNotMatch(output, /proxy.*stop|proxy.*--once/);
  assert.doesNotMatch(output, /ccs run/);
});

test("ccs status footer separates direct commands from namespaces", async () => {
  const home = await writeProfiles({
    profiles: { test001: { baseURL: "https://example.invalid", apiKey: "" } },
    current: "test001",
  });
  try {
    const output = await runCcs(["dist/bin/ccs.js"], home, { XDG_CACHE_HOME: join(home, ".cache") });
    assert.match(output, /^commands:/m);
    assert.match(output, /^namespaces:/m);
    assert.doesNotMatch(output, /^commands:.*\[/m);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs exposes route conversion in current, list, and profile views", async () => {
  const home = await writeProfiles({
    profiles: {
      test001: { baseURL: "https://test001.example.test", apiKey: "test001-key", routeConversion: { enabled: true } },
      direct: { baseURL: "https://direct.example.test", apiKey: "direct-key" },
    },
    current: "test001",
  });
  const env = { XDG_CACHE_HOME: join(home, ".cache") };
  try {
    const status = await runCcs(["dist/bin/ccs.js"], home, env);
    const list = await runCcs(["dist/bin/ccs.js", "list"], home, env);
    const profile = await runCcs(["dist/bin/ccs.js", "test001"], home, env);

    assert.match(status, /^conversion:\s+responses→chat$/m);
    assert.match(list, /test001\s+https:\/\/test001\.example\.test.*responses→chat/);
    assert.match(list, /direct\s+https:\/\/direct\.example\.test.*off/);
    assert.match(profile, /^conversion:\s+responses→chat$/m);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs config shows sync endpoints and has local help", async () => {
  const home = await writeProfiles({
    profiles: { test001: { baseURL: "https://example.invalid", apiKey: "" } },
    current: "test001",
  });
  const env = { XDG_CACHE_HOME: join(home, ".cache") };
  try {
    const configOutput = await runCcs(["dist/bin/ccs.js", "config"], home, env);
    assert.match(configOutput, /^local:/m);
    assert.match(configOutput, /run in an interactive terminal to push or pull/);
    assert.match(await runCcs(["dist/bin/ccs.js", "config", "--help"], home, env), /choose push or pull/);
    for (const removed of [["config", "push"], ["config", "pull"]]) {
      await assert.rejects(() => runCcs(["dist/bin/ccs.js", ...removed], home, env), /unknown argument for ccs config/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs models reads the selected profile v1/models endpoint", async () => {
  const requests = [];
  const { server, baseUrl } = await startJsonServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      object: "list",
      data: [
        { id: "gpt-5-sol", object: "model", created: 1735689600, owned_by: "openai" },
        { id: "gpt-5-mini", object: "model", created: 1735689600, owned_by: "openai" },
      ],
    }));
  });
  const home = await writeProfiles({
    profiles: {
      test001: { baseURL: "https://test001.example.test", apiKey: "test001-key" },
      test002: { baseURL: `${baseUrl}/api/v1`, apiKey: "test002-key" },
    },
    current: "test002",
  });
  try {
    const output = await runCcsDirect(["models"], home);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/v1/models");
    assert.equal(requests[0].authorization, "Bearer test002-key");
    assert.match(output, /^profile:\s+test002\s+http:\/\/127\.0\.0\.1:\d+\/api\/v1\/models$/m);
    assert.match(output, /^model\s+owned_by\s+created$/m);
    assert.match(output, /gpt-5-sol\s+openai\s+2025-01-01/);
    assert.match(output, /gpt-5-mini\s+openai\s+2025-01-01/);
  } finally {
    await closeServer(server);
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs models builds the default v1 endpoint and prints JSON", async () => {
  const requests = [];
  const { server, baseUrl } = await startJsonServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      object: "list",
      data: [{ id: "gpt-5-sol", object: "model", created: 1735689600, owned_by: "openai" }],
    }));
  });
  const home = await writeProfiles({
    profiles: {
      test001: { baseURL: "https://test001.example.test", apiKey: "test001-key" },
      test002: { baseURL: baseUrl, apiKey: "test002-key" },
    },
    current: "test001",
  });
  try {
    const output = await runCcsDirect(["models", "test002", "--json"], home);
    assert.deepEqual(requests, ["/v1/models"]);
    assert.deepEqual(JSON.parse(output), {
      version: 1,
      profile: "test002",
      url: `${baseUrl}/v1/models`,
      models: [{ id: "gpt-5-sol", owned_by: "openai", created: 1735689600 }],
    });
  } finally {
    await closeServer(server);
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs models fails with explicit errors instead of partial output", async () => {
  const { server, baseUrl } = await startJsonServer((request, response) => {
    if (request.url === "/bad/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ object: "model" }] }));
      return;
    }
    response.statusCode = 503;
    response.end("unavailable");
  });
  const home = await writeProfiles({
    profiles: {
      test001: { baseURL: "https://test001.example.test", apiKey: "" },
      down: { baseURL: `${baseUrl}/v1`, apiKey: "down-key" },
      bad: { baseURL: `${baseUrl}/bad`, apiKey: "bad-key" },
      broken: { baseURL: "not a url", apiKey: "broken-key" },
    },
    current: "down",
  });
  try {
    await assert.rejects(runCcsDirect(["models", "test001"], home), /profile test001 has no apiKey/);
    await assert.rejects(runCcsDirect(["models", "down"], home), /GET http:\/\/[^ ]+\/v1\/models failed: HTTP 503/);
    await assert.rejects(runCcsDirect(["models", "bad"], home), /returned an invalid model list/);
    await assert.rejects(runCcsDirect(["models", "broken"], home), /profile broken has an invalid baseURL: not a url/);
    await assert.rejects(runCcsDirect(["models", "missing"], home), /profile not found: missing/);
    await assert.rejects(runCcsDirect(["models", "--bogus"], home), /unknown argument for ccs models: --bogus/);
  } finally {
    await closeServer(server);
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs models help documents the local surface", async () => {
  const home = await writeProfiles({
    profiles: { test001: { baseURL: "https://example.invalid", apiKey: "" } },
    current: "test001",
  });
  try {
    const output = await runCcsDirect(["models", "--help"], home);
    assert.match(output, /ccs models PROFILE --json/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex wrappers execute standard codex directly", async () => {
  const binDir = await createFakeCodex("console.log(JSON.stringify(process.argv.slice(2)));\n");
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  const cwd = await mkdtemp(join(tmpdir(), "codex cwd "));
  try {
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, "dist/bin/cx.js"), "hello"], { cwd, env })), [
      "--search", "hello",
    ]);
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, "dist/bin/cxx.js"), "hello"], { cwd, env })), [
      "--search", "--dangerously-bypass-approvals-and-sandbox", "hello",
    ]);
    assert.deepEqual(JSON.parse(await execNodeStdout([join(repoRoot, "dist/bin/cxxs.js"), "thread"], { cwd, env })), [
      "--search", "--dangerously-bypass-approvals-and-sandbox", "resume", "thread",
    ]);
  } finally {
    await rm(binDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Codex wrapper help documents profile launches", async () => {
  for (const tool of ["cx", "cxx", "cxxs"]) {
    const output = await runTool(tool, ["--help"]);
    assert.match(output, new RegExp(`${tool} run PROFILE`));
    assert.doesNotMatch(output, new RegExp(`${tool} local`));
  }
});

test("Codex wrappers launch with a selected profile through an installed proxy", async () => {
  const home = await writeProfiles({
    profiles: {
      test001: { baseURL: "https://test001.example.com", apiKey: "test001-key" },
      test002: { baseURL: "https://test002.example.com", apiKey: "test002-key" },
    },
    current: "test002",
  });
  const stateRoot = join(home, ".cache", "codex-tools", "proxy");
  const proxyPort = await reservePort();
  const capturePath = join(home, "codex-profile-run.json");
  const binDir = await createFakeCodex(`
    const { writeFileSync } = require("node:fs");
    writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2), apiKey: process.env.CODEX_TOOLS_PROFILE_API_KEY }));
  `);
  const codexConfigPath = join(home, ".codex", "config.toml");
  const options = { codexConfigPath, listenHost: "127.0.0.1", listenPort: proxyPort, stateRoot };
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(codexConfigPath, [
      'model_provider = "codex"',
      "",
      "[model_providers.codex]",
      'base_url = "https://test002.example.com"',
      'wire_api = "responses"',
      "",
    ].join("\n"), "utf8");
    await writeProxyStateForRunTest(home, stateRoot, proxyPort);

    const cases = [
      { tool: "cx", args: ["hello"], prefix: ["--search"] },
      { tool: "cxx", args: ["hello"], prefix: ["--search", "--dangerously-bypass-approvals-and-sandbox"] },
      { tool: "cxxs", args: ["thread"], prefix: ["--search", "--dangerously-bypass-approvals-and-sandbox"] },
    ];
    for (const entry of cases) {
      await runCcs([`dist/bin/${entry.tool}.js`, "run", "test001", ...entry.args], home, {
        XDG_CACHE_HOME: join(home, ".cache"),
        CCS_PROXY_STATE_ROOT: stateRoot,
        CCS_PROXY_LISTEN_PORT: String(proxyPort),
        PATH: `${binDir}:${process.env.PATH}`,
        CAPTURE_PATH: capturePath,
      });

      const captured = JSON.parse(await readFile(capturePath, "utf8"));
      assert.equal(captured.apiKey, "test001-key");
      assert.deepEqual(captured.args, [
        ...entry.prefix,
        "-c", `model_providers.codex.base_url="http://127.0.0.1:${proxyPort}"`,
        "-c", 'model_providers.codex.env_key="CODEX_TOOLS_PROFILE_API_KEY"',
        "-c", 'model_providers.codex.http_headers.x-ccs-profile="test001"',
        ...(entry.tool === "cxxs" ? ["resume"] : []),
        ...entry.args,
      ]);
      assert.equal(captured.args.includes("--remote"), false);
    }
  } finally {
    await shutdownProxyRuntime(options).catch(() => null);
    await rm(binDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex profile launch uses the direct URL and rejects unknown profiles", async () => {
  const home = await writeProfiles({
    profiles: { test001: { baseURL: "https://test001.example.com", apiKey: "test001-key" } },
    current: "test001",
  });
  const capturePath = join(home, "codex-direct-profile-run.json");
  const binDir = await createFakeCodex(`
    const { writeFileSync } = require("node:fs");
    writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2), apiKey: process.env.CODEX_TOOLS_PROFILE_API_KEY }));
  `);
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), 'model_provider = "codex"\n', "utf8");
    const env = {
      XDG_CACHE_HOME: join(home, ".cache"),
      PATH: `${binDir}:${process.env.PATH}`,
      CAPTURE_PATH: capturePath,
    };

    await runCcs(["dist/bin/cx.js", "run", "test001", "hello"], home, env);
    const usage = JSON.parse(await readFile(join(home, ".cache", "codex-tools", "profile-usage.json"), "utf8"));
    assert.ok(Number.isFinite(Date.parse(usage.profiles.test001.launched_at)));
    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(captured.apiKey, "test001-key");
    assert.deepEqual(captured.args, [
      "--search",
      "-c", 'model_providers.codex.base_url="https://test001.example.com"',
      "-c", 'model_providers.codex.env_key="CODEX_TOOLS_PROFILE_API_KEY"',
      "hello",
    ]);
    await assert.rejects(
      () => runCcs(["dist/bin/cx.js", "run", "missing"], home, env),
      /profile not found: missing/,
    );
  } finally {
    await rm(binDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs sync stays additive when no existing values are selected", async () => {
  const home = await writeSyncFixture([
    'model_provider = "codex"',
    'model = "local-model"',
    'local_only = true',
    '',
    '[model_providers.codex]',
    'base_url = "https://local.example"',
    '',
    '[features]',
    'goals = false',
    '',
  ].join("\n"));
  try {
    const { output } = await runCcsInteractive(["sync"], home, [
      ["Replace which existing values with the template?", KEYS.enter],
      ["Apply changes?", "yes\n"],
    ]);
    const config = await readFile(join(home, ".codex", "config.toml"), "utf8");
    assert.equal("toggle" in JSON.parse(await readFile(join(home, ".config", "codex-tools", "profiles.json"), "utf8")), false);
    assert.match(output, /model\s+"local-model" -> "gpt-5\.6-sol"/);
    assert.match(output, /features\.goals\s+false -> true/);
    assert.doesNotMatch(output, /model_providers\.codex\.base_url\s+"https/);
    assert.match(output, /^different:\s+\d+\s+.*model.*features\.goals/m);
    assert.match(output, /^update:\s+\d+\s+/m);
    assert.match(config, /model = "local-model"/);
    assert.match(config, /goals = false/);
    assert.match(config, /local_only = true/);
    assert.match(config, /personality = "pragmatic"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs sync replaces only the selected existing values and applies its preview", async () => {
  const home = await writeSyncFixture([
    'model_provider = "codex"',
    'model = "local-model"',
    'local_only = true',
    '',
    '[model_providers.codex]',
    'base_url = "https://local.example"',
    'wire_api = "chat"',
    '',
    '[features]',
    'goals = false',
    '',
  ].join("\n"));
  try {
    const { output } = await runCcsInteractive(["sync"], home, [
      ["Replace which existing values with the template?", `${KEYS.space}${KEYS.down}${KEYS.space}${KEYS.enter}`],
      ["Apply changes?", "yes\n"],
    ]);
    const config = await readFile(join(home, ".codex", "config.toml"), "utf8");
    const updateLine = output.split("\n").find((line) => line.startsWith("update:"));
    assert.ok(updateLine);
    assert.match(updateLine, /(?:^|, |\s)model(?:,|$)/);
    assert.match(config, /model = "gpt-5\.6-sol"/);
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /goals = false/);
    assert.match(config, /base_url = "https:\/\/local\.example"/);
    assert.match(config, /local_only = true/);

    const all = await writeSyncFixture('model_provider = "codex"\nmodel = "local-model"\n\n[features]\ngoals = false\n');
    try {
      await runCcsInteractive(["sync"], all, [
        ["Replace which existing values with the template?", `a${KEYS.enter}`],
        ["Apply changes?", "yes\n"],
      ]);
      const replaced = await readFile(join(all, ".codex", "config.toml"), "utf8");
      assert.match(replaced, /model = "gpt-5\.6-sol"/);
      assert.match(replaced, /goals = true/);
    } finally {
      await rm(all, { recursive: true, force: true });
    }
    await assert.rejects(() => runCcsDirect(["sync", "--replace", "all"], home), /usage: ccs sync/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs sync keeps model_provider unselectable while proxy state exists", async () => {
  const home = await writeSyncFixture('model_provider = "other"\nmodel = "local-model"\n');
  try {
    const stateRoot = join(home, ".cache", "codex-tools", "proxy");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "proxy.json"), "{}", "utf8");
    const { output } = await runCcsInteractive(["sync"], home, [
      ["Replace which existing values with the template?", `a${KEYS.enter}`],
      ["Apply changes?", "yes\n"],
    ]);
    assert.match(output, /model_provider\s+\(proxy installed\)/);
    const config = await readFile(join(home, ".codex", "config.toml"), "utf8");
    assert.match(config, /model_provider = "other"/);
    assert.match(config, /model = "gpt-5\.6-sol"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs sync summaries compare TOML values semantically", async () => {
  const template = await readFile(join(repoRoot, "config", "codex-config.toml"), "utf8");
  const config = template.replace('model_provider = "codex"', "model_provider = 'codex' # local style");
  const home = await writeSyncFixture(config);
  try {
    const { output } = await runCcsInteractive(["sync"], home, [["Apply changes?", "yes\n"]]);
    assert.doesNotMatch(output, /Replace which existing values/);
    assert.match(output, /^different:\s+0$/m);
    assert.match(output, /^update:\s+0$/m);
    assert.match(await readFile(join(home, ".codex", "config.toml"), "utf8"), /model_provider = 'codex' # local style/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs remove picks a profile, previews the current switch, and writes after yes", async () => {
  const home = await writeProfiles({
    profiles: {
      test001: { baseURL: "https://test001.example.test", apiKey: "test001-key-123456" },
      test002: { baseURL: "https://test002.example.test", apiKey: "test002-key-123456" },
    },
    current: "test001",
  });
  const profilesFile = join(home, ".config", "codex-tools", "profiles.json");
  try {
    await assert.rejects(() => runCcsDirect(["remove"], home), /ccs remove requires an interactive terminal/);
    await assert.rejects(() => runCcsDirect(["remove", "test001"], home), /usage: ccs remove/);

    const declined = await runCcsInteractive(["remove"], home, [
      ["Remove which profile?", KEYS.enter],
      ["Apply changes?", "no\n"],
    ]);
    assert.match(declined.output, /test001\s+https:\/\/test001\.example\.test\s+\(current\)/);
    assert.match(declined.output, /current:\s+test001 -> test002/);
    assert.equal(declined.output.includes("test001-key-123456"), false);
    assert.ok(JSON.parse(await readFile(profilesFile, "utf8")).profiles.test001);

    await runCcsInteractive(["remove"], home, [
      ["Remove which profile?", KEYS.enter],
      ["Apply changes?", "yes\n"],
    ]);
    const profiles = JSON.parse(await readFile(profilesFile, "utf8"));
    assert.deepEqual(Object.keys(profiles.profiles), ["test002"]);
    assert.equal(profiles.current, "test002");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs use defaults to the previously used profile, switches on enter, and records the switch", async () => {
  const home = await writeProfiles({
    profiles: {
      test001: { baseURL: "https://test001.example.test", apiKey: "test001-key-123456" },
      test002: { baseURL: "https://test002.example.test", apiKey: "test002-key-123456" },
      local: { baseURL: "https://local.example.test", apiKey: "local-key-123456" },
      empty: { baseURL: "https://empty.example.test", apiKey: "" },
    },
    current: "test001",
  });
  const usagePath = join(home, ".cache", "codex-tools", "profile-usage.json");
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), 'model_provider = "codex"\n\n[model_providers.codex]\nbase_url = "https://test001.example.test"\n', "utf8");
    await mkdir(dirname(usagePath), { recursive: true });
    await writeFile(usagePath, JSON.stringify({
      version: 1,
      profiles: {
        test001: { requested_at: ago(60_000), switched_at: ago(3 * 86_400_000) },
        test002: { launched_at: ago(5 * 3_600_000) },
        local: { switched_at: ago(10 * 86_400_000) },
      },
    }), "utf8");

    const list = await runCcsDirect(["list"], home);
    assert.match(list, /input .*used 1m ago\s+switched 3d ago/);
    assert.match(list, /local .*used -\s+switched 10d ago/);
    const plain = await runCcsDirect(["use"], home);
    assert.match(plain, /run in an interactive terminal to switch/);
    await assert.rejects(() => runCcsDirect(["use", "test002"], home), /usage: ccs use/);

    const { output } = await runCcsInteractive(["use"], home, [["Switch to which profile?", KEYS.enter]]);
    assert.match(output, /test001\s+current · used 1m ago · switched 3d ago/);
    assert.match(output, /empty\s+\(missing apiKey\)/);
    assert.match(output, /✔ Switch to which profile\? · test002/);
    assert.match(output, /current:\s+test001 -> test002/);
    assert.equal(JSON.parse(await readFile(join(home, ".config", "codex-tools", "profiles.json"), "utf8")).current, "test002");
    assert.match(await readFile(join(home, ".codex", "config.toml"), "utf8"), /base_url = "https:\/\/test002\.example\.test"/);
    assert.equal(JSON.parse(await readFile(join(home, ".codex", "auth.json"), "utf8")).OPENAI_API_KEY, "test002-key-123456");
    const usage = JSON.parse(await readFile(usagePath, "utf8"));
    assert.ok(Date.now() - Date.parse(usage.profiles.test002.switched_at) < 60_000);
    assert.ok(Date.now() - Date.parse(usage.profiles.test002.launched_at) > 4 * 3_600_000);

    const unchanged = await runCcsInteractive(["use"], home, [["Switch to which profile?", `${KEYS.down}${KEYS.enter}`]]);
    assert.match(unchanged.output, /✔ Switch to which profile\? · test002/);
    assert.match(unchanged.output, /no changes\./);

    await assert.rejects(
      () => runCcs(["dist/bin/ccs.js", "toggle"], home, { XDG_CACHE_HOME: join(home, ".cache") }),
      /unknown command: toggle/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ccs add edits a chosen profile or creates a new one with masked keys", async () => {
  const home = await writeProfiles({
    profiles: { test001: { baseURL: "https://test001.example.test", apiKey: "test001-key-123456" } },
    current: "test001",
  });
  const profilesFile = join(home, ".config", "codex-tools", "profiles.json");
  try {
    await assert.rejects(() => runCcsDirect(["add"], home), /ccs add requires an interactive terminal/);
    await assert.rejects(() => runCcsDirect(["add", "test001"], home), /usage: ccs add/);

    const edited = await runCcsInteractive(["add"], home, [
      ["Add or edit which profile?", `${KEYS.down}${KEYS.enter}`],
      ["baseURL", KEYS.enter],
      ["apiKey", KEYS.enter],
      ["Provider API", `${KEYS.down}${KEYS.enter}`],
      ["Apply changes?", "yes\n"],
    ]);
    assert.equal(edited.output.includes("test001-key-123456"), false);
    assert.deepEqual(JSON.parse(await readFile(profilesFile, "utf8")).profiles.test001, {
      baseURL: "https://test001.example.test",
      apiKey: "test001-key-123456",
      routeConversion: { enabled: true },
    });

    const secret = "local-secret-abcdef";
    const created = await runCcsInteractive(["add"], home, [
      ["Add or edit which profile?", KEYS.enter],
      ["Profile name", `test001${KEYS.enter}`],
      ["profile test001 exists", `${KEYS.backspace.repeat(5)}local${KEYS.enter}`],
      ["baseURL", `https://local.example.test${KEYS.enter}`],
      ["apiKey", `${secret}${KEYS.enter}`],
      ["Provider API", KEYS.enter],
      ["Apply changes?", "yes\n"],
    ]);
    assert.equal(created.output.includes(secret), false);
    const profiles = JSON.parse(await readFile(profilesFile, "utf8"));
    assert.deepEqual(profiles.profiles.local, { baseURL: "https://local.example.test", apiKey: secret });
    assert.equal(profiles.current, "test001");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function runTool(tool, args) {
  const home = await mkdtemp(join(tmpdir(), "ccs-version-home-"));
  try {
    return await runCcs([`dist/bin/${tool}.js`, ...args], home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function createFakeCodex(source) {
  const binDir = await mkdtemp(join(tmpdir(), "fake-codex-bin-"));
  const codexPath = join(binDir, "codex");
  await writeFile(codexPath, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(codexPath, 0o755);
  return binDir;
}

async function writeSyncFixture(config) {
  const home = await mkdtemp(join(tmpdir(), "ccs-sync-home-"));
  const profiles = JSON.parse(await readFile(join(repoRoot, "config", "ccs-profiles.json"), "utf8"));
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".config", "codex-tools"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), config, "utf8");
  await writeFile(
    join(home, ".codex", "AGENTS.md"),
    await readFile(join(repoRoot, "config", "codex-agents.md"), "utf8"),
    "utf8",
  );
  await writeFile(
    join(home, ".config", "codex-tools", "profiles.json"),
    JSON.stringify({ ...profiles, toggle: ["test001", "test002"] }, null, 2),
    "utf8",
  );
  return home;
}

function runCcs(args, home, env = {}) {
  return execNodeStdout(args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      ...env,
    },
  });
}

async function runCcsDirect(args, home, env = {}, isTTY = false) {
  const values = {
    HOME: home,
    NO_COLOR: "1",
    ...env,
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await captureStdout(() => runCcsCommand(args), { isTTY });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function runCcsInteractive(args, home, steps, env = {}) {
  const values = { HOME: home, NO_COLOR: "1", XDG_CACHE_HOME: join(home, ".cache"), ...env };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await runInteractive(() => runCcsCommand(args), steps);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function writeProfiles(profiles) {
  const home = await mkdtemp(join(tmpdir(), "ccs-home-"));
  const configDir = join(home, ".config", "codex-tools");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  return home;
}

async function writeProxyStateForRunTest(home, stateRoot, proxyPort) {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "proxy.json"), JSON.stringify({
    state_schema_version: 4,
    installed_at: "2026-01-01T00:00:00.000Z",
    codex_config_path: join(home, ".codex", "config.toml"),
    provider_name: "codex",
    original_base_url: "https://test002.example.com",
    proxy_base_url: `http://127.0.0.1:${proxyPort}`,
    mode: "passthrough",
    status_retry: {
      enabled: false,
      total_window_ms: 3_600_000,
      backoff_base_ms: 1000,
      backoff_max_ms: 30_000,
    },
    latency_guard: {
      enabled: false,
      first_progress_timeout_ms: 0,
      first_progress_action: "return_502",
      total_timeout_ms: 0,
    },
    listen_host: "127.0.0.1",
    listen_port: proxyPort,
    profile_order: ["test002"],
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
  }, null, 2), "utf8");
}

async function replaceJson(path, value) {
  const temporaryPath = `${path}.test.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  await rename(temporaryPath, path);
}

async function writeUsageTopState(home, entries) {
  const cacheDir = join(home, ".cache", "codex-tools");
  await mkdir(cacheDir, { recursive: true });
  await replaceJson(join(cacheDir, "ccs-top-state.json"), {
    version: 1,
    active: true,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    entries,
  });
}

async function waitForFileMatch(path, pattern) {
  const deadline = Date.now() + 5000;
  let lastValue = "";
  while (Date.now() < deadline) {
    try {
      lastValue = await readFile(path, "utf8");
      if (pattern.test(lastValue)) {
        return;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${path} to match ${pattern}; last value: ${lastValue}`);
}

async function writeModelPriceCache(home, models, { patterns = [], providers = [] } = {}) {
  const configDir = join(home, ".config", "codex-tools");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "model-prices.json"), JSON.stringify({
    source: "test",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    patterns,
    providers,
    models,
  }, null, 2), "utf8");
}

function modelPriceFixture(kind) {
  return {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
    ...(kind === "ok" ? { cache_read_input_token_cost: 0.0000001 } : {}),
  };
}

function modelPriceValueFixture(inputCostPerToken, provider = "openai") {
  return {
    litellm_provider: provider,
    input_cost_per_token: inputCostPerToken,
    output_cost_per_token: inputCostPerToken * 2,
    cache_read_input_token_cost: inputCostPerToken / 10,
  };
}

async function writeCodexCostFixture(home, model, usages = [{ model, test001: 100, output: 10 }]) {
  const timestampMs = Date.parse("2026-01-01T12:00:00.000Z");
  const codexDir = join(home, ".codex");
  const sessionsDir = join(codexDir, "sessions", "2026", "01", "01");
  await mkdir(sessionsDir, { recursive: true });
  const rolloutPath = join(sessionsDir, "rollout-fixture.jsonl");
  await writeFile(rolloutPath, `${[
    taskStarted(uuidV7At(timestampMs), timestampMs),
    turnContext(uuidV7At(timestampMs + 1), "/tmp/ccs-cost-project", model),
    ...usages.map((usage, index) => tokenCount(
      new Date(timestampMs + 2000 + index * 1000).toISOString(),
      usage.model,
      usage,
    )),
  ].map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  await sqliteRun(join(codexDir, "state.sqlite"), `
    create table threads (
      id text primary key,
      rollout_path text not null,
      created_at integer not null,
      updated_at integer not null,
      cwd text not null,
      model text,
      created_at_ms integer,
      updated_at_ms integer
    );
    insert into threads values (
      'thread-fixture',
      '${sqlString(rolloutPath)}',
      ${Math.floor(timestampMs / 1000)},
      ${Math.floor((timestampMs + 120000) / 1000)},
      '/tmp/ccs-cost-project',
      '${sqlString(model)}',
      ${timestampMs},
      ${timestampMs + 120000}
    );
  `);
}

function taskStarted(turnId, timestampMs) {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turnId,
      started_at: Math.floor(timestampMs / 1000),
    },
  };
}

function turnContext(turnId, cwd, model) {
  return {
    timestamp: new Date(uuidV7TimestampMs(turnId)).toISOString(),
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd,
      model,
    },
  };
}

function tokenCount(timestamp, model, usage) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      model,
      info: {
        total_token_usage: tokenUsage(usage),
        last_token_usage: tokenUsage(usage),
      },
    },
  };
}

function tokenUsage(usage) {
  return {
    input_tokens: usage.input,
    cached_input_tokens: usage.cached ?? 0,
    output_tokens: usage.output,
    reasoning_output_tokens: usage.reasoning ?? 0,
    total_tokens: usage.input + usage.output,
  };
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

async function waitForJsonOk(url) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

function sqliteRun(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = execFile("sqlite3", [dbPath], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolve();
    });
    child.stdin?.end(sql);
  });
}

function sqlString(value) {
  return value.replaceAll("'", "''");
}

function uuidV7At(timestampMs) {
  const prefix = Math.floor(timestampMs).toString(16).padStart(12, "0");
  return `${prefix.slice(0, 8)}-${prefix.slice(8, 12)}-7000-8000-000000000000`;
}

function uuidV7TimestampMs(value) {
  return Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16);
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
