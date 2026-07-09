import { ClvmRuntimeError, ClashApi, clvmErrorDetail } from "./api.js";
import { domainMatches, isPlainObject, normalizeDomains } from "./config.js";
import type {
  ClvmConnectionsResponse,
  ConnectionEntry,
  ConnectionState,
  DomainMatch,
  MonitorResult,
  RuntimeConfig,
  SpeedSample,
} from "./types.js";

const domainFields = [
  "host",
  "destinationHost",
  "sniffHost",
  "sni",
  "domain",
] as const;

export class ConnectionSampler {
  #states = new Map<string, ConnectionState>();
  #now: () => Date;

  constructor({ now = () => new Date() }: { now?: () => Date } = {}) {
    this.#now = now;
  }

  sample(payload: unknown, options: { domains: string[]; zeroSpeedThreshold: number }): MonitorResult {
    const now = this.#now();
    const nowMs = now.getTime();
    const connections = readConnections(payload);
    const nextIds = new Set<string>();
    const matched: ConnectionEntry[] = [];

    for (const connection of connections) {
      const id = String(readObjectValue(connection, "id") ?? "");
      if (!id) {
        continue;
      }

      nextIds.add(id);
      const state = this.#updateState(connection, nowMs, options.zeroSpeedThreshold);
      const domainMatch = findDomainMatch(connection, options.domains);

      if (!domainMatch) {
        continue;
      }

      const entry = toEntry(connection, state, domainMatch);
      matched.push({
        ...entry,
        status: statusFor(entry),
      });
    }

    for (const id of this.#states.keys()) {
      if (!nextIds.has(id)) {
        this.#states.delete(id);
      }
    }

    return {
      timestamp: now.toISOString(),
      totalConnections: connections.length,
      matchedConnections: matched,
    };
  }

  #updateState(connection: Record<string, unknown>, nowMs: number, zeroSpeedThreshold: number): ConnectionState {
    const id = String(connection.id);
    const previous = this.#states.get(id);
    const uploadTotal = numberOrZero(connection.upload);
    const downloadTotal = numberOrZero(connection.download);
    const startMs = parseStartTime(connection.start) ?? previous?.startMs ?? nowMs;
    const elapsedSeconds = previous ? Math.max((nowMs - previous.lastSeenMs) / 1000, 0) : 0;
    const speeds = readSpeeds(connection, previous, {
      elapsedSeconds,
      uploadTotal,
      downloadTotal,
    });
    const isIdle = speeds.totalBytesPerSecond !== null && speeds.totalBytesPerSecond <= zeroSpeedThreshold;
    const idleSinceMs = isIdle
      ? previous?.isIdle
        ? previous.idleSinceMs
        : speeds.coversPreviousInterval && previous
          ? previous.lastSeenMs
          : nowMs
      : null;
    const next = {
      startMs,
      lastSeenMs: nowMs,
      uploadTotal,
      downloadTotal,
      uploadBytesPerSecond: speeds.uploadBytesPerSecond,
      downloadBytesPerSecond: speeds.downloadBytesPerSecond,
      totalBytesPerSecond: speeds.totalBytesPerSecond,
      zeroSpeedThreshold,
      isIdle,
      idleSinceMs,
      observedIdleMs: idleSinceMs === null ? 0 : nowMs - idleSinceMs,
    };

    this.#states.set(id, next);
    return next;
  }
}

export function sampleConnections(sampler: ConnectionSampler, response: ClvmConnectionsResponse, config: RuntimeConfig): MonitorResult {
  try {
    return sampler.sample(response.payload, {
      domains: config.domains,
      zeroSpeedThreshold: config.zeroSpeedThreshold,
    });
  } catch (error) {
    if (error instanceof ClvmRuntimeError && error.code === "invalid_connections_payload") {
      throw new ClvmRuntimeError(error.code, error.message, {
        raw: response.raw,
        cause: error,
      });
    }
    throw error;
  }
}

export async function closeExpiredConnections(
  api: ClashApi,
  result: MonitorResult,
  config: RuntimeConfig,
  closedIds = new Set<string>(),
): Promise<ConnectionEntry[]> {
  result.closedConnections = [];
  result.closeFailures = [];

  if (!config.autoCloseEnabled || config.closeZeroForMs === null) {
    return result.closedConnections;
  }

  const currentIds = new Set(result.matchedConnections.map((connection) => connection.id));
  for (const id of closedIds) {
    if (!currentIds.has(id)) {
      closedIds.delete(id);
    }
  }

  const targets = result.matchedConnections.filter(
    (connection) => connection.isIdle && connection.observedIdleMs > config.closeZeroForMs! && !closedIds.has(connection.id),
  );

  for (const connection of targets) {
    try {
      await api.closeConnection(connection.id);
      closedIds.add(connection.id);
      result.closedConnections.push(connection);
    } catch (error) {
      result.closeFailures.push({
        ...connection,
        failedAt: new Date().toISOString(),
        error: clvmErrorDetail(error),
        raw: null,
      });
    }
  }

  return result.closedConnections;
}

