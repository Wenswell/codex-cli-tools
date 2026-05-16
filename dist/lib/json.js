export function parseJsonObject(text) {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("expected a JSON object");
    }
    return value;
}
export function stringifyJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
