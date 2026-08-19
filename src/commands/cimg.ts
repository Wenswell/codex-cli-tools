import { createHash, randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { rejectRemovedYesFlags } from "../lib/confirm.js";
import { ensureDir } from "../lib/fs.js";
import { formatCompactBytes, formatDurationMs } from "../lib/format.js";
import { colorPath, colorUrl, printKeyValue } from "../lib/output.js";
import { codexToolsCacheDir, formatHomePath } from "../lib/paths.js";
import { assertProfile, readProfiles, type Profile, type ProfilesFile } from "../lib/profiles.js";
import { appendBoundedJsonLine } from "../lib/runtime-log.js";
import { textDim, textGreen, textRed, textYellow } from "../lib/text.js";
import { printToolVersionIfRequested } from "../lib/version.js";

export const CIMG_MODEL = "gpt-image-2";
export const CIMG_DEFAULT_RATIO = "1:1";
export const CIMG_DEFAULT_QUALITY = "auto";

const requestTimeoutMs = 300_000;
const requestLogMaxBytes = 16 * 1024 * 1024;
const requestLogTrimBytes = 12 * 1024 * 1024;
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

export type CimgRatio = keyof typeof CIMG_SIZES;
export type CimgQuality = "auto" | "low" | "medium" | "high";

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
  ratio: CimgRatio;
  size: string;
  quality: CimgQuality;
  outputPath: string;
};

type ImageResponse = {
  data?: Array<{ b64_json?: string }>;
  error?: { code?: string; message?: string };
};

type RequestResult = {
  bytes: Buffer;
  httpStatus: number;
  width: number;
  height: number;
};

type RequestEvent = {
  version: 1;
  recorded_at: string;
  source: "cimg";
  request_id: string;
  event: "started" | "succeeded" | "failed";
  config: {
    profile: string;
    base_url: string;
    endpoint: string;
    model: typeof CIMG_MODEL;
    ratio: CimgRatio;
    size: string;
    quality: CimgQuality;
  };
  prompt: {
    sha256: string;
    characters: number;
  };
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

export type CimgDependencies = {
  fetch: typeof fetch;
  confirm: () => Promise<boolean>;
  now: () => Date;
  requestId: () => string;
  profiles: () => Promise<ProfilesFile>;
  appendEvent: (event: RequestEvent) => Promise<void>;
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

  const args = parseArgs(argv, dependencies.now());
  const active = resolveActiveProfile(await dependencies.profiles());
  const endpoint = buildEndpoint(active.profile.baseURL);
  await assertOutputAvailable(args.outputPath);
  printPreview(active.name, endpoint, args);
  if (!(await dependencies.confirm())) {
    return;
  }

  await ensureDir(dirname(args.outputPath));
  const requestId = dependencies.requestId();
  const startedAt = dependencies.now();
  const baseEvent = buildBaseEvent(requestId, startedAt, active.name, active.profile.baseURL, endpoint, args);
  await dependencies.appendEvent({ ...baseEvent, event: "started" });

  let response: RequestResult;
  try {
    response = await requestImage(dependencies.fetch, endpoint, active.profile.apiKey, args);
    await writeFile(args.outputPath, response.bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
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
    throw error;
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
  printCimgValue("result:", textGreen("generated"));
  printCimgValue("output:", colorPath(formatHomePath(args.outputPath)));
  printCimgValue("image:", `${response.width}x${response.height} ${formatCompactBytes(response.bytes.length)}`);
  printCimgValue("duration:", formatDurationMs(durationMs));
  printCimgValue("log:", colorPath(formatHomePath(cimgRequestsPath())));
  if (`${response.width}x${response.height}` !== args.size) {
    printCimgValue("warning:", textYellow(`requested ${args.size}, received ${response.width}x${response.height}`));
  }
}

export function parseArgs(argv: string[], now = new Date()): CimgArgs {
  rejectRemovedYesFlags(argv, "cimg");
  let prompt: string | undefined;
  let ratio: CimgRatio = CIMG_DEFAULT_RATIO;
  let size: string | undefined;
  let quality: CimgQuality = CIMG_DEFAULT_QUALITY;
  let outputPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-p" || arg === "--prompt") {
      prompt = requireValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--ratio") {
      const value = requireValue(argv, index);
      if (!isRatio(value)) {
        throw new Error(`invalid ratio: ${value}; expected ${Object.keys(CIMG_SIZES).join(" | ")}`);
      }
      ratio = value;
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
  const resolvedOutput = resolve(outputPath ?? defaultOutputName(now));
  if (!resolvedOutput.toLowerCase().endsWith(".png")) {
    throw new Error("output path must end with .png");
  }

  return { prompt: normalizedPrompt, ratio, size: resolvedSize, quality, outputPath: resolvedOutput };
}

export function buildRequestBody(args: Pick<CimgArgs, "prompt" | "size" | "quality">): Record<string, unknown> {
  return {
    prompt: args.prompt,
    model: CIMG_MODEL,
    size: args.size,
    quality: args.quality,
    n: 1,
    output_format: "png",
  };
}

export function buildEndpoint(baseURL: string): string {
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
  return `${url.toString().replace(/\/+$/u, "")}/v1/images/generations`;
}

export function cimgRequestsPath(): string {
  return resolve(codexToolsCacheDir(), "cimg", "requests.jsonl");
}

async function requestImage(fetchImpl: typeof fetch, endpoint: string, apiKey: string, args: CimgArgs): Promise<RequestResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildRequestBody(args)),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("image request timed out after 300 seconds");
    }
    throw error;
  }

  const text = await response.text();
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
  const base64 = payload.data?.[0]?.b64_json;
  if (!base64) {
    throw new CimgHttpError(response.status, "missing_image", "image API response is missing data[0].b64_json");
  }
  const bytes = Buffer.from(base64, "base64");
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

