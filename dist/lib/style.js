import { textBlue, textBold, textCyan, textDim, textGreen, textMagenta, textRed, textYellow, } from "./text.js";
const identity = (value) => value;
export function createTextStyle(color = true) {
    if (!color) {
        return {
            bold: identity,
            blue: identity,
            cyan: identity,
            dim: identity,
            green: identity,
            magenta: identity,
            red: identity,
            yellow: identity,
        };
    }
    return {
        bold: textBold,
        blue: textBlue,
        cyan: textCyan,
        dim: textDim,
        green: textGreen,
        magenta: textMagenta,
        red: textRed,
        yellow: textYellow,
    };
}
