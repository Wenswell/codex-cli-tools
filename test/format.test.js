import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCompactBytes,
  formatCompactRate,
  formatDurationMs,
  formatThreeSignificant,
} from "../dist/lib/format.js";

test("formats compact numbers with three significant digits", () => {
  assert.equal(formatThreeSignificant(Number.NaN), "-");
  assert.equal(formatThreeSignificant(2.345), "2.35");
  assert.equal(formatThreeSignificant(43.24), "43.2");
  assert.equal(formatThreeSignificant(160.4), "160");
});

test("formats compact bytes and rates", () => {
  assert.equal(formatCompactBytes(0), "0B");
  assert.equal(formatCompactBytes(999), "999B");
  assert.equal(formatCompactBytes(32 * 1024), "32.0K");
  assert.equal(formatCompactBytes(982 * 1024), "982K");
  assert.equal(formatCompactBytes(3.41 * 1024 * 1024), "3.41M");
  assert.equal(formatCompactRate(160 * 1024), "160K/s");
});

test("formats compact durations", () => {
  assert.equal(formatDurationMs(Number.NaN), "-");
  assert.equal(formatDurationMs(56), "56ms");
  assert.equal(formatDurationMs(2340), "2.34s");
  assert.equal(formatDurationMs(43_200), "43.2s");
  assert.equal(formatDurationMs(187_200), "3.12m");
  assert.equal(formatDurationMs(3_600_000), "1.00h");
  assert.equal(formatDurationMs(3_600_000, { maxUnit: "m" }), "60.0m");
});
