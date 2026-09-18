import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { rejectRemovedYesFlags } from "../lib/confirm.js";
import { ensureDir } from "../lib/fs.js";
import { formatCompactBytes, formatDurationMs } from "../lib/format.js";
import { colorPath, colorUrl, printKeyValue } from "../lib/output.js";
import { codexToolsCacheDir, formatHomePath, homeDir, profilesPath } from "../lib/paths.js";
import { assertProfile, readProfiles, writeProfiles, type Profile, type ProfilesFile } from "../lib/profiles.js";
import { appendBoundedJsonLine } from "../lib/runtime-log.js";
import { textDim, textGreen, textRed, textYellow } from "../lib/text.js";
import { printToolVersionIfRequested } from "../lib/version.js";

export const CIMG_MODEL = "gpt-image-2";
export const CIMG_DEFAULT_RATIO = "1:1";
export const CIMG_DEFAULT_QUALITY = "auto";

const requestTimeoutMs = 300_000;
const CIMG_PROGRESS_INTERVAL_MS = 10_000;
const requestLogMaxBytes = 16 * 1024 * 1024;
const requestLogTrimBytes = 12 * 1024 * 1024;
const maxInputImages = 16;
const maxInputImageBytes = 50 * 1024 * 1024;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const CIMG_SIZES = {
  "1:1": ["1024x1024", "1536x1536", "2048x2048", "2560x2560"],
  "3:2": ["1536x1024", "3072x2048"],
  "2:3": ["1024x1536", "2048x3072"],
  "4:3": ["1024x768", "1536x1152", "2048x1536", "3072x2304"],
  "3:4": ["768x1024", "1152x1536", "1536x2048", "2304x3072"],
  "16:9": ["1280x720", "1536x864", "1792x1008", "2048x1152", "2560x1440", "3072x1728", "3840x2160"],
  "9:16": ["720x1280", "864x1536", "1008x1792", "1152x2048", "1440x2560", "1728x3072", "2160x3840"],
  "21:9": ["1344x576", "1792x768", "2240x960", "2688x1152", "3136x1344", "3584x1536"],
  "9:21": ["576x1344", "768x1792", "960x2240", "1152x2688", "1344x3136", "1536x3584"],
} as const;

type CimgRatio = keyof typeof CIMG_SIZES;
type CimgQuality = "auto" | "low" | "medium" | "high";

export const CIMG_DEFAULT_SIZES: Record<CimgRatio, string> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "16:9": "1792x1008",
  "9:16": "1008x1792",
  "21:9": "1344x576",
  "9:21": "576x1344",
};

type CimgArgs = {
  prompt: string;
  profile?: string;
  model: string;
  ratio: CimgRatio;
  size: string;
  quality: CimgQuality;
  outputPath: string;
  inputPaths: string[];
};

export type CimgResolvedDefaults = {
  profile?: string;
  model: string;
  ratio: CimgRatio;
  size: string;
  quality: CimgQuality;
  outputDir: string;
};

export function resolveCimgDefaults(profiles: ProfilesFile): CimgResolvedDefaults {
  const config = profiles.cimg ?? {};
  const ratio = (config.ratio && isRatio(config.ratio)) ? config.ratio : CIMG_DEFAULT_RATIO;
  const defaultSizeForRatio = CIMG_DEFAULT_SIZES[ratio];
  const size = (config.size && (CIMG_SIZES[ratio] as readonly string[]).includes(config.size))
    ? config.size
    : defaultSizeForRatio;
  const quality = (config.quality && isQuality(config.quality)) ? config.quality : CIMG_DEFAULT_QUALITY;
  const model = config.model?.trim() || CIMG_MODEL;
  const outputDir = config.outputDir?.trim() ? resolve(config.outputDir.trim()) : cimgDefaultOutputDir();
  const profile = config.profile?.trim() || undefined;

  return { profile, model, ratio, size, quality, outputDir };
}

type CimgMode = "generate" | "edit";

type ImageInput = {
  path: string;
  name: string;
  mediaType: string;
  bytes: Buffer;
  sha256: string;
};

type ImageResponse = {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { code?: string; message?: string };
};

type RequestResult = {
  bytes: Buffer;
  httpStatus: number;
  width: number;
  height: number;
};

