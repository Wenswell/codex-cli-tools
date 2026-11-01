import { createInterface } from "node:readline/promises";
import { textDim } from "./text.js";
import { recordUsagePrompt } from "./usage.js";
export function rejectRemovedYesFlags(argv, command) {
    if (argv.includes("-y") || argv.includes("--yes")) {
        throw new Error(`${command} no longer accepts -y/--yes; run without it and type yes at the prompt`);
    }
}
export async function confirmApply() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log("");
        console.log(textDim("not applied. Re-run in an interactive terminal and type yes to apply changes."));
        return false;
    }
    const input = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        const answer = await input.question("\nApply changes? Type yes to continue: ");
        recordUsagePrompt({ prompt: "Apply changes?", outcome: answer === "yes" ? "answered" : "cancelled", kept_default: null });
        if (answer === "yes") {
            return true;
        }
        console.log(textDim("not applied."));
        return false;
    }
    finally {
        input.close();
    }
}
