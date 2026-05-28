#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { confirmApply, rejectRemovedYesFlags } from "../lib/confirm.js";
import { codexToolsConfigDir } from "../lib/paths.js";
import { colorPath, printKeyValue } from "../lib/output.js";
import { textBlue, textDim, textGreen, textRed } from "../lib/text.js";

const maxLogEntries = 10;
const maxInlineUserChars = 240;
const maxHeaderReplyChars = 96;
const maxAnswerPreviewChars = 360;
const noticeEnvPath = join(codexToolsConfigDir(), "notice.env");

type CodexNotifyPayload = {
  type?: string;
  client?: string;
  cwd?: string;
  "input-messages"?: unknown;
  "last-assistant-message"?: string;
  last_assistant_message?: string;
  lastAssistantMessage?: string;
  [key: string]: unknown;
};

type InputMessages = {
  latest: string;
  all: string[];
};

type FeishuCardBody = {
  msg_type: "interactive";
  card: {
    schema: "2.0";
    header: {
      template: "blue" | "red";
      title: {
        tag: "plain_text";
        content: string;
      };
    };
    body: {
      elements: Array<
        | {
            tag: "markdown";
            content: string;
          }
        | {
            tag: "hr";
          }
        | {
            tag: "column_set";
            flex_mode: "none";
            background_style: "grey";
            columns: Array<{
              tag: "column";
              width: "weighted";
              weight: number;
              elements: Array<{
                tag: "markdown";
                content: string;
              }>;
            }>;
          }
        | {
            tag: "collapsible_panel";
            expanded: boolean;
            header: {
              title: {
                tag: "markdown";
                content: string;
              };
              vertical_align: "center";
              icon: {
                tag: "standard_icon";
                token: string;
                color: "";
                size: string;
              };
              icon_position: "right";
              icon_expanded_angle: number;
            };
            border: {
              color: "grey";
              corner_radius: string;
            };
            vertical_spacing: string;
            padding: string;
            elements: Array<{
              tag: "markdown";
              content: string;
            }>;
          }
      >;
    };
  };
};

type FeishuPostResult = {
  status: number;
  responseText: string;
  responseJson: unknown;
};

type SendLogEntry = {
  at: string;
  payload: CodexNotifyPayload;
  request?: FeishuCardBody;
  response?: FeishuPostResult;
  skipped?: {
    reason: string;
  };
};

const argv = process.argv.slice(2);
const command = argv[0] ?? "";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${textRed("codex-notice:")} ${message}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (!command) {
    await printStatus();
    printCommands();
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }
  if (command === "status") {
    requireNoExtraArgs(argv.slice(1), "codex-notice status");
    await printStatus();
    return;
  }
  if (command === "logs") {
    await printLogs(parseLogLimit(argv.slice(1)));
    return;
  }
  if (command === "config") {
    await configureWebhook(argv.slice(1));
    return;
  }
  if (command === "test") {
    await sendPayload(buildTestPayload(argv.slice(1).join(" ") || "codex-notice test"));
    return;
  }
  if (command === "hook") {
    await sendPayload(parseHookPayload(argv.slice(1)));
    return;
  }

  console.error(`${textRed("unknown command:")} ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log([
    "Usage:",
    "  codex-notice                           # show active webhook, config, log, and commands",
    "  codex-notice status                    # show active webhook, config, and log",
    "  codex-notice config WEBHOOK           # preview, confirm, and write Feishu webhook config",
    "  codex-notice test [MESSAGE]            # send a test notification",
    "  codex-notice logs [N]                  # show recent send logs",
    "  codex-notice hook JSON_PAYLOAD         # receive Codex notify payload and send Feishu card",
  ].join("\n"));
}

function printCommands(): void {
  printKeyValue("commands:", "codex-notice | status | config WEBHOOK | test [MESSAGE] | logs [N] | hook JSON_PAYLOAD", 10);
}

function requireNoExtraArgs(args: string[], usage: string): void {
  if (args.length > 0) {
    throw new Error(`usage: ${usage}`);
  }
}

function parseLogLimit(args: string[]): number {
  if (args.length > 1) {
    throw new Error("usage: codex-notice logs [N]");
  }
  const raw = args[0] ?? "5";
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error("logs N must be a positive integer");
  }
  return Number(raw);
}

function parseHookPayload(args: string[]): CodexNotifyPayload {
  if (args.length !== 1) {
    throw new Error("usage: codex-notice hook JSON_PAYLOAD");
  }
  try {
    const payload = JSON.parse(args[0]) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("payload must be a JSON object");
    }
    return payload as CodexNotifyPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON payload: ${message}`);
  }
}

