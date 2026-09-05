/**
 * The anchor registry (SPEC.md §12 in the design notes; not part of the wire
 * format).
 *
 * A registry is a *directory* of anchors — who committed what, when, and where
 * to find the proof. It is a convenience for discovery and nothing more.
 *
 * The distinction matters enough to state twice: **a registry entry is not
 * evidence.** Anyone can write any claim into a registry. What makes an anchor
 * true is the bundle verifying against the ledger, which requires no registry
 * at all. If this file disappeared, every proof ever issued would still check.
 * That is the correct relationship, and it is the opposite of how most
 * "blockchain notarisation" products are built — they make the registry
 * authoritative and the chain decorative, which reintroduces exactly the
 * trusted intermediary the chain was supposed to remove.
 *
 * So: entries carry a `verified` field that is only ever set by actually
 * running the verifier, never by the publisher asserting it.
 */

import { validateAnchorRecord, type AnchorRecord } from "./anchor.js";

export const REGISTRY_VERSION = 1;

export interface RegistryEntry {
  /** Stable id within this registry. Not a global identifier. */
  id: string;
  /** Who says they made this commitment. Unverified by construction. */
  publisher: string;
  /** Human description of the committed set, e.g. "Degree certificates 2026". */
  description: string;
  anchor: AnchorRecord;
  ledger: { sequence: number; txHash: string; closeTime: string };
  /** Where the proof bundles for this anchor can be fetched, if published. */
  bundlesUrl?: string;
  /**
   * Result of the registry operator independently verifying the anchor.
   * `null` means nobody has checked, which is different from failing.
   */
  verified: null | { at: string; ok: boolean; note?: string };
}

export interface Registry {
  version: number;
  note: string;
  entries: RegistryEntry[];
}

export function emptyRegistry(): Registry {
  return {
    version: REGISTRY_VERSION,
    note:
      "A directory of anchors, not a source of truth. Entries are claims by their publishers. " +
      "An anchor is true because its proof bundle verifies against the Stellar ledger, which needs " +
      "nothing from this file. `verified` is set only by running the verifier, never by assertion.",
    entries: [],
  };
}

/**
 * Structural validation of one entry.
 *
 * Note what is deliberately not validated: whether the publisher is who they
 * say they are. A registry cannot establish that and should not pretend to —
 * identity belongs to whatever process the reader already trusts, and the
 * anchor proves only that *someone* committed these bytes by this ledger.
 */
export function validateEntry(entry: RegistryEntry): string[] {
  const problems: string[] = [];

  if (!entry.id?.trim()) problems.push("Entry has no id.");
  if (!entry.publisher?.trim()) problems.push("Entry has no publisher.");
  if (!entry.description?.trim()) problems.push("Entry has no description.");

  problems.push(...validateAnchorRecord(entry.anchor).map((p) => `anchor: ${p}`));

  if (!Number.isInteger(entry.ledger?.sequence) || entry.ledger.sequence <= 0) {
    problems.push("ledger.sequence must be a positive integer.");
  }
  if (!/^[0-9a-f]{64}$/i.test(entry.ledger?.txHash ?? "")) {
    problems.push("ledger.txHash is not a 32-byte hex digest.");
  }
  if (entry.bundlesUrl && !/^https:\/\//.test(entry.bundlesUrl)) {
    problems.push("bundlesUrl must be https.");
  }
  if (entry.verified !== null && typeof entry.verified?.ok !== "boolean") {
    problems.push("verified must be null or carry a boolean `ok` and a timestamp.");
  }
  return problems;
}

export function validateRegistry(registry: Registry): string[] {
  const problems: string[] = [];
  if (registry.version !== REGISTRY_VERSION) {
    problems.push(`Unsupported registry version ${registry.version}.`);
  }

  const seen = new Set<string>();
  for (const entry of registry.entries) {
    if (seen.has(entry.id)) problems.push(`Duplicate entry id "${entry.id}".`);
    seen.add(entry.id);
    problems.push(...validateEntry(entry).map((p) => `${entry.id}: ${p}`));
  }
  return problems;
}

export interface RegistryQuery {
  publisher?: string;
  namespace?: string;
  /** Exact root, hex. The most precise lookup a registry supports. */
  root?: string;
  /** Only entries the registry operator has independently verified. */
  verifiedOnly?: boolean;
  /** Committed at or after this ledger sequence. */
  sinceLedger?: number;
}

export function queryRegistry(registry: Registry, query: RegistryQuery = {}): RegistryEntry[] {
  return registry.entries.filter((e) => {
    if (query.publisher && e.publisher !== query.publisher) return false;
    if (query.namespace && e.anchor.namespace !== query.namespace) return false;
    if (query.root && e.anchor.root.toLowerCase() !== query.root.toLowerCase()) return false;
    if (query.verifiedOnly && e.verified?.ok !== true) return false;
    if (query.sinceLedger !== undefined && e.ledger.sequence < query.sinceLedger) return false;
    return true;
  });
}

/**
 * Add an entry, refusing anything malformed.
 *
 * Returns a new registry rather than mutating, so a caller cannot half-apply a
 * batch and leave the file in a state that was never validated as a whole.
 */
export function addEntry(registry: Registry, entry: RegistryEntry): Registry {
  const problems = validateEntry(entry);
  if (problems.length > 0) {
    throw new Error(`Refusing to register a malformed entry:\n  - ${problems.join("\n  - ")}`);
  }
  if (registry.entries.some((e) => e.id === entry.id)) {
    throw new Error(`Entry id "${entry.id}" already exists in this registry.`);
  }
  return { ...registry, entries: [...registry.entries, entry] };
}

/**
 * Summary counts, with unverified and unchecked kept apart.
 *
 * Collapsing "we checked and it failed" into "not verified" would let a broken
 * anchor hide among ones nobody has looked at yet.
 */
export function summarise(registry: Registry): {
  total: number;
  verified: number;
  failed: number;
  unchecked: number;
  namespaces: string[];
} {
  return {
    total: registry.entries.length,
    verified: registry.entries.filter((e) => e.verified?.ok === true).length,
    failed: registry.entries.filter((e) => e.verified?.ok === false).length,
    unchecked: registry.entries.filter((e) => e.verified === null).length,
    namespaces: [...new Set(registry.entries.map((e) => e.anchor.namespace))].sort(),
  };
}
