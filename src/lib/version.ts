import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonObject } from "./json.js";

let cachedPackageVersion: string | undefined;

export function packageVersion(): string {
  if (cachedPackageVersion) {
    return cachedPackageVersion;
  }

  const path = fileURLToPath(new URL("../../package.json", import.meta.url));
  const raw = parseJsonObject(readFileSync(path, "utf8"));
  const version = raw.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("package.json version must be a non-empty string");
  }
  cachedPackageVersion = version;
  return version;
}

export function isVersionArgument(value: string | undefined): boolean {
  return value === "version" || value === "-v";
}

export function toolNameFromArgv(path = process.argv[1] ?? "tool"): string {
  return basename(path).replace(/\.js$/, "");
}

export function printToolVersion(toolName: string): void {
  console.log(`${toolName} ${packageVersion()}`);
}

export function printToolVersionIfRequested(toolName: string, argv: string[]): boolean {
  const command = argv[0];
  if (!isVersionArgument(command)) {
    return false;
  }
  if (argv.length !== 1) {
    throw new Error(`usage: ${toolName} ${command}`);
  }
  printToolVersion(toolName);
  return true;
}
