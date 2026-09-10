# cimg specification

This document owns the request, input, output, and runtime-record contracts for
`cimg`.

## Modes

- `cimg -p TEXT` generates one PNG through `POST {baseURL}/v1/images/generations`.
- `cimg -p TEXT -i FILE` edits one image through `POST {baseURL}/v1/images/edits`.
- Endpoint construction preserves any path prefix in `baseURL` and ensures the
  path contains exactly one `/v1` before `images`. A `baseURL` that already
  ends in `/v1` is not given a second `/v1` segment.
- `-i` and `--image` are repeatable. Multiple inputs are sent in argument order
  as reference images through the same edits endpoint.
- Masked editing is outside the command surface.
- Every request uses `model=gpt-image-2`, `n=1`, `output_format=png`, and the
  selected size and quality.

Generation sends JSON. Editing sends `multipart/form-data`: one input uses an
`image` part, while multiple inputs use repeated `image[]` parts in argument
order. They are followed by `prompt`, `model`, `size`, `quality`, `n`, and
`output_format`. Fetch owns the multipart boundary; the command does not set a
`Content-Type` header for edits.

## Image Inputs

- Accepted input extensions are `.png`, `.jpg`, `.jpeg`, and `.webp`.
- A request accepts at most 16 inputs, each smaller than 50 MiB.
- Every input must be a readable regular file.
- The preview prints each resolved input path in request order.
- The command fingerprints previewed inputs and verifies them again after
  confirmation. A changed input stops the request.
- Input files are read locally and are never modified.

## Output And Confirmation

- Output is one PNG and existing files are never overwritten.
- The default output remains `~/Pictures/cimg/image-<timestamp>.png`.
- Generation and editing print a complete preview and require exact `yes` before
  sending a request or writing an output file.
- Completion verifies PNG signature and IHDR dimensions before writing.

## Runtime Records

Each request appends schema v2 `started` and terminal lifecycle events to the
bounded private `requests.jsonl` log. Records include the request mode and, for
editing, each input's SHA-256, byte count, and media type. They exclude input
paths, image bytes, prompt text, API keys, response bodies, and provider error
messages.

For every confirmed API request, `cimg` also writes an unbounded private
diagnostic capture under `~/.cache/codex-tools/cimg/raw/<request_id>/`. It
stores structured request and response metadata, including prompt text and
provider URLs. Input image parts are represented by their names, media types,
byte counts, and SHA-256 values; image bytes and response `b64_json` values are
omitted. Response image URLs remain when provided. Authorization values are
redacted. Network failures write `error.json`. The directory uses mode `0700`
and files use mode `0600`; cleanup is manual.

## Acceptance Criteria

- No `--image` uses the existing JSON generation request.
- One or more `--image` values use one multipart edit request and preserve input
  order.
- Missing, unsupported, non-file, changed, and unreadable inputs fail before the
  API request.
- Preview, help, status commands, cancellation, PNG validation, output
  exclusivity, and private lifecycle logging remain covered by focused tests.
