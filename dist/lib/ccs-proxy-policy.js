const RETRY_AFTER_MAX_MS = 60_000;
const RETRY_BACKOFF_MAX_MS = 30_000;
const NODE_TIMER_MAX_MS = 2_147_483_647;
export class ProxyRetryBudget {
    limit;
    usedCount = 0;
    constructor(limit) {
        this.limit = limit;
        if (!Number.isInteger(limit) || limit < 0) {
            throw new Error("retry budget limit must be a non-negative integer");
        }
    }
    get used() {
        return this.usedCount;
    }
    get remaining() {
        return Math.max(0, this.limit - this.usedCount);
    }
    consume() {
        if (this.remaining === 0) {
            return false;
        }
        this.usedCount += 1;
        return true;
    }
}
export function matchesReasoningTokens(value, values) {
    return value !== null && values.includes(value);
}
export function decideProxyPolicy(facts, actions, retryBudgetRemaining) {
    const selected = facts.timeout
        ? { trigger: "timeout", action: actions.timeout }
        : facts.capacity
            ? { trigger: "capacity", action: actions.capacity }
            : facts.status === 429
                ? { trigger: "http_429", action: actions.http429 }
                : facts.reasoningMatched
                    ? { trigger: "reasoning", action: "retry_then_502" }
                    : { trigger: "pass_through", action: "pass_through" };
    const retryAction = selected.action === "retry_then_pass_through" || selected.action === "retry_then_502";
    return {
        ...selected,
        retry: retryAction && retryBudgetRemaining > 0,
        exhaustedAction: selected.action === "return_502" || selected.action === "retry_then_502"
            ? "return_502"
            : "pass_through",
    };
}
export function parseRetryAfter(value, nowMs = Date.now()) {
    if (!value) {
        return { kind: "missing_or_invalid" };
    }
    const text = value.trim();
    let delayMs;
    if (/^\d+(?:\.\d+)?$/.test(text)) {
        const seconds = Number(text);
        delayMs = Math.ceil(seconds * 1000);
    }
    else {
        if (/^[+-]/.test(text))
            return { kind: "missing_or_invalid" };
        const dateMs = Date.parse(text);
        if (!Number.isFinite(dateMs)) {
            return { kind: "missing_or_invalid" };
        }
        delayMs = Math.max(0, dateMs - nowMs);
    }
    if (delayMs > RETRY_AFTER_MAX_MS) {
        return { kind: "exceeds_limit", delayMs };
    }
    return { kind: "valid", delayMs };
}
export function retryDelayMs(retryIndex, random = Math.random) {
    if (!Number.isInteger(retryIndex) || retryIndex < 0) {
        throw new Error("retry index must be a non-negative integer");
    }
    const maximum = Math.min(RETRY_BACKOFF_MAX_MS, 1000 * (2 ** retryIndex));
    return Math.floor(Math.max(0, Math.min(1, random())) * maximum);
}
export async function waitForProxyRetry(delayMs, signal, deadlineAtMs) {
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
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(delayTimer);
            if (deadlineTimer)
                clearTimeout(deadlineTimer);
            signal.removeEventListener("abort", onAbort);
            resolve(result);
        };
        const onAbort = () => finish("aborted");
        const delayTimer = setTimeout(() => finish(deadlineAtMs !== null && Date.now() >= deadlineAtMs ? "deadline" : "ready"), delayMs);
        const deadlineTimer = deadlineAtMs === null
            ? null
            : setTimeout(() => finish("deadline"), Math.max(0, deadlineAtMs - Date.now()));
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
