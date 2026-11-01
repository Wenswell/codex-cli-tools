import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRetryAfter,
  retryDelayMs,
  waitForProxyRetry,
} from "../dist/lib/ccs-proxy-policy.js";

test("Retry-After parsing, jitter, abort, and deadline are bounded", async () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  assert.deepEqual(parseRetryAfter("1.5", now), { kind: "valid", delayMs: 1500 });
  assert.deepEqual(parseRetryAfter("Wed, 15 Jul 2026 00:00:02 GMT", now), { kind: "valid", delayMs: 2000 });
  assert.deepEqual(parseRetryAfter("61", now), { kind: "exceeds_limit", delayMs: 61000 });
  assert.deepEqual(parseRetryAfter("invalid", now), { kind: "missing_or_invalid" });
  assert.equal(retryDelayMs(2, 1000, 30_000, () => 0), 0);
  assert.equal(retryDelayMs(2, 1000, 30_000, () => 1), 4000);
  assert.equal(retryDelayMs(20, 250, 5000, () => 1), 5000);
  assert.deepEqual(parseRetryAfter("120", now, 180_000), { kind: "valid", delayMs: 120_000 });

  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await waitForProxyRetry(10, aborted.signal, null), "aborted");
  assert.equal(await waitForProxyRetry(10, new AbortController().signal, Date.now() - 1), "deadline");
  assert.equal(await waitForProxyRetry(0, new AbortController().signal, null), "ready");
});
