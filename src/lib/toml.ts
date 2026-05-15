export function updateTomlBaseUrl(content: string, baseUrl: string): string {
  const provider = readTopLevelTomlString(content, "model_provider") ?? "codex";
  return upsertTomlKey(content, `model_providers.${provider}`, "base_url", JSON.stringify(baseUrl));
}

export function updateTopLevelTomlString(content: string, key: string, value: string): string {
  return upsertTopLevelTomlKey(content, key, JSON.stringify(value));
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

export function mergeTomlModelProviderSections(template: string, existing: string): string {
  const templateSections = parseTomlSections(template);
  const existingSections = parseTomlSections(existing);
  const extraSections = existingSections.filter((section) => {
    return section.name.startsWith("model_providers.") &&
      !templateSections.some((templateSection) => templateSection.name === section.name);
  });

  if (extraSections.length === 0) {
    return ensureTrailingNewline(template);
  }

  let next = ensureTrailingNewline(template).replace(/\n*$/, "\n");
  for (const section of extraSections) {
    if (!next.endsWith("\n\n")) {
      next += "\n";
    }
    next += `${section.lines.join("\n")}\n`;
  }
  return ensureTrailingNewline(next);
}

function upsertTopLevelTomlKey(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  let inserted = false;
  let replaced = false;
  const next: string[] = [];

  for (const line of lines) {
    if (!inserted && /^\s*\[/.test(line)) {
      if (!replaced) {
        next.push(`${key} = ${value}`);
        replaced = true;
      }
      inserted = true;
    }

    if (!inserted && new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) {
      next.push(`${key} = ${value}`);
      replaced = true;
      continue;
    }

    next.push(line);
  }

  if (!replaced) {
    if (next.length > 0 && next[0].trim() !== "") {
      next.unshift(`${key} = ${value}`, "");
    } else {
      next.unshift(`${key} = ${value}`);
    }
  }

  return ensureTrailingNewline(next.join("\n"));
}

type TomlSection = {
  name: string;
  lines: string[];
};

function parseTomlSections(content: string): TomlSection[] {
  const lines = content.split(/\r?\n/);
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;

  for (const line of lines) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      current = {
        name: sectionMatch[1],
        lines: [line],
      };
      sections.push(current);
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  return sections;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
