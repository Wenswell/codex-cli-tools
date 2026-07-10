import { readFile } from "node:fs/promises";
import { codexConfigPath, modelPricesCachePath } from "./paths.js";
import { readTextIfExists, writeTextFileAtomic } from "./fs.js";
import { readTopLevelTomlString } from "./toml.js";

export type CodexCostSpeed = "auto" | "standard" | "fast";
export type ResolvedCodexCostSpeed = "standard" | "fast";

export type CodexTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type CodexModelUsage = CodexTokenUsage;

export type ModelPrice = {
  input: number;
  cacheRead: number;
  output: number;
};

export type ModelPriceParts = {
  input: number | null;
  cacheRead: number | null;
  output: number | null;
};

export type ModelPriceCache = {
  source: string;
  fetchedAt: string;
  models: Record<string, unknown>;
};

export type ModelPriceOverride = {
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheReadInputTokenCost?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
};

export type ModelPriceCacheOptions = {
  overrides?: Record<string, ModelPriceOverride>;
};

export type ModelPricingStatus = "ok" | "partial" | "missing";

export type ModelPriceModelUpdateAction = "update" | "missing";

export type ModelPriceModelUpdateRecord = {
  model: string;
  cached: ModelPricingStatus;
  remote: ModelPricingStatus | "missing";
  action: ModelPriceModelUpdateAction;
};

export type ModelPriceModelUpdatePlan = {
  cachePath: string;
  source: string;
  fetchedAt: string;
  records: ModelPriceModelUpdateRecord[];
  nextCache: ModelPriceCache;
};

export type RemoteModelPriceCatalog =
  | { models: Record<string, unknown>; error: null }
  | { models: null; error: string };

export const litellmPricingUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const remoteModelPriceTimeoutMs = 5_000;

type LiteLlmModelPrice = {
  input_cost_per_token?: unknown;
  input_cost_per_token_priority?: unknown;
  output_cost_per_token?: unknown;
  output_cost_per_token_priority?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_read_input_token_cost_priority?: unknown;
};

