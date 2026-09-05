# `@landfall/anchoring`

Cryptographic commitments on the Stellar ledger: commit a set of records, then
prove any single one was committed — by anyone, without trusting whoever
committed it, years later, with no API in the path.

> **"Anchor" here means a cryptographic commitment, not a SEP-24 anchor.** The
> rest of this repository uses "anchor" for a licensed business moving value
> between Stellar and a bank. The two senses are unrelated and collide
> unfortunately. This package always means the first.

The format and the reasoning behind each decision are in [SPEC.md](./SPEC.md).

## The short version

Stellar's `MEMO_HASH` is exactly 32 bytes. A SHA-256 Merkle root is exactly 32
bytes. So anchoring on Stellar needs **no smart contract, no new operation
type, and no protocol change** — the primitive has been there since 2015.

```
documents → RFC 6962 Merkle tree → root → MEMO_HASH → ledger
```

A commitment written this way has no contract state to migrate, nothing to keep
running, and no code that can be upgraded out from under it.

## Try it

```bash
# 1. Commit some documents
npm run anchor -- anchor --namespace certificates alice.txt bob.txt carol.txt

# 2. Submit any Stellar transaction carrying the MEMO_HASH it prints, then:
npm run anchor -- prove --tree tree.json --index 1 \
    --ledger 55123456 --tx <hash> --close-time 2026-09-05T10:00:00Z

# 3. Anyone can now verify, against any Horizon, with only the bundle
npm run anchor -- verify bundle-1.json --document bob.txt
```

Step 3 is the point. It talks to a Horizon the *verifier* chooses — not one
belonging to whoever made the commitment.

## What it does

| Capability | Status |
|---|---|
| RFC 6962 Merkle tree, domain-separated, no duplication bug | ✅ |
| Anchor record with committed record count | ✅ |
| `MEMO_HASH` write path — no contract required | ✅ |
| Self-contained proof bundles | ✅ |
| Verifier needing only a bundle + any Horizon | ✅ |
| Document-to-hash binding, checked separately | ✅ |
| Ledger-derived timestamps (sequence, close time, tx, op index) | ✅ |
| Finality levels: LEDGER → ARCHIVED → CHECKPOINTED | ✅ |
| Off-chain storage pointers that are never load-bearing | ✅ |
| External checkpoint aggregation + proof paths | ✅ format only |
| Writing checkpoints to Bitcoin | ❌ needs funds, keys, an operator |
| Zero-knowledge membership proofs | ❌ slot defined, no circuit |
| Anchor registry (directory, explicitly not evidence) | ✅ |

The two ❌ rows are honest rather than aspirational. `NULL_SUBMITTER` throws
rather than fabricating a checkpoint receipt, and `verifyZkProof` reports
`unsupported: true` rather than `verified: true`, because a stub that returned
success would let a bundle assert a guarantee nobody provided. If you need
Bitcoin checkpointing today, use [OpenTimestamps](https://opentimestamps.org) —
it has done exactly this since 2016.

## Security properties worth knowing

Both of these are tested, and both are attacks the naive implementation admits:

- **An internal node cannot be replayed as a leaf.** Leaf and node preimages are
  domain-separated (`0x00` / `0x01`), so a record whose bytes happen to equal two
  concatenated hashes does not collide with a real internal node.
- **No two record lists share a root.** Odd levels split at the largest power of
  two rather than duplicating the trailing node, avoiding
  [CVE-2012-2459](https://nvd.nist.gov/vuln/detail/CVE-2012-2459), where
  `[a,b,c]` and `[a,b,c,c]` produce the same root.

A namespace is bound into every leaf, so a proof issued for `certificates`
cannot be replayed under `invoices`.

## What an anchor does not prove

Stated here because these are the claims people reach for and none of them
follow:

- **Not authorship.** Anyone can anchor anyone's data.
- **Not creation time.** It proves the data existed *no later than* a ledger.
  A commitment can be made long after the fact.
- **Not correctness.** A committed record can be entirely false.
- **Not confidentiality.** A hash leaks nothing directly, but a low-entropy
  record is brute-forceable. Salt anything that needs to stay secret.
- **Not tamper-proofing.** It makes tampering *detectable*, which is weaker and
  more useful than it sounds.

## Prior art

[OpenTimestamps](https://opentimestamps.org) has done Bitcoin-backed
timestamping since 2016, for free. Certificate Transparency
([RFC 6962](https://datatracker.ietf.org/doc/html/rfc6962)) is where the tree
construction comes from. Anyone building in this space should read both before
writing code — this package's contribution is the Stellar-specific write path
and a proof format that survives without its issuer, not a new idea about
Merkle trees.
