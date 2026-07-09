import { formatDurationMs, formatThreeSignificant } from "../../lib/format.js";
const durationUnits = new Map([
    ["ms", 1],
    ["s", 1000],
    ["m", 60_000],
    ["h", 3_600_000],
]);
const configFields = new Set([
    "baseUrl",
    "secret",
    "domains",
    "interval",
    "zeroSpeedThreshold",
    "closeZeroForSeconds",
    "rawArchive",
]);
export function mergeClvmConfig(base, overlay) {
    return {
        baseUrl: overlay.baseUrl ?? base.baseUrl,
        secret: overlay.secret ?? base.secret,
        domains: overlay.domains ?? base.domains,
        interval: overlay.interval ?? base.interval,
        zeroSpeedThreshold: overlay.zeroSpeedThreshold ?? base.zeroSpeedThreshold,
        closeZeroForSeconds: overlay.closeZeroForSeconds !== undefined
            ? overlay.closeZeroForSeconds
            : base.closeZeroForSeconds,
        rawArchive: overlay.rawArchive ?? base.rawArchive,
    };
}
export function requireResolvedClvmConfig(config, path) {
    return {
        baseUrl: requireString(config.baseUrl, `${path} baseUrl`),
        secret: requireString(config.secret, `${path} secret`),
        domains: requireStringArray(config.domains, `${path} domains`),
        interval: requireString(config.interval, `${path} interval`),
        zeroSpeedThreshold: requireNumber(config.zeroSpeedThreshold, `${path} zeroSpeedThreshold`),
        closeZeroForSeconds: config.closeZeroForSeconds === undefined
            ? null
            : requireNullableSeconds(config.closeZeroForSeconds, `${path} closeZeroForSeconds`),
        rawArchive: requireBoolean(config.rawArchive, `${path} rawArchive`),
    };
}
export function parseClvmConfig(text, path = "clvm.json") {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${path} is not valid JSON: ${message}`);
    }
    if (!isPlainObject(parsed)) {
        throw new Error(`${path} must contain a JSON object`);
    }
    const unknownKeys = Object.keys(parsed).filter((key) => !configFields.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`${path} has unknown keys: ${unknownKeys.join(", ")}`);
    }
    const config = {};
    if (parsed.baseUrl !== undefined) {
        config.baseUrl = requireString(parsed.baseUrl, "baseUrl");
    }
    if (parsed.secret !== undefined) {
        config.secret = requireString(parsed.secret, "secret");
    }
    if (parsed.domains !== undefined) {
        if (!Array.isArray(parsed.domains)) {
            throw new Error(`${path} domains must be an array of strings`);
        }
        config.domains = parsed.domains.map((domain, index) => requireString(domain, `domains[${index}]`));
    }
    if (parsed.interval !== undefined) {
        config.interval = requireString(parsed.interval, "interval");
    }
    if (parsed.zeroSpeedThreshold !== undefined) {
        if (typeof parsed.zeroSpeedThreshold !== "number") {
            throw new Error(`${path} zeroSpeedThreshold must be a number`);
        }
        config.zeroSpeedThreshold = parseNonNegativeNumber(parsed.zeroSpeedThreshold, "zeroSpeedThreshold");
    }
    if (parsed.closeZeroForSeconds !== undefined) {
        if (parsed.closeZeroForSeconds === null) {
            config.closeZeroForSeconds = null;
        }
        else {
            if (typeof parsed.closeZeroForSeconds !== "number") {
                throw new Error(`${path} closeZeroForSeconds must be a number or null`);
            }
            config.closeZeroForSeconds = parsePositiveSeconds(parsed.closeZeroForSeconds, "closeZeroForSeconds");
        }
    }
    if (parsed.rawArchive !== undefined) {
        config.rawArchive = requireBoolean(parsed.rawArchive, "rawArchive");
    }
    return config;
}
export function buildRuntimeConfig(fileConfig, options, mode) {
    const baseUrl = options.baseUrl ?? fileConfig.baseUrl;
    const secret = options.secret ?? fileConfig.secret;
    const domains = options.domains !== undefined
        ? normalizeDomains(options.domains)
        : normalizeDomains(fileConfig.domains);
    const interval = options.interval ?? fileConfig.interval;
    const intervalMs = parseDuration(interval, "interval");
    const zeroSpeedThreshold = options.zeroSpeedThreshold ?? fileConfig.zeroSpeedThreshold;
    const closeZeroForSeconds = options.closeZeroForSeconds !== undefined
        ? options.closeZeroForSeconds
        : fileConfig.closeZeroForSeconds;
    const rawArchive = options.rawArchive ?? fileConfig.rawArchive;
    new URL(baseUrl);
    if (intervalMs <= 0) {
        throw new Error("interval must be greater than 0");
    }
    if (zeroSpeedThreshold < 0) {
        throw new Error("zero speed threshold must be a non-negative number");
    }
    if (closeZeroForSeconds !== null && closeZeroForSeconds <= 0) {
        throw new Error("closeZeroForSeconds must be a positive number or null");
    }
    return {
        baseUrl,
        secret,
        domains,
        interval,
        intervalMs,
        zeroSpeedThreshold,
        closeZeroForSeconds,
        closeZeroForMs: closeZeroForSeconds === null ? null : closeZeroForSeconds * 1000,
        autoCloseEnabled: mode.autoCloseEnabled,
        rawArchive,
        once: options.once ?? mode.once,
        json: options.json ?? false,
        clear: (options.clear ?? true) && mode.clear && options.json !== true && options.once !== true,
        color: options.color ?? true,
    };
}
export function normalizeDomains(values) {
    const domains = values
        .flatMap((value) => String(value ?? "").split(","))
        .map((value) => normalizeHost(value))
        .filter(Boolean);
    return [...new Set(domains)];
}
export function domainMatches(candidate, target) {
    const normalizedCandidate = normalizeHost(candidate);
    const normalizedTarget = normalizeHost(target);
    if (!normalizedCandidate || !normalizedTarget) {
        return false;
    }
    return normalizedCandidate === normalizedTarget || normalizedCandidate.endsWith(`.${normalizedTarget}`);
}
export function parseDuration(value, name = "duration") {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return Math.round(value);
    }
    const text = String(value ?? "").trim();
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u.exec(text);
    if (!match) {
        throw new Error(`${name} must use one of: 500ms, 5s, 3m, 1h`);
    }
    const amount = Number(match[1]);
    const unit = match[2] ?? "ms";
    return Math.round(amount * durationUnits.get(unit));
}
export function nextAlignedDelay(intervalMs, nowMs = Date.now()) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error("interval must be a positive finite number");
    }
    const nextTick = Math.ceil((nowMs + 1) / intervalMs) * intervalMs;
    return Math.max(0, nextTick - nowMs);
}
export function formatDuration(milliseconds) {
    return formatDurationMs(milliseconds);
}
export function formatSeconds(seconds) {
    if (seconds < 60) {
        return `${formatThreeSignificant(seconds)}s`;
    }
    return `${formatThreeSignificant(seconds / 60)}m`;
}
export function parseCloseZeroForSeconds(value) {
    if (value === "off") {
        return null;
    }
    return parsePositiveSeconds(value, "close zero-for seconds");
}
export function parseRawArchiveMode(value) {
    if (value === "on") {
        return true;
    }
    if (value === "off") {
        return false;
    }
    throw new Error("raw archive must be on or off");
}
export function parseNonNegativeNumber(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new Error(`${name} must be a non-negative number`);
    }
    return number;
}
export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(value, name) {
    if (typeof value !== "string") {
        throw new Error(`${name} must be a string`);
    }
    return value;
}
function requireStringArray(value, name) {
    if (!Array.isArray(value)) {
        throw new Error(`${name} must be an array of strings`);
    }
    return value.map((entry, index) => requireString(entry, `${name}[${index}]`));
}
function requireNumber(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${name} must be a number`);
    }
    return value;
}
function requireBoolean(value, name) {
    if (typeof value !== "boolean") {
        throw new Error(`${name} must be a boolean`);
    }
    return value;
}
function requireNullableSeconds(value, name) {
    if (value === null) {
        return null;
    }
    return parsePositiveSeconds(value, name);
}
function parsePositiveSeconds(value, name) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`${name} must be a positive number of seconds`);
    }
    return seconds;
}
function normalizeHost(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/^\*\./u, "")
        .replace(/^\+\./u, "")
        .replace(/^\./u, "")
        .replace(/\.$/u, "");
}
