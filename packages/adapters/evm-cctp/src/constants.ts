/**
 * Circle CCTP domain ids, as publicly documented at
 * https://developers.circle.com/cctp/concepts/supported-chains-and-domains
 *
 * Treat this as a convenience default, not an authority: pass an explicit
 * `sourceDomainId` to EvmCctpAdapter instead of relying on this table for
 * any chain you have not independently confirmed against Circle's current
 * docs — domain ids are assigned once and don't change, but this table can
 * still go stale if Circle adds chains this file hasn't caught up with.
 */
export const CCTP_DOMAIN_IDS: Readonly<Record<string, number>> = Object.freeze({
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  noble: 4,
  solana: 5,
  base: 6,
  polygon: 7,
});
