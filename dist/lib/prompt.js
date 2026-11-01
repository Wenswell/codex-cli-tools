import stripAnsi from "strip-ansi";
import { maskSecret, padVisibleRight, textBold, textCyan, textDim, textGreen, textRed, truncateVisible, visibleLength } from "./text.js";
import { recordUsagePrompt } from "./usage.js";
export class PromptCancelledError extends Error {
    interrupted;
    constructor(interrupted) {
        super(interrupted ? "prompt interrupted" : "prompt cancelled");
        this.interrupted = interrupted;
    }
}
const ESCAPE_KEYS = {
    "\u001b[A": "up",
    "\u001bOA": "up",
    "\u001b[B": "down",
    "\u001bOB": "down",
    "\u001b[C": "right",
    "\u001bOC": "right",
    "\u001b[D": "left",
    "\u001bOD": "left",
};
const CONTROL_KEYS = {
    "\r": "enter",
    "\n": "enter",
    "\u007f": "backspace",
    "\b": "backspace",
    "\u0003": "ctrl-c",
    "\u0015": "ctrl-u",
    "\t": "tab",
};
export function isInteractive() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
function parseKeys(chunk) {
    const keys = [];
    for (let index = 0; index < chunk.length;) {
        if (chunk[index] === "\u001b") {
            const next = chunk[index + 1];
            if (next === "[" || next === "O") {
                let end = index + 2;
                while (end < chunk.length && !/[A-Za-z~]/.test(chunk[end]))
                    end += 1;
                keys.push(ESCAPE_KEYS[chunk.slice(index, end + 1)] ?? "unknown");
                index = end + 1;
            }
            else {
                keys.push("escape");
                index += 1;
            }
            continue;
        }
        const value = String.fromCodePoint(chunk.codePointAt(index));
        index += value.length;
        keys.push(CONTROL_KEYS[value] ?? value);
    }
    return keys;
}
function isPrintableKey(key) {
    return [...key].length === 1 && key >= " " && key !== "\u007f";
}
function runPrompt(session) {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY || !output.isTTY) {
        return Promise.reject(new Error("interactive prompt requires a terminal"));
    }
    return new Promise((resolve, reject) => {
        const wasRaw = Boolean(input.isRaw);
        let cursorRow = 0;
        let settled = false;
        const width = () => Math.max(20, (output.columns || 80) - 1);
        const clearFrame = () => `${cursorRow > 0 ? `\u001b[${cursorRow}A` : ""}\r\u001b[J`;
        const draw = () => {
            const frame = session.render();
            const columns = width();
            const lines = frame.lines.map((line) => truncateVisible(line, columns));
            const clear = clearFrame();
            let tail = "";
            if (frame.cursor) {
                const up = lines.length - 1 - frame.cursor.row;
                const column = Math.min(frame.cursor.column, columns);
                tail = `${up > 0 ? `\u001b[${up}A` : ""}\r${column > 0 ? `\u001b[${column}C` : ""}\u001b[?25h`;
                cursorRow = frame.cursor.row;
            }
            else {
                cursorRow = lines.length - 1;
            }
            output.write(`\u001b[?25l${clear}${lines.join("\n")}${tail}`);
        };
        const cleanup = () => {
            input.off("data", onData);
            input.off("end", onEnd);
            if (typeof input.setRawMode === "function")
                input.setRawMode(wasRaw);
            input.pause();
        };
        const finish = (line) => {
            settled = true;
            cleanup();
            const clear = clearFrame();
            cursorRow = 0;
            output.write(`${clear}${truncateVisible(line, width())}\n\u001b[?25h`);
        };
        const handleKey = (key) => {
            if (settled)
                return;
            if (key === "ctrl-c" || key === "escape") {
                recordUsagePrompt({ prompt: session.message, outcome: "cancelled", kept_default: null });
                finish(`${textRed("✖")} ${textBold(session.message)} ${textDim("· cancelled")}`);
                reject(new PromptCancelledError(key === "ctrl-c"));
                return;
            }
            try {
                const result = session.onKey(key);
                if (result) {
                    recordUsagePrompt({ prompt: session.message, outcome: "answered", ...session.usage(result.value) });
                    finish(`${textGreen("✔")} ${textBold(session.message)} ${textDim("·")} ${session.summary(result.value)}`);
                    resolve(result.value);
                    return;
                }
                draw();
            }
            catch (error) {
                finish(`${textRed("✖")} ${textBold(session.message)}`);
                reject(error);
            }
        };
        const onData = (chunk) => {
            const keys = parseKeys(chunk.toString());
            setImmediate(() => {
                for (const key of keys)
                    handleKey(key);
            });
        };
        const onEnd = () => {
            setImmediate(() => handleKey("ctrl-c"));
        };
        if (typeof input.setRawMode === "function")
            input.setRawMode(true);
        input.on("data", onData);
        input.once("end", onEnd);
        input.resume();
        draw();
    });
}
function visibleChoiceCount(count, requested) {
    const rows = process.stdout.rows || 24;
    return Math.max(1, Math.min(count, requested ?? 10, rows - 4));
}
function scrollOffset(offset, focus, size, count) {
    if (focus < offset)
        return focus;
    if (focus >= offset + size)
        return focus - size + 1;
    return Math.min(offset, Math.max(0, count - size));
}
function moveFocus(choices, focus, step) {
    for (let distance = 1; distance <= choices.length; distance += 1) {
        const next = (((focus + step * distance) % choices.length) + choices.length) % choices.length;
        if (!choices[next].disabled)
            return next;
    }
    return focus;
}
function promptHeader(message, keys) {
    return `${textCyan("?")} ${textBold(message)} ${textDim(keys)}`;
}
function choiceLines(choices, focus, offset, size, marker) {
    const lines = [];
    const labelWidth = Math.max(...choices.map((choice) => visibleLength(choice.label)));
    if (offset > 0)
        lines.push(textDim(`  ↑ ${offset} more`));
    for (let index = offset; index < Math.min(choices.length, offset + size); index += 1) {
        const choice = choices[index];
        const focused = index === focus;
        const padded = padVisibleRight(choice.label, labelWidth);
        const label = choice.disabled ? textDim(padded) : focused ? textCyan(padded) : padded;
        const detail = choice.disabled ? `(${choice.disabled})` : choice.hint;
        lines.push(`${focused ? textCyan("❯") : " "} ${marker(choice, index)}${label}${detail ? `  ${textDim(detail)}` : ""}`);
    }
    const below = choices.length - offset - size;
    if (below > 0)
        lines.push(textDim(`  ↓ ${below} more`));
    return lines;
}
function plainLabel(choice) {
    return stripAnsi(choice.label).trim();
}
export function select(message, choices, options = {}) {
    const firstEnabled = choices.findIndex((choice) => !choice.disabled);
    if (firstEnabled < 0) {
        return Promise.reject(new Error(`${message}: no selectable choices`));
    }
    const defaultIndex = choices.findIndex((choice) => !choice.disabled && Object.is(choice.value, options.default));
    let focus = defaultIndex >= 0 ? defaultIndex : firstEnabled;
    const initialFocus = focus;
    const size = visibleChoiceCount(choices.length, options.pageSize);
    let offset = scrollOffset(0, focus, size, choices.length);
    return runPrompt({
        message,
        render: () => ({
            lines: [
                promptHeader(message, "↑↓ move · enter select · esc cancel"),
                ...choiceLines(choices, focus, offset, size, () => ""),
            ],
        }),
        onKey: (key) => {
            if (key === "up" || key === "k")
                focus = moveFocus(choices, focus, -1);
            else if (key === "down" || key === "j")
                focus = moveFocus(choices, focus, 1);
            else if (key === "enter")
                return { value: choices[focus].value };
            offset = scrollOffset(offset, focus, size, choices.length);
        },
        summary: () => textCyan(plainLabel(choices[focus])),
        usage: () => ({ kept_default: focus === initialFocus }),
    });
}
export function multiSelect(message, choices, options = {}) {
    const selectable = choices.flatMap((choice, index) => choice.disabled ? [] : [index]);
    if (selectable.length === 0) {
        return Promise.reject(new Error(`${message}: no selectable choices`));
    }
    const checked = new Set(selectable.filter((index) => choices[index].checked));
    const initialChecked = [...checked].sort((left, right) => left - right).join(",");
    let focus = selectable[0];
    let error = null;
    const size = visibleChoiceCount(choices.length, options.pageSize);
    let offset = scrollOffset(0, focus, size, choices.length);
    const selected = () => [...checked].sort((left, right) => left - right);
    return runPrompt({
        message,
        render: () => ({
            lines: [
                promptHeader(message, "↑↓ move · space toggle · a all · enter confirm · esc cancel"),
                ...choiceLines(choices, focus, offset, size, (choice, index) => {
                    if (choice.disabled)
                        return textDim("◯ ");
                    return checked.has(index) ? textGreen("◉ ") : textDim("◯ ");
                }),
                ...(error ? [textRed(`  ${error}`)] : []),
            ],
        }),
        onKey: (key) => {
            error = null;
            if (key === "up" || key === "k")
                focus = moveFocus(choices, focus, -1);
            else if (key === "down" || key === "j")
                focus = moveFocus(choices, focus, 1);
            else if (key === " ") {
                if (checked.has(focus))
                    checked.delete(focus);
                else
                    checked.add(focus);
            }
            else if (key === "a") {
                const all = selectable.every((index) => checked.has(index));
                for (const index of selectable) {
                    if (all)
                        checked.delete(index);
                    else
                        checked.add(index);
                }
            }
            else if (key === "enter") {
                if (checked.size === 0 && options.required)
                    error = options.required;
                else
                    return { value: selected().map((index) => choices[index].value) };
            }
            offset = scrollOffset(offset, focus, size, choices.length);
        },
        summary: () => {
            const labels = selected().map((index) => plainLabel(choices[index]));
            return labels.length === 0 ? textDim("none") : textCyan(labels.join(", "));
        },
        usage: (value) => ({ kept_default: selected().join(",") === initialChecked, selected: value.length }),
    });
}
export function input(message, options = {}) {
    let buffer = "";
    let error = null;
    let typed = false;
    const shownDefault = options.defaultLabel ?? options.default;
    return runPrompt({
        message,
        render: () => {
            const prefix = `${textCyan("?")} ${textBold(message)}${shownDefault ? ` ${textDim(`(${shownDefault})`)}` : ""} `;
            const typed = options.mask ? "*".repeat([...buffer].length) : buffer;
            return {
                lines: [`${prefix}${typed}`, ...(error ? [textRed(`  ${error}`)] : [])],
                cursor: { row: 0, column: visibleLength(prefix) + visibleLength(typed) },
            };
        },
        onKey: (key) => {
            error = null;
            if (key === "enter") {
                typed = buffer.trim().length > 0;
                const value = buffer.trim() || options.default || "";
                error = options.validate?.(value) ?? null;
                if (!error)
                    return { value };
            }
            else if (key === "backspace") {
                buffer = [...buffer].slice(0, -1).join("");
            }
            else if (key === "ctrl-u") {
                buffer = "";
            }
            else if (isPrintableKey(key)) {
                buffer += key;
            }
        },
        summary: (value) => {
            if (!options.mask)
                return textCyan(value || "-");
            if (value === options.default && options.defaultLabel)
                return textCyan(options.defaultLabel);
            return textCyan(value ? maskSecret(value) : "-");
        },
        usage: () => ({ kept_default: options.default === undefined ? null : !typed }),
    });
}
