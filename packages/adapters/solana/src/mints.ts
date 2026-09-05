/**
 * Well-known SPL mint addresses, confirmed live against mainnet-beta
 * (`getAccountInfo`, jsonParsed) before use here: both resolve to an
 * initialized mint owned by the SPL Token program
 * (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA) with 6 decimals.
 */
export const KNOWN_MINTS: Readonly<Record<string, { symbol: string; decimals: number }>> = Object.freeze({
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", decimals: 6 },
});

/** Falls back to the mint address itself as the symbol — honest about not recognizing it, rather than mislabeling. */
export function mintSymbol(mint: string): string {
  return KNOWN_MINTS[mint]?.symbol ?? mint;
}
