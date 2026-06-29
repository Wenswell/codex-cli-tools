import assert from "node:assert/strict";
import test from "node:test";
import { renderTable } from "../dist/lib/table.js";
import { textGreen, textRed, truncateVisible, visibleLength } from "../dist/lib/text.js";

test("table aligns ANSI colored cells by visible width", () => {
  const lines = renderTable(
    [
      { key: "name", title: "name" },
      { key: "value", title: "value", align: "right" },
    ],
    [
      { name: textGreen("alpha"), value: "9" },
      { name: textRed("beta"), value: "100" },
    ],
    { boldHeader: false },
  );

  assert.deepEqual(lines.map(stripAnsi), [
    "name   value",
    "alpha      9",
    "beta     100",
  ]);
});

test("table treats wide characters as terminal display width", () => {
  const lines = renderTable(
    [
      { key: "name", title: "name", width: 6 },
      { key: "value", title: "value", width: 5, align: "right" },
    ],
    [
      { name: "中文", value: "7" },
      { name: "abc", value: "888" },
    ],
    { gap: 1, boldHeader: false },
  );

  assert.deepEqual(lines.map(stripAnsi), [
    "name   value",
    "中文       7",
    "abc      888",
  ]);
});

test("table truncates by visible width and keeps the last flex column within max width", () => {
  const lines = renderTable(
    [
      { key: "index", title: "", width: 3, align: "right" },
      { key: "model", title: "model", width: 8 },
      { key: "path", title: "path", flex: true, minWidth: 8 },
    ],
    [
      { index: "1.", model: "gpt-5.5-super-long", path: "/v1/responses/with/a/long/path" },
    ],
    { gap: 1, maxWidth: 28, boldHeader: false },
  );

  assert.deepEqual(lines.map(stripAnsi), [
    "    model    path",
    " 1. gpt-5.5… /v1/responses/…",
  ]);
  assert.ok(lines.every((line) => visibleLength(line) <= 28));
});

test("truncateVisible handles ANSI colored text", () => {
  assert.equal(stripAnsi(truncateVisible(textGreen("abcdef"), 5)), "abcd…");
  assert.equal(visibleLength(truncateVisible(textGreen("中文abcdef"), 7)), 7);
});

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
