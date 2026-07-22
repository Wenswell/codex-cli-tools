import { codexConfigPath } from "../lib/paths.js";
import { assertProfile, readProfiles } from "../lib/profiles.js";
import { readTextIfExists } from "../lib/fs.js";
import { readTopLevelTomlString } from "../lib/toml.js";
import { CCS_PROXY_PROFILE_HEADER, ensureProxyRunning, resolveProxyOptions, resolveProxySwitchBaseUrl } from "./ccs-proxy.js";
const profileApiKeyEnv = "CODEX_TOOLS_PROFILE_API_KEY";
export async function resolveCodexProfileLaunch(name) {
    const profiles = await readProfiles();
    const profile = profiles.profiles?.[name];
    if (!profile) {
        throw new Error(`profile not found: ${name}`);
    }
    const normalized = assertProfile(profile, name);
    if (!normalized.baseURL.trim()) {
        throw new Error(`profile ${name} is missing baseURL`);
    }
    if (!normalized.apiKey.trim()) {
        throw new Error(`profile ${name} is missing apiKey`);
    }
    const currentConfig = (await readTextIfExists(codexConfigPath())) ?? "";
    const provider = readTopLevelTomlString(currentConfig, "model_provider") ?? "codex";
    const runtime = await ensureProxyRunning(resolveProxyOptions());
    const proxyBaseURL = runtime ? resolveProxySwitchBaseUrl(runtime.state) : null;
    if (runtime && !proxyBaseURL) {
        throw new Error("proxy state has no base URL");
    }
    return {
        configOverrides: [
            `model_providers.${provider}.base_url=${JSON.stringify(proxyBaseURL ?? normalized.baseURL)}`,
            `model_providers.${provider}.env_key=${JSON.stringify(profileApiKeyEnv)}`,
            ...(runtime
                ? [`model_providers.${provider}.http_headers.${CCS_PROXY_PROFILE_HEADER}=${JSON.stringify(name)}`]
                : []),
        ],
        env: { ...process.env, [profileApiKeyEnv]: normalized.apiKey },
        profile: normalized,
    };
}
