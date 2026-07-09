import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildModelPriceModelUpdatePlan,
  calculateCodexCostUSD,
  missingPricingModels,
  modelPricingStatus,
  readModelPriceCache,
  writeModelPriceModelUpdatePlan,
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

test("pricing updates only selected model cache entries", async () => {
  const cacheHome = await mkdtemp(join(tmpdir(), "pricing-update-cache-"));
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  const previousFetch = globalThis.fetch;
  try {
    process.env.XDG_CACHE_HOME = cacheHome;
    await writePriceCache(cacheHome, {
      "kept-model": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000004,
        cache_read_input_token_cost: 0.0000003,
      },
      "updated-model": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    });
    globalThis.fetch = async () => new Response(JSON.stringify({
      "updated-model": {
        input_cost_per_token: 0.000011,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000011,
      },
    }), { status: 200 });

    const plan = await buildModelPriceModelUpdatePlan([" updated-model ", "updated-model", "missing-model", ""], "standard");

    assert.deepEqual(plan.records, [
      { model: "updated-model", cached: "partial", remote: "ok", action: "update" },
      { model: "missing-model", cached: "missing", remote: "missing", action: "missing" },
    ]);
    await writeModelPriceModelUpdatePlan(plan);
    const cache = await readModelPriceCache();

    assert.equal(cache.models["kept-model"].input_cost_per_token, 0.000003);
    assert.equal(cache.models["updated-model"].input_cost_per_token, 0.000011);
    assert.equal(cache.models["missing-model"], undefined);
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

test("pricing expands star patterns against remote model names", async () => {
  const cacheHome = await mkdtemp(join(tmpdir(), "pricing-pattern-cache-"));
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  const previousFetch = globalThis.fetch;
  try {
    process.env.XDG_CACHE_HOME = cacheHome;
    await writePriceCache(cacheHome, {});
    globalThis.fetch = async () => new Response(JSON.stringify({
      "gpt-5": modelPriceFixture(0.000001),
      "gpt-5.5": modelPriceFixture(0.000005),
      "gpt-5.4": modelPriceFixture(0.000004),
      "gpt-5x": modelPriceFixture(0.000009),
      "claude-sonnet-4.5": modelPriceFixture(0.000006),
    }), { status: 200 });

    const plan = await buildModelPriceModelUpdatePlan(["gpt-5.5", "gpt-5.*", "missing-*"], "standard");

    assert.deepEqual(plan.records.map((record) => record.model), ["gpt-5.5", "gpt-5.4", "missing-*"]);
    assert.deepEqual(plan.records.map((record) => record.action), ["update", "update", "missing"]);
    await writeModelPriceModelUpdatePlan(plan);
    const cache = await readModelPriceCache();

    assert.equal(cache.models["gpt-5"], undefined);
    assert.equal(cache.models["gpt-5.4"].input_cost_per_token, 0.000004);
    assert.equal(cache.models["gpt-5.5"].input_cost_per_token, 0.000005);
    assert.equal(cache.models["gpt-5x"], undefined);
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

test("pricing model update plan fails before cache writes when remote fetch fails", async () => {
  const cacheHome = await mkdtemp(join(tmpdir(), "pricing-update-fail-cache-"));
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  const previousFetch = globalThis.fetch;
  try {
    process.env.XDG_CACHE_HOME = cacheHome;
    await writePriceCache(cacheHome, {
      "kept-model": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000004,
      },
    });
    globalThis.fetch = async () => {
      throw new Error("offline");
    };

    await assert.rejects(
      buildModelPriceModelUpdatePlan(["kept-model"], "standard"),
      /pricing cache missing and refresh failed/,
    );
    const cache = await readModelPriceCache();

    assert.equal(cache.source, "test");
    assert.equal(cache.models["kept-model"].input_cost_per_token, 0.000003);
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

function modelPriceFixture(inputCostPerToken) {
  return {
    input_cost_per_token: inputCostPerToken,
    output_cost_per_token: inputCostPerToken * 2,
    cache_read_input_token_cost: inputCostPerToken / 10,
  };
}

async function writePriceCache(cacheHome, models) {
  const dir = join(cacheHome, "codex-tools");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "model-prices.json"), JSON.stringify({
    source: "test",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    models,
  }, null, 2), "utf8");
}