const builtinModelPrices: Record<string, LiteLlmModelPrice> = {
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

export async function readModelPriceCache(options: ModelPriceCacheOptions = {}): Promise<ModelPriceCache> {
  const path = modelPricesCachePath();
  const cachedText = await readTextIfExists(path);
  if (cachedText !== null) {
    return applyModelPriceOverrides(mergeBuiltinModelPrices(parseModelPriceCache(cachedText, path)), options.overrides);
  }

  return applyModelPriceOverrides(mergeBuiltinModelPrices({
    source: "builtin",
    fetchedAt: new Date(0).toISOString(),
    models: {},
  }), options.overrides);
}

export async function readModelPriceCacheForModels(
  modelUsage: Map<string, CodexModelUsage>,
  speed: ResolvedCodexCostSpeed,
  options: ModelPriceCacheOptions = {},
): Promise<ModelPriceCache> {
  void modelUsage;
  void speed;
  return readModelPriceCache(options);
}

function parseModelPriceCache(text: string, path: string): ModelPriceCache {
  const parsed = JSON.parse(text) as ModelPriceCache;
  if (!parsed.models || typeof parsed.models !== "object") {
    throw new Error(`invalid pricing cache: ${path}`);
  }
  return parsed;
}

export async function buildModelPriceModelUpdatePlan(
  models: string[],
  speed: ResolvedCodexCostSpeed,
): Promise<ModelPriceModelUpdatePlan> {
  const path = modelPricesCachePath();
  const cachedText = await readTextIfExists(path);
  const currentCache = cachedText === null
    ? { source: litellmPricingUrl, fetchedAt: new Date(0).toISOString(), models: {} }
    : parseModelPriceCache(cachedText, path);
  const remote = await readRemoteModelPriceCatalog();
  if (!remote.models) {
    throw new Error(`pricing refresh failed: ${path} (${remote.error})`);
  }
  const remoteModels = remote.models;
  const names = expandModelNamePatterns(models, Object.keys(remoteModels));
  const fetchedAt = new Date().toISOString();
  const nextModels = { ...currentCache.models };
  const records = names.map((model) => {
    const remotePrice = remoteModels[model];
    const action: ModelPriceModelUpdateAction = remotePrice === undefined ? "missing" : "update";
    const remoteCache: ModelPriceCache = {
      source: litellmPricingUrl,
      fetchedAt,
      models: remotePrice === undefined ? {} : { [model]: remotePrice },
    };
    if (remotePrice !== undefined) {
      nextModels[model] = remotePrice;
    }
    return {
      model,
      cached: modelPricingStatus(mergeBuiltinModelPrices(currentCache), model, speed),
      remote: remotePrice === undefined ? "missing" : modelPricingStatus(remoteCache, model, speed),
      action,
    };
  });

  return {
    cachePath: path,
    source: litellmPricingUrl,
    fetchedAt,
    records,
    nextCache: {
      source: litellmPricingUrl,
      fetchedAt,
      models: nextModels,
    },
  };
}

export async function writeModelPriceModelUpdatePlan(plan: ModelPriceModelUpdatePlan): Promise<void> {
  await writeTextFileAtomic(plan.cachePath, `${JSON.stringify(plan.nextCache, null, 2)}\n`, 0o644);
}

export async function readRemoteModelPriceCatalog(): Promise<RemoteModelPriceCatalog> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remoteModelPriceTimeoutMs);
  try {
    const response = await fetch(litellmPricingUrl, { signal: controller.signal });
    if (!response.ok) {
      return { models: null, error: `http ${response.status}` };
    }
    try {
      const models = await response.json() as unknown;
      return isModelPriceCatalog(models)
        ? { models, error: null }
        : { models: null, error: "invalid response" };
    } catch {
      return { models: null, error: "invalid response" };
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { models: null, error: name === "AbortError" ? "timeout" : "fetch failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function isModelPriceCatalog(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeBuiltinModelPrices(cache: ModelPriceCache): ModelPriceCache {
  return {
    ...cache,
    models: {
      ...cache.models,
      ...Object.fromEntries(Object.entries(builtinModelPrices).filter(([model]) => !(model in cache.models))),
    },
  };
}

function applyModelPriceOverrides(
  cache: ModelPriceCache,
  overrides: Record<string, ModelPriceOverride> | undefined,
): ModelPriceCache {
  if (!overrides || Object.keys(overrides).length === 0) {
    return cache;
  }
  const models = { ...cache.models };
  for (const [model, override] of Object.entries(overrides)) {
    const existing = typeof models[model] === "object" && models[model] !== null
      ? models[model] as LiteLlmModelPrice
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

function finiteOverride(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueModelNames(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter((model) => model.length > 0))];
}

function expandModelNamePatterns(models: string[], remoteModels: string[]): string[] {
  const names: string[] = [];
  for (const model of uniqueModelNames(models)) {
    const matches = matchingModelNames(model, remoteModels);
    names.push(...(matches.length > 0 ? matches : [model]));
  }
  return uniqueModelNames(names);
}

export function matchingModelNames(pattern: string, models: string[]): string[] {
  if (!pattern.includes("*")) {
    return models.includes(pattern) ? [pattern] : [];
  }
  const regexp = modelNamePatternRegExp(pattern);
  return models.filter((model) => regexp.test(model)).sort();
}

export function modelNamePatternRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function resolveCodexCostSpeed(speed: CodexCostSpeed): Promise<ResolvedCodexCostSpeed> {
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

export function modelPrice(
  cache: ModelPriceCache,
  model: string,
  speed: ResolvedCodexCostSpeed,
  usage: CodexModelUsage,
): ModelPrice | null {
  const parts = modelPriceParts(cache, model, speed);
  if (!parts) {
    return null;
  }
  if (
    (usage.inputTokens > usage.cachedInputTokens && parts.input === null) ||
    (usage.outputTokens > 0 && parts.output === null) ||
    (usage.cachedInputTokens > 0 && parts.cacheRead === null)
  ) {
    return null;
  }
  return {
    input: parts.input ?? 0,
    cacheRead: parts.cacheRead ?? 0,
    output: parts.output ?? 0,
  };
}

export function modelPriceParts(
  cache: ModelPriceCache,
  model: string,
  speed: ResolvedCodexCostSpeed,
): ModelPriceParts | null {
  const raw = cache.models[model] as LiteLlmModelPrice | undefined;
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

export function modelPricingStatus(
  cache: ModelPriceCache,
  model: string,
  speed: ResolvedCodexCostSpeed,
): ModelPricingStatus {
  const baseUsage: CodexModelUsage = {
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 2,
  };
  if (!modelPrice(cache, model, speed, baseUsage)) {
    return "missing";
  }
  const cacheReadUsage: CodexModelUsage = {
    inputTokens: 1,
    cachedInputTokens: 1,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 2,
  };
  return modelPrice(cache, model, speed, cacheReadUsage) ? "ok" : "partial";
}

export function missingPricingModels(
  modelUsage: Map<string, CodexModelUsage>,
  cache: ModelPriceCache,
  speed: ResolvedCodexCostSpeed,
): string[] {
  return [...modelUsage.entries()]
    .filter(([, usage]) => usage.inputTokens > 0 || usage.cachedInputTokens > 0 || usage.outputTokens > 0)
    .filter(([model, usage]) => modelPrice(cache, model, speed, usage) === null)
    .map(([model]) => model)
    .sort();
}

export function calculateCodexCostUSD(
  modelUsage: Map<string, CodexModelUsage>,
  cache: ModelPriceCache,
  speed: ResolvedCodexCostSpeed,
): number {
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

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
