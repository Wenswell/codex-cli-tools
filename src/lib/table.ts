import { padVisibleLeft, padVisibleRight, textBold, truncateVisible, visibleLength } from "./text.js";

export type TableAlign = "left" | "right";

export type TableColumn = {
  key: string;
  title: string;
  align?: TableAlign;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  shrinkPriority?: number;
  flex?: boolean;
  truncate?: boolean;
};

export type TableRow = Record<string, string | number | null | undefined>;

export type RenderTableOptions = {
  gap?: number;
  maxWidth?: number;
  header?: boolean;
  boldHeader?: boolean;
};

export function styleTableRow(row: TableRow, style: (value: string) => string): TableRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value === null || value === undefined ? value : style(String(value)),
  ]));
}

const DEFAULT_GAP = 2;

export function renderTable(columns: TableColumn[], rows: TableRow[], options: RenderTableOptions = {}): string[] {
  const header = options.header ?? true;
  const gap = options.gap ?? DEFAULT_GAP;
  const widths = resolveColumnWidths(columns, rows, options.maxWidth, gap, header);
  const lines = header
    ? [formatTableRow(columns, Object.fromEntries(columns.map((column) => [column.key, options.boldHeader === false ? column.title : textBold(column.title)])), widths, gap)]
    : [];
  for (const row of rows) {
    lines.push(formatTableRow(columns, row, widths, gap));
  }
  return lines;
}

export function printTable(columns: TableColumn[], rows: TableRow[], options: RenderTableOptions = {}): void {
  for (const line of renderTable(columns, rows, options)) {
    console.log(line);
  }
}

function resolveColumnWidths(
  columns: TableColumn[],
  rows: TableRow[],
  maxWidth: number | undefined,
  gap: number,
  includeHeader: boolean,
): number[] {
  const naturalWidths = columns.map((column) => {
    const values = rows.map((row) => formatCellValue(row[column.key]));
    if (includeHeader) {
      values.push(column.title);
    }
    const natural = Math.max(0, ...values.map(visibleLength));
    const minWidth = column.minWidth ?? 0;
    const maxColumnWidth = column.width ?? column.maxWidth ?? Number.POSITIVE_INFINITY;
    return Math.max(minWidth, Math.min(natural, maxColumnWidth));
  });

  const fixedWidths = naturalWidths.map((width, index) => columns[index].width ?? width);
  if (!maxWidth || maxWidth <= 0 || columns.length === 0) {
    return fixedWidths;
  }

  const separatorWidth = gap * Math.max(0, columns.length - 1);
  const available = Math.max(0, maxWidth - separatorWidth);
  const widths = [...fixedWidths];
  let flexIndex = -1;
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    if (columns[index].flex) {
      flexIndex = index;
      break;
    }
  }
  if (flexIndex >= 0) {
    const otherWidth = widths.reduce((sum, width, index) => sum + (index === flexIndex ? 0 : width), 0);
    const column = columns[flexIndex];
    widths[flexIndex] = clampWidth(available - otherWidth, column.minWidth ?? 0, column.maxWidth ?? Number.POSITIVE_INFINITY);
  }

  let overflow = widths.reduce((sum, width) => sum + width, 0) - available;
  for (const index of shrinkOrder(columns)) {
    if (overflow <= 0) {
      break;
    }
    const column = columns[index];
    const minimum = column.minWidth ?? Math.min(widths[index], visibleLength(column.title));
    const shrink = Math.min(overflow, Math.max(0, widths[index] - minimum));
    widths[index] -= shrink;
    overflow -= shrink;
  }
  return widths;
}

function shrinkOrder(columns: TableColumn[]): number[] {
  return columns
    .map((column, index) => ({ index, priority: column.shrinkPriority ?? 100 }))
    .sort((left, right) => left.priority - right.priority || right.index - left.index)
    .map((item) => item.index);
}

function formatTableRow(columns: TableColumn[], row: TableRow, widths: number[], gap: number): string {
  return columns.map((column, index) => {
    const width = widths[index] ?? 0;
    const raw = formatCellValue(row[column.key]);
    const value = column.truncate === false ? raw : truncateVisible(raw, width);
    return (column.align ?? "left") === "right"
      ? padVisibleLeft(value, width)
      : padVisibleRight(value, width);
  }).join(" ".repeat(gap)).trimEnd();
}

function formatCellValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function clampWidth(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
