export function updateTomlBaseUrl(content: string, baseUrl: string): string {
  const provider = readTopLevelTomlString(content, "model_provider") ?? "codex";
  return updateTomlProviderBaseUrl(content, provider, baseUrl);
}

export function updateTomlProviderBaseUrl(content: string, provider: string, baseUrl: string): string {
  return upsertTomlKey(content, `model_providers.${provider}`, "base_url", JSON.stringify(baseUrl));
}

export function updateTopLevelTomlString(content: string, key: string, value: string): string {
  return upsertTopLevelTomlKey(content, key, JSON.stringify(value));
}

export function readTomlBaseUrl(content: string): string | null {
  const provider = readTopLevelTomlString(content, "model_provider") ?? "codex";
  return readTomlProviderBaseUrl(content, provider);
}

export function readTomlProviderBaseUrl(content: string, provider: string): string | null {
  const sectionName = `model_providers.${provider}`;
  let currentSection = "";
  for (const line of content.split(/\r?\n/)) {
    const sectionMatch = parseSectionHeader(line);
    if (sectionMatch) {
      currentSection = sectionMatch;
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

export function mergeTomlDefaults(template: string, existing: string): string {
  if (!existing.trim()) {
    return ensureTrailingNewline(template);
  }

  const next = existing.replace(/\r\n/g, "\n").split("\n");
  const templateTopLevel = parseTomlTopLevel(template);
  const existingTopLevel = parseTomlTopLevel(existing);
  const missingTopLevel = templateTopLevel.lines.filter((line) => {
    const key = parseTomlKey(line);
    return key !== null && !existingTopLevel.keys.has(key);
  });

  if (missingTopLevel.length > 0) {
    insertTopLevelLines(next, missingTopLevel);
  }

  for (const templateSection of parseTomlSections(template)) {
    const currentSection = parseTomlSections(next.join("\n")).find((section) => section.name === templateSection.name);
    if (!currentSection) {
      appendSection(next, templateSection.lines);
      continue;
    }

    const currentKeys = new Set(currentSection.lines.map(parseTomlKey).filter((key): key is string => key !== null));
    const missingLines = templateSection.lines.slice(1).filter((line) => {
      const key = parseTomlKey(line);
      return key !== null && !currentKeys.has(key);
    });
    if (missingLines.length > 0) {
      insertSectionLines(next, currentSection, missingLines);
    }
  }

  return ensureTrailingNewline(next.join("\n"));
}

export type TomlTemplateSyncResult = {
  content: string;
  leafPaths: string[];
  differentPaths: string[];
  updatedPaths: string[];
};

type TomlLeaf = {
  path: string;
  line: string;
  value: string;
};

export function syncTomlTemplate(
  template: string,
  existing: string,
  replacePaths: ReadonlySet<string>,
): TomlTemplateSyncResult {
  const templateLeaves = parseTomlLeaves(template);
  const existingLeaves = new Map(parseTomlLeaves(existing).map((leaf) => [leaf.path, leaf]));
  const leafPaths = templateLeaves.map((leaf) => leaf.path);
  const differentPaths = templateLeaves
    .filter((leaf) => existingLeaves.get(leaf.path)?.value !== leaf.value)
    .map((leaf) => leaf.path);
  const different = new Set(differentPaths);
  const updated = new Set(templateLeaves
    .filter((leaf) => !existingLeaves.has(leaf.path) || (replacePaths.has(leaf.path) && existingLeaves.get(leaf.path)?.value !== leaf.value))
    .map((leaf) => leaf.path));

  let content = mergeTomlDefaults(template, existing);
  if (replacePaths.size > 0) {
    const templateByPath = new Map(templateLeaves.map((leaf) => [leaf.path, leaf]));
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    let section = "";
    for (let index = 0; index < lines.length; index += 1) {
      const sectionName = parseSectionHeader(lines[index]);
      if (sectionName !== null) {
        section = sectionName;
        continue;
      }
      const key = parseTomlKey(lines[index]);
      const path = key === null ? null : (section ? `${section}.${key}` : key);
      if (path && replacePaths.has(path) && different.has(path)) {
        lines[index] = templateByPath.get(path)?.line ?? lines[index];
      }
    }
    content = ensureTrailingNewline(lines.join("\n"));
  }

  return {
    content,
    leafPaths,
    differentPaths,
    updatedPaths: leafPaths.filter((path) => updated.has(path)),
  };
}

function parseTomlLeaves(content: string): TomlLeaf[] {
  const leaves: TomlLeaf[] = [];
  let section = "";
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const sectionName = parseSectionHeader(line);
    if (sectionName !== null) {
      section = sectionName;
      continue;
    }
    const key = parseTomlKey(line);
    if (key === null) {
      continue;
    }
    leaves.push({
      path: section ? `${section}.${key}` : key,
      line,
      value: normalizeTomlValue(line.slice(line.indexOf("=") + 1)),
    });
  }
  return leaves;
}

function normalizeTomlValue(value: string): string {
  const withoutComment = stripTomlComment(value).trim();
  if ((withoutComment.startsWith('"') && withoutComment.endsWith('"'))
    || (withoutComment.startsWith("'") && withoutComment.endsWith("'"))) {
    try {
      return JSON.stringify(withoutComment.startsWith('"')
        ? JSON.parse(withoutComment)
        : withoutComment.slice(1, -1));
    } catch {
      return withoutComment;
    }
  }
  let normalized = "";
  let single = false;
  let double = false;
  for (let index = 0; index < withoutComment.length; index += 1) {
    const char = withoutComment[index];
    if (char === "'" && !double) {
      single = !single;
    } else if (char === '"' && !single && withoutComment[index - 1] !== "\\") {
      double = !double;
    }
    if (!/\s/.test(char) || single || double) {
      normalized += char;
    }
  }
  return normalized;
}

function stripTomlComment(value: string): string {
  let single = false;
  let double = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'" && !double) {
      single = !single;
    } else if (char === '"' && !single && value[index - 1] !== "\\") {
      double = !double;
    } else if (char === "#" && !single && !double) {
      return value.slice(0, index);
    }
  }
  return value;
}

