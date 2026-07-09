import type { RuntimeRawReference } from "../../lib/runtime-log.js";

export type CommandName = "status" | "monitor" | "config" | "setup" | "sync" | "help";

export type ClvmConfigFile = {
  baseUrl?: string;
  secret?: string;
  domains?: string[];
  interval?: string;
  zeroSpeedThreshold?: number;
  closeZeroForSeconds?: number | null;
  rawArchive?: boolean;
};

export type ClvmConfig = {
  baseUrl: string;
  secret: string;
  domains: string[];
  interval: string;
  zeroSpeedThreshold: number;
  closeZeroForSeconds: number | null;
  rawArchive: boolean;
};

export type CommandOptions = {
  baseUrl?: string;
  secret?: string;
  domains?: string[];
  interval?: string;
  zeroSpeedThreshold?: number;
  closeZeroForSeconds?: number | null;
  rawArchive?: boolean;
  json?: boolean;
  clear?: boolean;
  color?: boolean;
  once?: boolean;
};

export type ParsedCommand = {
  command: CommandName;
  options: CommandOptions;
};

export type RuntimeConfig = {
  baseUrl: string;
  secret: string;
  domains: string[];
  interval: string;
  intervalMs: number;
  zeroSpeedThreshold: number;
  closeZeroForSeconds: number | null;
  closeZeroForMs: number | null;
  autoCloseEnabled: boolean;
  rawArchive: boolean;
  once: boolean;
  json: boolean;
  clear: boolean;
  color: boolean;
};

export type ConnectionState = {
  startMs: number;
  lastSeenMs: number;
  uploadTotal: number;
  downloadTotal: number;
  uploadBytesPerSecond: number | null;
  downloadBytesPerSecond: number | null;
  totalBytesPerSecond: number | null;
  zeroSpeedThreshold: number;
  isIdle: boolean;
  idleSinceMs: number | null;
  observedIdleMs: number;
};

export type SpeedSample = {
  uploadBytesPerSecond: number | null;
  downloadBytesPerSecond: number | null;
  totalBytesPerSecond: number | null;
  coversPreviousInterval: boolean;
};

export type DomainMatch = {
  domain: string;
  candidate: string;
};

export type ConnectionEntry = {
  id: string;
  endpoint: string;
  process: string;
  rule: string;
  chains: string[];
  matchedDomain: string;
  matchedValue: string;
  ageMs: number;
  observedIdleMs: number;
  uploadTotal: number;
  downloadTotal: number;
  uploadBytesPerSecond: number | null;
  downloadBytesPerSecond: number | null;
  totalBytesPerSecond: number | null;
  isIdle: boolean;
  status: "unknown" | "active" | "zero";
};

export type ClosedConnectionEntry = ConnectionEntry & {
  closedAt: string;
};

export type CloseFailureEntry = ConnectionEntry & {
  failedAt: string;
  error: ClvmErrorDetail;
  raw: unknown;
};

export type MonitorResult = {
  timestamp: string;
  totalConnections: number;
  matchedConnections: ConnectionEntry[];
  closedConnections?: ConnectionEntry[];
  closeFailures?: CloseFailureEntry[];
  closedHistory?: ClosedConnectionEntry[];
  closedTotal?: number;
};

export type SampleSource = "status" | "monitor";

export type ClvmErrorCode = "fetch_failed" | "http_error" | "invalid_connections_payload" | "unknown_error";

export type ClvmErrorDetail = {
  code: ClvmErrorCode;
  message: string;
  status?: number;
  statusText?: string;
  body?: string;
  cause?: {
    name: string;
    message: string;
  };
};

export type ClvmRetryState = {
  attempt: number;
  intervalMs: number;
  nextAt: string;
};

export type ClvmRawHttpResponse = {
  method: string;
  path: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyBytes: number;
};

export type ClvmConnectionsResponse = {
  payload: unknown;
  raw: ClvmRawHttpResponse;
};

export type ClvmRawReference = RuntimeRawReference;

export type ClvmSampleRecord = {
  version: number;
  ok: true;
  status: "ok";
  recorded_at: string;
  source: SampleSource;
  config: {
    baseUrl: string;
    domains: string[];
    intervalMs: number;
    zeroSpeedThreshold: number;
    closeZeroForSeconds: number | null;
    autoCloseEnabled: boolean;
    rawArchive: boolean;
  };
  summary: {
    totalConnections: number;
    matchedConnections: number;
    activeConnections: number;
    zeroConnections: number;
    unknownConnections: number;
    closedNow: number;
    closeFailed: number;
    closedTotal: number;
    uploadBytesPerSecond: number;
    downloadBytesPerSecond: number;
    uploadBytes: number;
    downloadBytes: number;
  };
  result: Record<string, unknown>;
  raw_ref: ClvmRawReference | null;
  raw: unknown;
};

export type ClvmFailureRecord = {
  version: number;
  ok: false;
  status: "unavailable";
  recorded_at: string;
  source: SampleSource;
  config: ClvmSampleRecord["config"];
  error: ClvmErrorDetail;
  retry?: ClvmRetryState;
  raw_ref: ClvmRawReference | null;
  raw: unknown;
};

export type ClvmRuntimeRecord = ClvmSampleRecord | ClvmFailureRecord;
export type ClvmStateSampleRecord = Omit<ClvmSampleRecord, "raw">;
export type ClvmStateFailureRecord = Omit<ClvmFailureRecord, "raw">;
export type ClvmStateRecord = ClvmStateSampleRecord | ClvmStateFailureRecord;
export type ClvmHistorySampleRecord = Omit<ClvmSampleRecord, "raw" | "result">;
export type ClvmHistoryFailureRecord = Omit<ClvmFailureRecord, "raw">;
export type ClvmHistoryRecord = ClvmHistorySampleRecord | ClvmHistoryFailureRecord;

export type ClvmRuntimeRecordDedupe = {
  lastFingerprint: string | null;
};

export type MonitorFailure = {
  timestamp: string;
  error: ClvmErrorDetail;
  retry?: ClvmRetryState;
  raw: unknown;
};

export type Layout = {
  maxWidth: number;
  showTrafficTotals: boolean;
  showChain: boolean;
  endpoint: number;
  endpointMin: number;
  ageZeroFor: number;
  zeroFor: number;
  up: number;
  down: number;
  upload: number;
  download: number;
  chain: number;
  ruleMin: number;
};

export type MonitorLayout = Layout & {
  closedHistoryRenderCount: number;
};
