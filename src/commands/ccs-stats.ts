import { readTextIfExists } from "../lib/fs.js";
import { formatDurationMs } from "../lib/format.js";
import { colorPath, printKeyValue } from "../lib/output.js";
import { formatHomePath } from "../lib/paths.js";
import { formatAgo } from "../lib/profile-usage.js";
import { printTable, type TableColumn } from "../lib/table.js";
import { textBold, textDim, textGreen, textRed, textYellow } from "../lib/text.js";
import { usageLogPath, type UsageRecord } from "../lib/usage.js";

function parseUsageRecords(text: string): UsageRecord[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const record = JSON.parse(line) as UsageRecord;
      return record.version === 1 && typeof record.command === "string" ? [record] : [];
    } catch {
      return [];
    }
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percent(part: number, total: number): string {
  return total === 0 ? "-" : `${Math.round((part / total) * 100)}%`;
}

function count(value: number, color: (text: string) => string): string {
  return value === 0 ? textDim("0") : color(String(value));
}

export async function runCcsStats(args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new Error(`unknown argument for ccs stats: ${args[0]}`);
  }
  const path = usageLogPath();
  const records = parseUsageRecords((await readTextIfExists(path)) ?? "");
  printKeyValue("file:", colorPath(formatHomePath(path)), 8);
  if (records.length === 0) {
    printKeyValue("records:", "0", 8);
    console.log(textDim(process.env.CODEX_TOOLS_USAGE === "off" ? "recording is off (CODEX_TOOLS_USAGE=off)." : "no usage recorded yet."));
    return;
  }
  const nowMs = Date.now();
  printKeyValue("records:", `${records.length} since ${formatAgo(Date.parse(records[0].recorded_at), nowMs)}`, 8);

  const commands = new Map<string, UsageRecord[]>();
  for (const record of records) {
    commands.set(record.command, [...(commands.get(record.command) ?? []), record]);
  }
  const commandColumns: TableColumn[] = [
    { key: "command", title: "command", flex: true, truncate: true },
    { key: "runs", title: "runs", align: "right" },
    { key: "last", title: "last", align: "right" },
    { key: "ok", title: "ok", align: "right" },
    { key: "error", title: "error", align: "right" },
    { key: "cancel", title: "cancel", align: "right" },
    { key: "p50", title: "p50", align: "right" },
    { key: "shortcut", title: "shortcut", align: "right" },
  ];
  console.log("");
  printTable(commandColumns, [...commands.entries()]
    .sort(([, left], [, right]) => right.length - left.length)
    .map(([command, entries]) => {
      const outcomes = (outcome: UsageRecord["outcome"]): number => entries.filter((entry) => entry.outcome === outcome).length;
      return {
        command,
        runs: String(entries.length),
        last: textDim(formatAgo(Date.parse(entries.at(-1)!.recorded_at), nowMs)),
        ok: count(outcomes("ok"), textGreen),
        error: count(outcomes("error"), textRed),
        cancel: count(outcomes("cancelled") + outcomes("interrupted"), textYellow),
        p50: formatDurationMs(median(entries.map((entry) => entry.duration_ms))),
        shortcut: textDim(percent(entries.filter((entry) => entry.via === "shortcut").length, entries.length)),
      };
    }), { maxWidth: process.stdout.columns || 120 });

  const prompts = new Map<string, { command: string; entries: UsageRecord["prompts"] }>();
  for (const record of records) {
    for (const prompt of record.prompts ?? []) {
      const key = `${record.command}\u0000${prompt.prompt}`;
      const entry = prompts.get(key) ?? { command: record.command, entries: [] };
      entry.entries.push(prompt);
      prompts.set(key, entry);
    }
  }
  if (prompts.size === 0) return;
  console.log("");
  console.log(textBold("prompts"));
  printTable([
    { key: "prompt", title: "prompt", flex: true, truncate: true },
    { key: "command", title: "command", truncate: true },
    { key: "shown", title: "shown", align: "right" },
    { key: "cancelled", title: "cancelled", align: "right" },
    { key: "default", title: "kept default", align: "right" },
  ], [...prompts.values()]
    .sort((left, right) => right.entries.length - left.entries.length)
    .map(({ command, entries }) => {
      const answered = entries.filter((entry) => entry.outcome === "answered");
      const withDefault = answered.filter((entry) => entry.kept_default !== null);
      return {
        prompt: entries[0].prompt,
        command: textDim(command),
        shown: String(entries.length),
        cancelled: percent(entries.length - answered.length, entries.length),
        default: withDefault.length === 0 ? textDim("-") : percent(withDefault.filter((entry) => entry.kept_default).length, withDefault.length),
      };
    }), { maxWidth: process.stdout.columns || 120 });
}
