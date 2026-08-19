import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CIMG_DEFAULT_SIZES,
  CIMG_MODEL,
  CIMG_SIZES,
  buildEndpoint,
  buildRequestBody,
  parseArgs,
  runCimg,
} from "../dist/commands/cimg.js";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=", "base64");
const profiles = async () => ({
  current: "test",
  profiles: {
    test: { baseURL: "https://images.example.test", apiKey: "secret-key" },
  },
});

test("cimg keeps the PixAI ratio, standard-size, and quality contract", () => {
  assert.deepEqual(Object.keys(CIMG_SIZES), ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21"]);
  assert.equal(CIMG_DEFAULT_SIZES["16:9"], "1792x1008");
  assert.equal(CIMG_DEFAULT_SIZES["9:16"], "1008x1792");
  assert.equal(parseArgs(["-p", "scene", "--ratio", "16:9"]).size, "1792x1008");
  assert.throws(
    () => parseArgs(["-p", "scene", "--ratio", "16:9", "--size", "1024x1024"]),
    /invalid size for 16:9/,
  );
  assert.throws(() => parseArgs(["-p", "scene", "--quality", "ultra"]), /invalid quality/);
});

test("cimg builds one fixed-model PNG generation request", () => {
  assert.equal(buildEndpoint("https://images.example.test///"), "https://images.example.test/v1/images/generations");
  assert.throws(() => buildEndpoint("https://token@images.example.test"), /must not contain credentials/);
  assert.throws(() => buildEndpoint("https://images.example.test?key=secret"), /must not contain credentials/);
  assert.deepEqual(buildRequestBody({ prompt: "scene", size: "1024x1024", quality: "low" }), {
    prompt: "scene",
    model: CIMG_MODEL,
    size: "1024x1024",
    quality: "low",
    n: 1,
    output_format: "png",
  });
});

test("cimg confirmation decline has no request, image, or request log events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cimg-decline-"));
  const output = join(directory, "declined.png");
  const events = [];
  let requests = 0;
  try {
    await runCimg(["-p", "private scene", "-o", output], {
      profiles,
      confirm: async () => false,
      fetch: async () => {
        requests += 1;
        throw new Error("unexpected request");
      },
      appendEvent: async (event) => events.push(event),
    });
    assert.equal(requests, 0);
    assert.deepEqual(events, []);
    await assert.rejects(() => readFile(output), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cimg logs started before fetch and succeeded after writing one PNG", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cimg-success-"));
  const output = join(directory, "generated.png");
  const events = [];
  const times = [
    new Date("2026-08-19T09:00:00.000Z"),
    new Date("2026-08-19T09:00:01.000Z"),
    new Date("2026-08-19T09:00:03.500Z"),
  ];
  try {
    await runCimg(["-p", "private scene", "--quality", "low", "-o", output], {
      profiles,
      confirm: async () => true,
      now: () => times.shift() ?? new Date("2026-08-19T09:00:03.500Z"),
      requestId: () => "request-1",
      appendEvent: async (event) => events.push(event),
      fetch: async (url, init) => {
        assert.equal(events.length, 1);
        assert.equal(events[0].event, "started");
        assert.equal(url, "https://images.example.test/v1/images/generations");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer secret-key");
        assert.deepEqual(JSON.parse(init.body), {
          prompt: "private scene",
          model: "gpt-image-2",
          size: "1024x1024",
          quality: "low",
          n: 1,
          output_format: "png",
        });
        return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), { status: 200 });
      },
    });

    assert.deepEqual(await readFile(output), pngBytes);
    assert.deepEqual(events.map((event) => event.event), ["started", "succeeded"]);
    assert.equal(events[0].request_id, "request-1");
    assert.equal(events[1].request_id, "request-1");
    assert.equal(events[1].result.duration_ms, 2500);
    assert.equal(events[1].result.http_status, 200);
    assert.equal(events[1].result.output_path, output);
    assert.equal(events[1].result.output_width, 1);
    assert.equal(events[1].result.output_height, 1);
    assert.equal(JSON.stringify(events).includes("private scene"), false);
    assert.equal(JSON.stringify(events).includes("secret-key"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cimg logs a failed terminal event for an API error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cimg-failure-"));
  const output = join(directory, "failed.png");
  const events = [];
  try {
    await assert.rejects(
      () => runCimg(["-p", "scene", "-o", output], {
        profiles,
        confirm: async () => true,
        requestId: () => "request-2",
        appendEvent: async (event) => events.push(event),
        fetch: async () => new Response(JSON.stringify({ error: { code: "invalid_request", message: "bad size" } }), { status: 400 }),
      }),
      /bad size/,
    );
    assert.deepEqual(events.map((event) => event.event), ["started", "failed"]);
    assert.equal(events[1].request_id, "request-2");
    assert.equal(events[1].result.http_status, 400);
    assert.deepEqual(events[1].result.error, { code: "invalid_request", message: "image request failed with HTTP 400" });
    await assert.rejects(() => readFile(output), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
