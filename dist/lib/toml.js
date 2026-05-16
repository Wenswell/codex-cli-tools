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
export function mergeTomlModelProviderSections(template, existing) {
    const templateSections = parseTomlSections(template);
    const existingSections = parseTomlSections(existing);
    const extraSections = existingSections.filter((section) => {
        return shouldPreserveExtraSection(section.name) &&
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
export function listTomlSectionNames(content) {
    return parseTomlSections(content).map((section) => section.name);
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
    for (const line of lines) {
        const sectionMatch = parseSectionHeader(line);
        if (sectionMatch) {
            current = {
                name: sectionMatch,
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
function ensureTrailingNewline(content) {
    return content.endsWith("\n") ? content : `${content}\n`;
}
function parseSectionHeader(line) {
    const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    return match?.[1] ?? null;
}
function shouldPreserveExtraSection(sectionName) {
    return sectionName.startsWith("model_providers.") ||
        sectionName.startsWith("projects.") ||
        sectionName === "tui.model_availability_nux";
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
