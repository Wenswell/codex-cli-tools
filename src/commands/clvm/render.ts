import { formatCompactBytes, formatCompactRate } from "../../lib/format.js";
import { renderTable, styleTableRow, type TableColumn } from "../../lib/table.js";
import { createTextStyle, type TextStyle } from "../../lib/style.js";
import { bgDarkBlue } from "../../lib/text.js";
import { fitTerminalLine, terminalColumns } from "../../lib/terminal.js";
import { formatDuration, formatSeconds } from "./config.js";
import { toJsonFailure, toJsonResult } from "./records.js";
import type {
  ClosedConnectionEntry,
  ConnectionEntry,
  Layout,
  MonitorFailure,
  MonitorLayout,
  MonitorResult,
  RuntimeConfig,
} from "./types.js";

const closedHistoryDefaultRenderCount = 5;
const closedHistorySectionFixedLines = 3;

export type MonitorRenderOptions = {
  historyVisible?: boolean;
  interactive?: boolean;
};

export function printMonitorResult(result: MonitorResult, config: RuntimeConfig, stream: NodeJS.WriteStream = process.stdout, options: MonitorRenderOptions = {}): void {
  if (config.json) {
    stream.write(`${JSON.stringify(toJsonResult(result))}\n`);
    return;
  }

  if (config.clear) {
    stream.write("\x1B[2J\x1B[H");
  }

  const closed = result.closedConnections ?? [];
  const closeFailures = result.closeFailures ?? [];
  const historyVisible = options.historyVisible ?? true;
  const closedHistory = historyVisible ? result.closedHistory ?? [] : [];
  const closedTotal = result.closedTotal ?? 0;
  const shownConnections = sortConnections(result.matchedConnections);
  const style = createTextStyle(config.color);
  const header = [
    ...clvmMonitorTitle(config),
    style.dim(formatLocalTimestamp(result.timestamp)),
    style.cyan(`domains=${config.domains.join(",")}`),
    style.blue(`current=${result.matchedConnections.length}`),
    style.dim(`refresh=${formatDuration(config.intervalMs)}`),
  ];

  if (config.closeZeroForSeconds === null) {
    header.push(style.dim("autoClose=off"));
    header.push(style.dim("closeAfter=none"));
  } else {
    header.push(config.autoCloseEnabled ? style.red(style.bold("autoClose=on")) : style.dim("autoClose=configured"));
    header.push(style.dim(`closeAfter=${formatSeconds(config.closeZeroForSeconds)}`));
  }

  if (config.zeroSpeedThreshold > 0) {
    header.push(style.dim(`zero<=${formatSpeed(config.zeroSpeedThreshold)}`));
  }
  if (config.autoCloseEnabled && config.closeZeroForSeconds !== null) {
    if (closed.length > 0) {
      header.push(style.red(style.bold(`closedNow=${closed.length}`)));
    }
    if (closeFailures.length > 0) {
      header.push(style.red(style.bold(`closeFailed=${closeFailures.length}`)));
    }
    if (closedTotal > 0) {
      header.push(style.dim(`closedTotal=${closedTotal}`));
    }
  }

  stream.write(`${fitTerminalLine(header.join(" "), { stream })}\n`);

  const layout = buildMonitorLayout(stream, shownConnections.length, closedHistory.length, options.interactive ?? false);
  if (shownConnections.length === 0) {
    stream.write("no current connections for configured domains\n");
  } else {
    printCurrentConnections(shownConnections, layout, style, stream);
  }

  printClosedHistory(closedHistory, layout, style, stream);
  printMonitorFooter(historyVisible, options.interactive ?? false, style, stream);
}

export function printMonitorFailure(failure: MonitorFailure, config: RuntimeConfig, stream: NodeJS.WriteStream = process.stdout, options: MonitorRenderOptions = {}): void {
  if (config.json) {
    stream.write(`${JSON.stringify(toJsonFailure(failure))}\n`);
    return;
  }

  if (config.clear) {
    stream.write("\x1B[2J\x1B[H");
  }

  const style = createTextStyle(config.color);
  const header = [
    ...clvmMonitorTitle(config),
    style.dim(formatLocalTimestamp(failure.timestamp)),
    style.cyan(`domains=${config.domains.join(",")}`),
    style.red("status=unavailable"),
    style.dim(`error=${failure.error.code}`),
  ];
  if (failure.retry) {
    header.push(style.dim(`attempt=${failure.retry.attempt}`));
    header.push(style.dim(`retry=${formatDuration(failure.retry.intervalMs)}`));
    header.push(style.dim(`next=${formatLocalTimestamp(failure.retry.nextAt)}`));
  }

  stream.write(`${fitTerminalLine(header.join(" "), { stream })}\n`);
  stream.write(`${style.red("error:")} ${failure.error.message}\n`);
  printMonitorFooter(options.historyVisible ?? true, options.interactive ?? false, style, stream);
}

