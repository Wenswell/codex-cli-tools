export function maskSecret(value) {
    if (value.length <= 9) {
        return "*".repeat(value.length);
    }
    return `${value.slice(0, 6)}***${value.slice(-3)}`;
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
export function textGreen(value) {
    return withAnsi("38;5;114", value);
}
export function textRed(value) {
    return withAnsi("38;5;203", value);
}
export function bgBlue(value) {
    return withAnsi("30;48;5;153", value);
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
