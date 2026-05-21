#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { codexToolsConfigDir } from "../lib/paths.js";
import { colorPath, printKeyValue } from "../lib/output.js";
import { textBlue, textDim, textGreen, textRed } from "../lib/text.js";
const maxLogEntries = 10;
const maxInlineUserChars = 240;
const maxAnswerPreviewChars = 360;
const noticeEnvPath = join(codexToolsConfigDir(), "notice.env");
const argv = process.argv.slice(2);
const command = argv[0] ?? "";
if (!command) {
    await printStatus();
}
else if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
}
else if (command === "status") {
    await printStatus();
}
else if (command === "logs") {
    await printLogs(Number(argv[1] ?? "5"));
}
else if (command === "config") {
    await configureWebhook(argv.slice(1));
}
else if (command === "test") {
    await sendPayload(buildTestPayload(argv.slice(1).join(" ") || "codex-notice test"));
}
else if (command === "hook") {
    const rawPayload = argv.length > 1 ? argv.at(-1) : "";
    if (!rawPayload) {
        throw new Error("codex-notice hook requires Codex notify JSON payload");
    }
    await sendPayload(JSON.parse(rawPayload));
}
else {
    printHelp();
    process.exitCode = 1;
}
function printHelp() {
    console.log([
        "Usage:",
        "  codex-notice hook JSON_PAYLOAD",
        "  codex-notice test [MESSAGE]",
        "  codex-notice logs [N]",
        "  codex-notice config WEBHOOK [-y|--yes]",
        "  codex-notice status",
    ].join("\n"));
}
async function sendPayload(payload) {
    const webhook = await readWebhook();
    const card = buildCard(payload);
    await postFeishu(webhook, {
        msg_type: "interactive",
        card,
    });
}
async function readWebhook() {
    const webhook = process.env.FEISHU_BOT_WEBHOOK || await readWebhookFromConfigFile();
    if (!webhook) {
        throw new Error("FEISHU_BOT_WEBHOOK is required in environment or ~/.config/codex-tools/notice.env");
    }
    return webhook;
}
function buildTestPayload(message) {
    return {
        type: "agent-turn-complete",
        cwd: process.cwd(),
        "input-messages": ["codex-notice test"],
        "last-assistant-message": message,
    };
}
async function readWebhookFromConfigFile() {
    return readWebhookFromFile(noticeEnvPath);
}
async function readWebhookFromFile(path) {
    let text = "";
    try {
        text = await readFile(path, "utf8");
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
async function printStatus() {
    const hasEnv = Boolean(process.env.FEISHU_BOT_WEBHOOK);
    const configWebhook = await readWebhookFromFile(noticeEnvPath);
    const webhook = process.env.FEISHU_BOT_WEBHOOK || configWebhook;
    printKeyValue("webhook:", webhook ? textGreen(webhook) : textRed("missing"), 10);
    printKeyValue("config:", colorPath(noticeEnvPath), 10);
    printKeyValue("log:", colorPath(logPath().pathname), 10);
}
async function configureWebhook(argv) {
    const apply = argv.includes("-y") || argv.includes("--yes");
    const webhook = argv.find((arg) => arg !== "-y" && arg !== "--yes") ?? "";
    if (!webhook) {
        throw new Error("usage: codex-notice config WEBHOOK [-y|--yes]");
    }
    printKeyValue("target:", `${apply ? textGreen("updated") : textBlue("would update")} ${colorPath(noticeEnvPath)}`, 10);
    printKeyValue("webhook:", textGreen(webhook), 10);
    if (!apply) {
        console.log(textDim("dry-run only. Re-run with -y or --yes to apply changes."));
        return;
    }
    await mkdir(dirname(noticeEnvPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(noticeEnvPath), 0o700);
    await writeFile(noticeEnvPath, `FEISHU_BOT_WEBHOOK=${webhook}\n`, { mode: 0o600 });
    await chmod(noticeEnvPath, 0o600);
}
async function printLogs(limit) {
    const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
    let text = "";
    try {
        text = await readFile(logPath(), "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
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
        const entry = JSON.parse(line);
        const title = entry.request?.card?.header?.title?.content ?? "Codex";
        const status = entry.response?.status ?? "?";
        const code = entry.response?.responseJson?.code ?? entry.response?.responseJson?.StatusCode ?? "?";
        const msg = entry.response?.responseJson?.msg ?? entry.response?.responseJson?.StatusMessage ?? "";
        console.log(`${entry.at ?? ""}  ${status}  ${code}  ${title}${msg ? `  ${msg}` : ""}`);
    }
}
function stripEnvQuotes(value) {
    if ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function buildCard(payload) {
    const title = `Codex ${formatSystemLabel()}`;
    const input = readInputMessages(payload["input-messages"]);
    const answer = payload["last-assistant-message"] ??
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
                    tag: "markdown",
                    content: answerParts.preview,
                },
                ...(answerParts.rest ? [buildCollapsibleReply(answerParts.rest)] : []),
            ],
        },
    };
}
function formatSystemLabel() {
    const username = process.env.USER || process.env.LOGNAME || userInfo().username || "unknown";
    const host = (process.env.HOSTNAME || hostname() || "unknown").split(".")[0] || "unknown";
    return `${username}@${host}`;
}
function getHeaderTemplate(payload) {
    const type = payload.type?.toLowerCase() ?? "";
    return type.includes("error") || type.includes("fail") ? "red" : "blue";
}
function buildMetaColumns(cwd, latestInput) {
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
function buildHr() {
    return {
        tag: "hr",
    };
}
function buildCollapsibleReply(content) {
    return buildCollapsiblePanel("剩余回复（点击展开）", content);
}
function buildCollapsiblePanel(title, content) {
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
function readInputMessages(value) {
    if (Array.isArray(value)) {
        const all = value.filter((item) => typeof item === "string" && item.trim().length > 0);
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
function truncate(value, maxChars) {
    return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
function splitPreview(value, maxChars) {
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
function findPreviewSplitIndex(value, maxChars) {
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
    const result = parseJson(text);
    await tryWriteSendLog(body, {
        status: response.status,
        responseText: text,
        responseJson: result,
    });
    if (!response.ok) {
        throw new Error(`Feishu webhook failed: ${response.status} ${text}`);
    }
    const responseJson = result;
    if (responseJson.code !== 0 && responseJson.StatusCode !== 0) {
        throw new Error(`Feishu webhook rejected message: ${text}`);
    }
}
async function tryWriteSendLog(request, result) {
    try {
        await writeSendLog(request, result);
    }
    catch {
        // Notify hooks should not fail only because local debug logging failed.
    }
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
async function writeSendLog(request, result) {
    const path = logPath();
    let existing = "";
    try {
        existing = await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code !== "ENOENT") {
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
function logPath() {
    return new URL("../../codex-notice.log.jsonl", import.meta.url);
}
