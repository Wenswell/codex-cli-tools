# ccs proxy received bytes plan

## Goal

Make the overview `size` column show bytes already received for active proxy
responses, so `ccs proxy watch` visibly confirms streaming progress.

## Scope

1. Keep `response_bytes` on the active request record updated for every
   forwarded upstream response chunk.
2. Render active and completed overview rows from the same `response_bytes`
   field.
3. Add one streaming lifecycle test and document the behavior.

## Acceptance

- While an upstream stream remains open, `proxy.json.metrics.active_requests`
  contains the bytes received so far.
- `ccs proxy --once` and `ccs proxy watch` show that value in `size`.
- On completion, the history record retains the final received byte count.

## Outcome

Implemented on 2026-07-14. Upstream response reads update active request bytes
per chunk, including streams buffered for proxy inspection. The completed record
continues to use the final byte count.
