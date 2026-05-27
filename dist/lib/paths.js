import { homedir } from "node:os";
import { join } from "node:path";
export function homeDir() {
    return process.env.HOME || homedir();
}
export function codexToolsConfigDir() {
    return join(homeDir(), ".config", "codex-tools");
}
export function codexToolsCacheDir() {
    return join(process.env.XDG_CACHE_HOME || join(homeDir(), ".cache"), "codex-tools");
}
export function profilesPath() {
    return join(codexToolsConfigDir(), "profiles.json");
}
export function codexDir() {
    return join(homeDir(), ".codex");
}
export function codexConfigPath() {
    return join(codexDir(), "config.toml");
}
export function codexAgentsPath() {
    return join(codexDir(), "AGENTS.md");
}
export function codexAuthPath() {
    return join(codexDir(), "auth.json");
}
