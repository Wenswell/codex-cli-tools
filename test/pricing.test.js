import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  calculateCodexCostBreakdown,
  calculateCodexCostUSD,
  missingPricingModels,
  modelPricingStatus,
  readModelPriceCache,
  readModelPriceCacheForModels,
  readRemoteModelPriceCatalog,
  selectRemoteModelPrices,
} from "../dist/lib/pricing.js";

test("pricing calculates strict input, output, cached, and total cost components", () => {
  const modelUsage = new Map([
    ["model-a", usage(100, 20, 40)],
    ["model-b", usage(50, 10, 10)],
  ]);
  const cache = priceCache({
    "model-a": modelPriceFixture(1),
    "model-b": modelPriceFixture(2),
  });

  assert.deepEqual(calculateCodexCostBreakdown(modelUsage, cache, "standard"), {
    inputCostUSD: 140,
    outputCostUSD: 80,
    cachedCostUSD: 6,
    costUSD: 226,
    missingPricingModels: [],
  });
});

test("pricing breakdown preserves complete components when one price category is missing", () => {
  const modelUsage = new Map([
    ["partial-model", usage(100, 20, 40)],
  ]);
  const cache = priceCache({
    "partial-model": { output_cost_per_token: 2, cache_read_input_token_cost: 0.1 },
  });

  assert.deepEqual(calculateCodexCostBreakdown(modelUsage, cache, "standard"), {
    inputCostUSD: null,
    outputCostUSD: 40,
    cachedCostUSD: 4,
    costUSD: null,
    missingPricingModels: ["partial-model"],
  });
});

test("pricing breakdown sorts and deduplicates models missing any required category", () => {
  const modelUsage = new Map([
    ["missing-output", usage(0, 10)],
    ["missing-cache-and-input", usage(10, 0, 5)],
  ]);

  assert.deepEqual(calculateCodexCostBreakdown(modelUsage, priceCache({}), "standard").missingPricingModels, [
    "missing-cache-and-input",
    "missing-output",
  ]);
});

test("pricing breakdown keeps unused price categories complete", () => {
  const modelUsage = new Map([
    ["input-only", usage(10, 0)],
  ]);
  const cache = priceCache({
    "input-only": { input_cost_per_token: 1 },
  });

  assert.deepEqual(calculateCodexCostBreakdown(modelUsage, cache, "standard"), {
    inputCostUSD: 10,
    outputCostUSD: 0,
    cachedCostUSD: 0,
    costUSD: 10,
    missingPricingModels: [],
  });
});

test("pricing breakdown rejects cached input above total input", () => {
  const modelUsage = new Map([
    ["invalid-model", usage(10, 0, 11)],
  ]);

  assert.throws(
    () => calculateCodexCostBreakdown(modelUsage, priceCache({}), "standard"),
    /cached input exceeds input for model: invalid-model/,
  );
});

test("pricing skips missing models and reports them separately", () => {
  const modelUsage = new Map([
    ["known-model", usage(100, 20)],
    ["missing-model", usage(50, 10)],
  ]);
  const cache = priceCache({
    "known-model": modelPriceFixture(0.000001),
  });

  assert.equal(calculateCodexCostUSD(modelUsage, cache, "standard"), 0.00014);
  assert.deepEqual(missingPricingModels(modelUsage, cache, "standard"), ["missing-model"]);
});

test("pricing includes builtin GLM-5.2 prices without a remote cache", async () => {
  const cacheHome = await mkdtemp(join(tmpdir(), "pricing-cache-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = cacheHome;
    const cache = await readModelPriceCache();

    assert.equal(modelPricingStatus(cache, "glm-5.2", "standard"), "ok");
  } finally {
    restoreEnvironment("HOME", previousHome);
    await rm(cacheHome, { recursive: true, force: true });
  }
});

test("pricing cache reads do not fetch remote prices for missing models", async () => {
  const cacheHome = await mkdtemp(join(tmpdir(), "pricing-no-auto-refresh-cache-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    process.env.HOME = cacheHome;
    await writePriceCache(cacheHome, {
      "kept-model": modelPriceFixture(0.000003),
    }, { patterns: ["kept-*"], providers: ["openai"] });
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response("{}", { status: 200 });
    };

    const cache = await readModelPriceCacheForModels(new Map([
      ["missing-model", usage(10, 5)],
    ]), "standard");

    assert.equal(fetchCount, 0);
    assert.equal(cache.models["missing-model"], undefined);
    assert.equal(cache.models["kept-model"].input_cost_per_token, 0.000003);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("HOME", previousHome);
    await rm(cacheHome, { recursive: true, force: true });
  }
});

test("pricing remote catalog keeps only LiteLLM model records", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      "gpt-5.5": modelPriceFixture(0.000005),
      fallback_generalizations: { rules: [] },
      missing_provider: { input_cost_per_token: 0.000001 },
    }), { status: 200 });

    const remote = await readRemoteModelPriceCatalog();

    assert.deepEqual(Object.keys(remote.models ?? {}), ["gpt-5.5"]);
    assert.equal(remote.models?.["gpt-5.5"].litellm_provider, "openai");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("pricing provider filtering precedes the pattern union", () => {
  const models = {
    "gpt-5.4": modelPriceFixture(0.000004),
    "gpt-5.5": modelPriceFixture(0.000005),
    "azure/gpt-5.5": modelPriceFixture(0.000006, "azure"),
    "claude-sonnet-4.5": modelPriceFixture(0.000003, "anthropic"),
  };

  const selected = selectRemoteModelPrices(models, ["gpt-5.*", "claude-*"], ["openai", "anthropic"]);

  assert.deepEqual(Object.keys(selected), ["claude-sonnet-4.5", "gpt-5.4", "gpt-5.5"]);
  assert.deepEqual(selectRemoteModelPrices(models, ["*"], []), {});
});

function priceCache(models, patterns = [], providers = []) {
  return {
    source: "test",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    patterns,
    providers,
    models,
  };
}

function usage(inputTokens, outputTokens, cachedInputTokens = 0) {
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function modelPriceFixture(inputCostPerToken, provider = "openai") {
  return {
    litellm_provider: provider,
    input_cost_per_token: inputCostPerToken,
    output_cost_per_token: inputCostPerToken * 2,
    cache_read_input_token_cost: inputCostPerToken / 10,
  };
}

async function writePriceCache(cacheHome, models, { patterns = [], providers = [] } = {}) {
  const dir = join(cacheHome, ".config", "codex-tools");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "model-prices.json"), JSON.stringify(priceCache(models, patterns, providers), null, 2), "utf8");
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