type RequestEvent = {
  version: 2;
  recorded_at: string;
  source: "cimg";
  request_id: string;
  event: "started" | "succeeded" | "failed";
  config: {
    profile: string;
    base_url: string;
    endpoint: string;
    model: string;
    mode: CimgMode;
    ratio: CimgRatio;
    size: string;
    quality: CimgQuality;
  };
  prompt: {
    sha256: string;
    characters: number;
  };
  inputs: Array<{
    sha256: string;
    bytes: number;
    media_type: string;
  }>;
  result?: {
    duration_ms: number;
    http_status: number | null;
    output_path: string | null;
    output_bytes: number | null;
    output_width: number | null;
    output_height: number | null;
    error: { code: string; message: string } | null;
  };
};

type CimgDependencies = {
  fetch: typeof fetch;
  confirm: () => Promise<boolean>;
  now: () => Date;
  requestId: () => string;
  profiles: () => Promise<ProfilesFile>;
  appendEvent: (event: RequestEvent) => Promise<void>;
  appendRaw: (requestId: string, name: string, content: string) => Promise<void>;
};

const defaultDependencies: CimgDependencies = {
  fetch,
  confirm: confirmGeneration,
  now: () => new Date(),
  requestId: randomUUID,
  profiles: readProfiles,
  appendEvent: (event) => appendBoundedJsonLine(cimgRequestsPath(), event, {
    maxBytes: requestLogMaxBytes,
    trimToBytes: requestLogTrimBytes,
    mode: 0o600,
  }),
  appendRaw: writeCimgRaw,
};

