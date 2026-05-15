export function updateTomlBaseUrl(content: string, baseUrl: string): string {
  return upsertTomlKey(content, "model_providers.codex", "base_url", JSON.stringify(baseUrl));
}

export function ensureTomlDefaults(content: string, defaults: string): string {
  if (!content.trim()) {
    return ensureTrailingNewline(defaults);
  }

  const currentLines = splitTomlLines(content);
  const defaultEntries = parseDefaultEntries(defaults);
  const currentSections = parseCurrentSections(currentLines);
  const missing = new Map<string, string[]>();

  for (const entry of defaultEntries) {
    const section = currentSections.get(entry.section);
    if (!section?.keys.has(entry.key)) {
      const lines = missing.get(entry.section) ?? [];
      lines.push(entry.line);
      missing.set(entry.section, lines);
    }
  }

  if (missing.size === 0) {
    return ensureTrailingNewline(content);
  }

  const insertions = new Map<number, string[]>();
  for (const [sectionName, lines] of missing) {
    const section = currentSections.get(sectionName);
    if (section) {
      const existing = insertions.get(section.end) ?? [];
      if (existing.length === 0 && currentLines[section.end - 1]?.trim() !== "") {
        existing.push("");
      }
      existing.push(...lines);
      insertions.set(section.end, existing);
      continue;
    }

    const append = insertions.get(currentLines.length) ?? [];
    if (append.length === 0 && currentLines.at(-1)?.trim() !== "") {
      append.push("");
    }
    if (sectionName !== "") {
      append.push(`[${sectionName}]`);
    }
    append.push(...lines);
    insertions.set(currentLines.length, append);
  }

  const output: string[] = [];
  for (let index = 0; index <= currentLines.length; index += 1) {
    const extra = insertions.get(index);
    if (extra) {
      output.push(...extra);
    }
    if (index < currentLines.length) {
      output.push(currentLines[index]);
    }
  }

  return ensureTrailingNewline(output.join("\n"));
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

type DefaultEntry = {
  section: string;
  key: string;
  line: string;
};

type CurrentSection = {
  end: number;
  keys: Set<string>;
};

function splitTomlLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function parseDefaultEntries(content: string): DefaultEntry[] {
  const entries: DefaultEntry[] = [];
  let section = "";

  for (const line of splitTomlLines(content)) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const keyMatch = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (keyMatch) {
      entries.push({ section, key: keyMatch[1], line });
    }
  }

  return entries;
}

function parseCurrentSections(lines: string[]): Map<string, CurrentSection> {
  const sections = new Map<string, CurrentSection>();
  let currentName = "";
  let currentStart = 0;
  let currentKeys = new Set<string>();

  const finish = (end: number) => {
    sections.set(currentName, { end, keys: currentKeys });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      finish(index);
      currentName = sectionMatch[1];
      currentStart = index;
      currentKeys = new Set<string>();
      continue;
    }

    const keyMatch = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (keyMatch) {
      currentKeys.add(keyMatch[1]);
    }
  }

  finish(lines.length);
  sections.get(currentName)!.end = Math.max(sections.get(currentName)!.end, currentStart + 1);
  return sections;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
