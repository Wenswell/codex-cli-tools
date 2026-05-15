export function updateTomlBaseUrl(content: string, baseUrl: string): string {
  const provider = readTopLevelTomlString(content, "model_provider") ?? "codex";
  return upsertTomlKey(content, `model_providers.${provider}`, "base_url", JSON.stringify(baseUrl));
}

export function readTomlBaseUrl(content: string): string | null {
  const provider = readTopLevelTomlString(content, "model_provider") ?? "codex";
  const sectionName = `model_providers.${provider}`;
  let currentSection = "";
  for (const line of content.split(/\r?\n/)) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    if (currentSection !== sectionName) {
      continue;
    }

    const match = /^\s*base_url\s*=\s*("([^"]*)"|'([^']*)'|([^\s#]+))/.exec(line);
    if (match) {
      return match[2] ?? match[3] ?? match[4] ?? "";
    }
  }
  return null;
}

export function readTopLevelTomlString(content: string, key: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      return null;
    }
    const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s#]+))`).exec(line);
    if (match) {
      return match[2] ?? match[3] ?? match[4] ?? "";
    }
  }
  return null;
}

function upsertTomlKey(content: string, sectionName: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  let currentSection = "";
  let sectionStart = -1;
  let sectionEnd = lines.length;
  let replaced = false;

  const next = lines.map((line, index) => {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      if (currentSection === sectionName && sectionEnd === lines.length) {
        sectionEnd = index;
      }
      currentSection = sectionMatch[1];
      if (currentSection === sectionName) {
        sectionStart = index;
      }
    }

    if (currentSection === sectionName && new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) {
      replaced = true;
      return `${key} = ${value}`;
    }
    return line;
  });

  if (!replaced) {
    if (sectionStart === -1) {
      if (next.at(-1)?.trim() !== "") {
        next.push("");
      }
      next.push(`[${sectionName}]`, `${key} = ${value}`);
    } else {
      next.splice(sectionEnd, 0, `${key} = ${value}`);
    }
  }

  return ensureTrailingNewline(next.join("\n"));
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
