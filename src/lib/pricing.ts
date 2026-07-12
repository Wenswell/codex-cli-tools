import { readFile } from "node:fs/promises";
import { codexConfigPath, modelPricesConfigPath } from "./paths.js";
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

export type CodexCostBreakdown = {
  inputCostUSD: number | null;
  outputCostUSD: number | null;
  cachedCostUSD: number | null;
  costUSD: number | null;
  missingPricingModels: string[];
};

export type ModelPriceCache = {
  source: string;
  fetchedAt: string;
  patterns: string[];
  providers: string[];
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

export type ModelPriceSnapshotPlan = {
  configPath: string;
  source: string;
  fetchedAt: string;
  currentCache: ModelPriceCache;
  nextCache: ModelPriceCache;
};

export type RemoteModelPriceCatalog =
  | { models: Record<string, RemoteModelPrice>; error: null }
  | { models: null; error: string };

export const litellmPricingUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const remoteModelPriceTimeoutMs = 5_000;

export type LiteLlmModelPrice = {
  input_cost_per_token?: unknown;
  input_cost_per_token_priority?: unknown;
  output_cost_per_token?: unknown;
  output_cost_per_token_priority?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_read_input_token_cost_priority?: unknown;
};

export type RemoteModelPrice = LiteLlmModelPrice & {
  litellm_provider: string;
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
  return applyModelPriceOverrides(mergeBuiltinModelPrices(await readStoredModelPriceCache()), options.overrides);
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

export async function readStoredModelPriceCache(): Promise<ModelPriceCache> {
  const path = modelPricesConfigPath();
  const text = await readTextIfExists(path);
  return text === null ? emptyModelPriceCache() : parseModelPriceCache(text, path);
}

export async function writeModelPriceCache(cache: ModelPriceCache): Promise<void> {
  await writeTextFileAtomic(modelPricesConfigPath(), `${JSON.stringify(cache, null, 2)}\n`, 0o644);
}

function emptyModelPriceCache(): ModelPriceCache {
  return {
    source: "builtin",
    fetchedAt: new Date(0).toISOString(),
    patterns: [],
    providers: [],
    models: {},
  };
}

function parseModelPriceCache(text: string, path: string): ModelPriceCache {
  const parsed = JSON.parse(text) as Partial<ModelPriceCache>;
  if (
    typeof parsed.source !== "string"
    || typeof parsed.fetchedAt !== "string"
    || !Array.isArray(parsed.patterns)
    || !parsed.patterns.every((pattern) => typeof pattern === "string")
    || !Array.isArray(parsed.providers)
    || !parsed.providers.every((provider) => typeof provider === "string")
    || !parsed.models
    || typeof parsed.models !== "object"
    || Array.isArray(parsed.models)
  ) {
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

export async function buildModelPriceSnapshotPlanFromRemoteCatalog(
  patterns: string[],
  providers: string[],
  remoteModels: Record<string, RemoteModelPrice>,
): Promise<ModelPriceSnapshotPlan> {
  const currentCache = await readStoredModelPriceCache();
  const nextPatterns = normalizeModelPricePatterns(patterns);
  const nextProviders = normalizeModelPriceProviders(providers);
  const fetchedAt = new Date().toISOString();

  return {
    configPath: modelPricesConfigPath(),
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

export async function writeModelPriceSnapshotPlan(plan: ModelPriceSnapshotPlan): Promise<void> {
  await writeModelPriceCache(plan.nextCache);
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
      const catalog = parseRemoteModelPriceCatalog(models);
      return catalog ? { models: catalog, error: null } : { models: null, error: "invalid response" };
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

function parseRemoteModelPriceCatalog(value: unknown): Record<string, RemoteModelPrice> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, RemoteModelPrice] => (
    isRemoteModelPrice(entry[1])
  )));
}

function isRemoteModelPrice(value: unknown): value is RemoteModelPrice {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { litellm_provider?: unknown }).litellm_provider === "string";
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

export function normalizeModelPricePatterns(patterns: string[]): string[] {
  return normalizeModelPriceNames(patterns);
}

export function normalizeModelPriceProviders(providers: string[]): string[] {
  return normalizeModelPriceNames(providers);
}

function normalizeModelPriceNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

export function selectRemoteModelPrices(
  models: Record<string, RemoteModelPrice>,
  patterns: string[],
  providers: string[],
): Record<string, RemoteModelPrice> {
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

export function pruneModelPriceCache(
  cache: ModelPriceCache,
  patterns: string[] = cache.patterns,
  providers: string[] = cache.providers,
): ModelPriceCache {
  const nextPatterns = normalizeModelPricePatterns(patterns);
  const nextProviders = normalizeModelPriceProviders(providers);
  const currentModels = Object.fromEntries(Object.entries(cache.models).filter((entry): entry is [string, RemoteModelPrice] => (
    isRemoteModelPrice(entry[1])
  )));
  return {
    ...cache,
    patterns: nextPatterns,
    providers: nextProviders,
    models: selectRemoteModelPrices(currentModels, nextPatterns, nextProviders),
  };
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

export function calculateCodexCostBreakdown(
  modelUsage: Map<string, CodexModelUsage>,
  cache: ModelPriceCache,
  speed: ResolvedCodexCostSpeed,
): CodexCostBreakdown {
  let inputCostUSD = 0;
  let outputCostUSD = 0;
  let cachedCostUSD = 0;
  let inputMissing = false;
  let outputMissing = false;
  let cachedMissing = false;
  const missingModels = new Set<string>();

  for (const [model, usage] of modelUsage) {
    const nonCachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
    if (nonCachedInputTokens < 0) {
      throw new Error(`cached input exceeds input for model: ${model}`);
    }

    const prices = modelPriceParts(cache, model, speed);
    const inputPrice = prices?.input ?? null;
    const outputPrice = prices?.output ?? null;
    const cachedPrice = prices?.cacheRead ?? null;
    if (nonCachedInputTokens > 0) {
      if (inputPrice === null) {
        inputMissing = true;
        missingModels.add(model);
      } else {
        inputCostUSD += nonCachedInputTokens * inputPrice;
      }
    }
    if (usage.outputTokens > 0) {
      if (outputPrice === null) {
        outputMissing = true;
        missingModels.add(model);
      } else {
        outputCostUSD += usage.outputTokens * outputPrice;
      }
    }
    if (usage.cachedInputTokens > 0) {
      if (cachedPrice === null) {
        cachedMissing = true;
        missingModels.add(model);
      } else {
        cachedCostUSD += usage.cachedInputTokens * cachedPrice;
      }
    }
  }

  const breakdown: CodexCostBreakdown = {
    inputCostUSD: inputMissing ? null : inputCostUSD,
    outputCostUSD: outputMissing ? null : outputCostUSD,
    cachedCostUSD: cachedMissing ? null : cachedCostUSD,
    costUSD: null,
    missingPricingModels: [...missingModels].sort(),
  };
  if (breakdown.inputCostUSD !== null && breakdown.outputCostUSD !== null && breakdown.cachedCostUSD !== null) {
    breakdown.costUSD = breakdown.inputCostUSD + breakdown.outputCostUSD + breakdown.cachedCostUSD;
  }
  return breakdown;
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
