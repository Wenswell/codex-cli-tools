# proxy active progress write plan

## Problem

`ccs proxy serve` persists `response_bytes` after every streamed response chunk. Each update reads, parses, and atomically rewrites the complete `proxy.json`, so concurrent SSE streams cause excessive CPU, disk writes, and queued promises.

## Scope

- Persist the first streamed byte observation immediately.
- Coalesce later active-response byte updates to at most one write per second.
- Persist the exact final byte count before response completion settles.
- Keep response forwarding, completed request records, and other active-request facts unchanged.

## Acceptance

- A paused stream exposes its first chunk in `active_requests`.
- A burst of response chunks produces one initial progress update instead of one state write per chunk.
- Completion stores the exact final `response_bytes` value.
- Focused proxy tests and the full test suite pass.

## Result

- The per-request progress writer persists the first observation, coalesces later values on a one-second timer, and flushes the final byte count before completion.
- The lifecycle regression test confirms that a burst update stays in memory during the coalescing window and that history receives the exact final size.
- Focused proxy lifecycle test: 1 passed, 0 failed.
- Full `pnpm test`: 166 passed, 0 failed, 71.8 seconds.
