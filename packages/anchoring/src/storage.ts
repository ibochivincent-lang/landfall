/**
 * Off-chain data pointers (SPEC.md §8).
 *
 * The ledger holds 32 bytes and must not hold the data. The interesting design
 * rule is the one this module enforces by shape rather than by documentation:
 * **a storage pointer is never part of verification.**
 *
 * If a proof could only be checked by dereferencing an IPFS CID or an HTTPS
 * URL, then losing the storage layer would invalidate the proof, and the
 * scheme would have reintroduced exactly the dependency it exists to remove.
 * So `resolveStorage` returns bytes for convenience, and nothing in the
 * verifier calls it. Someone still holding the document can always verify;
 * someone holding only a dead link never could have.
 */

export type StorageKind = "ipfs" | "arweave" | "https" | "none";

export interface StoragePointer {
  kind: StorageKind;
  /** CID, transaction id, or URL depending on `kind`. Empty for "none". */
  locator: string;
  /** Optional human note, e.g. which gateway the publisher used. */
  note?: string;
}

const IPFS_CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;
const ARWEAVE_TX = /^[A-Za-z0-9_-]{43}$/;

/**
 * Reject a pointer that is obviously malformed.
 *
 * Format-only. Whether the locator resolves is not checked and deliberately
 * not checked here: a pointer that is dead today may be revived from a backup
 * tomorrow, and either way it has no bearing on whether the proof is sound.
 */
export function validateStoragePointer(pointer: StoragePointer): string[] {
  const problems: string[] = [];

  switch (pointer.kind) {
    case "none":
      if (pointer.locator) problems.push('Storage kind "none" must not carry a locator.');
      break;
    case "ipfs":
      if (!IPFS_CID.test(pointer.locator)) problems.push(`"${pointer.locator}" is not a v0 or v1 IPFS CID.`);
      break;
    case "arweave":
      if (!ARWEAVE_TX.test(pointer.locator)) problems.push(`"${pointer.locator}" is not an Arweave transaction id.`);
      break;
    case "https":
      if (!/^https:\/\//.test(pointer.locator)) problems.push("An https pointer must use https://.");
      break;
    default:
      problems.push(`Unknown storage kind "${String((pointer as StoragePointer).kind)}".`);
  }
  return problems;
}

/**
 * Suggested retrieval URLs for a pointer.
 *
 * Returns several for the content-addressed kinds because the gateway is
 * incidental — the CID is the identity, and any gateway serving the wrong
 * bytes is caught the moment the caller hashes them. Gateways are listed in no
 * particular order and none is endorsed.
 */
export function retrievalUrls(pointer: StoragePointer): string[] {
  switch (pointer.kind) {
    case "ipfs":
      return [
        `https://ipfs.io/ipfs/${pointer.locator}`,
        `https://cloudflare-ipfs.com/ipfs/${pointer.locator}`,
        `https://dweb.link/ipfs/${pointer.locator}`,
      ];
    case "arweave":
      return [`https://arweave.net/${pointer.locator}`];
    case "https":
      return [pointer.locator];
    case "none":
    default:
      return [];
  }
}

/**
 * Whether the anchored data is retrievable by a third party at all.
 *
 * Worth surfacing separately from validity: an anchor with `kind: "none"` is
 * perfectly valid and completely useless to anyone who was not already given
 * the document. That is a legitimate choice — it is how you anchor something
 * private — but a reader should be told which situation they are in.
 */
export function isPubliclyRetrievable(pointer: StoragePointer | undefined): boolean {
  return pointer !== undefined && pointer.kind !== "none" && pointer.locator.length > 0;
}
