import { discoverDomain } from "../../indexer/src/toml.js";
import type { AnchorAccount } from "../../indexer/src/types.js";

export interface AnchorIdentity {
  /**
   * The canonical Landfall anchor id (MULTICHAIN.md §5). The home domain
   * itself: SEP-1 already makes it the unique, permissionless key for an
   * anchor's identity, so there is no reason to mint a second id for it.
   */
  anchorId: string;
  domain: string;
  /** Every account the domain's stellar.toml declares — ACCOUNTS entries and currency issuers alike. */
  stellarAccounts: AnchorAccount[];
  /** Set when the domain's stellar.toml could not be fetched or parsed — the identity is still returned, just empty. */
  error?: string;
}

/**
 * Resolves a home domain to a Landfall anchor identity via SEP-1
 * (MULTICHAIN.md §5, step 1). Reuses the indexer's own `discoverDomain`
 * rather than re-fetching/re-parsing stellar.toml a second way.
 *
 * SDF Anchor Directory / stellar.expert reconciliation (§5, step 2) is not
 * done here — this resolves identity from the domain alone, which is what
 * SEP-1 already guarantees permissionlessly.
 */
export async function resolveAnchorIdentity(
  domain: string,
  fetchImpl: typeof fetch = fetch,
  horizon = "https://horizon.stellar.org",
): Promise<AnchorIdentity> {
  const { accounts, error } = await discoverDomain(domain, fetchImpl, horizon);
  return { anchorId: domain, domain, stellarAccounts: accounts, error };
}