async function sendPayload(payload: CodexNotifyPayload): Promise<void> {
  if (shouldSkipNotification(payload)) {
    await tryWriteSkippedLog(payload, "non-main conversation");
    return;
  }
  const webhook = await readWebhook();
  const card = buildCard(payload);
  await postFeishu(webhook, payload, {
    msg_type: "interactive",
    card,
  });
}

function shouldSkipNotification(payload: CodexNotifyPayload): boolean {
  return payload.client !== "codex-tui";
}

async function readWebhook(): Promise<string> {
  const webhook = process.env.FEISHU_BOT_WEBHOOK || await readWebhookFromConfigFile();
  if (!webhook) {
    throw new Error("FEISHU_BOT_WEBHOOK is required in environment or ~/.config/codex-tools/notice.env");
  }
  return webhook;
}

function buildTestPayload(message: string): CodexNotifyPayload {
  return {
    type: "agent-turn-complete",
    cwd: process.cwd(),
    "input-messages": ["codex-notice test"],
    "last-assistant-message": message,
  };
}

async function readWebhookFromConfigFile(): Promise<string> {
  return readWebhookFromFile(noticeEnvPath);
}

async function readWebhookFromFile(path: string | URL): Promise<string> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?FEISHU_BOT_WEBHOOK\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    return stripEnvQuotes(match[1].trim());
  }

  return "";
}

async function printStatus(): Promise<void> {
  const configWebhook = await readWebhookFromFile(noticeEnvPath);
  const webhook = process.env.FEISHU_BOT_WEBHOOK || configWebhook;
  printKeyValue("webhook:", webhook ? textGreen(webhook) : textRed("missing"), 10);
  printKeyValue("config:", colorPath(noticeEnvPath), 10);
  printKeyValue("log:", colorPath(logPath().pathname), 10);
}

async function configureWebhook(argv: string[]): Promise<void> {
  rejectRemovedYesFlags(argv, "codex-notice config");
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      throw new Error(`unknown argument for codex-notice config: ${arg}`);
    }
  }
  const values = argv;
  if (values.length !== 1) {
    throw new Error("usage: codex-notice config WEBHOOK");
  }
  const webhook = values[0];
  validateWebhook(webhook);
  printKeyValue("target:", `${textBlue("would update")} ${colorPath(noticeEnvPath)}`, 10);
  printKeyValue("webhook:", textGreen(webhook), 10);
  console.log(textDim("no changes are written unless you type yes at the prompt."));
  if (!(await confirmApply())) {
    return;
  }
  await mkdir(dirname(noticeEnvPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(noticeEnvPath), 0o700);
  await writeFile(noticeEnvPath, `FEISHU_BOT_WEBHOOK=${webhook}\n`, { mode: 0o600 });
  await chmod(noticeEnvPath, 0o600);
  printKeyValue("target:", `${textGreen("updated")} ${colorPath(noticeEnvPath)}`, 10);
}

