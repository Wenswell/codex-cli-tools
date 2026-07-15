import assert from "node:assert/strict";
import test from "node:test";
import {
  ProxyRetryBudget,
  decideProxyPolicy,
  matchesReasoningTokens,
  parseRetryAfter,
  retryDelayMs,
  waitForProxyRetry,
} from "../dist/lib/ccs-proxy-policy.js";

const actions = {
  timeout: "retry_then_502",
  capacity: "retry_then_pass_through",
  http429: "pass_through",
};

test("proxy policy prioritizes observed facts and maps all actions", () => {
  const allFacts = { timeout: true, capacity: true, status: 429, reasoningMatched: true };
  assert.equal(decideProxyPolicy(allFacts, actions, 3).trigger, "timeout");
  assert.equal(decideProxyPolicy({ ...allFacts, timeout: false }, actions, 3).trigger, "capacity");
  assert.equal(decideProxyPolicy({ ...allFacts, timeout: false, capacity: false }, actions, 3).trigger, "http_429");
  assert.equal(decideProxyPolicy({ timeout: false, capacity: false, status: 200, reasoningMatched: true }, actions, 3).trigger, "reasoning");
  assert.equal(decideProxyPolicy({ timeout: false, capacity: false, status: 503, reasoningMatched: false }, actions, 3).trigger, "pass_through");

  for (const action of ["pass_through", "return_502", "retry_then_pass_through", "retry_then_502"]) {
    const decision = decideProxyPolicy(
      { timeout: false, capacity: true, status: 429, reasoningMatched: false },
      { ...actions, capacity: action },
      1,
    );
    assert.equal(decision.action, action);
    assert.equal(decision.retry, action.startsWith("retry_then_"));
    assert.equal(decision.exhaustedAction, action.endsWith("502") || action === "return_502" ? "return_502" : "pass_through");
  }

  assert.equal(matchesReasoningTokens(516, [516, 1034, 1552]), true);
  assert.equal(matchesReasoningTokens(2070, [516, 1034, 1552]), false);
  const budget = new ProxyRetryBudget(3);
  assert.equal(budget.consume(), true);
  assert.equal(budget.used, 1);
  assert.equal(budget.remaining, 2);
});

test("Retry-After parsing, jitter, abort, and deadline are bounded", async () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  assert.deepEqual(parseRetryAfter("1.5", now), { kind: "valid", delayMs: 1500 });
  assert.deepEqual(parseRetryAfter("Wed, 15 Jul 2026 00:00:02 GMT", now), { kind: "valid", delayMs: 2000 });
  assert.deepEqual(parseRetryAfter("61", now), { kind: "exceeds_limit", delayMs: 61000 });
  assert.deepEqual(parseRetryAfter("invalid", now), { kind: "missing_or_invalid" });
  assert.equal(retryDelayMs(2, () => 0), 0);
  assert.equal(retryDelayMs(2, () => 1), 4000);

  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await waitForProxyRetry(10, aborted.signal, null), "aborted");
  assert.equal(await waitForProxyRetry(10, new AbortController().signal, Date.now() - 1), "deadline");
  assert.equal(await waitForProxyRetry(0, new AbortController().signal, null), "ready");
});
