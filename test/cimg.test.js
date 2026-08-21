import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CIMG_DEFAULT_SIZES,
  CIMG_MODEL,
  CIMG_PROGRESS_INTERVAL_MS,
  CIMG_SIZES,
  CimgCanceledError,
  buildEndpoint,
  buildEditRequestBody,
  buildRequestBody,
  cimgDefaultOutputDir,
  parseArgs,
  runCimg,
} from "../dist/commands/cimg.js";
import { captureStdout } from "./helpers/terminal.js";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=", "base64");
const profiles = async () => ({
  current: "test",
  profiles: {
    test: { baseURL: "https://images.example.test", apiKey: "secret-key" },
  },
});

test("cimg no-argument output shows active state and compact commands", async () => {
  const output = await captureStdout(() => runCimg([], { profiles }));
  assert.match(output, /^profile:\s+test$/m);
  assert.match(output, /^api:\s+https:\/\/images\.example\.test$/m);
  assert.match(output, /^model:\s+gpt-image-2$/m);
  assert.match(output, /^defaults:\s+1:1 1024x1024 auto$/m);
  assert.match(output, /^output:\s+~\/Pictures\/cimg$/m);
  assert.match(output, /^commands: cimg -p TEXT \[-i FILE \.\.\.\] \| version\|-v \| --help$/m);
});

test("cimg defaults images to the user Pictures directory and keeps explicit output paths", () => {
  const now = new Date("2026-08-19T09:00:00.000Z");
  assert.equal(
    parseArgs(["-p", "scene"], now).outputPath,
    join(cimgDefaultOutputDir(), "image-20260819-090000-000.png"),
  );
  assert.equal(parseArgs(["-p", "scene", "-o", "custom.png"], now).outputPath, join(process.cwd(), "custom.png"));
});

test("cimg help documents the default image directory", async () => {
  const output = await captureStdout(() => runCimg(["--help"]));
  assert.match(output, /default: ~\/Pictures\/cimg\/image-<timestamp>\.png/);
  assert.match(output, /-i, --image FILE input PNG, JPEG, or WebP; repeat for multiple reference images/);
  assert.match(output, /one input edits the source; repeat -i\/--image for ordered reference images/);
  assert.match(output, /accepts PNG, JPEG, or WebP; at most 16 files, each smaller than 50 MiB/);
  assert.match(output, /masked editing is not part of this command/);
  assert.match(output, /preview is shown before exact yes confirmation; Ctrl-C cancels an active request/);
  assert.match(output, /elapsed time refreshes every 10 seconds in a terminal; Ctrl-C cancels the request/);
});

