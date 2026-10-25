# cimg

`cimg` generates or edits one PNG through a selected or active profile. Text-only requests call `{baseURL}/v1/images/generations`; requests with one or more reference images call `{baseURL}/v1/images/edits`. If `baseURL` already ends in `/v1`, `cimg` reuses that version path without duplicating it. The default model is `gpt-image-2`; use `--model MODEL` to select another provider model, or `--profile PROFILE` to use a specific profile. Requests use `n=1` and `output_format=png`. Responses may return Base64 image data or an image URL; URL responses are downloaded and validated before saving.

Defaults for profile, model, ratio, size, quality, and output directory can be configured interactively using `cimg config`, which stores configuration under the `cimg` section of `~/.config/codex-tools/profiles.json`.

```bash
cimg
cimg config
cimg -p "A red ceramic cup on a white background"
cimg -p "A red ceramic cup on a white background" --profile fal --model fal-ai/gpt-image-2
cimg -p "A wide mountain landscape" --ratio 16:9 --size 2048x1152 --quality high
cimg -p "A vertical poster without text" --ratio 9:16 -o poster.png
cimg -p "Put the person in a studio" -i person.png
cimg -p "Combine the references into one product scene" -i product.png -i room.jpg
cimg version
cimg -v
cimg --help
```

The built-in fallback default is `1:1`, `1024x1024`, and `auto` quality. Ratios are fixed to `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`, and `9:21`; each ratio accepts only the sizes printed by `cimg --help`. Quality accepts `auto`, `low`, `medium`, or `high`.

With no arguments, `cimg` prints the active profile (or configured default), base URL, API key state, model, defaults, output directory, and request log path. Generation and editing print the complete request plan and write nothing until you type exact `yes`. Use `-i` or `--image` for one reference image, and repeat it for multiple references; accepted files are PNG, JPEG, and WebP, with at most 16 inputs smaller than 50 MiB each. Inputs are fingerprinted before confirmation and checked again before upload. After confirmation, an interactive terminal immediately prints the active size, quality, and elapsed time, then refreshes that line every 10 seconds. Non-interactive output prints one start line. The endpoint does not expose real progress, so `cimg` does not display a percentage. Press `Ctrl-C` to abort an active request; the CLI exits with status `130` after recording the cancellation. The default output is `~/Pictures/cimg/image-<timestamp>.png`; the directory is created after confirmation when needed, and existing files are not overwritten. `-o` or `--out` selects another PNG path. Completion output and logs use the PNG's actual IHDR dimensions and warn when the provider returns a different size from the request; `cimg` does not resize the image.

Every API request writes two schema v2 lifecycle events with the same `request_id`:

```text
~/.cache/codex-tools/cimg/requests.jsonl
```

`started` is appended before the HTTP request. `succeeded` or `failed` is appended after completion with duration, HTTP status, output bytes, actual PNG width and height, or normalized error facts. Editing records each input's SHA-256, byte count, and media type. User cancellation is recorded as `failed` with error code `canceled`. The bounded `0600` log stores the prompt SHA-256 and character count, not input paths, image bytes, the API key, prompt text, provider error message, response body, or image base64. See the [cimg specification](CIMG_SPEC.md) for the complete contract.

Confirmed requests also write structured diagnostic files under `~/.cache/codex-tools/cimg/raw/<request_id>/`. The existing `response.json` remains redacted with large fields summarized; `response-full.json` stores the complete redacted response and rolls over after the three newest files. Request, error, and image-download metadata remain available in older request directories. Raw diagnostic directories use private permissions.

