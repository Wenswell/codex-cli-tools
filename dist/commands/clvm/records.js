import { join } from "node:path";
import { appendBoundedJsonLine, pruneRuntimeRawArchive, writeJsonStateAtomic, writeRuntimeRawArchive, } from "../../lib/runtime-log.js";
import { codexToolsCacheDir } from "../../lib/paths.js";
import { clvmErrorDetail, clvmErrorRaw } from "./api.js";
const closedHistoryRetentionLimit = 100;
const clvmHistoryMaxBytes = 16 * 1024 * 1024;
const clvmRawPayloadMaxBytes = 1024 * 1024;
const clvmRawArchiveMaxFiles = 256;
const clvmRawArchiveMaxBytes = 64 * 1024 * 1024;
const clvmStateVersion = 3;
const clvmRetryMaxIntervalMs = 300_000;
const clvmRetryMultipliers = [1, 2, 5, 10, 30, 60];
export function clvmStatePath() {
    return join(codexToolsCacheDir(), "clvm-state.json");
}
export function clvmHistoryPath() {
    return join(codexToolsCacheDir(), "clvm-history.jsonl");
}
export function clvmRawDir() {
    return join(codexToolsCacheDir(), "clvm-raw");
}
export async function recordClvmSample(source, config, result, raw, dedupe) {
    const record = buildClvmSampleRecord(source, config, result, raw);
    await writeClvmRuntimeRecord(record, dedupe);
}
export async function recordClvmFailure(source, config, failure, dedupe) {
    const record = buildClvmFailureRecord(source, config, failure);
    await writeClvmRuntimeRecord(record, dedupe);
}
export function buildMonitorFailure(error, retry, includeRaw = false) {
    return {
        timestamp: new Date().toISOString(),
        error: clvmErrorDetail(error),
        retry,
        raw: includeRaw ? clvmErrorRaw(error) : null,
    };
}
export function buildRetryState(attempt, intervalMs, now = Date.now()) {
    return {
        attempt,
        intervalMs,
        nextAt: new Date(now + intervalMs).toISOString(),
    };
}
export function nextClvmRetryInterval(baseIntervalMs, attempt) {
    if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) {
        throw new Error("base interval must be a positive finite number");
    }
    if (!Number.isFinite(attempt) || attempt <= 0) {
        throw new Error("retry attempt must be a positive finite number");
    }
    const multiplier = clvmRetryMultipliers[attempt - 1] ?? Number.POSITIVE_INFINITY;
    const interval = multiplier === Number.POSITIVE_INFINITY
        ? clvmRetryMaxIntervalMs
        : Math.round(baseIntervalMs * multiplier);
    return Math.min(clvmRetryMaxIntervalMs, Math.max(1, interval));
}
export function recordClosedConnections(closedHistory, closedConnections) {
    const closedAt = new Date().toISOString();
    for (const connection of closedConnections) {
        closedHistory.unshift({
            ...connection,
            closedAt,
        });
    }
    closedHistory.length = Math.min(closedHistory.length, closedHistoryRetentionLimit);
}
export function toJsonResult(result) {
    return {
        ok: true,
        status: "ok",
        timestamp: result.timestamp,
        totalConnections: result.totalConnections,
        matchedConnections: result.matchedConnections,
        closedConnections: result.closedConnections ?? [],
        closeFailures: sanitizedCloseFailures(result.closeFailures ?? []),
        closedHistory: result.closedHistory ?? [],
        closedTotal: result.closedTotal ?? 0,
    };
}
export function toJsonFailure(failure) {
    return {
        ok: false,
        status: "unavailable",
        timestamp: failure.timestamp,
        error: failure.error,
        retry: failure.retry ?? null,
    };
}
async function writeClvmRuntimeRecord(record, dedupe) {
    const fingerprint = clvmRuntimeRecordFingerprint(record);
    if (dedupe?.lastFingerprint === fingerprint) {
        return;
    }
    const rawWrite = record.config.rawArchive
        ? await writeClvmRawPayload(record.raw)
        : { ref: null, retainedPath: null };
    const recordWithRawRef = {
        ...record,
        raw_ref: rawWrite.ref,
    };
    if (rawWrite.retainedPath) {
        await pruneRuntimeRawArchive(rawWrite.retainedPath, clvmRawArchiveOptions());
    }
    await writeJsonStateAtomic(clvmStatePath(), toClvmStateRecord(recordWithRawRef), 0o600);
    await appendClvmHistoryRecord(toClvmHistoryRecord(recordWithRawRef));
    if (dedupe) {
        dedupe.lastFingerprint = fingerprint;
    }
}
async function appendClvmHistoryRecord(record) {
    await appendBoundedJsonLine(clvmHistoryPath(), record, { maxBytes: clvmHistoryMaxBytes, mode: 0o600 });
}
async function writeClvmRawPayload(raw) {
    return writeRuntimeRawArchive(raw, clvmRawArchiveOptions());
}
function clvmRawArchiveOptions() {
    return {
        dir: clvmRawDir(),
        maxPayloadBytes: clvmRawPayloadMaxBytes,
        maxFiles: clvmRawArchiveMaxFiles,
        maxBytes: clvmRawArchiveMaxBytes,
        mode: 0o600,
    };
}
function toClvmStateRecord(record) {
    const { raw: _raw, ...state } = record;
    if (state.ok) {
        return {
            ...state,
            result: toJsonResult(state.result),
        };
    }
    return state;
}
function toClvmHistoryRecord(record) {
    const state = toClvmStateRecord(record);
    if (state.ok) {
        const { result: _result, ...history } = state;
        return history;
    }
    return state;
}
function clvmRuntimeRecordFingerprint(record) {
    if (record.ok) {
        return JSON.stringify({
            version: record.version,
            ok: record.ok,
            status: record.status,
            source: record.source,
            config: record.config,
            summary: record.summary,
            result: clvmResultFingerprint(record.result),
        });
    }
    return JSON.stringify({
        version: record.version,
        ok: record.ok,
        status: record.status,
        source: record.source,
        config: record.config,
        error: record.error,
        retry: record.retry
            ? {
                attempt: record.retry.attempt,
                intervalMs: record.retry.intervalMs,
            }
            : undefined,
    });
}
function clvmResultFingerprint(result) {
    return {
        totalConnections: result.totalConnections,
        matchedConnections: clvmConnectionsFingerprint(result.matchedConnections),
        closedConnections: clvmConnectionsFingerprint(result.closedConnections),
        closeFailures: clvmConnectionsFingerprint(result.closeFailures),
        closedHistory: clvmConnectionsFingerprint(result.closedHistory),
        closedTotal: result.closedTotal,
    };
}
function clvmConnectionsFingerprint(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(clvmConnectionFingerprint);
}
function clvmConnectionFingerprint(value) {
    if (!value || typeof value !== "object") {
        return value;
    }
    const record = value;
    return {
        id: record.id,
        endpoint: record.endpoint,
        process: record.process,
        rule: record.rule,
        chains: record.chains,
        matchedDomain: record.matchedDomain,
        matchedValue: record.matchedValue,
        uploadTotal: record.uploadTotal,
        downloadTotal: record.downloadTotal,
        uploadBytesPerSecond: record.uploadBytesPerSecond,
        downloadBytesPerSecond: record.downloadBytesPerSecond,
        totalBytesPerSecond: record.totalBytesPerSecond,
        isIdle: record.isIdle,
        status: record.status,
        closedAt: record.closedAt,
        failedAt: record.failedAt,
        error: record.error,
    };
}
function buildClvmSampleRecord(source, config, result, raw) {
    const matched = result.matchedConnections;
    return {
        version: clvmStateVersion,
        ok: true,
        status: "ok",
        recorded_at: new Date().toISOString(),
        source,
        config: clvmRecordConfig(config),
        summary: {
            totalConnections: result.totalConnections,
            matchedConnections: matched.length,
            activeConnections: matched.filter((connection) => connection.status === "active").length,
            zeroConnections: matched.filter((connection) => connection.status === "zero").length,
            unknownConnections: matched.filter((connection) => connection.status === "unknown").length,
            closedNow: result.closedConnections?.length ?? 0,
            closeFailed: result.closeFailures?.length ?? 0,
            closedTotal: result.closedTotal ?? 0,
            uploadBytesPerSecond: sumConnectionNumber(matched, "uploadBytesPerSecond"),
            downloadBytesPerSecond: sumConnectionNumber(matched, "downloadBytesPerSecond"),
            uploadBytes: sumConnectionNumber(matched, "uploadTotal"),
            downloadBytes: sumConnectionNumber(matched, "downloadTotal"),
        },
        result: toJsonResult(result),
        raw_ref: null,
        raw,
    };
}
function buildClvmFailureRecord(source, config, failure) {
    return {
        version: clvmStateVersion,
        ok: false,
        status: "unavailable",
        recorded_at: failure.timestamp,
        source,
        config: clvmRecordConfig(config),
        error: failure.error,
        retry: failure.retry,
        raw_ref: null,
        raw: failure.raw,
    };
}
function clvmRecordConfig(config) {
    return {
        baseUrl: config.baseUrl,
        domains: config.domains,
        intervalMs: config.intervalMs,
        zeroSpeedThreshold: config.zeroSpeedThreshold,
        closeZeroForSeconds: config.closeZeroForSeconds,
        autoCloseEnabled: config.autoCloseEnabled,
        rawArchive: config.rawArchive,
    };
}
function sumConnectionNumber(connections, field) {
    return connections.reduce((sum, connection) => {
        const value = connection[field];
        return typeof value === "number" && Number.isFinite(value) ? sum + value : sum;
    }, 0);
}
function sanitizedCloseFailures(closeFailures) {
    return closeFailures.map((failure) => {
        const { raw: _raw, ...safeFailure } = failure;
        return safeFailure;
    });
}
