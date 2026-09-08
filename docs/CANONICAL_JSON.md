# Canonical JSON

The exact byte string an STP attestation is signed over, specified so a
verifier can be written in any language without reading the TypeScript.

Implementation: [`packages/stp/src/canonical.ts`](../packages/stp/src/canonical.ts).

---

## Why this needs a spec

A signature is over bytes, not over an object. Two programs that serialise the
same attestation differently produce different bytes and therefore different
digests — so a verifier that disagrees with the signer about serialisation
rejects valid signatures, which looks identical to a forgery.

Publishing the rule is what lets someone verify a Landfall attestation without
running Landfall's code. An attestation only anybody-with-our-library can check
is not much of an attestation.

---

## The rule

```
canonical(value) = JSON.stringify(sortKeysDeep(value))
```

Two operations, in this order:

**1. Sort every object's keys recursively**, ascending, by JavaScript's
default string sort — which compares UTF-16 code units. Arrays keep their
order; array *elements* are sorted internally if they are objects.

**2. Serialise with standard `JSON.stringify` semantics:**

| | |
|---|---|
| Separators | No whitespace — `{"a":1,"b":2}` |
| Strings | Double-quoted, with JSON's standard escaping |
| Encoding | UTF-8 for the resulting byte string |
| `null` | Emitted as `null` |
| Key order | As sorted in step 1 |

```js
canonicalize({ b: "2", a: "1" })            // {"a":"1","b":"2"}
canonicalize({ z: { y: "1", x: "2" } })     // {"x":"2","y":"1"} nested inside {"z":…}
canonicalize({ list: [{ b: 1, a: 2 }] })    // {"list":[{"a":2,"b":1}]}
```

---

## Scope, and what is deliberately not handled

**This is not RFC 8785 (JCS).** It is a narrower rule that is correct for the
data STP actually carries: attestations are flat objects of strings and
`null`. The header of `canonical.ts` says so rather than implying general
compliance.

The difference matters at exactly the edges STP avoids:

| Case | JCS | Here |
|---|---|---|
| Key sort | By UTF-16 code unit | Same |
| Numbers | Specified serialisation (ES6 `Number::toString`) | Delegated to `JSON.stringify` |
| Floats, `NaN`, `±Infinity` | Specified / rejected | **Not used by STP.** Amounts are decimal *strings*, never floats — see below |
| Unicode escapes | Specified normalisation | Delegated to `JSON.stringify` |
| `undefined` | n/a | Dropped by `JSON.stringify`, as in any JS object |

**Why amounts are strings.** Every monetary value in an attestation is a
decimal string, never a JSON number. A float cannot represent stroop
quantities exactly, and a serialiser disagreeing about float formatting would
change the digest. Keeping amounts as strings sidesteps the entire class of
number-canonicalisation problems — which is also why the number cases above
are untested territory rather than a lurking bug.

**If STP ever carries a JSON number**, this rule needs tightening to a full
JCS implementation first. That is the trigger to watch for.

---

## Writing a verifier

1. Take the attestation body **without** its signature field.
2. Apply the rule above to get the canonical string.
3. UTF-8 encode it.
4. SHA-256 it — that digest is what every attestation carries, signed or not.
5. If a signature is present, verify it as Ed25519 over that digest using the
   published key.

The digest is reproducible with **no key at all**. An unsigned attestation is
still checkable for integrity: recompute the digest from the body and compare.
That is deliberate — signing is an added assurance about origin, not a
prerequisite for verifying content.

Reference implementation of the whole flow:
[`packages/stp/src/sign.ts`](../packages/stp/src/sign.ts).

---

## Related

- [MULTICHAIN.md](architecture/MULTICHAIN.md) — the STP schema and its evidence tiers
- [`packages/anchoring/SPEC.md`](../packages/anchoring/SPEC.md) — Merkle inclusion proofs, which hash the same way
- [TRUST.md](TRUST.md) — why a recomputable digest matters more than a signature
