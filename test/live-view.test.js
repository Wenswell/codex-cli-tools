import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pinLiveViewFooter, runLiveView } from "../dist/lib/live-view.js";

test("live view footer fills short frames and preserves overflowing body lines", () => {
  assert.deepEqual(pinLiveViewFooter(["header", "body", "footer"], 6), [
    "header",
    "body",
    "",
    "",
    "",
    "footer",
  ]);
  assert.deepEqual(pinLiveViewFooter(["header", "one", "two", "three", "footer"], 3), [
    "header",
    "one",
    "two",
    "three",
    "footer",
  ]);
  assert.deepEqual(pinLiveViewFooter(["header", "footer"], undefined), ["header", "footer"]);
});

test("live view Ctrl-C restores raw TTY state and exits", async () => {
  const stdin = process.stdin;
  const keys = ["isTTY", "setRawMode", "resume", "pause"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(stdin, key)]));
  const rawModes = [];
  let resumed = 0;
  let paused = 0;
  const initialDataListeners = stdin.listenerCount("data");
  const stream = new PassThrough();
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  Object.defineProperty(stream, "isTTY", { configurable: true, value: true });

  try {
    Object.defineProperties(stdin, {
      isTTY: { configurable: true, value: true },
      setRawMode: { configurable: true, value: (enabled) => { rawModes.push(enabled); } },
      resume: { configurable: true, value: () => { resumed += 1; return stdin; } },
      pause: { configurable: true, value: () => { paused += 1; return stdin; } },
    });

    const running = runLiveView(
      () => ["frame"],
      {
        stream,
        enabled: true,
        intervalMs: 60_000,
        onKey: () => { throw new Error("Ctrl-C must be handled by live view"); },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    stdin.emit("data", Buffer.from([3]));
    await running;

    assert.deepEqual(rawModes, [true, false]);
    assert.equal(resumed >= 1, true);
    assert.equal(paused, 1);
    assert.equal(stdin.listenerCount("data"), initialDataListeners);
    assert.match(output, /\u001b\[\?1049h\u001b\[\?25l/);
    assert.match(output, /\u001b\[\?25h\u001b\[\?1049l/);
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) {
        Object.defineProperty(stdin, key, descriptor);
      } else {
        delete stdin[key];
      }
    }
  }
});
