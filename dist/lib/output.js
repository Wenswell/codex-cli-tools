import { textBlue, textCyan, textGreen, textMagenta, padVisibleRight, textYellow, } from "./text.js";
export function printKeyValue(label, value, width = 8) {
    console.log(`${padVisibleRight(label, width)} ${value}`);
}
export function colorCount(value) {
    return textGreen(value);
}
export function colorHost(value) {
    return textYellow(value);
}
export function colorInput(value) {
    return textCyan(value);
}
export function colorName(value) {
    return textGreen(value);
}
export function colorOutput(value) {
    return textMagenta(value);
}
export function colorPath(value) {
    return textBlue(value);
}
export function colorUrl(value) {
    return textCyan(value);
}