export async function runCimg(argv: string[], overrides: Partial<CimgDependencies> = {}): Promise<void> {
  if (printToolVersionIfRequested("cimg", argv)) {
    return;
  }
  if (argv.length === 1 && isHelp(argv[0])) {
    printHelp();
    return;
  }

  const dependencies = { ...defaultDependencies, ...overrides };
  if (argv.length === 0) {
    printStatus(await dependencies.profiles());
    return;
  }

  if (argv.length === 1 && argv[0] === "config") {
    await runCimgConfig(await dependencies.profiles());
    return;
  }

  const profilesData = await dependencies.profiles();
  const cimgDefaults = resolveCimgDefaults(profilesData);
  const args = parseArgs(argv, dependencies.now(), cimgDefaults);
  const active = resolveActiveProfile(profilesData, args.profile);
  const mode = requestMode(args);
  const endpoint = buildEndpoint(active.profile.baseURL, mode);
  const previewInputs = await readImageInputs(args.inputPaths);
  await assertOutputAvailable(args.outputPath);
  printPreview(active.name, endpoint, args);
  if (!(await dependencies.confirm())) {
    return;
  }

  const inputs = await verifyImageInputs(previewInputs);

  await ensureDir(dirname(args.outputPath));
  const requestId = dependencies.requestId();
  const startedAt = dependencies.now();
  const baseEvent = buildBaseEvent(requestId, startedAt, active.name, active.profile.baseURL, endpoint, args, inputs);
  await dependencies.appendEvent({ ...baseEvent, event: "started" });

  const abortController = new AbortController();
  const cancelRequest = (): void => abortController.abort();
  const progress = startImageProgress(mode, args.size, args.quality);
  process.once("SIGINT", cancelRequest);
  let response: RequestResult;
  try {
    response = await requestImage(
      dependencies.fetch,
      endpoint,
      active.profile.apiKey,
      args,
      inputs,
      requestId,
      dependencies.appendRaw,
      abortController.signal,
    );
    await writeFile(args.outputPath, response.bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    progress.stop();
    const completedAt = dependencies.now();
    const normalized = normalizeError(error);
    await dependencies.appendEvent({
      ...baseEvent,
      recorded_at: completedAt.toISOString(),
      event: "failed",
      result: {
        duration_ms: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        http_status: error instanceof CimgHttpError ? error.status : null,
        output_path: null,
        output_bytes: null,
        output_width: null,
        output_height: null,
        error: normalized,
      },
    });
    printCimgValue("raw:", colorPath(formatHomePath(cimgRawDir(requestId))));
    throw error;
  } finally {
    process.off("SIGINT", cancelRequest);
    progress.stop();
  }

  const completedAt = dependencies.now();
  const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
  await dependencies.appendEvent({
    ...baseEvent,
    recorded_at: completedAt.toISOString(),
    event: "succeeded",
    result: {
      duration_ms: durationMs,
      http_status: response.httpStatus,
      output_path: args.outputPath,
      output_bytes: response.bytes.length,
      output_width: response.width,
      output_height: response.height,
      error: null,
    },
  });
  printCimgValue("result:", textGreen(mode === "edit" ? "edited" : "generated"));
  printCimgValue("output:", colorPath(formatHomePath(args.outputPath)));
  printCimgValue("image:", `${response.width}x${response.height} ${formatCompactBytes(response.bytes.length)}`);
  printCimgValue("duration:", formatDurationMs(durationMs));
  printCimgValue("log:", colorPath(formatHomePath(cimgRequestsPath())));
  printCimgValue("raw:", colorPath(formatHomePath(cimgRawDir(requestId))));
  if (`${response.width}x${response.height}` !== args.size) {
    printCimgValue("warning:", textYellow(`requested ${args.size}, received ${response.width}x${response.height}`));
  }
}

export function parseArgs(
  argv: string[],
  now = new Date(),
  defaults?: Partial<CimgResolvedDefaults>,
): CimgArgs {
  rejectRemovedYesFlags(argv, "cimg");
  let prompt: string | undefined;
  let profile = defaults?.profile;
  let model = defaults?.model ?? CIMG_MODEL;
  let ratio: CimgRatio = (defaults?.ratio && isRatio(defaults.ratio)) ? defaults.ratio : CIMG_DEFAULT_RATIO;
  let size: string | undefined = defaults?.size;
  let quality: CimgQuality = (defaults?.quality && isQuality(defaults.quality)) ? defaults.quality : CIMG_DEFAULT_QUALITY;
  let outputPath: string | undefined;
  const inputPaths: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-p" || arg === "--prompt") {
      prompt = requireValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--profile") {
      profile = requireValue(argv, index).trim();
      if (!profile) {
        throw new Error("--profile requires a non-empty value");
      }
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = requireValue(argv, index).trim();
      if (!model) {
        throw new Error("--model requires a non-empty value");
      }
      index += 1;
      continue;
    }
    if (arg === "--ratio") {
      const value = requireValue(argv, index);
      if (!isRatio(value)) {
        throw new Error(`invalid ratio: ${value}; expected ${Object.keys(CIMG_SIZES).join(" | ")}`);
      }
      ratio = value;
      // If size was not explicitly passed via CLI, reset to defaults or default size for this ratio
      size = undefined;
      index += 1;
      continue;
    }
    if (arg === "--size") {
      size = requireValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--quality") {
      const value = requireValue(argv, index);
      if (!isQuality(value)) {
        throw new Error(`invalid quality: ${value}; expected auto | low | medium | high`);
      }
      quality = value;
      index += 1;
      continue;
    }
    if (arg === "-o" || arg === "--out") {
      outputPath = requireValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "-i" || arg === "--image") {
      inputPaths.push(resolve(requireValue(argv, index)));
      index += 1;
      continue;
    }
    if (isHelp(arg)) {
      throw new Error("help must be used without generation arguments");
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  const normalizedPrompt = prompt?.trim() ?? "";
  if (!normalizedPrompt) {
    throw new Error("-p/--prompt is required");
  }
  const resolvedSize = size ?? CIMG_DEFAULT_SIZES[ratio];
  if (!(CIMG_SIZES[ratio] as readonly string[]).includes(resolvedSize)) {
    throw new Error(`invalid size for ${ratio}: ${resolvedSize}; expected ${CIMG_SIZES[ratio].join(" | ")}`);
  }
  const baseOutputDir = defaults?.outputDir ?? cimgDefaultOutputDir();
  const resolvedOutput = outputPath
    ? resolve(outputPath)
    : join(baseOutputDir, defaultOutputName(now));
  if (!resolvedOutput.toLowerCase().endsWith(".png")) {
    throw new Error("output path must end with .png");
  }

  for (const inputPath of inputPaths) {
    if (!imageMediaType(inputPath)) {
      throw new Error(`unsupported input image: ${inputPath}; expected .png | .jpg | .jpeg | .webp`);
    }
  }
  if (inputPaths.length > maxInputImages) {
    throw new Error(`too many input images: ${inputPaths.length}; maximum is ${maxInputImages}`);
  }

  return { prompt: normalizedPrompt, profile, model, ratio, size: resolvedSize, quality, outputPath: resolvedOutput, inputPaths };
}

export function buildRequestBody(args: Pick<CimgArgs, "prompt" | "model" | "size" | "quality">): Record<string, unknown> {
  return {
    prompt: args.prompt,
    model: args.model,
    size: args.size,
    quality: args.quality,
    n: 1,
    output_format: "png",
  };
}

export function buildEditRequestBody(
  args: Pick<CimgArgs, "prompt" | "model" | "size" | "quality">,
  inputs: Array<Pick<ImageInput, "name" | "mediaType" | "bytes">>,
): FormData {
  const body = new FormData();
  const imageField = inputs.length === 1 ? "image" : "image[]";
  for (const input of inputs) {
    body.append(imageField, new Blob([new Uint8Array(input.bytes)], { type: input.mediaType }), input.name);
  }
  body.append("prompt", args.prompt);
  body.append("model", args.model);
  body.append("size", args.size);
  body.append("quality", args.quality);
  body.append("n", "1");
  body.append("output_format", "png");
  return body;
}

export function buildEndpoint(baseURL: string, mode: CimgMode = "generate"): string {
  const normalized = baseURL.trim().replace(/\/+$/u, "");
  if (!normalized) {
    throw new Error("active profile baseURL is empty");
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("active profile baseURL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("active profile baseURL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("active profile baseURL must not contain credentials, a query, or a fragment");
  }
  const resource = mode === "edit" ? "edits" : "generations";
  const pathWithoutVersion = url.pathname.replace(/\/+$/u, "").replace(/(?:\/v1)+$/u, "");
  url.pathname = `${pathWithoutVersion}/v1/images/${resource}`;
  return url.toString();
}

function cimgRequestsPath(): string {
  return resolve(codexToolsCacheDir(), "cimg", "requests.jsonl");
}

export function cimgDefaultOutputDir(): string {
  return join(homeDir(), "Pictures", "cimg");
}

function cimgRawDir(requestId: string): string {
  return resolve(codexToolsCacheDir(), "cimg", "raw", requestId);
}

async function writeCimgRaw(requestId: string, name: string, content: string): Promise<void> {
  const directory = cimgRawDir(requestId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  if (name === "response-full.json") {
    await pruneCimgFullResponses();
  }
}

export async function pruneCimgFullResponses(): Promise<void> {
  const root = resolve(codexToolsCacheDir(), "cimg", "raw");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const responses: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(root, entry.name, "response-full.json");
    try {
      const fileStat = await stat(path);
      if (fileStat.isFile()) {
        responses.push({ path, mtimeMs: fileStat.mtimeMs });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  responses.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  await Promise.all(responses.slice(3).map((response) => rm(response.path, { force: true })));
}

async function requestImage(
  fetchImpl: typeof fetch,
  endpoint: string,
  apiKey: string,
  args: CimgArgs,
  inputs: ImageInput[],
  requestId: string,
  appendRaw: CimgDependencies["appendRaw"],
  cancelSignal: AbortSignal,
): Promise<RequestResult> {
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  const editing = inputs.length > 0;
  const headers = {
    authorization: "[redacted]",
    ...(editing ? {} : { "content-type": "application/json" }),
  };
  const requestBody = editing ? buildEditRequestBody(args, inputs) : JSON.stringify(buildRequestBody(args));
  const diagnosticBody = editing ? buildEditRequestSummary(args, inputs) : buildRequestBody(args);
  await appendRaw(requestId, "request.json", JSON.stringify({
    version: 1,
    recorded_at: new Date().toISOString(),
    method: "POST",
    url: endpoint,
    headers,
    body: diagnosticBody,
  }, null, 2));
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(editing ? {} : { "Content-Type": "application/json" }),
      },
      body: requestBody,
      signal: AbortSignal.any([cancelSignal, timeoutSignal]),
    });
  } catch (error) {
    await appendRaw(requestId, "error.json", JSON.stringify({
      recorded_at: new Date().toISOString(),
      error: normalizeError(error),
    }, null, 2));
    if (cancelSignal.aborted) {
      throw new CimgCanceledError();
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("image request timed out after 300 seconds");
    }
    throw error;
  }

  const text = await response.text();
  await appendRaw(requestId, "response.json", JSON.stringify({
    version: 1,
    recorded_at: new Date().toISOString(),
    status: response.status,
    headers: sanitizeResponseHeaders(response.headers),
    body: sanitizeResponseBody(text),
  }, null, 2));
  await appendRaw(requestId, "response-full.json", JSON.stringify({
    version: 1,
    recorded_at: new Date().toISOString(),
    status: response.status,
    headers: sanitizeResponseHeaders(response.headers),
    body: sanitizeCompleteResponseBody(text),
  }, null, 2));
  let payload: ImageResponse;
  try {
    payload = parseResponse(text);
  } catch {
    throw new CimgHttpError(response.status, "invalid_json", "image API returned invalid JSON");
  }
  if (!response.ok) {
    throw new CimgHttpError(
      response.status,
      payload.error?.code ?? `http_${response.status}`,
      payload.error?.message ?? `image generation failed with HTTP ${response.status}`,
    );
  }
  const image = payload.data?.[0];
  if (!image) {
    throw new CimgHttpError(response.status, "missing_image", "image API response is missing data[0]");
  }
  let bytes: Buffer;
  if (image.b64_json) {
    bytes = Buffer.from(image.b64_json, "base64");
  } else if (image.url) {
    let imageURL: URL;
    try {
      imageURL = new URL(image.url);
    } catch {
      throw new CimgHttpError(response.status, "invalid_image_url", "image API response contains an invalid image URL");
    }
    if (imageURL.protocol !== "https:" && imageURL.protocol !== "http:") {
      throw new CimgHttpError(response.status, "invalid_image_url", "image API response image URL must use http or https");
    }
    let imageResponse: Response;
    try {
      imageResponse = await fetchImpl(imageURL, { signal: AbortSignal.any([cancelSignal, timeoutSignal]) });
    } catch (error) {
      throw new Error(`image URL download failed: ${normalizeError(error).message}`);
    }
    if (!imageResponse.ok) {
      throw new CimgHttpError(imageResponse.status, "image_download_failed", `image URL download failed with HTTP ${imageResponse.status}`);
    }
    bytes = Buffer.from(await imageResponse.arrayBuffer());
    await appendRaw(requestId, "image-response.json", JSON.stringify({
      version: 1,
      recorded_at: new Date().toISOString(),
      url: image.url,
      status: imageResponse.status,
      headers: Object.fromEntries(imageResponse.headers.entries()),
      bytes: bytes.length,
    }, null, 2));
  } else {
    throw new CimgHttpError(response.status, "missing_image", "image API response has no b64_json or url");
  }
  if (bytes.length < pngSignature.length || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new CimgHttpError(response.status, "invalid_image", "image API response is not a PNG");
  }
  if (bytes.length < 24 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new CimgHttpError(response.status, "invalid_image", "image API response has no PNG IHDR");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new CimgHttpError(response.status, "invalid_image", "image API response has invalid PNG dimensions");
  }
  return { bytes, httpStatus: response.status, width, height };
}

function buildEditRequestSummary(
  args: Pick<CimgArgs, "prompt" | "model" | "size" | "quality">,
  inputs: ImageInput[],
): Record<string, unknown> {
  return {
    prompt: args.prompt,
    model: args.model,
    size: args.size,
    quality: args.quality,
    n: 1,
    output_format: "png",
    images: inputs.map((input) => ({
      name: input.name,
      media_type: input.mediaType,
      bytes: input.bytes.length,
      sha256: input.sha256,
    })),
  };
}

function sanitizeResponseBody(text: string): unknown {
  try {
    return sanitizeResponseValue(JSON.parse(text) as unknown);
  } catch {
    return { format: "text", text };
  }
}

function sanitizeResponseValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeResponseValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === "b64_json" && typeof child === "string") {
      return [key, { omitted: true, encoded_bytes: Buffer.byteLength(child, "utf8") }];
    }
    return [key, sanitizeResponseValue(child)];
  }));
}

