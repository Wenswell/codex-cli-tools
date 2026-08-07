export type ProxyPolicyAction = "pass_through" | "return_502" | "retry_then_pass_through" | "retry_then_502";
export type ProxyPolicyTrigger = "timeout" | "capacity" | "http_429" | "http_503" | "reasoning" | "pass_through";

export type ProxyPolicyDecision = {
  trigger: ProxyPolicyTrigger;
  action: ProxyPolicyAction;
  retry: boolean;
  exhaustedAction: "pass_through" | "return_502";
};

export type ProxyPolicyFacts = {
  timeout: boolean;
  capacity: boolean;
  status: number;
  reasoningMatched: boolean;
};

export type ProxyPolicyActions = {
  timeout: Extract<ProxyPolicyAction, "return_502" | "retry_then_502">;
  capacity: ProxyPolicyAction;
  http429: ProxyPolicyAction;
};

export type RetryAfterResult =
  | { kind: "missing_or_invalid" }
  | { kind: "valid"; delayMs: number }
  | { kind: "exceeds_limit"; delayMs: number };

const RETRY_AFTER_MAX_MS = 60_000;
const RETRY_BACKOFF_MAX_MS = 30_000;
const NODE_TIMER_MAX_MS = 2_147_483_647;

export class ProxyRetryBudget {
  private usedCount = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("retry budget limit must be a non-negative integer");
    }
  }

  get used(): number {
    return this.usedCount;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.usedCount);
  }

  consume(): boolean {
    if (this.remaining === 0) {
      return false;
    }
    this.usedCount += 1;
    return true;
  }
}

export function matchesReasoningTokens(value: number | null, values: readonly number[]): boolean {
  return value !== null && values.includes(value);
}

export function decideProxyPolicy(
  facts: ProxyPolicyFacts,
  actions: ProxyPolicyActions,
  retryBudgetRemaining: number,
): ProxyPolicyDecision {
  const selected = facts.timeout
    ? { trigger: "timeout" as const, action: actions.timeout }
    : facts.capacity
      ? { trigger: "capacity" as const, action: actions.capacity }
      : facts.status === 429
        ? { trigger: "http_429" as const, action: actions.http429 }
        : facts.reasoningMatched
          ? { trigger: "reasoning" as const, action: "retry_then_502" as const }
          : { trigger: "pass_through" as const, action: "pass_through" as const };
  const retryAction = selected.action === "retry_then_pass_through" || selected.action === "retry_then_502";
  return {
    ...selected,
    retry: retryAction && retryBudgetRemaining > 0,
    exhaustedAction: selected.action === "return_502" || selected.action === "retry_then_502"
      ? "return_502"
      : "pass_through",
  };
}

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
