# ccs cost model breakdown plan

Status: implemented

## Goal

Align `ccs cost` with the established `ccs proxy` token and pricing semantics:

- `input` is uncached input: `input_tokens - cached_input_tokens`.
- `output` is output tokens.
- `cached` is cached input tokens.
- Each token category has an independent cost.
- Usage and cost can be aggregated and displayed by model.

## Command Contract

Add these reports:

```bash
ccs cost models
ccs cost central models
```

The `models` report applies the existing range, timezone, JSON, raw, and speed options. Rows sort by unrounded complete total cost descending, then model name. Rows with incomplete pricing follow complete rows and sort by model name.

All cost report tables use this metric order:

```text
input  output  cached  input$  output$  cached$  total$
```

Existing date, project, and time grouping remains unchanged. The `models` report provides the independent model dimension.

## Data Contract

Public report and central-status metrics use:

```text
inputTokens
outputTokens
cachedInputTokens
inputCostUSD
outputCostUSD
cachedCostUSD
costUSD
missingPricingModels
```

`inputTokens` changes directly to uncached-input semantics. Report and status payload versions increase because this is a breaking contract change. Upload snapshots and the central derived store keep their current raw fact schema.

Costs are `number | null`. A component is `null` when any model with tokens in that component lacks its required price. `costUSD` is `null` when any component is `null`. Terminal output renders `null` as `-`. `missingPricingModels` identifies incomplete model pricing.

## Implementation

1. Add a shared structured pricing calculation in `src/lib/pricing.ts`.
2. Build metrics from model usage for local and central aggregates.
3. Add local and central `models` aggregation.
4. Update terminal tables, JSON normalization, central status, help, and command summaries.
5. Add focused tests for pure input, cache, output, component costs, model sorting, missing pricing, and central report parsing.
6. Update README, cost specification, engineering preferences, built output, and package version.

## Verification

```bash
pnpm check
pnpm test
```
