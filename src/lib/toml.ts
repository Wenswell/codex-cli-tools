export function updateTomlBaseUrl(content: string, baseUrl: string): string {
  const lines = content.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (/^\s*base_url\s*=/.test(line)) {
      replaced = true;
      return `base_url = ${JSON.stringify(baseUrl)}`;
    }
    return line;
  });

  if (!replaced) {
    next.push(`base_url = ${JSON.stringify(baseUrl)}`);
  }

  return next.join("\n");
}
