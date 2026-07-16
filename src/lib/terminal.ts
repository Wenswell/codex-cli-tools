import { truncateVisible, visibleLength } from "./text.js";

export type FitTerminalLineOptions = {
  stream?: NodeJS.WriteStream;
  columns?: number;
  reserveColumns?: number;
  ellipsis?: string;
  ttyOnly?: boolean;
};

export type CommandFooterRow = {
  label: string;
  commands: string[];
};

export function terminalColumns(stream: NodeJS.WriteStream = process.stdout, defaultColumns = 120): number {
  const columns = Number.isFinite(stream.columns) ? stream.columns : process.stdout.columns;
  return columns && columns > 0 ? Math.floor(columns) : defaultColumns;
}

export function fitTerminalLine(line: string, options: FitTerminalLineOptions = {}): string {
  const stream = options.stream ?? process.stdout;
  const columns = options.columns ?? terminalColumns(stream, 0);
  if ((options.ttyOnly ?? true) && !stream.isTTY) {
    return line;
  }
  if (!columns || visibleLength(line) < columns) {
    return line;
  }
  const reserveColumns = options.reserveColumns ?? 1;
  return truncateVisible(line, Math.max(0, columns - reserveColumns), options.ellipsis ?? "");
}

export function fitCommandsLine(fullLine: string, compactLine: string, columns: number): string {
  const line = visibleLength(fullLine) <= columns ? fullLine : compactLine;
  return visibleLength(line) <= columns ? line : truncateVisible(line, columns);
}

export function formatCommandFooterLines(
  rows: CommandFooterRow[],
): string[] {
  const labelWidth = Math.max(...rows.map(({ label }) => visibleLength(label)));
  return rows.map(({ label, commands }) =>
    `${label}${" ".repeat(labelWidth - visibleLength(label) + 1)}${commands.join(" | ")}`);
}
