# ccs proxy reasoning observability plan

Date: 2026-07-02

## Goal

Improve `ccs proxy` reasoning observability so status and history records clearly distinguish:

- Upstream returned an explicit reasoning token count.
- Upstream returned reasoning text and the explicit token count was absent.
- Reasoning metadata was absent from the observed upstream payload.

The proxy must keep `reasoning_tokens` as a numeric token-count fact from upstream usage fields. Reasoning text fields such as `reasoning_content` and `reasoning` are recorded separately as observed reasoning text metadata.

## Current finding

Recent local history shows `glm-5.2` successful SSE responses with `upstream_model=glm-5.2`, but `reasoning_tokens=null` for every request. The proxy parses the SSE model field correctly, so the missing token count comes from response field shape.

The current extractor only reads explicit integer token counts from:

- `/usage/output_tokens_details/reasoning_tokens`
- `/usage/completion_tokens_details/reasoning_tokens`
- `/response/usage/output_tokens_details/reasoning_tokens`
- `/response/usage/completion_tokens_details/reasoning_tokens`

GLM-style responses can stream reasoning text through fields such as `delta.reasoning_content`, `message.reasoning_content`, or `delta.reasoning`. These fields indicate reasoning content. Token counts remain explicit upstream count fields.

## Update principles

- Use one current schema and one current extraction path.
- Remove the current first-SSE-token behavior and store the latest explicit token count.
- Record upstream facts directly.
- Keep token counts and reasoning text observations as separate concepts.
- Add tests for every supported response shape.

## Decisions

- Keep `reasoning_tokens` as `number | null`.
- Accept only non-negative integer `reasoning_tokens` values.
- Update SSE extraction to store the latest observed `reasoning_tokens` value for the request.
- Token counts come only from explicit upstream token-count fields.
- Add explicit reasoning text observation metadata as a separate concept from token-count metrics.
- Keep the reasoning guard based on explicit `reasoning_tokens` counts only.
- Normalize old records at read time with new metadata fields set to `null` or `false`.

## Proposed request record fields

Add these fields to `ProxyRequestRecord`:

- `reasoning_tokens_source: string | null`
- `reasoning_text_observed: boolean`
- `reasoning_text_source: string | null`

Field meanings:

- `reasoning_tokens`: latest explicit upstream reasoning token count.
- `reasoning_tokens_source`: JSON Pointer or SSE JSON Pointer that produced `reasoning_tokens`.
- `reasoning_text_observed`: true when a supported reasoning text field is present and non-empty.
- `reasoning_text_source`: JSON Pointer or SSE JSON Pointer that produced the first observed reasoning text field.

Supported reasoning text paths:

- `/choices/0/delta/reasoning_content`
- `/choices/0/message/reasoning_content`
- `/choices/0/delta/reasoning`
- `/choices/0/message/reasoning`
- `/delta/reasoning_content`
- `/message/reasoning_content`
- `/delta/reasoning`
- `/message/reasoning`
- `/output/0/content/0/reasoning`
- `/response/output/0/content/0/reasoning`

The implementation should use a small JSON Pointer helper as the shared extraction API.

## Status rendering

Keep the table width stable and keep the current `reas./code` column.

Render `reas./code` as:

- `516/200` when `reasoning_tokens` is present.
- `text/200` when `reasoning_text_observed=true` and `reasoning_tokens=null`.
- `-/200` when reasoning metadata is absent.

Reasoning summary counts explicit `reasoning_tokens` events only. Text observations stay separate from `reasoning total`, `max`, and grouped counts.

## Implementation steps

1. Add structured extraction results:
   - `reasoningTokens`
   - `reasoningTokensSource`
   - `reasoningTextObserved`
   - `reasoningTextSource`

2. Replace `parseReasoningTokens` with a helper that returns value and source.

3. Update non-stream JSON inspection to read token counts and text observations.

4. Update SSE inspection and active stream scanner:
   - Emit latest explicit token count.
   - Emit first reasoning text observation.
   - Preserve accepted SSE bytes exactly.

5. Update request records, normalization, active request updates, history append, and status formatting.

6. Update reasoning token metrics to count explicit numeric token events only.

7. Update tests:
   - JSON explicit `reasoning_tokens` with source.
   - SSE latest token count replaces earlier token count.
   - Non-negative integer token values are accepted.
   - GLM-style `delta.reasoning_content` renders `text/status`, and reasoning token counters stay unchanged.
   - `application/*+json` responses enter JSON inspection.
   - Old state records normalize new fields correctly.

8. Update documentation:
   - `README.md`
   - `docs/CCS_PROXY_SPEC.md`
   - This plan file with completion notes.

9. Build and verify:
   - `pnpm build`
   - `pnpm test`
   - Targeted `ccs proxy --once` output check with fixture coverage through tests.

10. Commit the completed change with a patch version increment.

## Questions to confirm

Recommended defaults are listed below. Confirm only if a different behavior is preferred.

| Topic | Recommended decision |
| --- | --- |
| Status text marker | Use `text` in `reas./code` for reasoning text with absent token count. |
| Text source paths | Support the listed GLM/OpenAI-compatible paths only. |
| Guard scope | Keep guard tied to explicit numeric `reasoning_tokens` only. |
| Metrics scope | Keep `reasoning total` as token-count events only. |

## Completion criteria

- GLM-style reasoning text renders as `text/200` when text metadata is present.
- Explicit token-count metrics remain numerically clean.
- SSE records store the latest observed explicit token count.
- Documentation states the difference between token counts and reasoning text observations.
