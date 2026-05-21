#!/usr/bin/env node
import { readFile } from "node:fs/promises";
const rawPayload = process.argv.length > 2 ? process.argv.at(-1) : "";
if (!rawPayload) {
    throw new Error("Codex notify JSON payload is required as the last argument");
}
const webhook = process.env.FEISHU_BOT_WEBHOOK || await readWebhookFromEnvFile();
if (!webhook) {
    throw new Error("FEISHU_BOT_WEBHOOK is required in .env or environment");
}
const payload = JSON.parse(rawPayload);
const card = buildCard(payload);
await postFeishu(webhook, {
    msg_type: "interactive",
    card,
});
async function readWebhookFromEnvFile() {
    const envPath = new URL("../../.env", import.meta.url);
    let text = "";
    try {
        text = await readFile(envPath, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
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
function stripEnvQuotes(value) {
    if ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function buildCard(payload) {
    const title = payload.type ? `Codex ${payload.type}` : "Codex notification";
    const input = readInputMessage(payload["input-messages"]);
    const answer = payload["last-assistant-message"] ??
        payload.last_assistant_message ??
        payload.lastAssistantMessage;
    const metaLines = [];
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
                        tag: "div",
                        text: {
                            tag: "lark_md",
                            content: metaLines.join("\n"),
                        },
                    }]
                : []),
            ...(answer
                ? [
                    { tag: "hr" },
                    {
                        tag: "div",
                        text: {
                            tag: "lark_md",
                            content: answer,
                        },
                    },
                ]
                : [
                    { tag: "hr" },
                    {
                        tag: "div",
                        text: {
                            tag: "lark_md",
                            content: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
                        },
                    },
                ]),
        ],
    };
}
function readInputMessage(value) {
    if (Array.isArray(value)) {
        return value.filter((item) => typeof item === "string").join("\n");
    }
    return typeof value === "string" ? value : "";
}
function formatHomePath(path) {
    const home = process.env.HOME;
    if (!home) {
        return path;
    }
    if (path === home) {
        return "~";
    }
    return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
async function postFeishu(url, body) {
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
    const result = JSON.parse(text);
    if (result.code !== 0) {
        throw new Error(`Feishu webhook rejected message: ${text}`);
    }
}
