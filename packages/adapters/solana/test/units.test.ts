import { test } from "node:test";
import assert from "node:assert/strict";

import { formatTokenAmount, parseTokenAmount } from "../src/units.js";

test("formatTokenAmount renders whole units without a decimal point", () => {
  assert.equal(formatTokenAmount(5_000_000n, 6), "5");
});

test("formatTokenAmount renders fractional units and trims trailing zeros", () => {
  assert.equal(formatTokenAmount(1_250_000n, 6), "1.25");
});

test("formatTokenAmount/parseTokenAmount round-trip", () => {
  const raw = 1_234_567_890_123n;
  assert.equal(parseTokenAmount(formatTokenAmount(raw, 6), 6), raw);
});