function sanitizeCompleteResponseBody(text: string): unknown {
  try {
    return sanitizeCompleteResponseValue(JSON.parse(text) as unknown);
  } catch {
    return { format: "text", text };
  }
}

function sanitizeCompleteResponseValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeCompleteResponseValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    isSensitiveField(key) ? "[redacted]" : sanitizeCompleteResponseValue(child),
  ]));
}

function sanitizeResponseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].map(([key, value]) => [
    key,
    isSensitiveField(key) ? "[redacted]" : value,
  ]));
}

function isSensitiveField(key: string): boolean {
  return /(?:authorization|cookie|token|secret|password|api[-_]?key)/iu.test(key);
}

function parseResponse(text: string): ImageResponse {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("response is not an object");
  }
  return parsed as ImageResponse;
}

function resolveActiveProfile(profiles: ProfilesFile, explicitName?: string): { name: string; profile: Profile } {
  const name = explicitName?.trim() || profiles.cimg?.profile?.trim() || profiles.current?.trim();
  if (!name) {
    throw new Error("profiles.json has no current profile");
  }
  const profile = assertProfile(profiles.profiles?.[name], name);
  if (!profile.baseURL.trim()) {
    throw new Error(`profile ${name} has no baseURL`);
  }
  if (!profile.apiKey.trim()) {
    throw new Error(`profile ${name} has no apiKey`);
  }
  return { name, profile };
}

