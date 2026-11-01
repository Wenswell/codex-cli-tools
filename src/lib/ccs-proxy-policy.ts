// Status retry is the only proxy policy: it retries a listed status or a Capacity error and then
// passes the final upstream response through.
export type ProxyPolicyAction = "retry_then_pass_through";
export type ProxyPolicyTrigger = "capacity" | "http_429" | "http_503";

type RetryAfterResult =
  | { kind: "missing_or_invalid" }
  | { kind: "valid"; delayMs: number }
  | { kind: "exceeds_limit"; delayMs: number };

const RETRY_AFTER_MAX_MS = 60_000;
const RETRY_BACKOFF_MAX_MS = 30_000;
const NODE_TIMER_MAX_MS = 2_147_483_647;

export function parseRetryAfter(value: string | null, nowMs = Date.now(), maxDelayMs = RETRY_AFTER_MAX_MS): RetryAfterResult {
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0 || maxDelayMs > NODE_TIMER_MAX_MS) {
    throw new Error("Retry-After maximum must be within the Node timer range");
  }
  if (!value) {
    return { kind: "missing_or_invalid" };
  }
  const text = value.trim();
  let delayMs: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    delayMs = Math.ceil(seconds * 1000);
  } else {
    if (/^[+-]/.test(text)) return { kind: "missing_or_invalid" };
    const dateMs = Date.parse(text);
    if (!Number.isFinite(dateMs)) {
      return { kind: "missing_or_invalid" };
    }
    delayMs = Math.max(0, dateMs - nowMs);
  }
  if (delayMs > maxDelayMs) {
    return { kind: "exceeds_limit", delayMs };
  }
  return { kind: "valid", delayMs };
}

export function retryDelayMs(
  retryIndex: number,
  baseMs = 1000,
  maxMs = RETRY_BACKOFF_MAX_MS,
  random = Math.random,
): number {
  if (!Number.isInteger(retryIndex) || retryIndex < 0) {
    throw new Error("retry index must be a non-negative integer");
  }
  if (!Number.isInteger(baseMs) || baseMs <= 0 || !Number.isInteger(maxMs) || maxMs < baseMs || maxMs > NODE_TIMER_MAX_MS) {
    throw new Error("retry backoff requires positive integer bounds within the Node timer range");
  }
  const maximum = Math.min(maxMs, baseMs * (2 ** retryIndex));
  return Math.floor(Math.max(0, Math.min(1, random())) * maximum);
}

export async function waitForProxyRetry(delayMs: number, signal: AbortSignal, deadlineAtMs: number | null): Promise<"ready" | "aborted" | "deadline"> {
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > NODE_TIMER_MAX_MS) {
    throw new Error("retry delay must be within the Node timer range");
  }
  if (signal.aborted) {
    return "aborted";
  }
  const remainingMs = deadlineAtMs === null ? null : deadlineAtMs - Date.now();
  if (remainingMs !== null && (remainingMs <= 0 || delayMs > remainingMs)) {
    return "deadline";
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: "ready" | "aborted" | "deadline"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(delayTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish("aborted");
    const delayTimer = setTimeout(() => finish(deadlineAtMs !== null && Date.now() >= deadlineAtMs ? "deadline" : "ready"), delayMs);
    const deadlineTimer = deadlineAtMs === null
      ? null
      : setTimeout(() => finish("deadline"), Math.max(0, deadlineAtMs - Date.now()));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