test("cimg accepts ordered repeatable image inputs and rejects unsupported or excessive inputs", () => {
  const parsed = parseArgs(["-p", "combine", "-i", "first.png", "--image", "second.JPG"]);
  assert.deepEqual(parsed.inputPaths, [join(process.cwd(), "first.png"), join(process.cwd(), "second.JPG")]);
  assert.throws(() => parseArgs(["-p", "edit", "-i", "source.gif"]), /unsupported input image/);
  assert.throws(
    () => parseArgs(["-p", "combine", ...Array.from({ length: 17 }, (_, index) => ["-i", `${index}.png`]).flat()]),
    /too many input images: 17; maximum is 16/,
  );
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
  assert.equal(CIMG_PROGRESS_INTERVAL_MS, 10_000);
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

test("cimg builds the official single-image and multi-image edit forms", () => {
  assert.equal(buildEndpoint("https://images.example.test///", "edit"), "https://images.example.test/v1/images/edits");
  const args = { prompt: "combine", size: "1024x1024", quality: "high" };
  const first = { name: "first.png", mediaType: "image/png", bytes: Buffer.from("first") };
  const second = { name: "second.jpg", mediaType: "image/jpeg", bytes: Buffer.from("second") };

  const single = buildEditRequestBody(args, [first]);
  assert.equal(single.getAll("image").length, 1);
  assert.equal(single.getAll("image[]").length, 0);

  const multiple = buildEditRequestBody(args, [first, second]);
  const images = multiple.getAll("image[]");
  assert.equal(images.length, 2);
  assert.deepEqual(images.map((image) => image.name), ["first.png", "second.jpg"]);
  assert.deepEqual(images.map((image) => image.type), ["image/png", "image/jpeg"]);
  assert.equal(multiple.get("prompt"), "combine");
  assert.equal(multiple.get("model"), CIMG_MODEL);
  assert.equal(multiple.get("size"), "1024x1024");
  assert.equal(multiple.get("quality"), "high");
  assert.equal(multiple.get("n"), "1");
  assert.equal(multiple.get("output_format"), "png");
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
    const terminalOutput = await captureStdout(
      () => runCimg(["-p", "private scene", "--quality", "low", "-o", output], {
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
      }),
      { isTTY: true },
    );

    assert.deepEqual(await readFile(output), pngBytes);
    assert.match(terminalOutput, /\r\u001b\[2Kgenerating: \d+ms 1024x1024 low Ctrl-C to cancel/);
    assert.match(terminalOutput, /\r\u001b\[2Kresult:/);
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

test("cimg sends ordered reference images to the edits endpoint and logs only input facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cimg-edit-"));
  const firstPath = join(directory, "first.png");
  const secondPath = join(directory, "second.jpg");
  const output = join(directory, "edited.png");
  const firstBytes = Buffer.from("first-image");
  const secondBytes = Buffer.from("second-image");
  const events = [];
  try {
    await writeFile(firstPath, firstBytes);
    await writeFile(secondPath, secondBytes);
    const terminalOutput = await captureStdout(() => runCimg([
      "-p", "combine references", "-i", firstPath, "--image", secondPath, "-o", output,
    ], {
      profiles,
      confirm: async () => true,
      requestId: () => "request-edit",
      appendEvent: async (event) => events.push(event),
      fetch: async (url, init) => {
        assert.equal(url, "https://images.example.test/v1/images/edits");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer secret-key");
        assert.equal(new Headers(init.headers).get("content-type"), null);
        assert.ok(init.body instanceof FormData);
        assert.equal(init.body.getAll("image").length, 0);
        const images = init.body.getAll("image[]");
        assert.deepEqual(images.map((image) => image.name), ["first.png", "second.jpg"]);
        assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), firstBytes);
        assert.deepEqual(Buffer.from(await images[1].arrayBuffer()), secondBytes);
        assert.equal(init.body.get("prompt"), "combine references");
        return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), { status: 200 });
      },
    }));

    assert.deepEqual(await readFile(output), pngBytes);
    assert.match(terminalOutput, /^mode:\s+edit$/m);
    assert.match(terminalOutput, /^editing: 1024x1024 auto$/m);
    assert.match(terminalOutput, /^result:\s+edited$/m);
    assert.deepEqual(events.map((event) => event.event), ["started", "succeeded"]);
    assert.equal(events[0].version, 2);
    assert.equal(events[0].config.mode, "edit");
    assert.deepEqual(events[0].inputs.map((input) => input.media_type), ["image/png", "image/jpeg"]);
    assert.deepEqual(events[0].inputs.map((input) => input.bytes), [firstBytes.length, secondBytes.length]);
    assert.equal(JSON.stringify(events).includes(firstPath), false);
    assert.equal(JSON.stringify(events).includes(secondPath), false);
    assert.equal(JSON.stringify(events).includes("combine references"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cimg stops before the edit request when an input changes after preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cimg-edit-changed-"));
  const input = join(directory, "source.png");
  const output = join(directory, "edited.png");
  const events = [];
  let requests = 0;
  try {
    await writeFile(input, Buffer.from("before"));
    await assert.rejects(() => runCimg(["-p", "edit", "-i", input, "-o", output], {
      profiles,
      confirm: async () => {
        await writeFile(input, Buffer.from("after"));
        return true;
      },
      appendEvent: async (event) => events.push(event),
      fetch: async () => {
        requests += 1;
        throw new Error("unexpected request");
      },
    }), /input image changed after preview/);
    assert.equal(requests, 0);
    assert.deepEqual(events, []);
    await assert.rejects(() => readFile(output), /ENOENT/);
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

test("cimg Ctrl-C aborts the request and logs a canceled terminal event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cimg-cancel-"));
  const output = join(directory, "canceled.png");
  const events = [];
  const existingSigintListeners = new Set(process.listeners("SIGINT"));
  try {
    await assert.rejects(
      () => captureStdout(
        () => runCimg(["-p", "scene", "-o", output], {
          profiles,
          confirm: async () => true,
          requestId: () => "request-canceled",
          appendEvent: async (event) => events.push(event),
          fetch: async (_url, init) => await new Promise((resolve, reject) => {
            const signal = init.signal;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            const cancelRequest = process.listeners("SIGINT").find((listener) => !existingSigintListeners.has(listener));
            assert.ok(cancelRequest);
            setImmediate(() => cancelRequest());
          }),
        }),
        { isTTY: true },
      ),
      CimgCanceledError,
    );
    assert.deepEqual(events.map((event) => event.event), ["started", "failed"]);
    assert.equal(events[1].request_id, "request-canceled");
    assert.equal(events[1].result.http_status, null);
    assert.deepEqual(events[1].result.error, {
      code: "canceled",
      message: "image request canceled by user",
    });
    await assert.rejects(() => readFile(output), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
