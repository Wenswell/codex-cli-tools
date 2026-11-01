import assert from "node:assert/strict";
import test from "node:test";
import { input, isInteractive, multiSelect, PromptCancelledError, select } from "../dist/lib/prompt.js";
import { KEYS, runInteractive } from "./helpers/terminal.js";

const choices = [
  { value: "a", label: "alpha", hint: "first" },
  { value: "b", label: "beta", disabled: "missing apiKey" },
  { value: "c", label: "gamma" },
];

test("select moves with arrows and j/k, skips disabled choices, and wraps", async () => {
  const { result, output } = await runInteractive(
    () => select("Pick one", choices),
    [["Pick one", `${KEYS.down}${KEYS.enter}`]],
  );
  assert.equal(result, "c");
  assert.match(output, /beta\s+\(missing apiKey\)/);
  assert.match(output, /✔ Pick one · gamma\n/);

  const wrapped = await runInteractive(
    () => select("Pick one", choices, { default: "c" }),
    [["Pick one", `j${KEYS.enter}`]],
  );
  assert.equal(wrapped.result, "a");

  const upward = await runInteractive(
    () => select("Pick one", choices),
    [["Pick one", `k${KEYS.up}${KEYS.enter}`]],
  );
  assert.equal(upward.result, "a");
});

test("select handles several keys in one input chunk and ignores keys after enter", async () => {
  const { result } = await runInteractive(
    () => select("Pick one", choices),
    [["Pick one", `${KEYS.down}${KEYS.enter}${KEYS.down}${KEYS.enter}`]],
  );
  assert.equal(result, "c");
});

test("multiSelect toggles with space and a, and enforces a required selection", async () => {
  const { result, output } = await runInteractive(
    () => multiSelect("Pick many", choices, { required: "select at least one" }),
    [
      ["Pick many", KEYS.enter],
      ["select at least one", `a${KEYS.space}${KEYS.enter}`],
    ],
  );
  assert.deepEqual(result, ["c"]);
  assert.match(output, /✔ Pick many · gamma\n/);

  const all = await runInteractive(
    () => multiSelect("Pick many", choices),
    [["Pick many", `a${KEYS.enter}`]],
  );
  assert.deepEqual(all.result, ["a", "c"]);

  const none = await runInteractive(
    () => multiSelect("Pick many", choices),
    [["Pick many", KEYS.enter]],
  );
  assert.deepEqual(none.result, []);
  assert.match(none.output, /✔ Pick many · none/);
});

test("input uses defaults, validates, edits, and masks secrets", async () => {
  const defaulted = await runInteractive(
    () => input("Count", { default: "5" }),
    [["Count", KEYS.enter]],
  );
  assert.equal(defaulted.result, "5");

  const validated = await runInteractive(
    () => input("Count", { validate: (value) => /^\d+$/.test(value) ? null : "enter a number" }),
    [
      ["Count", `x${KEYS.enter}`],
      ["enter a number", `${KEYS.backspace}12${KEYS.enter}`],
    ],
  );
  assert.equal(validated.result, "12");

  const secret = "sk-abcdefghijklmnop";
  const masked = await runInteractive(
    () => input("apiKey", { mask: true }),
    [["apiKey", `${secret}${KEYS.enter}`]],
  );
  assert.equal(masked.result, secret);
  assert.equal(masked.output.includes(secret), false);
  assert.match(masked.output, /✔ apiKey · sk-abc\*\*\*nop/);
});

test("escape and Ctrl-C cancel prompts and restore the terminal", async () => {
  const rawModes = [];
  let stdin;
  await assert.rejects(
    () => runInteractive(() => {
      stdin = process.stdin;
      const setRawMode = stdin.setRawMode;
      stdin.setRawMode = (value) => {
        rawModes.push(value);
        return setRawMode(value);
      };
      return select("Pick one", choices);
    }, [["Pick one", KEYS.escape]]),
    (error) => error instanceof PromptCancelledError && error.interrupted === false,
  );
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(stdin.listenerCount("data"), 0);
  assert.equal(stdin.isPaused(), true);

  await assert.rejects(
    () => runInteractive(() => input("Name"), [["Name", KEYS.ctrlC]]),
    (error) => error instanceof PromptCancelledError && error.interrupted === true,
  );
});

test("prompts require a terminal", async () => {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  assert.equal(isInteractive(), false);
  await assert.rejects(() => select("Pick one", choices), /interactive prompt requires a terminal/);
});