function validateWebhook(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("webhook must be an http or https URL");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid webhook URL: ${message}`);
  }
}

async function printLogs(limit: number): Promise<void> {
  const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
  let text = "";
  try {
    text = await readFile(logPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("no logs");
      return;
    }
    throw error;
  }
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-count);
  if (lines.length === 0) {
    console.log("no logs");
    return;
  }
  for (const line of lines) {
    let entry: {
      at?: string;
      payload?: CodexNotifyPayload;
      request?: { card?: { header?: { title?: { content?: string } } } };
      response?: { status?: number; responseJson?: { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string } };
      skipped?: { reason?: string };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid log entry in ${logPath().pathname}: ${message}`);
    }
    const title = entry.request?.card?.header?.title?.content ?? entry.skipped?.reason ?? "Codex";
    const type = entry.payload?.type ?? "?";
    const status = entry.skipped ? "skip" : (entry.response?.status ?? "?");
    const code = entry.skipped ? "-" : (entry.response?.responseJson?.code ?? entry.response?.responseJson?.StatusCode ?? "?");
    const msg = entry.skipped?.reason ?? entry.response?.responseJson?.msg ?? entry.response?.responseJson?.StatusMessage ?? "";
    console.log(`${entry.at ?? ""}  ${status}  ${code}  ${type}  ${title}${msg ? `  ${msg}` : ""}`);
  }
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function buildCard(payload: CodexNotifyPayload): FeishuCardBody["card"] {
  const input = readInputMessages(payload["input-messages"]);
  const answer =
    payload["last-assistant-message"] ??
    payload.last_assistant_message ??
    payload.lastAssistantMessage;
  const answerText = answer ?? `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  const title = buildHeaderTitle(answerText, payload);
  const answerParts = splitPreview(answerText, maxAnswerPreviewChars);
  return {
    schema: "2.0",
    header: {
      template: getHeaderTemplate(payload),
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    body: {
      elements: [
        ...buildMetaColumns(payload.cwd, input.latest),
        buildHr(),
        {
          tag: "markdown" as const,
          content: answerParts.preview,
        },
        ...(answerParts.rest ? [buildCollapsibleReply(answerParts.rest)] : []),
      ],
    },
  };
}

function buildHeaderTitle(answerText: string, payload: CodexNotifyPayload): string {
  const summary = formatHeaderPreview(answerText);
  return summary ? truncate(summary, maxHeaderReplyChars) : (payload.type ?? "codex notice");
}

function formatHeaderPreview(value: string): string {
  return compactInline(normalizeHeaderPunctuation(stripMarkdownDecoration(value)));
}

function stripMarkdownDecoration(value: string): string {
  return value
    .replace(/```[a-zA-Z0-9_-]*\s*/g, "")
    .replace(/```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)[*_]{1,3}([^*_]+)[*_]{1,3}(\s|$)/g, "$1$2$3")
    .replace(/(^|\s)>+\s*/g, "$1")
    .replace(/(^|\s)(?:[-*+]|\d+[.)])\s+/g, "$1");
}

function normalizeHeaderPunctuation(value: string): string {
  return value
    .replace(/，/g, ",")
    .replace(/。/g, ".")
    .replace(/：/g, ":")
    .replace(/；/g, ";")
    .replace(/！/g, "!")
    .replace(/？/g, "?")
    .replace(/、/g, ",");
}

function getHeaderTemplate(payload: CodexNotifyPayload): "blue" | "red" {
  const type = payload.type?.toLowerCase() ?? "";
  return type.includes("error") || type.includes("fail") ? "red" : "blue";
}

function buildMetaColumns(
  cwd: string | undefined,
  latestInput: string,
): Array<FeishuCardBody["card"]["body"]["elements"][number]> {
  return [
    {
      tag: "column_set",
      flex_mode: "none",
      background_style: "grey",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "markdown",
              content: `🕒 ${formatLocalTimestamp(new Date())}  👤 ${formatSystemLabel()}`,
            },
          ],
        },
      ],
    },
    {
      tag: "column_set",
      flex_mode: "none",
      background_style: "grey",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "markdown",
              content: `📁 ${cwd ? formatHomePath(cwd) : "-"}`,
            },
          ],
        },
      ],
    },
    {
      tag: "column_set",
      flex_mode: "none",
      background_style: "grey",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "markdown",
              content: `💬 ${latestInput ? truncate(latestInput, maxInlineUserChars) : "-"}`,
            },
          ],
        },
      ],
    },
  ];
}

function formatSystemLabel(): string {
  const username = process.env.USER || process.env.LOGNAME || userInfo().username || "unknown";
  const host = (process.env.HOSTNAME || hostname() || "unknown").split(".")[0] || "unknown";
  return `${username}@${host}`;
}

function formatLocalTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

function buildHr(): FeishuCardBody["card"]["body"]["elements"][number] {
  return {
    tag: "hr",
  };
}

function buildCollapsibleReply(content: string): FeishuCardBody["card"]["body"]["elements"][number] {
  return buildCollapsiblePanel("剩余回复（点击展开）", content);
}

function buildCollapsiblePanel(
  title: string,
  content: string,
): FeishuCardBody["card"]["body"]["elements"][number] {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "markdown",
        content: `**${title}**`,
      },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    border: {
      color: "grey",
      corner_radius: "5px",
    },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [
      {
        tag: "markdown",
        content,
      },
    ],
  };
}

function readInputMessages(value: unknown): InputMessages {
  if (Array.isArray(value)) {
    const all = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return {
      latest: all.at(-1) ?? "",
      all,
    };
  }
  if (typeof value === "string" && value.trim()) {
    return {
      latest: value,
      all: [value],
    };
  }
  return {
    latest: "",
    all: [],
  };
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function compactInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitPreview(value: string, maxChars: number): { preview: string; rest: string } {
  if (value.length <= maxChars) {
    return {
      preview: value,
      rest: "",
    };
  }
  const splitAt = findPreviewSplitIndex(value, maxChars);
  return {
    preview: `${value.slice(0, splitAt).trimEnd()}...`,
    rest: value.slice(splitAt).trimStart(),
  };
}

function findPreviewSplitIndex(value: string, maxChars: number): number {
  const window = value.slice(0, maxChars);
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak >= Math.floor(maxChars * 0.45)) {
    return paragraphBreak;
  }
  const lineBreak = window.lastIndexOf("\n");
  if (lineBreak >= Math.floor(maxChars * 0.65)) {
    return lineBreak;
  }
  const space = window.lastIndexOf(" ");
  if (space >= Math.floor(maxChars * 0.75)) {
    return space;
  }
  return maxChars;
}

function formatHomePath(path: string): string {
  const home = process.env.HOME;
  if (!home) {
    return path;
  }
  if (path === home) {
    return "~";
  }
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

async function postFeishu(url: string, payload: CodexNotifyPayload, body: FeishuCardBody): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const result = parseJson(text);
  await tryWriteSendLog(payload, body, {
    status: response.status,
    responseText: text,
    responseJson: result,
  });

  if (!response.ok) {
    throw new Error(`Feishu webhook failed: ${response.status} ${text}`);
  }

  const responseJson = result as { code?: number; StatusCode?: number; msg?: string };

  if (responseJson.code !== 0 && responseJson.StatusCode !== 0) {
    throw new Error(`Feishu webhook rejected message: ${text}`);
  }
}

async function tryWriteSendLog(payload: CodexNotifyPayload, request: FeishuCardBody, result: FeishuPostResult): Promise<void> {
  try {
    await writeLogEntry({
      at: new Date().toISOString(),
      payload,
      request,
      response: result,
    });
  } catch {
    // Notify hooks should not fail only because local debug logging failed.
  }
}

async function tryWriteSkippedLog(payload: CodexNotifyPayload, reason: string): Promise<void> {
  try {
    await writeLogEntry({
      at: new Date().toISOString(),
      payload,
      skipped: { reason },
    });
  } catch {
    // Notify hooks should not fail only because local debug logging failed.
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeLogEntry(entry: SendLogEntry): Promise<void> {
  const path = logPath();
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const entries = existing
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-(maxLogEntries - 1));
  entries.push(JSON.stringify(entry));

  await writeFile(path, `${entries.join("\n")}\n`, { mode: 0o600 });
}

function logPath(): URL {
  return new URL("../../codex-notice.log.jsonl", import.meta.url);
}