function readConnections(payload: unknown): Record<string, unknown>[] {
  if (!isPlainObject(payload) || !Array.isArray(payload.connections)) {
    throw new ClvmRuntimeError("invalid_connections_payload", "/connections response must contain a connections array", {
      raw: payload,
    });
  }
  return payload.connections.filter(isPlainObject);
}

function readObjectValue(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

export function getDomainCandidates(connection: Record<string, unknown>): string[] {
  const metadataValue = connection.metadata;
  const metadata = isPlainObject(metadataValue) ? metadataValue : {};
  const candidates = domainFields.map((field) => metadata[field]);

  if (String(connection.rule ?? "").toUpperCase().includes("DOMAIN")) {
    candidates.push(connection.rulePayload);
  }

  return normalizeDomains(candidates);
}

export function findDomainMatch(connection: Record<string, unknown>, domains: string[]): DomainMatch | null {
  const candidates = getDomainCandidates(connection);

  for (const candidate of candidates) {
    const domain = domains.find((target) => domainMatches(candidate, target));
    if (domain) {
      return { domain, candidate };
    }
  }

  return null;
}

function endpointLabel(connection: Record<string, unknown>): string {
  const metadataValue = connection.metadata;
  const metadata = isPlainObject(metadataValue) ? metadataValue : {};
  const host = metadata.host
    ?? metadata.destinationHost
    ?? metadata.sniffHost
    ?? metadata.sni
    ?? metadata.destinationIP
    ?? "unknown";
  const port = metadata.destinationPort;

  return port ? `${host}:${port}` : String(host);
}

function statusFor(entry: Omit<ConnectionEntry, "status">): ConnectionEntry["status"] {
  if (entry.totalBytesPerSecond === null) {
    return "unknown";
  }
  return entry.isIdle ? "zero" : "active";
}

function toEntry(connection: Record<string, unknown>, state: ConnectionState, domainMatch: DomainMatch): Omit<ConnectionEntry, "status"> {
  const metadataValue = connection.metadata;
  const metadata = isPlainObject(metadataValue) ? metadataValue : {};

  return {
    id: String(connection.id),
    endpoint: endpointLabel(connection),
    process: String(metadata.process ?? metadata.processPath ?? ""),
    rule: [connection.rule, connection.rulePayload].filter(Boolean).join(":"),
    chains: Array.isArray(connection.chains) ? connection.chains.map(String) : [],
    matchedDomain: domainMatch.domain,
    matchedValue: domainMatch.candidate,
    ageMs: Math.max(0, state.lastSeenMs - state.startMs),
    observedIdleMs: state.observedIdleMs,
    uploadTotal: state.uploadTotal,
    downloadTotal: state.downloadTotal,
    uploadBytesPerSecond: state.uploadBytesPerSecond,
    downloadBytesPerSecond: state.downloadBytesPerSecond,
    totalBytesPerSecond: state.totalBytesPerSecond,
    isIdle: state.isIdle,
  };
}

function readSpeeds(
  connection: Record<string, unknown>,
  previous: ConnectionState | undefined,
  { elapsedSeconds, uploadTotal, downloadTotal }: { elapsedSeconds: number; uploadTotal: number; downloadTotal: number },
): SpeedSample {
  const explicitUploadSpeed = numberOrNull(connection.uploadSpeed);
  const explicitDownloadSpeed = numberOrNull(connection.downloadSpeed);

  if (explicitUploadSpeed !== null || explicitDownloadSpeed !== null) {
    const uploadBytesPerSecond = explicitUploadSpeed ?? 0;
    const downloadBytesPerSecond = explicitDownloadSpeed ?? 0;

    return {
      uploadBytesPerSecond,
      downloadBytesPerSecond,
      totalBytesPerSecond: uploadBytesPerSecond + downloadBytesPerSecond,
      coversPreviousInterval: false,
    };
  }

  if (!previous || elapsedSeconds <= 0) {
    return {
      uploadBytesPerSecond: null,
      downloadBytesPerSecond: null,
      totalBytesPerSecond: null,
      coversPreviousInterval: false,
    };
  }

  const uploadBytesPerSecond = Math.max(0, (uploadTotal - previous.uploadTotal) / elapsedSeconds);
  const downloadBytesPerSecond = Math.max(0, (downloadTotal - previous.downloadTotal) / elapsedSeconds);

  return {
    uploadBytesPerSecond,
    downloadBytesPerSecond,
    totalBytesPerSecond: uploadBytesPerSecond + downloadBytesPerSecond,
    coversPreviousInterval: true,
  };
}

function parseStartTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}
