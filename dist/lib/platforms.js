import { stat } from "node:fs/promises";
import { ensureDir, readTextIfExists, writeTextFile, writeTextFileAtomic } from "./fs.js";
import { parseJsonObject, stringifyJson } from "./json.js";
import { claudeSettingsPath, codexAuthPath, codexConfigPath, codexDir } from "./paths.js";
import { textAnsi256, textGreen } from "./text.js";
import { readTomlBaseUrl, updateTomlBaseUrl } from "./toml.js";
export const PLATFORM_LABELS = {
    codex: "Codex",
    claude: "Claude Code",
};
// Platform identifiers print in upper case with a fixed color each: Codex green, Claude orange.
export function colorPlatform(platform, suffix = "") {
    const label = `${platform.toUpperCase()}${suffix}`;
    return platform === "codex" ? textGreen(label) : textAnsi256(208, label);
}
// The client config files `ccs use` writes for each platform.
export function platformFiles(platform) {
    return platform === "codex" ? [codexConfigPath(), codexAuthPath()] : [claudeSettingsPath()];
}
export async function readPlatformConnection(platform) {
    if (platform === "claude") {
        const env = (await readClaudeSettings()).env;
        const value = (key) => (env && typeof env === "object" && typeof env[key] === "string"
            ? env[key] : "");
        return { baseURL: value("ANTHROPIC_BASE_URL"), apiKey: value("ANTHROPIC_AUTH_TOKEN") };
    }
    const configText = (await readTextIfExists(codexConfigPath())) ?? "";
    const authText = (await readTextIfExists(codexAuthPath())) ?? "";
    const auth = authText ? parseJsonObject(authText) : {};
    return {
        baseURL: readTomlBaseUrl(configText) ?? "",
        apiKey: typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "",
    };
}
// Points the platform's client at `baseURL` with `apiKey`, changing only the provider fields.
export async function writePlatformConnection(platform, connection) {
    if (platform === "claude") {
        await writeClaudeConnection(connection);
        return;
    }
    await ensureDir(codexDir());
    const config = (await readTextIfExists(codexConfigPath())) ?? "";
    await writeTextFile(codexConfigPath(), updateTomlBaseUrl(config, connection.baseURL));
    await writeTextFile(codexAuthPath(), stringifyJson({ OPENAI_API_KEY: connection.apiKey }), 0o600);
}
async function readClaudeSettings() {
    const text = await readTextIfExists(claudeSettingsPath());
    if (!text)
        return {};
    try {
        return parseJsonObject(text);
    }
    catch (error) {
        throw new Error(`invalid ${claudeSettingsPath()}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
// Claude Code reads its provider from settings.json `env`. ANTHROPIC_API_KEY is removed because it
// would be sent as a second credential next to the Bearer token.
async function writeClaudeConnection(connection) {
    const path = claudeSettingsPath();
    const settings = await readClaudeSettings();
    const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
        ? { ...settings.env } : {};
    delete env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_BASE_URL = connection.baseURL;
    env.ANTHROPIC_AUTH_TOKEN = connection.apiKey;
    const mode = await stat(path).then((info) => info.mode & 0o777, () => 0o600);
    await writeTextFileAtomic(path, stringifyJson({ ...settings, env }), mode);
}
