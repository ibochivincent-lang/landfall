/**
 * Streaming tree construction.
 *
 * `buildAnchor` holds every leaf in memory, which is fine for a batch of
 * certificates and useless for the case this standard is actually pitched at —
 * millions of records, hashed once as they stream past.
 *
 * This builds the same RFC 6962 root in O(log n) memory using the standard
 * "stack of complete subtrees" technique: keep one root per completed subtree
 * size, merge whenever two subtrees of equal size meet. For n leaves the stack
 * holds at most ⌈log₂ n⌉ hashes — 24 hashes for 10 million records, under a
 * kilobyte, regardless of how much data went past.
 *
 * The root produced is bit-for-bit identical to `rootFromLeaves` over the same
 * sequence. That equivalence is not obvious, so it is property-tested across
 * every size rather than assumed.
 *
 * What it deliberately does not do: retain leaves, and therefore produce
 * inclusion proofs. A caller who needs proofs must either keep the leaves or
 * re-stream. Pretending otherwise would mean silently buffering the thing the
 * caller used this class to avoid buffering.
 */

import { hashLeaf, hashNode, emptyRoot, toHex, type Hash } from "./merkle.js";

/**
 * A completed subtree: its root, and how many leaves are under it.
 *
 * The size is what drives merging — two subtrees combine only when they are
 * the same size, which is exactly what reproduces the power-of-two split shape
 * that `rootFromLeaves` produces recursively.
 */
interface Subtree {
  root: Hash;
  size: number;
}

export class IncrementalTree {
  private readonly stack: Subtree[] = [];
  private count = 0;

  constructor(private readonly namespace: string) {
    if (!namespace || namespace.trim() === "") throw new Error("Namespace is required.");
    if (namespace.indexOf(String.fromCharCode(0)) !== -1) {
      throw new Error("Namespace may not contain a NUL byte — it terminates the domain tag.");
    }
  }

  /** Number of records appended so far. This is the anchor record's `count`. */
  get size(): number {
    return this.count;
  }

  /** Append one record. */
  append(record: Uint8Array): this {
    return this.appendLeaf(hashLeaf(this.namespace, record));
  }

  /**
   * Append an already-hashed leaf.
   *
   * For a caller who hashed elsewhere — a database that stores digests, or a
   * pipeline that hashed while reading from disk and never held the record.
   */
  appendLeaf(leaf: Hash): this {
    let node: Subtree = { root: leaf, size: 1 };

    // Merge with the top of the stack while sizes match. Equal sizes mean two
    // complete subtrees sit side by side and their parent is now determined;
    // unequal means the left subtree is still waiting for more leaves.
    while (this.stack.length > 0 && (this.stack[this.stack.length - 1] as Subtree).size === node.size) {
      const left = this.stack.pop() as Subtree;
      node = { root: hashNode(left.root, node.root), size: left.size * 2 };
    }

    this.stack.push(node);
    this.count++;
    return this;
  }

  /** Append many records. */
  appendAll(records: Iterable<Uint8Array>): this {
    for (const r of records) this.append(r);
    return this;
  }

  /**
   * The root over everything appended so far.
   *
   * Non-destructive: the tree can be appended to afterwards and asked again,
   * which is what an append-only log doing periodic re-anchoring needs.
   *
   * The stack is folded right-to-left because the leftover subtrees are in
   * descending size order, and the incomplete right-hand remainder always
   * attaches beneath the larger complete subtree to its left.
   */
  root(): Hash {
    if (this.count === 0) return emptyRoot();

    let acc = (this.stack[this.stack.length - 1] as Subtree).root;
    for (let i = this.stack.length - 2; i >= 0; i--) {
      acc = hashNode((this.stack[i] as Subtree).root, acc);
    }
    return acc;
  }

  /** The root as hex, ready for an anchor record. */
  rootHex(): string {
    return toHex(this.root());
  }

  /** Peak memory held, in hashes — for a caller who wants to prove the claim. */
  get retainedHashes(): number {
    return this.stack.length;
  }
}

/**
 * Root over an async stream of records.
 *
 * The intended entry point for the large case: records arrive from a database
 * cursor, a file read, or a network stream, are hashed once, and are never
 * collected.
 */
export async function rootFromStream(
  namespace: string,
  records: AsyncIterable<Uint8Array>,
): Promise<{ root: string; count: number }> {
  const tree = new IncrementalTree(namespace);
  for await (const record of records) tree.append(record);
  return { root: tree.rootHex(), count: tree.size };
}