function printStatus(profiles: ProfilesFile): void {
  const defaults = resolveCimgDefaults(profiles);
  const active = (() => {
    try {
      return resolveActiveProfile(profiles);
    } catch {
      return undefined;
    }
  })();
  const name = active?.name ?? profiles.current?.trim() ?? "-";
  const candidate = name === "-" ? undefined : profiles.profiles?.[name];
  const baseURL = candidate && typeof candidate.baseURL === "string" && candidate.baseURL.trim() ? candidate.baseURL : "-";
  const apiKey = candidate && typeof candidate.apiKey === "string" && candidate.apiKey.trim() ? textGreen("set") : textRed("missing");
  const profileDisplay = profiles.cimg?.profile ? `${name} (cimg default)` : name;
  printCimgValue("profile:", profileDisplay);
  printCimgValue("api:", baseURL === "-" ? textYellow(baseURL) : colorUrl(baseURL));
  printCimgValue("key:", apiKey);
  printCimgValue("model:", defaults.model);
  printCimgValue("defaults:", `${defaults.ratio} ${defaults.size} ${defaults.quality}`);
  printCimgValue("output:", colorPath(formatHomePath(defaults.outputDir)));
  printCimgValue("log:", colorPath(formatHomePath(cimgRequestsPath())));
  console.log("commands: cimg -p TEXT [-i FILE ...] | config | version|-v | --help");
}

