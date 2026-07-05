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

export type ModelPriceCache = {
  source: string;
  fetchedAt: string;
  models: Record<string, unknown>;
};

export const litellmPricingUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

type LiteLlmModelPrice = {
  input_cost_per_token?: unknown;
  input_cost_per_token_priority?: unknown;
  output_cost_per_token?: unknown;
  output_cost_per_token_priority?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_read_input_token_cost_priority?: unknown;
};

export async function readModelPriceCache(): Promise<ModelPriceCache> {
  const path = modelPricesCachePath();
  const cachedText = await readTextIfExists(path);
  if (cachedText !== null) {
    const parsed = JSON.parse(cachedText) as ModelPriceCache;
    if (!parsed.models || typeof parsed.models !== "object") {
      throw new Error(`invalid pricing cache: ${path}`);
    }
    return parsed;
  }

  let response: Response;
  try {
    response = await fetch(litellmPricingUrl);
  } catch (error) {
    throw new Error(`pricing cache missing and refresh failed: ${path} (${formatUnknownError(error)})`);
  }
  if (!response.ok) {
    throw new Error(`pricing cache missing and refresh failed: ${path} (${response.status} ${response.statusText})`);
  }

  const models = await response.json() as Record<string, unknown>;
  const cache: ModelPriceCache = {
    source: litellmPricingUrl,
    fetchedAt: new Date().toISOString(),
    models,
  };
  await writeTextFileAtomic(path, `${JSON.stringify(cache, null, 2)}\n`, 0o644);
  return cache;
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
  const raw = cache.models[model] as LiteLlmModelPrice | undefined;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  if (speed === "standard") {
    const input = readFiniteNumber(raw.input_cost_per_token);
    const output = readFiniteNumber(raw.output_cost_per_token);
    const cacheRead = readFiniteNumber(raw.cache_read_input_token_cost);
    if (
      (usage.inputTokens > usage.cachedInputTokens && input === null) ||
      (usage.outputTokens > 0 && output === null) ||
      (usage.cachedInputTokens > 0 && cacheRead === null)
    ) {
      return null;
    }
    return {
      input: input ?? 0,
      cacheRead: cacheRead ?? 0,
      output: output ?? 0,
    };
  }

  const input = readFiniteNumber(raw.input_cost_per_token_priority);
  const output = readFiniteNumber(raw.output_cost_per_token_priority);
  const cacheRead = readFiniteNumber(raw.cache_read_input_token_cost_priority);
  if (
    (usage.inputTokens > usage.cachedInputTokens && input === null) ||
    (usage.outputTokens > 0 && output === null) ||
    (usage.cachedInputTokens > 0 && cacheRead === null)
  ) {
    return null;
  }
  return {
    input: input ?? 0,
    cacheRead: cacheRead ?? 0,
    output: output ?? 0,
  };
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
      throw new Error(`missing pricing model: ${model}`);
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

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
