import {
  textBlue,
  textCyan,
  textGreen,
  textMagenta,
  padVisibleRight,
  textYellow,
} from "./text.js";

export function printKeyValue(label: string, value: string, width = 8): void {
  console.log(`${padVisibleRight(label, width)} ${value}`);
}

export function colorCount(value: string): string {
  return textGreen(value);
}

export function colorHost(value: string): string {
  return textYellow(value);
}

export function colorInput(value: string): string {
  return textCyan(value);
}

export function colorName(value: string): string {
  return textGreen(value);
}

export function colorOutput(value: string): string {
  return textMagenta(value);
}

export function colorPath(value: string): string {
  return textBlue(value);
}

export function colorUrl(value: string): string {
  return textCyan(value);
}
