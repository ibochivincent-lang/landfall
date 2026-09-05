/**
 * Formats a raw USDC amount (base units, 6 decimals) as the decimal string
 * the STP schema requires — bigint math throughout, so a large transfer
 * can't lose precision the way `Number(raw) / 1e6` would.
 */
export function formatUsdcAmount(rawBaseUnits: bigint): string {
  const DECIMALS = 6n;
  const scale = 10n ** DECIMALS;
  const whole = rawBaseUnits / scale;
  const frac = rawBaseUnits % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(Number(DECIMALS), "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}
