import {
  textBlue,
  textBold,
  textCyan,
  textDim,
  textGreen,
  textMagenta,
  textRed,
  textYellow,
} from "./text.js";

export type TextStyle = {
  bold: (value: string) => string;
  blue: (value: string) => string;
  cyan: (value: string) => string;
  dim: (value: string) => string;
  green: (value: string) => string;
  magenta: (value: string) => string;
  red: (value: string) => string;
  yellow: (value: string) => string;
};

const identity = (value: string): string => value;

export function createTextStyle(color = true): TextStyle {
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
