export function updateTomlBaseUrl(content, baseUrl) {
    const provider = readTopLevelTomlString(content, "model_provider") ?? "codex";
    return upsertTomlKey(content, `model_providers.${provider}`, "base_url", JSON.stringify(baseUrl));
}
export function updateTopLevelTomlString(content, key, value) {
    return upsertTopLevelTomlKey(content, key, JSON.stringify(value));
}
export function readTomlBaseUrl(content) {
    const provider = readTopLevelTomlString(content, "model_provider") ?? "codex";
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
export function readTopLevelTomlString(content, key) {
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
export function mergeTomlDefaults(template, existing) {
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
        const currentKeys = new Set(currentSection.lines.map(parseTomlKey).filter((key) => key !== null));
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
function upsertTomlKey(content, sectionName, key, value) {
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
        }
        else {
            next.splice(sectionEnd, 0, `${key} = ${value}`);
        }
    }
    return ensureTrailingNewline(next.join("\n"));
}
function upsertTopLevelTomlKey(content, key, value) {
    const lines = content.split(/\r?\n/);
    let inserted = false;
    let replaced = false;
    const next = [];
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
        }
        else {
            next.unshift(`${key} = ${value}`);
        }
    }
    return ensureTrailingNewline(next.join("\n"));
}
function parseTomlSections(content) {
    const lines = content.split(/\r?\n/);
    const sections = [];
    let current = null;
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
function parseTomlTopLevel(content) {
    const lines = content.split(/\r?\n/);
    const end = lines.findIndex((line) => parseSectionHeader(line) !== null);
    const topLevelLines = lines.slice(0, end === -1 ? lines.length : end);
    return {
        lines: topLevelLines,
        keys: new Set(topLevelLines.map(parseTomlKey).filter((key) => key !== null)),
        end: end === -1 ? lines.length : end,
    };
}
function insertTopLevelLines(lines, additions) {
    const topLevel = parseTomlTopLevel(lines.join("\n"));
    const insertion = [];
    if (topLevel.end > 0 && lines[topLevel.end - 1]?.trim() !== "") {
        insertion.push("");
    }
    insertion.push(...additions);
    if (lines[topLevel.end]?.trim()) {
        insertion.push("");
    }
    lines.splice(topLevel.end, 0, ...insertion);
}
function appendSection(lines, sectionLines) {
    while (lines.length > 0 && lines.at(-1) === "") {
        lines.pop();
    }
    if (lines.length > 0) {
        lines.push("");
    }
    lines.push(...sectionLines);
}
function insertSectionLines(lines, section, additions) {
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
function parseTomlKey(line) {
    if (!line.trim() || /^\s*[#[]/.test(line)) {
        return null;
    }
    const match = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    return match?.[1] ?? null;
}
function ensureTrailingNewline(content) {
    return content.endsWith("\n") ? content : `${content}\n`;
}
function parseSectionHeader(line) {
    const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    return match?.[1] ?? null;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
