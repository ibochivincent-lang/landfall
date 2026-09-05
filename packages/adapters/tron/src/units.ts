/** Bigint-based base-units <-> decimal-string conversion — no float precision loss. */
export function formatTokenAmount(rawBaseUnits: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = rawBaseUnits / scale;
  const frac = rawBaseUnits % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

export function parseTokenAmount(decimalAmount: string, decimals: number): bigint {
  const [whole, frac = ""] = decimalAmount.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}
