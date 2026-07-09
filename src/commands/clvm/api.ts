import type {
  ClvmConnectionsResponse,
  ClvmErrorCode,
  ClvmErrorDetail,
  ClvmRawHttpResponse,
} from "./types.js";

const sensitiveClvmResponseHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "api-key",
  "x-api-key",
  "openai-api-key",
]);

export class ClvmRuntimeError extends Error {
  readonly code: ClvmErrorCode;
  readonly status?: number;
  readonly statusText?: string;
  readonly body?: string;
  readonly raw?: unknown;
  readonly causeDetail?: { name: string; message: string };

  constructor(
    code: ClvmErrorCode,
    message: string,
    options: {
      status?: number;
      statusText?: string;
      body?: string;
      raw?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ClvmRuntimeError";
    this.code = code;
    this.status = options.status;
    this.statusText = options.statusText;
    this.body = options.body;
    this.raw = options.raw;
    this.causeDetail = options.cause === undefined ? undefined : errorCauseDetail(options.cause);
  }
}

export class ClashApi {
  #baseUrl: URL;
  #secret: string;
  #fetch: typeof fetch;

  constructor({
    baseUrl,
    secret,
    fetchImpl = globalThis.fetch,
  }: {
    baseUrl: string;
    secret: string;
    fetchImpl?: typeof fetch;
  }) {
    if (!baseUrl) {
      throw new Error("baseUrl is required");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("global fetch is required; use Node.js 20 or newer");
    }

    this.#baseUrl = new URL(baseUrl);
    this.#secret = secret;
    this.#fetch = fetchImpl;
  }

  async getConnections(): Promise<ClvmConnectionsResponse> {
    const response = await this.#request("/connections", "GET");
    const text = await response.text();
    const raw = buildClvmRawHttpResponse("GET", "/connections", response, text);
    try {
      return {
        payload: JSON.parse(text) as unknown,
        raw,
      };
    } catch (error) {
      throw new ClvmRuntimeError("invalid_connections_payload", "/connections response must be valid JSON", {
        raw,
        cause: error,
      });
    }
  }

  async closeConnection(id: string): Promise<void> {
    await this.#request(`/connections/${encodeURIComponent(id)}`, "DELETE");
  }

  async #request(pathname: string, method: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(pathname, this.#baseUrl), {
        method,
        headers: this.#headers(),
      });
    } catch (error) {
      throw new ClvmRuntimeError("fetch_failed", `${method} ${pathname} fetch failed`, {
        cause: error,
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new ClvmRuntimeError("http_error", `${method} ${pathname} failed with ${response.status} ${response.statusText}`, {
        status: response.status,
        statusText: response.statusText,
        body: text,
        raw: buildClvmRawHttpResponse(method, pathname, response, text),
      });
    }

    return response;
  }

  #headers(): Record<string, string> {
    return this.#secret ? { Authorization: `Bearer ${this.#secret}` } : {};
  }
}

export function clvmErrorDetail(error: unknown): ClvmErrorDetail {
  if (error instanceof ClvmRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      statusText: error.statusText,
      cause: error.causeDetail,
    };
  }

  return {
    code: "unknown_error",
    message: errorMessage(error),
    cause: errorCauseDetail(error),
  };
}

export function clvmErrorRaw(error: unknown): unknown {
  if (error instanceof ClvmRuntimeError) {
    return error.raw ?? null;
  }
  return null;
}

export function errorCauseDetail(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    name: typeof error,
    message: String(error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildClvmRawHttpResponse(method: string, path: string, response: Response, body: string): ClvmRawHttpResponse {
  return {
    method,
    path,
    status: response.status,
    statusText: response.statusText,
    headers: redactClvmResponseHeaders(Object.fromEntries(response.headers)),
    body,
    bodyBytes: Buffer.byteLength(body, "utf8"),
  };
}

function redactClvmResponseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    isSensitiveClvmResponseHeader(name) ? "[redacted]" : value,
  ]));
}

function isSensitiveClvmResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return sensitiveClvmResponseHeaders.has(lower)
    || lower.endsWith("-token")
    || lower.endsWith("-secret")
    || lower.endsWith("-api-key");
}
