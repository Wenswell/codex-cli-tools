import {
  textBlue,
  textCyan,
  textGreen,
  textMagenta,
  textYellow,
} from "./text.js";

export function printKeyValue(label: string, value: string, width = 8): void {
  console.log(`${label.padEnd(width)} ${value}`);
}

export function colorCount(value: string): string {
  return textGreen(value);
}

export function colorCost(value: string): string {
  return textYellow(value);
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
