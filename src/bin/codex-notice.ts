#!/usr/bin/env node
import { readFile } from "node:fs/promises";

type CodexNotifyPayload = {
  type?: string;
  cwd?: string;
  "input-messages"?: unknown;
  "last-assistant-message"?: string;
  last_assistant_message?: string;
  lastAssistantMessage?: string;
  [key: string]: unknown;
};

type FeishuCardBody = {
  msg_type: "interactive";
  card: {
    config: {
      wide_screen_mode: boolean;
    };
    header: {
      title: {
        tag: "plain_text";
        content: string;
      };
      template: "blue";
    };
    elements: Array<
      | {
          tag: "div";
          text: {
            tag: "lark_md";
            content: string;
          };
        }
      | {
          tag: "hr";
        }
    >;
  };
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
  const input = readInputMessage(payload["input-messages"]);
  const answer =
    payload["last-assistant-message"] ??
    payload.last_assistant_message ??
    payload.lastAssistantMessage;
  const metaLines: string[] = [];

  if (payload.cwd) {
    metaLines.push(`**cwd:** ${formatHomePath(payload.cwd)}`);
  }
  if (input) {
    metaLines.push(`**user:** ${input}`);
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
      template: "blue",
    },
    elements: [
      ...(metaLines.length > 0
        ? [{
            tag: "div" as const,
            text: {
              tag: "lark_md" as const,
              content: metaLines.join("\n"),
            },
          }]
        : []),
      ...(answer
        ? [
            { tag: "hr" as const },
            {
              tag: "div" as const,
              text: {
                tag: "lark_md" as const,
                content: answer,
              },
            },
          ]
        : [
            { tag: "hr" as const },
            {
              tag: "div" as const,
              text: {
                tag: "lark_md" as const,
                content: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
              },
            },
          ]),
    ],
  };
}

function readInputMessage(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join("\n");
  }
  return typeof value === "string" ? value : "";
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

  if (!response.ok) {
    throw new Error(`Feishu webhook failed: ${response.status} ${text}`);
  }

  const result = JSON.parse(text) as { code?: number; msg?: string };

  if (result.code !== 0) {
    throw new Error(`Feishu webhook rejected message: ${text}`);
  }
}