function printPreview(profile: string, endpoint: string, args: CimgArgs): void {
  printCimgValue("profile:", profile);
  printCimgValue("endpoint:", colorUrl(endpoint));
  printCimgValue("model:", args.model);
  printCimgValue("mode:", requestMode(args));
  args.inputPaths.forEach((path, index) => printCimgValue(`image ${index + 1}:`, colorPath(formatHomePath(path))));
  printCimgValue("ratio:", args.ratio);
  printCimgValue("size:", args.size);
  printCimgValue("quality:", args.quality);
  printCimgValue("output:", colorPath(formatHomePath(args.outputPath)));
  printCimgValue("log:", colorPath(formatHomePath(cimgRequestsPath())));
  console.log(textDim("no request is sent and no image is written unless you type yes at the prompt."));
}

function printHelp(): void {
  console.log([
    "Usage:",
    "  cimg                                                        # show active image generation status",
    "  cimg -p TEXT [--profile PROFILE] [--model MODEL] [--ratio RATIO] [--size SIZE] [--quality QUALITY] [-o FILE] # preview and generate one PNG",
    "  cimg -p TEXT -i FILE [-i FILE ...] [OPTIONS]                # preview and edit from reference images",
    "  cimg config                                                 # interactively view and configure default values",
    "  cimg version                                                # print package version",
    "  cimg -v                                                     # print package version",
    "  cimg help | -h | --help                                     # show this help",
    "",
    "Options:",
    "  --profile PROFILE provider profile (default: cimg config or current ccs profile)",
    `  --ratio RATIO    ${Object.keys(CIMG_SIZES).join(" | ")} (default: ${CIMG_DEFAULT_RATIO})`,
    `  --model MODEL    provider model (default: ${CIMG_MODEL})`,
    "  --size SIZE      one fixed size listed for the selected ratio",
    "  --quality VALUE  auto | low | medium | high (default: auto)",
    "  -i, --image FILE input PNG, JPEG, or WebP; repeat for multiple reference images",
    "  -o, --out FILE   output PNG path (default: ~/Pictures/cimg/image-<timestamp>.png)",
    "  -p, --prompt     text prompt",
    "",
    "Image inputs:",
    "  one input edits the source; repeat -i/--image for ordered reference images",
    "  accepts PNG, JPEG, or WebP; at most 16 files, each smaller than 50 MiB",
    "  masked editing is not part of this command",
    "",
    "Requests:",
    "  preview is shown before exact yes confirmation; Ctrl-C cancels an active request",
    "  elapsed time refreshes every 10 seconds in a terminal; Ctrl-C cancels the request",
    "",
    "Sizes:",
    ...Object.entries(CIMG_SIZES).map(([ratio, sizes]) => `  ${ratio.padEnd(5)} ${sizes.join(" | ")}`),
  ].join("\n"));
}

async function confirmGeneration(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("");
    console.log(textDim("not generated. Re-run in an interactive terminal and type yes to generate."));
    return false;
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question("\nGenerate image? Type yes to continue: ");
    if (answer === "yes") {
      return true;
    }
    console.log(textDim("not generated."));
    return false;
  } finally {
    input.close();
  }
}

type Prompt = {
  question(prompt: string): Promise<string>;
  close(): void;
};

function createPrompt(): Prompt {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const iterator = rl[Symbol.asyncIterator]();

  return {
    async question(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      const next = await iterator.next();
      return next.done ? "" : next.value;
    },
    close(): void {
      rl.close();
    },
  };
}