export function renderMonitorResultLines(result: MonitorResult, config: RuntimeConfig, options: MonitorRenderOptions = {}): string[] {
  return captureMonitorLines((stream) => {
    printMonitorResult(result, { ...config, clear: false }, stream, options);
  });
}

export function renderMonitorFailureLines(failure: MonitorFailure, config: RuntimeConfig, options: MonitorRenderOptions = {}): string[] {
  return captureMonitorLines((stream) => {
    printMonitorFailure(failure, { ...config, clear: false }, stream, options);
  });
}

export function formatUnavailableStatus(failure: MonitorFailure, style: TextStyle): string {
  return `${style.red("unavailable")} ${style.dim(failure.error.code)} ${failure.error.message}`;
}

export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) {
    return "-";
  }
  return formatCompactRate(bytesPerSecond);
}

function captureMonitorLines(writeOutput: (stream: NodeJS.WriteStream) => void): string[] {
  let output = "";
  const stream = {
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    isTTY: process.stdout.isTTY,
    write: (chunk: string | Uint8Array): boolean => {
      output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return true;
    },
  } as NodeJS.WriteStream;
  writeOutput(stream);
  return output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
}

function clvmMonitorTitle(config: RuntimeConfig): string[] {
  if (!config.autoCloseEnabled) {
    return [];
  }
  return [bgDarkBlue(" clvm monitor ")];
}

function printCurrentConnections(shownConnections: ConnectionEntry[], layout: Layout, style: TextStyle, stream: NodeJS.WriteStream): void {
  const rows = shownConnections.map((connection) => ({
    endpoint: style.cyan(connection.endpoint),
    ageZeroFor: ageZeroForCell(connection.ageMs, connection.observedIdleMs, style),
    up: speedCell(connection.uploadBytesPerSecond, style),
    down: speedCell(connection.downloadBytesPerSecond, style),
    upload: bytesCell(connection.uploadTotal, style),
    download: bytesCell(connection.downloadTotal, style),
    chain: style.magenta(connection.chains.join(" > ")),
    rule: style.dim(connection.rule),
  }));
  stream.write(`${renderTable(currentConnectionColumns(layout), rows, { gap: 1, maxWidth: layout.maxWidth }).join("\n")}\n`);
}

function printClosedHistory(closedHistory: ClosedConnectionEntry[], layout: MonitorLayout, style: TextStyle, stream: NodeJS.WriteStream): void {
  if (layout.closedHistoryRenderCount === 0) {
    return;
  }

  stream.write(`\n${style.bold("recent closed")}\n`);
  const rows = closedHistory.slice(0, layout.closedHistoryRenderCount).map((connection) => styleTableRow({
    closedAt: formatLocalTimestamp(connection.closedAt),
    endpoint: style.cyan(connection.endpoint),
    zeroFor: zeroForCell(connection.observedIdleMs, style),
    upload: bytesCell(connection.uploadTotal, style),
    download: bytesCell(connection.downloadTotal, style),
    chain: style.magenta(connection.chains.join(" > ")),
    rule: style.dim(connection.rule),
  }, style.dim));
  stream.write(`${renderTable(closedConnectionColumns(layout), rows, { gap: 1, maxWidth: layout.maxWidth }).join("\n")}\n`);
}

function printMonitorFooter(historyVisible: boolean, interactive: boolean, style: TextStyle, stream: NodeJS.WriteStream): void {
  if (!interactive) {
    return;
  }
  stream.write(`${fitTerminalLine(style.dim(`history:${historyVisible ? "on" : "off"}  keys: t history  q/Ctrl-C exit`), { stream })}\n`);
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "-";
  }
  return formatCompactBytes(bytes);
}

function formatLocalTimestamp(value: string): string {
  const date = new Date(value);

  return [
    padNumber(date.getHours()),
    padNumber(date.getMinutes()),
    padNumber(date.getSeconds()),
  ].join(":");
}

function sortConnections(connections: ConnectionEntry[]): ConnectionEntry[] {
  return [...connections].sort((left, right) => {
    const statusOrder = statusRank(left.status) - statusRank(right.status);
    if (statusOrder !== 0) {
      return statusOrder;
    }
    return right.observedIdleMs - left.observedIdleMs || right.ageMs - left.ageMs;
  });
}

function statusRank(status: ConnectionEntry["status"]): number {
  return {
    zero: 0,
    unknown: 1,
    active: 2,
  }[status] ?? 4;
}