function upsertTomlKey(content: string, sectionName: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  let currentSection = "";
  let sectionStart = -1;
  let sectionEnd = lines.length;
  let replaced = false;

  const next = lines.map((line, index) => {
    const sectionMatch = parseSectionHeader(line);
    if (sectionMatch) {
      if (currentSection === sectionName && sectionEnd === lines.length) {
        sectionEnd = index;
      }
      currentSection = sectionMatch;
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

type TomlTopLevel = {
  lines: string[];
  keys: Set<string>;
  end: number;
};

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
  end: number;
};

function parseTomlSections(content: string): TomlSection[] {
  const lines = content.split(/\r?\n/);
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionMatch = parseSectionHeader(line);
    if (sectionMatch) {
      if (current) {
        current.end = index;
      }
      current = {
        name: sectionMatch,
        lines: [line],
        end: lines.length,
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

function parseTomlTopLevel(content: string): TomlTopLevel {
  const lines = content.split(/\r?\n/);
  const end = lines.findIndex((line) => parseSectionHeader(line) !== null);
  const topLevelLines = lines.slice(0, end === -1 ? lines.length : end);
  return {
    lines: topLevelLines,
    keys: new Set(topLevelLines.map(parseTomlKey).filter((key): key is string => key !== null)),
    end: end === -1 ? lines.length : end,
  };
}

function insertTopLevelLines(lines: string[], additions: string[]): void {
  const topLevel = parseTomlTopLevel(lines.join("\n"));
  const insertion: string[] = [];
  if (topLevel.end > 0 && lines[topLevel.end - 1]?.trim() !== "") {
    insertion.push("");
  }
  insertion.push(...additions);
  if (lines[topLevel.end]?.trim()) {
    insertion.push("");
  }
  lines.splice(topLevel.end, 0, ...insertion);
}

function appendSection(lines: string[], sectionLines: string[]): void {
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(...sectionLines);
}

function insertSectionLines(lines: string[], section: TomlSection, additions: string[]): void {
  let insertionIndex = section.end;
  while (insertionIndex > 0 && lines[insertionIndex - 1]?.trim() === "") {
    insertionIndex -= 1;
  }

  const insertion = [...additions];
  const followingLine = lines[insertionIndex];
  if (followingLine !== undefined && parseSectionHeader(followingLine) !== null) {
    insertion.push("");
  }

  lines.splice(insertionIndex, 0, ...insertion);
}

function parseTomlKey(line: string): string | null {
  if (!line.trim() || /^\s*[#[]/.test(line)) {
    return null;
  }
  const match = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
  return match?.[1] ?? null;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function parseSectionHeader(line: string): string | null {
  const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
  return match?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
