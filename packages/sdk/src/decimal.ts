/**
 * Exact addition of two non-negative decimal strings.
 *
 * Amounts arrive at different scales — Stellar carries 7 decimal places,
 * USDC 6 — so they're normalised to a common scale and added as bigints.
 * `Number(a) + Number(b)` would be simpler and would quietly lose value on
 * large volumes, which is the one thing a settlement figure can't do.
 */
export function addDecimalStrings(a: string, b: string): string {
  const [aWhole = "0", aFrac = ""] = a.split(".");
  const [bWhole = "0", bFrac = ""] = b.split(".");
  const scale = Math.max(aFrac.length, bFrac.length);

  const scaled = (whole: string, frac: string) => BigInt(whole + frac.padEnd(scale, "0"));
  const sum = scaled(aWhole, aFrac) + scaled(bWhole, bFrac);
  if (scale === 0) return sum.toString();

  const digits = sum.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