function currentConnectionColumns(layout: Layout): TableColumn[] {
  const columns: TableColumn[] = [
    { key: "endpoint", title: "endpoint", maxWidth: layout.endpoint, minWidth: layout.endpointMin, shrinkPriority: 20 },
    { key: "ageZeroFor", title: "age/zeroFor", width: layout.ageZeroFor },
    { key: "up", title: "up/s", width: layout.up, align: "right" },
    { key: "down", title: "down/s", width: layout.down, align: "right" },
  ];

  if (layout.showTrafficTotals) {
    columns.push(
      { key: "upload", title: "upload", width: layout.upload, align: "right" },
      { key: "download", title: "download", width: layout.download, align: "right" },
    );
  }
  if (layout.showChain) {
    columns.push({ key: "chain", title: "chain", width: layout.chain });
  }
  columns.push({ key: "rule", title: "rule", flex: true, minWidth: layout.ruleMin });

  return columns;
}

function closedConnectionColumns(layout: Layout): TableColumn[] {
  const columns: TableColumn[] = [
    { key: "closedAt", title: "closedAt", width: 8 },
    { key: "endpoint", title: "endpoint", maxWidth: layout.endpoint, minWidth: layout.endpointMin, shrinkPriority: 20 },
    { key: "zeroFor", title: "zeroFor", width: layout.zeroFor },
  ];

  if (layout.showTrafficTotals) {
    columns.push(
      { key: "upload", title: "upload", width: layout.upload, align: "right" },
      { key: "download", title: "download", width: layout.download, align: "right" },
    );
  }
  if (layout.showChain) {
    columns.push({ key: "chain", title: "chain", width: layout.chain });
  }
  columns.push({ key: "rule", title: "rule", flex: true, minWidth: layout.ruleMin });

  return columns;
}

function ageZeroForCell(ageMs: number, zeroForMs: number, style: TextStyle): string {
  return `${formatDuration(ageMs)}/${zeroForCell(zeroForMs, style)}`;
}

function zeroForCell(milliseconds: number, style: TextStyle): string {
  const text = formatDuration(milliseconds);
  return milliseconds === 0 ? style.green(text) : style.yellow(text);
}

function speedCell(bytesPerSecond: number | null, style: TextStyle): string {
  const text = bytesPerSecond === null ? "-" : formatCompactBytes(bytesPerSecond);
  if (bytesPerSecond === null || bytesPerSecond === 0) {
    return style.dim(text);
  }
  return style.green(text);
}

function bytesCell(bytes: number | null, style: TextStyle): string {
  const text = formatBytes(bytes);
  if (bytes === null || bytes === 0) {
    return style.dim(text);
  }
  return text;
}

function buildMonitorLayout(stream: NodeJS.WriteStream, currentConnectionCount: number, closedHistoryCount: number, interactive: boolean): MonitorLayout {
  return {
    ...buildLayout(stream),
    closedHistoryRenderCount: resolveClosedHistoryRenderCount(stream, currentConnectionCount, closedHistoryCount, interactive),
  };
}

function resolveClosedHistoryRenderCount(stream: NodeJS.WriteStream, currentConnectionCount: number, closedHistoryCount: number, interactive: boolean): number {
  if (closedHistoryCount === 0) {
    return 0;
  }
  if (!stream.isTTY) {
    return Math.min(closedHistoryCount, closedHistoryDefaultRenderCount);
  }

  const rows = terminalRows(stream);
  if (rows === 0) {
    return Math.min(closedHistoryCount, closedHistoryDefaultRenderCount);
  }

  const currentSectionLines = currentConnectionCount === 0 ? 1 : 1 + currentConnectionCount;
  const fixedLines = 1 + currentSectionLines + closedHistorySectionFixedLines + (interactive ? 1 : 0);
  return Math.min(closedHistoryCount, Math.max(0, rows - fixedLines));
}

function terminalRows(stream: NodeJS.WriteStream): number {
  const rows = Number.isFinite(stream.rows) ? stream.rows : process.stdout.rows;
  return rows && rows > 0 ? Math.floor(rows) : 0;
}

function buildLayout(stream: NodeJS.WriteStream): Layout {
  const maxWidth = terminalColumns(stream);
  const fixed = {
    endpoint: maxWidth >= 120 ? 28 : 22,
    endpointMin: maxWidth >= 72 ? 10 : 6,
    ageZeroFor: 12,
    zeroFor: 7,
    up: 6,
    down: 6,
    upload: 8,
    download: 8,
    chain: maxWidth >= 120 ? 20 : 14,
  };

  return {
    maxWidth,
    showTrafficTotals: maxWidth >= 96,
    showChain: maxWidth >= 72,
    ...fixed,
    ruleMin: maxWidth >= 72 ? 12 : 4,
  };
}

function padNumber(value: number): string {
  return String(value).padStart(2, "0");
}
