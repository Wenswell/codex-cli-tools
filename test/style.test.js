import assert from "node:assert/strict";
import test from "node:test";
import { createTextStyle } from "../dist/lib/style.js";

test("text style can explicitly disable colors", () => {
  const style = createTextStyle(false);
  assert.equal(style.bold("value"), "value");
  assert.equal(style.blue("value"), "value");
  assert.equal(style.cyan("value"), "value");
  assert.equal(style.dim("value"), "value");
  assert.equal(style.green("value"), "value");
  assert.equal(style.magenta("value"), "value");
  assert.equal(style.red("value"), "value");
  assert.equal(style.yellow("value"), "value");
});
