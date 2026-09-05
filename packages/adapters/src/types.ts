/**
 * The interface every per-chain adapter implements, so L2 (attestation
 * signing) and L3 (distribution) never need to know which chain they're
 * reading. See docs/architecture/MULTICHAIN.md §6.
 */

/** The honesty ladder — kept in sync with, but decoupled from, @landfall/stp. */
export type EvidenceTier = "PROVEN" | "ATTESTED" | "DERIVED";

export interface SettlementEvent {
  anchorId: string;
  chain: string;
  asset: string;
  direction: "deposit" | "withdrawal" | "bridge_in" | "bridge_out";
  /** Decimal string, asset units — never a float, to avoid precision loss. */
  amount: string;
  /** Tx hash / operation id on `chain`. */
  onchainRef: string;
  fiatLegRef?: string | null;
  evidenceTier: EvidenceTier;
  evidenceDetail: string;
  /** Stellar tx hash this settlement roots to, when it touches the keystone chain. */
  keystoneRef?: string | null;
  observedAt: string; // ISO-8601
}

export interface ScanOpts {
  fromLedgerOrBlock?: number | string;
  toLedgerOrBlock?: number | string;
  minAmount?: string;
}

export interface ChainAdapter {
  chain: string;
  /** The highest tier this adapter can ever emit — never exceeded, whatever the data looks like. */
  maxTier: EvidenceTier;
  /** Streams settlement events for an anchor over a range. */
  scan(anchorId: string, opts: ScanOpts): AsyncIterable<SettlementEvent>;
  /** Independently re-verifies a single event's artifact (used before attestation signing). */
  verify(ev: SettlementEvent): Promise<boolean>;
}
