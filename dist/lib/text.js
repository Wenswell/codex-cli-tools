import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
export function maskSecret(value) {
    if (value.length <= 9) {
        return "*".repeat(value.length);
    }
    return `${value.slice(0, 6)}***${value.slice(-3)}`;
}
export function visibleLength(value) {
    return stringWidth(stripAnsi(value));
}
export function truncateVisible(value, width, ellipsis = "…") {
    if (width <= 0) {
        return "";
    }
    if (visibleLength(value) <= width) {
        return value;
    }
    const suffixWidth = visibleLength(ellipsis);
    if (width <= suffixWidth) {
        return sliceAnsi(ellipsis, 0, width);
    }
    return `${sliceAnsi(value, 0, width - suffixWidth)}${ellipsis}`;
}
export function padVisibleRight(value, width) {
    return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}
export function padVisibleLeft(value, width) {
    return `${" ".repeat(Math.max(0, width - visibleLength(value)))}${value}`;
}
const canColorize = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
function withAnsi(code, value) {
    if (!canColorize) {
        return value;
    }
    return `\u001b[${code}m${value}\u001b[0m`;
}
export function textBold(value) {
    return withAnsi(1, value);
}
export function textDim(value) {
    return withAnsi(2, value);
}
export function textBlue(value) {
    return withAnsi("38;5;81", value);
}
export function textCyan(value) {
    return withAnsi("38;5;45", value);
}
export function textGreen(value) {
    return withAnsi("38;5;114", value);
}
export function textMagenta(value) {
    return withAnsi("38;5;213", value);
}
export function textRed(value) {
    return withAnsi("38;5;203", value);
}
export function textYellow(value) {
    return withAnsi("38;5;221", value);
}
export function bgBlue(value) {
    return withAnsi("30;48;5;153", value);
}
export function bgDarkBlue(value) {
    return withAnsi("38;5;231;48;5;24", value);
}
export function bgGreen(value) {
    return withAnsi("30;48;5;194", value);
}
export function bgRed(value) {
    return withAnsi("30;48;5;224", value);
}
export function bgGray(value) {
    return withAnsi("30;48;5;252", value);
}
