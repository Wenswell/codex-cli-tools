import { homedir } from "node:os";
import { join } from "node:path";

export function homeDir(): string {
  return process.env.HOME || homedir();
}

export function codexToolsConfigDir(): string {
  return join(homeDir(), ".config", "codex-tools");
}

export function codexToolsCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homeDir(), ".cache"), "codex-tools");
}

export function profilesPath(): string {
  return join(codexToolsConfigDir(), "profiles.json");
}

export function codexDir(): string {
  return join(homeDir(), ".codex");
}

export function codexConfigPath(): string {
  return join(codexDir(), "config.toml");
}

export function codexAgentsPath(): string {
  return join(codexDir(), "AGENTS.md");
}

export function codexAuthPath(): string {
  return join(codexDir(), "auth.json");
}
