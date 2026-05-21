#!/usr/bin/env node
import { readFile } from "node:fs/promises";

type CodexNotifyPayload = {
  type?: string;
  last_assistant_message?: string;
  lastAssistantMessage?: string;
  [key: string]: unknown;
};

type FeishuTextBody = {
  msg_type: "text";
  content: {
    text: string;
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
const message = buildMessage(payload);

await postFeishu(webhook, {
  msg_type: "text",
  content: {
    text: message,
  },
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

function buildMessage(payload: CodexNotifyPayload): string {
  const title = payload.type ? `Codex: ${payload.type}` : "Codex notification";
  const body =
    payload.last_assistant_message ??
    payload.lastAssistantMessage ??
    JSON.stringify(payload, null, 2);

  return `${title}\n${body}`;
}

async function postFeishu(url: string, body: FeishuTextBody): Promise<void> {
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