async function askOptional(
  input: Prompt,
  label: string,
  current?: string,
): Promise<string> {
  const suffix = current ? ` [${current}]` : "";
  const value = await input.question(`${label}${suffix}: `);
  return value.trim() || current || "";
}

export async function runCimgConfig(
  profilesData?: ProfilesFile,
  promptImpl: () => Prompt = createPrompt,
  writeProfilesImpl: (profiles: ProfilesFile) => Promise<void> = writeProfiles,
): Promise<void> {
  const data = profilesData ?? await readProfiles();
  const availableProfiles = Object.keys(data.profiles ?? {});
  const currentConfig = data.cimg ?? {};
  const effectiveDefaults = resolveCimgDefaults(data);

  console.log("Configure cimg default settings (press Enter to keep current value):\n");
  if (availableProfiles.length > 0) {
    console.log(`available profiles: ${availableProfiles.join(", ")}`);
  }

  const prompt = promptImpl();
  let nextProfile: string | undefined;
  let nextModel: string | undefined;
  let nextRatio: string | undefined;
  let nextSize: string | undefined;
  let nextQuality: string | undefined;
  let nextOutputDir: string | undefined;

  try {
    const rawProfile = await askOptional(
      prompt,
      "1. default profile (leave empty or '-' to follow current ccs profile)",
      currentConfig.profile ?? "-",
    );
    if (rawProfile && rawProfile !== "-") {
      if (!data.profiles?.[rawProfile]) {
        throw new Error(`profile not found: ${rawProfile}; available: ${availableProfiles.join(", ")}`);
      }
      nextProfile = rawProfile;
    } else {
      nextProfile = undefined;
    }

    const rawModel = await askOptional(
      prompt,
      "2. default model",
      currentConfig.model ?? CIMG_MODEL,
    );
    nextModel = rawModel.trim() || CIMG_MODEL;

    const rawRatio = await askOptional(
      prompt,
      `3. default ratio (${Object.keys(CIMG_SIZES).join(" | ")})`,
      currentConfig.ratio ?? CIMG_DEFAULT_RATIO,
    );
    if (!isRatio(rawRatio)) {
      throw new Error(`invalid ratio: ${rawRatio}; expected ${Object.keys(CIMG_SIZES).join(" | ")}`);
    }
    nextRatio = rawRatio;

    const availableSizes = CIMG_SIZES[nextRatio as CimgRatio] as readonly string[];
    const defaultSizeForRatio = CIMG_DEFAULT_SIZES[nextRatio as CimgRatio];
    const sizeCurrent = (currentConfig.size && availableSizes.includes(currentConfig.size))
      ? currentConfig.size
      : defaultSizeForRatio;

    const rawSize = await askOptional(
      prompt,
      `4. default size for ${nextRatio} (${availableSizes.join(" | ")})`,
      sizeCurrent,
    );
    if (!availableSizes.includes(rawSize)) {
      throw new Error(`invalid size for ${nextRatio}: ${rawSize}; expected ${availableSizes.join(" | ")}`);
    }
    nextSize = rawSize;

    const rawQuality = await askOptional(
      prompt,
      "5. default quality (auto | low | medium | high)",
      currentConfig.quality ?? CIMG_DEFAULT_QUALITY,
    );
    if (!isQuality(rawQuality)) {
      throw new Error(`invalid quality: ${rawQuality}; expected auto | low | medium | high`);
    }
    nextQuality = rawQuality;

    const rawOutputDir = await askOptional(
      prompt,
      "6. default output directory",
      currentConfig.outputDir ?? cimgDefaultOutputDir(),
    );
    nextOutputDir = rawOutputDir.trim() || cimgDefaultOutputDir();
  } finally {
    prompt.close();
  }

  const updatedCimgConfig: Record<string, string> = {};
  if (nextProfile) updatedCimgConfig.profile = nextProfile;
  if (nextModel) updatedCimgConfig.model = nextModel;
  if (nextRatio) updatedCimgConfig.ratio = nextRatio;
  if (nextSize) updatedCimgConfig.size = nextSize;
  if (nextQuality) updatedCimgConfig.quality = nextQuality;
  if (nextOutputDir) updatedCimgConfig.outputDir = nextOutputDir;

  const nextProfilesData: ProfilesFile = {
    ...data,
    cimg: Object.keys(updatedCimgConfig).length > 0 ? updatedCimgConfig : undefined,
  };

  await writeProfilesImpl(nextProfilesData);
  console.log(`\ncimg configuration saved: ${textGreen(profilesPath())}`);
  printStatus(nextProfilesData);
}

