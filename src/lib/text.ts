export function maskSecret(value: string): string {
  if (value.length <= 9) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 6)}***${value.slice(-3)}`;
}

const canColorize = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function withAnsi(code: number | string, value: string): string {
  if (!canColorize) {
    return value;
  }
  return `\u001b[${code}m${value}\u001b[0m`;
}

export function textBold(value: string): string {
  return withAnsi(1, value);
}

export function textDim(value: string): string {
  return withAnsi(2, value);
}

export function textBlue(value: string): string {
  return withAnsi(34, value);
}

export function textGreen(value: string): string {
  return withAnsi(32, value);
}

export function textRed(value: string): string {
  return withAnsi(31, value);
}

export function bgBlue(value: string): string {
  return withAnsi("30;48;5;153", value);
}

export function bgGreen(value: string): string {
  return withAnsi("30;48;5;194", value);
}

export function bgRed(value: string): string {
  return withAnsi("30;48;5;224", value);
}

export function bgGray(value: string): string {
  return withAnsi("30;48;5;252", value);
}
