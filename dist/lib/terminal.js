import { truncateVisible, visibleLength } from "./text.js";
export function terminalColumns(stream = process.stdout, defaultColumns = 120) {
    const columns = Number.isFinite(stream.columns) ? stream.columns : process.stdout.columns;
    return columns && columns > 0 ? Math.floor(columns) : defaultColumns;
}
export function fitTerminalLine(line, options = {}) {
    const stream = options.stream ?? process.stdout;
    const columns = options.columns ?? terminalColumns(stream, 0);
    if ((options.ttyOnly ?? true) && !stream.isTTY) {
        return line;
    }
    if (!columns || visibleLength(line) < columns) {
        return line;
    }
    const reserveColumns = options.reserveColumns ?? 1;
    return truncateVisible(line, Math.max(0, columns - reserveColumns), options.ellipsis ?? "");
}
export function fitCommandsLine(fullLine, compactLine, columns) {
    const line = visibleLength(fullLine) <= columns ? fullLine : compactLine;
    return visibleLength(line) <= columns ? line : truncateVisible(line, columns);
}
export function formatCommandFooterLines(rows, columns = terminalColumns(process.stdout)) {
    const labelWidth = Math.max(...rows.map(({ label }) => visibleLength(label)));
    return rows.flatMap(({ label, commands }) => {
        const prefix = `${label}${" ".repeat(labelWidth - visibleLength(label) + 1)}`;
        const indent = " ".repeat(visibleLength(prefix));
        const lines = [];
        let line = prefix;
        for (const command of commands) {
            const separator = line === prefix ? "" : " | ";
            if (line !== prefix && visibleLength(line) + visibleLength(separator) + visibleLength(command) > columns) {
                lines.push(visibleLength(line) + 2 <= columns ? `${line} |` : line);
                line = `${indent}${command}`;
            }
            else {
                line += `${separator}${command}`;
            }
        }
        lines.push(line);
        return lines;
    });
}