function buildBaseEvent(
  requestId: string,
  recordedAt: Date,
  profile: string,
  baseURL: string,
  endpoint: string,
  args: CimgArgs,
  inputs: ImageInput[],
): Omit<RequestEvent, "event"> {
  return {
    version: 2,
    recorded_at: recordedAt.toISOString(),
    source: "cimg",
    request_id: requestId,
    config: {
      profile,
      base_url: baseURL,
      endpoint,
      model: args.model,
      mode: requestMode(args),
      ratio: args.ratio,
      size: args.size,
      quality: args.quality,
    },
    prompt: {
      sha256: createHash("sha256").update(args.prompt).digest("hex"),
      characters: [...args.prompt].length,
    },
    inputs: inputs.map((input) => ({
      sha256: input.sha256,
      bytes: input.bytes.length,
      media_type: input.mediaType,
    })),
  };
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof CimgCanceledError) {
    return { code: "canceled", message: "image request canceled by user" };
  }
  if (error instanceof CimgHttpError) {
    return { code: error.code, message: `image request failed with HTTP ${error.status}` };
  }
  if (error instanceof Error) {
    return { code: error.name || "Error", message: normalizeMessage(error.message) };
  }
  return { code: "unknown_error", message: normalizeMessage(String(error)) };
}

function normalizeMessage(message: string): string {
  return message.replace(/\s+/gu, " ").trim().slice(0, 500) || "unknown error";
}

function defaultOutputName(now: Date): string {
  const iso = now.toISOString().replace(/[-:]/gu, "").replace("T", "-").replace(".", "-").replace("Z", "");
  return `image-${iso}.png`;
}

function requireValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${argv[index]} requires a value`);
  }
  return value;
}

function isRatio(value: string): value is CimgRatio {
  return Object.hasOwn(CIMG_SIZES, value);
}

function isQuality(value: string): value is CimgQuality {
  return value === "auto" || value === "low" || value === "medium" || value === "high";
}

function isHelp(value: string | undefined): boolean {
  return value === "help" || value === "-h" || value === "--help";
}

function printCimgValue(label: string, value: string): void {
  printKeyValue(label, value, 10);
}

function startImageProgress(mode: CimgMode, size: string, quality: CimgQuality): { stop: () => void } {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const render = (): void => {
    const action = mode === "edit" ? "editing" : "generating";
    const status = `${action}: ${formatDurationMs(Date.now() - startedAt)} ${size} ${quality} Ctrl-C to cancel`;
    process.stdout.write(`\r\u001b[2K${status}`);
  };

  if (process.stdout.isTTY) {
    render();
    timer = setInterval(render, CIMG_PROGRESS_INTERVAL_MS);
    timer.unref();
  } else {
    console.log(`${mode === "edit" ? "editing" : "generating"}: ${size} ${quality}`);
  }

  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer) {
        clearInterval(timer);
      }
      if (process.stdout.isTTY) {
        process.stdout.write("\r\u001b[2K");
      }
    },
  };
}

function requestMode(args: CimgArgs): CimgMode {
  return args.inputPaths.length > 0 ? "edit" : "generate";
}

async function readImageInputs(paths: string[]): Promise<ImageInput[]> {
  return Promise.all(paths.map(async (path) => {
    const mediaType = imageMediaType(path);
    if (!mediaType) {
      throw new Error(`unsupported input image: ${path}`);
    }
    let fileStats;
    try {
      fileStats = await stat(path);
    } catch {
      throw new Error(`input image is not readable: ${path}`);
    }
    if (!fileStats.isFile()) {
      throw new Error(`input image is not a regular file: ${path}`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new Error(`input image is not readable: ${path}`);
    }
    if (bytes.length >= maxInputImageBytes) {
      throw new Error(`input image is too large: ${path}; each image must be smaller than 50 MiB`);
    }
    return {
      path,
      name: basename(path),
      mediaType,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }));
}

async function verifyImageInputs(previewed: ImageInput[]): Promise<ImageInput[]> {
  const current = await readImageInputs(previewed.map((input) => input.path));
  for (let index = 0; index < previewed.length; index += 1) {
    if (previewed[index].sha256 !== current[index].sha256) {
      throw new Error(`input image changed after preview: ${previewed[index].path}`);
    }
  }
  return current;
}

function imageMediaType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

async function assertOutputAvailable(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`output already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

class CimgHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CimgHttpError";
  }
}

export class CimgCanceledError extends Error {
  constructor() {
    super("image request canceled by user");
    this.name = "CimgCanceledError";
  }
}
