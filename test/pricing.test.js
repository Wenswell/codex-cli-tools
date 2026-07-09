import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  calculateCodexCostUSD,
  missingPricingModels,
  modelPricingStatus,
  readModelPriceCache,
} from "../dist/lib/pricing.js";

test("pricing skips missing models and reports them separately", () => {
  const modelUsage = new Map([
    ["known-model", usage(100, 20)],
    ["missing-model", usage(50, 10)],
  ]);
  const cache = {
    source: "test",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    models: {
      "known-model": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.0000001,
      },
    },
  };

  assert.equal(calculateCodexCostUSD(modelUsage, cache, "standard"), 0.00014);
  assert.deepEqual(missingPricingModels(modelUsage, cache, "standard"), ["missing-model"]);
});

test("pricing reports partial status when cache-read pricing is missing", () => {
  const cache = {
    source: "test",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    models: {
      "partial-model": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    },
  };

  assert.equal(modelPricingStatus(cache, "partial-model", "standard"), "partial");
  assert.equal(modelPricingStatus(cache, "missing-model", "standard"), "missing");
});

test("pricing includes builtin GLM-5.2 prices without a remote cache", async () => {
  const cacheHome = await mkdtemp(join(tmpdir(), "pricing-cache-"));
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  const previousFetch = globalThis.fetch;
  try {
    process.env.XDG_CACHE_HOME = cacheHome;
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    const cache = await readModelPriceCache();

    assert.equal(modelPricingStatus(cache, "glm-5.2", "standard"), "ok");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousCacheHome;
    }
    await rm(cacheHome, { recursive: true, force: true });
  }
});

function usage(inputTokens, outputTokens) {
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}
