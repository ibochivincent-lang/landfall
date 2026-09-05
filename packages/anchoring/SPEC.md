# Stellar Anchoring Standard v1

A format for committing a set of records to the Stellar ledger such that any
one record can later be proved to have been committed, at a specific ledger,
by anyone, without trusting the party who made the commitment.

**Terminology warning.** "Anchor" here means a *cryptographic commitment* — a
Merkle root written to a ledger. It has nothing to do with a SEP-24 anchor,
which is a licensed business moving value between Stellar and a bank. The two
senses collide unfortunately; this document always means the first.

---

## 1. Why this exists

Anyone can hash a file and put the hash on a chain. The hard parts are the ones
that make a proof survive contact with a sceptic ten years later:

- Can a verifier check it **without your API, your database, or your company
  existing**?
- Can an internal tree node be passed off as a leaf?
- Does the tree shape admit two different record sets with the same root?
- Does the proof say *when*, precisely, and against what?

This standard fixes those. It is deliberately small, and deliberately
implementable without smart contracts.

## 2. Hashing

SHA-256 throughout. Two domain-separated prefixes, following
[RFC 6962 §2.1](https://datatracker.ietf.org/doc/html/rfc6962#section-2.1)
(Certificate Transparency), whose construction has had far more adversarial
attention than anything invented here would get:

```
leaf(data)        = SHA-256( 0x00 || namespace_tag || data )
node(left, right) = SHA-256( 0x01 || left || right )
empty tree        = SHA-256( )                       // 32 zero-length bytes hashed
```

`namespace_tag` is the UTF-8 namespace string followed by a `0x00` terminator.
It binds a leaf to its namespace, so a leaf committed under `certificates`
cannot be replayed as a proof under `invoices`.

**Why the `0x00` / `0x01` prefixes matter.** Without them, an attacker who can
choose record content can submit a record whose bytes happen to equal the
concatenation of two real hashes. That record's leaf hash would equal a real
internal node, letting them present an internal node as though it were a
committed record — a second-preimage attack. The prefixes make leaf and node
preimages disjoint, so this is impossible.

## 3. Tree construction

Records are ordered. Order is significant and is part of what the root commits
to; a proof carries the leaf index, and reordering the input changes the root.

For `n` records, the root is defined recursively:

```
MTH([])       = SHA-256()
MTH([d0])     = leaf(d0)
MTH(d[0..n))  = node( MTH(d[0..k)), MTH(d[k..n)) )
                where k = largest power of two strictly less than n
```

**Why split at a power of two rather than duplicating the odd node.** The
common "if a level has an odd number of nodes, duplicate the last one" approach
is the source of [CVE-2012-2459](https://nvd.nist.gov/vuln/detail/CVE-2012-2459)
in Bitcoin: two *different* record lists can produce the same root, so a proof
proves less than it appears to. The RFC 6962 split has no such ambiguity — for
any `n` there is exactly one tree shape.

The record count is additionally committed in the anchor record (§4), so a
verifier can confirm the tree shape it reconstructs is the one that was
anchored.

## 4. The anchor record

What gets committed, and what a verifier needs to interpret it:

| Field       | Type      | Meaning |
|-------------|-----------|---------|
| `version`   | integer   | This standard's version. `1`. |
| `namespace` | string    | Application-defined scope, e.g. `certificates`. Bound into every leaf. |
| `root`      | 32 bytes  | Merkle root over the record set. |
| `algorithm` | string    | `sha256-rfc6962` for this version. |
| `count`     | integer   | Number of records. Pins tree shape. |
| `timestamp` | RFC 3339  | When the committer says it built the tree. Advisory only — see §6. |
| `metadata`  | object?   | Optional, application-defined. Never affects the root. |

Only `root` reaches the ledger (§5). The remaining fields travel in the proof
bundle (§7) and are checked against the root by reconstruction, so a lie in any
of them produces a root mismatch.

## 5. Writing to the ledger

Two modes. **The simple one requires no smart contract**, which is the point:
it is cheaper, has a far smaller trusted computing base, and will still verify
if Soroban changes underneath it.

### 5.1 Simple — `MEMO_HASH`

A Stellar transaction memo of type `MEMO_HASH` is exactly 32 bytes, which is
exactly a SHA-256 root. Submit any transaction — conventionally a 1-stroop
payment to self — carrying:

```
memo_type = MEMO_HASH
memo      = root
```

That is the whole write path. The commitment is then a property of the ledger,
readable from any Horizon instance or history archive, with no contract state
to migrate and nothing to keep running.

The namespace, count and algorithm are *not* on-chain in this mode. They live
in the bundle and are verified by reconstruction: a bundle claiming a different
namespace produces a different leaf hash, therefore a different root, therefore
fails against the on-chain memo.

### 5.2 Contract mode

For applications that need on-chain readability — a contract that must react to
an anchor, or an indexer that wants events — a Soroban contract may store the
full anchor record and emit it as an event. This standard defines the record
shape; it does not mandate a particular contract.

Contract mode costs more and inherits the contract's own risk. Use §5.1 unless
something specifically requires on-chain state.

## 6. Timestamp semantics

The committer's `timestamp` is a claim. The ledger's is evidence. A proof
carries both and a verifier must prefer the second:

```
ledger sequence     — monotonic, unforgeable position in history
ledger close time   — validator-agreed close time of that ledger
transaction hash    — identifies the exact transaction
operation index     — position within it
```

The correct reading of a verified anchor is *"this root existed no later than
the close of ledger N"*. It is not proof the data existed no **earlier**; a
commitment can be made long after the fact. Anchoring proves precedence, not
creation.

## 7. Anchor proof bundle

The unit that survives. A bundle is self-contained JSON holding everything a
verifier needs *except* the Stellar ledger itself:

```jsonc
{
  "version": 1,
  "anchor":  { /* §4 record, minus root duplication */ },
  "record":  { "index": 3, "hash": "<hex>" },   // the leaf being proved
  "proof":   [ { "position": "left" | "right", "hash": "<hex>" } ],
  "ledger":  { "sequence": 0, "closeTime": "", "txHash": "", "opIndex": 0 },
  "checkpoints": [ /* §9, optional */ ],
  "zk": null                                     /* §10, optional */
}
```

Verification, in order — each step must pass:

1. Recompute the root from `record.hash`, `record.index`, `proof` and
   `anchor.count`.
2. Confirm the recomputed root equals `anchor.root`.
3. Fetch `ledger.txHash` from **any** Horizon instance or history archive.
4. Confirm that transaction's `MEMO_HASH` equals `anchor.root`.
5. Confirm the transaction is in `ledger.sequence` and read its close time.

Step 3 is the property that matters: *any* instance. No API belonging to the
committer is in the path.

To prove a specific document rather than a hash, the verifier hashes the
document themselves and confirms it matches `record.hash`. The bundle
deliberately does not carry the document — see §8.

## 7a. Consistency proofs — is the log append-only?

An inclusion proof answers *"was this record committed?"*. It cannot answer the
question that decides whether a growing log is trustworthy: **"has anything
already committed been removed or altered?"**

Without this the scheme is silently rewritable. A publisher commits
`[a, b, c]`, later commits `[a, x, c, d]`, and every inclusion proof issued
against the new root verifies perfectly — while `b` has quietly ceased to have
ever existed. Only someone who kept the old root can tell, and nobody who
wasn't already watching ever will.

A consistency proof (RFC 6962 §2.1.2) closes it: given `root_m` over `m`
records and `root_n` over `n > m`, it proves the second tree **begins with
exactly** the first. Append-only, provably, and checkable by a third party who
holds neither set of records — only two roots, two sizes and the proof.

```
consistencyProof(leaves, oldSize)          → Hash[]
verifyConsistency(m, n, rootM, rootN, p)   → { consistent, reason }
```

The prover needs only the *current* leaves, since the old tree is by definition
a prefix of them. That is also why a publisher who rewrote history cannot
produce a valid proof: their current leaves no longer contain the old prefix.

A registry of anchors should audit every consecutive pair in a namespace this
way. Absence of a proof is not evidence of tampering — but it is not evidence
of good behaviour either, and the two must be reported differently.

## 7b. Structured records — canonical form

The record layer takes bytes. Applications anchor objects, and that is where
this class of scheme quietly breaks: `{"a":1,"b":2}` and `{"b":2,"a":1}` are
the same record and hash differently. A verifier re-serialising with a
different library, language or key order gets a different leaf and concludes
the document was tampered with.

That failure is worse than an ordinary bug: it surfaces years later, looks
exactly like fraud, and accuses the party holding a perfectly valid document.

Structured records **must** therefore be canonicalised before hashing, using
[RFC 8785 (JCS)](https://datatracker.ietf.org/doc/html/rfc8785): keys sorted by
UTF-16 code unit, no insignificant whitespace, ECMAScript number formatting.

Values that cannot be canonicalised are rejected rather than approximated,
because each has a plausible-looking `JSON.stringify` output that does not
round-trip — `NaN` and `Infinity` become `null`, `undefined` silently takes its
key with it, and a non-plain object serialises via whatever `toJSON` it happens
to have. A record that quietly loses a field is a record whose hash commits to
something its author never wrote.

## 7c. Large record sets

`buildAnchor` holds every leaf in memory, which is correct for a batch of
certificates and useless at the scale this is pitched for. `IncrementalTree`
produces a bit-identical root in O(log n) memory by keeping one root per
completed subtree and merging when two of equal size meet — 24 hashes for ten
million records, under a kilobyte, regardless of how much data streamed past.

It deliberately does **not** retain leaves, and therefore cannot produce
inclusion proofs. A caller needing proofs must keep the leaves or re-stream;
quietly buffering them would defeat the reason for using it.

## 8. Off-chain data

The ledger stores a 32-byte commitment. It must not store the data. Where the
data lives is an application decision, and a bundle may carry a pointer:

```jsonc
"storage": { "kind": "ipfs" | "arweave" | "https" | "none", "locator": "..." }
```

A pointer is a convenience, never part of verification. If the locator rots,
the proof is unaffected — anyone still holding the document can verify it. A
scheme where losing the storage layer invalidates the proof has defeated its
own purpose.

## 9. Finality levels

A commitment's strength is not binary, and collapsing it to "confirmed" hides
the interesting part:

| Level | Name | What backs it |
|---|---|---|
| 1 | `LEDGER` | Included in an externalised Stellar ledger under SCP. |
| 2 | `ARCHIVED` | Additionally present in ≥1 independent history archive, so it survives any single operator. |
| 3 | `CHECKPOINTED` | Additionally committed into an external chain (§9.1), so rewriting it requires attacking that chain too. |

Level 2 matters more than it sounds. Stellar's safety rests on quorum
configuration rather than accumulated proof-of-work, so "the ledger says so"
and "several independent parties retain a copy that says so" are meaningfully
different claims over a ten-year horizon.

### 9.1 External checkpoints

Many Stellar roots are aggregated into a root-of-roots, which is committed to a
chain with different security assumptions:

```
many anchors → root-of-roots → external chain (e.g. Bitcoin)
```

A bundle then carries a second proof path from its own root up to the
checkpoint. This mirrors what [OpenTimestamps](https://opentimestamps.org)
does; anyone building this should read it first rather than reinvent it.

**Submission to the external chain is not implemented here.** This package
defines the aggregation and the proof format and exposes a submitter interface;
actually writing to Bitcoin requires funds, keys and an operational commitment
that a library cannot make on someone's behalf. Until a submitter is supplied,
bundles report level 1 or 2 and say so, rather than claiming a checkpoint that
does not exist.

## 10. Zero-knowledge proofs

Stellar's ZK primitive layer went live with
[X-Ray / Protocol 25](https://stellar.org/blog/developers/announcing-stellar-x-ray-protocol-25)
in January 2026, making it possible to prove membership of a committed set
without revealing the record.

The bundle reserves a `zk` slot for such a proof and this package defines its
shape. **No circuit is implemented.** Writing and auditing production ZK
circuits is specialist work measured in months, and shipping an unaudited
circuit that appears to prove something would be considerably worse than
shipping nothing. The slot exists so bundles produced now remain
forward-compatible; `zk: null` is the honest current state.

## 11. What this standard does not claim

- **Not proof of authorship.** Anyone can anchor anyone's data.
- **Not proof of creation time.** See §6 — precedence only.
- **Not proof of correctness.** A committed record can be false.
- **Not confidentiality.** A hash leaks nothing directly, but a low-entropy
  record is brute-forceable. Salt records that need secrecy.
- **Not tamper-proofing.** It makes tampering *detectable*, which is a
  different and weaker thing.
