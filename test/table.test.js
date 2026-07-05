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

test("table shrinks columns by explicit priority", () => {
  const lines = renderTable(
    [
      { key: "left", title: "left", width: 10, minWidth: 4, shrinkPriority: 10 },
      { key: "middle", title: "middle", width: 10, minWidth: 6, shrinkPriority: 30 },
      { key: "right", title: "right", width: 10, minWidth: 5, shrinkPriority: 20 },
    ],
    [
      { left: "abcdefghij", middle: "klmnopqrst", right: "qrstuvwxyz" },
    ],
    { gap: 1, maxWidth: 23, boldHeader: false },
  );

  assert.deepEqual(lines.map(stripAnsi), [
    "left middle     right",
    "abc… klmnopqrst qrstuv…",
  ]);
  assert.ok(lines.every((line) => visibleLength(line) <= 23));
});

test("truncateVisible handles ANSI colored text", () => {
  assert.equal(stripAnsi(truncateVisible(textGreen("abcdef"), 5)), "abcd…");
  assert.equal(visibleLength(truncateVisible(textGreen("中文abcdef"), 7)), 7);
});

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
