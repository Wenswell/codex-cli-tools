#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const maxLogEntries = 10;
const maxInlineUserChars = 240;
const maxAnswerPreviewChars = 360;

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

const rawPayload = process.argv.length > 2 ? process.argv.at(-1) : "";

if (!rawPayload) {
  throw new Error("Codex notify JSON payload is required as the last argument");
}

const webhook = process.env.FEISHU_BOT_WEBHOOK || await readWebhookFromEnvFile();

if (!webhook) {
  throw new Error("FEISHU_BOT_WEBHOOK is required in .env or environment");
}

const payload = JSON.parse(rawPayload) as CodexNotifyPayload;
const card = buildCard(payload);

await postFeishu(webhook, {
  msg_type: "interactive",
  card,
});

async function readWebhookFromEnvFile(): Promise<string> {
  const envPath = new URL("../../.env", import.meta.url);
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
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
  const title = payload.type ? `Codex ${payload.type}` : "Codex notification";
  const input = readInputMessages(payload["input-messages"]);
  const answer =
    payload["last-assistant-message"] ??
    payload.last_assistant_message ??
    payload.lastAssistantMessage;
  const answerText = answer ?? `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  const answerParts = splitPreview(answerText, maxAnswerPreviewChars);
  const metaLines: string[] = [];

  if (payload.cwd) {
    metaLines.push(`**cwd:** ${formatHomePath(payload.cwd)}`);
  }
  if (input.latest) {
    metaLines.push(`**user:** ${truncate(input.latest, maxInlineUserChars)}`);
  }

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
        ...(metaLines.length > 0
          ? [{
              tag: "markdown" as const,
              content: metaLines.join("\n"),
            }]
          : []),
        buildSeparator(),
        {
          tag: "markdown" as const,
          content: answerParts.preview,
        },
        ...(answerParts.rest ? [buildCollapsibleReply(answerParts.rest)] : []),
      ],
    },
  };
}

function getHeaderTemplate(payload: CodexNotifyPayload): "blue" | "red" {
  const type = payload.type?.toLowerCase() ?? "";
  return type.includes("error") || type.includes("fail") ? "red" : "blue";
}

function buildSeparator(): FeishuCardBody["card"]["body"]["elements"][number] {
  return {
    tag: "markdown",
    content: "---",
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
  const path = new URL("../../codex-notice.log.jsonl", import.meta.url);
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