function parseResponse(text: string): ImageResponse {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("response is not an object");
  }
  return parsed as ImageResponse;
}

function resolveActiveProfile(profiles: ProfilesFile): { name: string; profile: Profile } {
  const name = profiles.current?.trim();
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
  const name = profiles.current?.trim() || "-";
  const candidate = name === "-" ? undefined : profiles.profiles?.[name];
  const baseURL = candidate && typeof candidate.baseURL === "string" && candidate.baseURL.trim() ? candidate.baseURL : "-";
  const apiKey = candidate && typeof candidate.apiKey === "string" && candidate.apiKey.trim() ? textGreen("set") : textRed("missing");
  printCimgValue("profile:", name);
  printCimgValue("api:", baseURL === "-" ? textYellow(baseURL) : colorUrl(baseURL));
  printCimgValue("key:", apiKey);
  printCimgValue("model:", CIMG_MODEL);
  printCimgValue("defaults:", `${CIMG_DEFAULT_RATIO} ${CIMG_DEFAULT_SIZES[CIMG_DEFAULT_RATIO]} ${CIMG_DEFAULT_QUALITY}`);
  printCimgValue("output:", colorPath(process.cwd()));
  printCimgValue("log:", colorPath(formatHomePath(cimgRequestsPath())));
  console.log("commands: cimg -p TEXT | version|-v | --help");
}

function printPreview(profile: string, endpoint: string, args: CimgArgs): void {
  printCimgValue("profile:", profile);
  printCimgValue("endpoint:", colorUrl(endpoint));
  printCimgValue("model:", CIMG_MODEL);
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
    "  cimg -p TEXT [--ratio RATIO] [--size SIZE] [--quality QUALITY] [-o FILE] # preview and generate one PNG",
    "  cimg version                                                # print package version",
    "  cimg -v                                                     # print package version",
    "  cimg help | -h | --help                                     # show this help",
    "",
    "Options:",
    `  --ratio RATIO    ${Object.keys(CIMG_SIZES).join(" | ")} (default: ${CIMG_DEFAULT_RATIO})`,
    "  --size SIZE      one fixed size listed for the selected ratio",
    "  --quality VALUE  auto | low | medium | high (default: auto)",
    "  -o, --out FILE   output PNG path (default: ./image-<timestamp>.png)",
    "  -p, --prompt     text prompt",
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

function buildBaseEvent(
  requestId: string,
  recordedAt: Date,
  profile: string,
  baseURL: string,
  endpoint: string,
  args: CimgArgs,
): Omit<RequestEvent, "event"> {
  return {
    version: 1,
    recorded_at: recordedAt.toISOString(),
    source: "cimg",
    request_id: requestId,
    config: {
      profile,
      base_url: baseURL,
      endpoint,
      model: CIMG_MODEL,
      ratio: args.ratio,
      size: args.size,
      quality: args.quality,
    },
    prompt: {
      sha256: createHash("sha256").update(args.prompt).digest("hex"),
      characters: [...args.prompt].length,
    },
  };
}

function normalizeError(error: unknown): { code: string; message: string } {
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
