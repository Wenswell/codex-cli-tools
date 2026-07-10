import { readFile } from "node:fs/promises";
import { codexConfigPath, modelPricesCachePath } from "./paths.js";
import { readTextIfExists, writeTextFileAtomic } from "./fs.js";
import { readTopLevelTomlString } from "./toml.js";
export const litellmPricingUrl = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const remoteModelPriceTimeoutMs = 5_000;
const builtinModelPrices = {
    "glm-5.2": {
        input_cost_per_token: 0.0000014,
        output_cost_per_token: 0.0000044,
        cache_read_input_token_cost: 0.00000026,
    },
    "GLM-5.2": {
        input_cost_per_token: 0.0000014,
        output_cost_per_token: 0.0000044,
        cache_read_input_token_cost: 0.00000026,
    },
    "zai/glm-5.2": {
        input_cost_per_token: 0.0000014,
        output_cost_per_token: 0.0000044,
        cache_read_input_token_cost: 0.00000026,
    },
};
export async function readModelPriceCache(options = {}) {
    return applyModelPriceOverrides(mergeBuiltinModelPrices(await readStoredModelPriceCache()), options.overrides);
}
export async function readModelPriceCacheForModels(modelUsage, speed, options = {}) {
    void modelUsage;
    void speed;
    return readModelPriceCache(options);
}
export async function readStoredModelPriceCache() {
    const path = modelPricesCachePath();
    const text = await readTextIfExists(path);
    return text === null ? emptyModelPriceCache() : parseModelPriceCache(text, path);
}
export async function writeModelPriceCache(cache) {
    await writeTextFileAtomic(modelPricesCachePath(), `${JSON.stringify(cache, null, 2)}\n`, 0o644);
}
function emptyModelPriceCache() {
    return {
        source: "builtin",
        fetchedAt: new Date(0).toISOString(),
        patterns: [],
        providers: [],
        models: {},
    };
}
function parseModelPriceCache(text, path) {
    const parsed = JSON.parse(text);
    if (typeof parsed.source !== "string"
        || typeof parsed.fetchedAt !== "string"
        || !Array.isArray(parsed.patterns)
        || !parsed.patterns.every((pattern) => typeof pattern === "string")
        || !Array.isArray(parsed.providers)
        || !parsed.providers.every((provider) => typeof provider === "string")
        || !parsed.models
        || typeof parsed.models !== "object"
        || Array.isArray(parsed.models)) {
        throw new Error(`invalid pricing cache: ${path}`);
    }
    return {
        source: parsed.source,
        fetchedAt: parsed.fetchedAt,
        patterns: normalizeModelPricePatterns(parsed.patterns),
        providers: normalizeModelPriceProviders(parsed.providers),
        models: parsed.models,
    };
}
export async function buildModelPriceSnapshotPlan(patterns, providers) {
    const remote = await readRemoteModelPriceCatalog();
    if (!remote.models) {
        throw new Error(`pricing refresh failed: ${modelPricesCachePath()} (${remote.error})`);
    }
    return buildModelPriceSnapshotPlanFromRemoteCatalog(patterns, providers, remote.models);
}
export async function buildModelPriceSnapshotPlanFromRemoteCatalog(patterns, providers, remoteModels) {
    const currentCache = await readStoredModelPriceCache();
    const nextPatterns = normalizeModelPricePatterns(patterns);
    const nextProviders = normalizeModelPriceProviders(providers);
    const fetchedAt = new Date().toISOString();
    return {
        cachePath: modelPricesCachePath(),
        source: litellmPricingUrl,
        fetchedAt,
        currentCache,
        nextCache: {
            source: litellmPricingUrl,
            fetchedAt,
            patterns: nextPatterns,
            providers: nextProviders,
            models: selectRemoteModelPrices(remoteModels, nextPatterns, nextProviders),
        },
    };
}
export async function writeModelPriceSnapshotPlan(plan) {
    await writeModelPriceCache(plan.nextCache);
}
export async function readRemoteModelPriceCatalog() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remoteModelPriceTimeoutMs);
    try {
        const response = await fetch(litellmPricingUrl, { signal: controller.signal });
        if (!response.ok) {
            return { models: null, error: `http ${response.status}` };
        }
        try {
            const models = await response.json();
            const catalog = parseRemoteModelPriceCatalog(models);
            return catalog ? { models: catalog, error: null } : { models: null, error: "invalid response" };
        }
        catch {
            return { models: null, error: "invalid response" };
        }
    }
    catch (error) {
        const name = error instanceof Error ? error.name : "";
        return { models: null, error: name === "AbortError" ? "timeout" : "fetch failed" };
    }
    finally {
        clearTimeout(timeout);
    }
}
function parseRemoteModelPriceCatalog(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return Object.fromEntries(Object.entries(value).filter((entry) => (isRemoteModelPrice(entry[1]))));
}
function isRemoteModelPrice(value) {
    return Boolean(value)
        && typeof value === "object"
        && !Array.isArray(value)
        && typeof value.litellm_provider === "string";
}
function mergeBuiltinModelPrices(cache) {
    return {
        ...cache,
        models: {
            ...cache.models,
            ...Object.fromEntries(Object.entries(builtinModelPrices).filter(([model]) => !(model in cache.models))),
        },
    };
}
function applyModelPriceOverrides(cache, overrides) {
    if (!overrides || Object.keys(overrides).length === 0) {
        return cache;
    }
    const models = { ...cache.models };
    for (const [model, override] of Object.entries(overrides)) {
        const existing = typeof models[model] === "object" && models[model] !== null
            ? models[model]
            : {};
        models[model] = {
            ...existing,
            input_cost_per_token: finiteOverride(override.inputCostPerToken ?? override.input_cost_per_token)
                ?? existing.input_cost_per_token,
            output_cost_per_token: finiteOverride(override.outputCostPerToken ?? override.output_cost_per_token)
                ?? existing.output_cost_per_token,
            cache_read_input_token_cost: finiteOverride(override.cacheReadInputTokenCost ?? override.cache_read_input_token_cost)
                ?? existing.cache_read_input_token_cost,
        };
    }
    return { ...cache, models };
}
function finiteOverride(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function normalizeModelPricePatterns(patterns) {
    return normalizeModelPriceNames(patterns);
}
export function normalizeModelPriceProviders(providers) {
    return normalizeModelPriceNames(providers);
}
function normalizeModelPriceNames(values) {
    return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}
export function selectRemoteModelPrices(models, patterns, providers) {
    const selectedPatterns = normalizeModelPricePatterns(patterns);
    const selectedProviders = new Set(normalizeModelPriceProviders(providers));
    if (selectedPatterns.length === 0 || selectedProviders.size === 0) {
        return {};
    }
    const providerModels = Object.entries(models)
        .filter(([, record]) => selectedProviders.has(record.litellm_provider))
        .map(([model]) => model);
    const names = new Set(selectedPatterns.flatMap((pattern) => matchingModelNames(pattern, providerModels)));
    return Object.fromEntries([...names].sort().map((model) => [model, models[model]]));
}
export function pruneModelPriceCache(cache, patterns = cache.patterns, providers = cache.providers) {
    const nextPatterns = normalizeModelPricePatterns(patterns);
    const nextProviders = normalizeModelPriceProviders(providers);
    const currentModels = Object.fromEntries(Object.entries(cache.models).filter((entry) => (isRemoteModelPrice(entry[1]))));
    return {
        ...cache,
        patterns: nextPatterns,
        providers: nextProviders,
        models: selectRemoteModelPrices(currentModels, nextPatterns, nextProviders),
    };
}
export function matchingModelNames(pattern, models) {
    if (!pattern.includes("*")) {
        return models.includes(pattern) ? [pattern] : [];
    }
    const regexp = modelNamePatternRegExp(pattern);
    return models.filter((model) => regexp.test(model)).sort();
}
export function modelNamePatternRegExp(pattern) {
    return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export async function resolveCodexCostSpeed(speed) {
    if (speed === "standard" || speed === "fast") {
        return speed;
    }
    const configText = await readFile(codexConfigPath(), "utf8").catch(() => "");
    const serviceTier = readTopLevelTomlString(configText, "service_tier");
    if (!serviceTier || serviceTier === "standard" || serviceTier === "default") {
        return "standard";
    }
    if (serviceTier === "fast" || serviceTier === "priority") {
        return "fast";
    }
    throw new Error(`unsupported Codex service_tier for ccs cost --speed auto: ${serviceTier}`);
}
export function modelPrice(cache, model, speed, usage) {
    const parts = modelPriceParts(cache, model, speed);
    if (!parts) {
        return null;
    }
    if ((usage.inputTokens > usage.cachedInputTokens && parts.input === null) ||
        (usage.outputTokens > 0 && parts.output === null) ||
        (usage.cachedInputTokens > 0 && parts.cacheRead === null)) {
        return null;
    }
    return {
        input: parts.input ?? 0,
        cacheRead: parts.cacheRead ?? 0,
        output: parts.output ?? 0,
    };
}
export function modelPriceParts(cache, model, speed) {
    const raw = cache.models[model];
    if (!raw || typeof raw !== "object") {
        return null;
    }
    if (speed === "standard") {
        return {
            input: readFiniteNumber(raw.input_cost_per_token),
            cacheRead: readFiniteNumber(raw.cache_read_input_token_cost),
            output: readFiniteNumber(raw.output_cost_per_token),
        };
    }
    const hasPriorityPricing = raw.input_cost_per_token_priority !== undefined
        || raw.output_cost_per_token_priority !== undefined
        || raw.cache_read_input_token_cost_priority !== undefined;
    return {
        input: readFiniteNumber(hasPriorityPricing ? raw.input_cost_per_token_priority : raw.input_cost_per_token),
        cacheRead: readFiniteNumber(hasPriorityPricing
            ? raw.cache_read_input_token_cost_priority
            : raw.cache_read_input_token_cost),
        output: readFiniteNumber(hasPriorityPricing ? raw.output_cost_per_token_priority : raw.output_cost_per_token),
    };
}
export function modelPricingStatus(cache, model, speed) {
    const baseUsage = {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        totalTokens: 2,
    };
    if (!modelPrice(cache, model, speed, baseUsage)) {
        return "missing";
    }
    const cacheReadUsage = {
        inputTokens: 1,
        cachedInputTokens: 1,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        totalTokens: 2,
    };
    return modelPrice(cache, model, speed, cacheReadUsage) ? "ok" : "partial";
}
export function missingPricingModels(modelUsage, cache, speed) {
    return [...modelUsage.entries()]
        .filter(([, usage]) => usage.inputTokens > 0 || usage.cachedInputTokens > 0 || usage.outputTokens > 0)
        .filter(([model, usage]) => modelPrice(cache, model, speed, usage) === null)
        .map(([model]) => model)
        .sort();
}
export function calculateCodexCostUSD(modelUsage, cache, speed) {
    let cost = 0;
    for (const [model, usage] of modelUsage) {
        const price = modelPrice(cache, model, speed, usage);
        if (!price) {
            continue;
        }
        const nonCachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
        if (nonCachedInputTokens < 0) {
            throw new Error(`cached input exceeds input for model: ${model}`);
        }
        cost +=
            nonCachedInputTokens * price.input +
                usage.cachedInputTokens * price.cacheRead +
                usage.outputTokens * price.output;
    }
    return cost;
}
function readFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
