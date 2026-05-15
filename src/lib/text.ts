export function maskSecret(value: string): string {
  if (value.length <= 9) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 6)}***${value.slice(-3)}`;
}
