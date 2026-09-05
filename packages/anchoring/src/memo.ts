/**
 * The simple write path (SPEC.md §5.1): a root in a Stellar `MEMO_HASH`.
 *
 * This module exists to make a point that is easy to miss — anchoring on
 * Stellar needs no smart contract and no new operation type. `MEMO_HASH` is
 * exactly 32 bytes and a SHA-256 root is exactly 32 bytes, so the primitive
 * has been sitting in the protocol since 2015.
 *
 * That matters beyond convenience. A commitment written this way has no
 * contract state to migrate, nothing to keep running, and no code that can be
 * upgraded out from under it. In ten years it will verify against a history
 * archive with the same three lines of arithmetic it verifies with today,
 * which is the entire point of anchoring.
 *
 * No transaction is built or submitted here. Signing and submission need a
 * keypair and a network connection, and a library that quietly acquired either
 * would be the wrong shape — this produces the memo, and the caller decides
 * what carries it.
 */

import { fromHex, toHex, HASH_BYTES } from "./merkle.js";

/** Stellar memo types, as Horizon reports them. */
export type MemoType = "none" | "id" | "text" | "hash" | "return";

export interface AnchorMemo {
  memoType: "hash";
  /** Base64, which is how Horizon returns and accepts a hash memo. */
  memoBase64: string;
  /** The same 32 bytes as hex, for readers who want to eyeball it. */
  memoHex: string;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Encode a hex root as the memo a Stellar transaction should carry.
 *
 * Throws on anything that is not exactly 32 bytes rather than padding or
 * truncating. A silently truncated root would still produce a transaction and
 * still look anchored, and the failure would only surface years later when a
 * proof did not verify.
 */
export function rootToMemo(rootHex: string): AnchorMemo {
  const bytes = fromHex(rootHex);
  if (bytes.length !== HASH_BYTES) {
    throw new Error(`A hash memo is exactly ${HASH_BYTES} bytes; got ${bytes.length}.`);
  }
  return { memoType: "hash", memoBase64: toBase64(bytes), memoHex: toHex(bytes) };
}

/**
 * Read a root back out of a transaction as Horizon reports it.
 *
 * Returns null rather than throwing for any transaction that is not carrying a
 * hash memo — most transactions are not anchors, and that is not an error
 * condition for a verifier walking history.
 */
export function memoToRoot(tx: { memo_type?: string; memo?: string }): string | null {
  if (tx.memo_type !== "hash" || typeof tx.memo !== "string") return null;
  try {
    const bytes = fromBase64(tx.memo);
    if (bytes.length !== HASH_BYTES) return null;
    return toHex(bytes);
  } catch {
    return null;
  }
}

/**
 * Does this transaction commit to this root?
 *
 * The whole of step 4 of SPEC.md §7, isolated so a verifier reads as the spec
 * does. Case-insensitive on the hex because a bundle written by hand should
 * not fail for capitalisation.
 */
export function transactionCommitsTo(tx: { memo_type?: string; memo?: string }, rootHex: string): boolean {
  const found = memoToRoot(tx);
  return found !== null && found.toLowerCase() === rootHex.toLowerCase();
}
