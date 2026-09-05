import { test } from "node:test";
import assert from "node:assert/strict";

import { formatUsdcAmount } from "../src/units.js";

test("formatUsdcAmount renders whole units without a decimal point", () => {
  assert.equal(formatUsdcAmount(5_000_000n), "5");
});

test("formatUsdcAmount renders fractional units and trims trailing zeros", () => {
  assert.equal(formatUsdcAmount(1_250_000n), "1.25");
  assert.equal(formatUsdcAmount(1_000_001n), "1.000001");
});

test("formatUsdcAmount handles zero", () => {
  assert.equal(formatUsdcAmount(0n), "0");
});

test("formatUsdcAmount does not lose precision on large amounts", () => {
  // 1,000,000,000.000001 USDC — well past Number's safe-integer precision in base units.
  assert.equal(formatUsdcAmount(1_000_000_000_000_001n), "1000000000.000001");
});
