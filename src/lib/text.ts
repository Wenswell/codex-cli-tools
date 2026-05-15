export function maskSecret(value: string): string {
  if (value.length <= 9) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 6)}***${value.slice(-3)}`;
}

const canColorize = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function withAnsi(code: number, value: string): string {
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

export function textRed(value: string): string {
  return withAnsi(31, value);
}
