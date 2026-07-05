export function formatThreeSignificant(value) {
    if (!Number.isFinite(value)) {
        return "-";
    }
    if (value >= 100) {
        return Math.round(value).toString();
    }
    if (value >= 10) {
        return value.toFixed(1);
    }
    return value.toFixed(2);
}
export function formatDurationMs(milliseconds, options = {}) {
    const value = Math.max(0, Math.round(milliseconds));
    if (!Number.isFinite(value)) {
        return "-";
    }
    if (value < 1000) {
        return `${value}ms`;
    }
    if (value < 60_000) {
        return `${formatThreeSignificant(value / 1000)}s`;
    }
    if (options.maxUnit === "m" || value < 3_600_000) {
        return `${formatThreeSignificant(value / 60_000)}m`;
    }
    return `${formatThreeSignificant(value / 3_600_000)}h`;
}
export function formatCompactBytes(bytes) {
    const units = ["B", "K", "M", "G", "T"];
    let scaled = Math.max(0, bytes);
    let unitIndex = 0;
    while (scaled >= 1024 && unitIndex < units.length - 1) {
        scaled /= 1024;
        unitIndex += 1;
    }
    const value = unitIndex === 0 ? Math.round(scaled).toString() : formatThreeSignificant(scaled);
    return `${value}${units[unitIndex]}`;
}
export function formatCompactRate(bytesPerSecond) {
    return `${formatCompactBytes(bytesPerSecond)}/s`;
}
