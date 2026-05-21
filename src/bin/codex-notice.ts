#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { codexToolsConfigDir } from "../lib/paths.js";

const maxLogEntries = 10;
const maxInlineUserChars = 240;
const maxAnswerPreviewChars = 360;
const noticeEnvPath = join(codexToolsConfigDir(), "notice.env");

type CodexNotifyPayload = {
  type?: string;
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

const argv = process.argv.slice(2);
const command = argv[0] ?? "";

if (command === "--help" || command === "-h" || command === "help") {
  printHelp();
} else if (command === "status") {
  await printStatus();
} else if (command === "logs") {
  await printLogs(Number(argv[1] ?? "5"));
} else if (command === "test") {
  await sendPayload(buildTestPayload(argv.slice(1).join(" ") || "codex-notice test"));
} else if (command === "hook") {
  const rawPayload = argv.length > 1 ? argv.at(-1) : "";
  if (!rawPayload) {
    throw new Error("codex-notice hook requires Codex notify JSON payload");
  }
  await sendPayload(JSON.parse(rawPayload) as CodexNotifyPayload);
} else {
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log([
    "Usage:",
    "  codex-notice hook JSON_PAYLOAD",
    "  codex-notice test [MESSAGE]",
    "  codex-notice logs [N]",
    "  codex-notice status",
  ].join("\n"));
}

async function sendPayload(payload: CodexNotifyPayload): Promise<void> {
  const webhook = await readWebhook();
  const card = buildCard(payload);
  await postFeishu(webhook, {
    msg_type: "interactive",
    card,
  });
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
  const hasEnv = Boolean(process.env.FEISHU_BOT_WEBHOOK);
  const configWebhook = await readWebhookFromFile(noticeEnvPath);
  const webhookSource = hasEnv
    ? "env"
    : configWebhook
      ? noticeEnvPath
      : "missing";
  console.log([
    `webhook: ${webhookSource}`,
    `config:  ${noticeEnvPath}`,
    `log:     ${logPath().pathname}`,
  ].join("\n"));
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
    const entry = JSON.parse(line) as {
      at?: string;
      request?: { card?: { header?: { title?: { content?: string } } } };
      response?: { status?: number; responseJson?: { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string } };
    };
    const title = entry.request?.card?.header?.title?.content ?? "Codex";
    const status = entry.response?.status ?? "?";
    const code = entry.response?.responseJson?.code ?? entry.response?.responseJson?.StatusCode ?? "?";
    const msg = entry.response?.responseJson?.msg ?? entry.response?.responseJson?.StatusMessage ?? "";
    console.log(`${entry.at ?? ""}  ${status}  ${code}  ${title}${msg ? `  ${msg}` : ""}`);
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
  const title = `Codex ${formatSystemLabel()}`;
  const input = readInputMessages(payload["input-messages"]);
  const answer =
    payload["last-assistant-message"] ??
    payload.last_assistant_message ??
    payload.lastAssistantMessage;
  const answerText = answer ?? `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
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

function formatSystemLabel(): string {
  const username = process.env.USER || process.env.LOGNAME || userInfo().username || "unknown";
  const host = (process.env.HOSTNAME || hostname() || "unknown").split(".")[0] || "unknown";
  return `${username}@${host}`;
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

async function postFeishu(url: string, body: FeishuCardBody): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const result = parseJson(text);
  await tryWriteSendLog(body, {
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

async function tryWriteSendLog(request: FeishuCardBody, result: FeishuPostResult): Promise<void> {
  try {
    await writeSendLog(request, result);
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

async function writeSendLog(request: FeishuCardBody, result: FeishuPostResult): Promise<void> {
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
  entries.push(JSON.stringify({
    at: new Date().toISOString(),
    request,
    response: result,
  }));

  await writeFile(path, `${entries.join("\n")}\n`, { mode: 0o600 });
}

function logPath(): URL {
  return new URL("../../codex-notice.log.jsonl", import.meta.url);
}
