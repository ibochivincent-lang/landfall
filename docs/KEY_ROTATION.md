# Key rotation

What to do when a key is compromised, suspected, or simply due for a change.
Each secret below has a different blast radius and a different procedure, and
the differences are the point — treating them all the same is how a routine
rotation turns into an outage or a leaked key stays live.

The current holdings are tabulated in [TRUST.md](TRUST.md#keys-and-secrets).

---

## First: decide whether this is an incident

| Signal | Treat as |
|---|---|
| A key appeared in a log, a screenshot, a chat, or a public commit | **Compromised.** Rotate now; assume it was read |
| A laptop or CI runner with access was lost or breached | **Compromised** |
| An `AdminChanged` or `PublisherChanged` event fired that you did not initiate | **Compromised, and already used.** Go to [oracle admin](#oracle-admin-key) immediately |
| Scheduled hygiene, staff change, nothing observed | **Routine.** Same steps, no urgency |

A key pasted into a chat window is compromised even if the window was
private, and even if it was deleted. Rotate it.

---

## Oracle publisher key

**Blast radius: bounded, on purpose.** This is the hourly key CI holds. It can
write scores and digests. It **cannot** call `set_admin` or `set_publisher`,
so a leak cannot cost you the contract — that is what the
[role split](../packages/contracts/landfall-oracle/src/lib.rs) exists for.
Bad scores written with it are visible in the event stream, recomputable from
Horizon, and reversible by writing correct ones.

Rotation needs **no downtime** and does not touch the admin key.

1. **Generate the replacement.**

   ```bash
   stellar keys generate landfall-publisher-2 --network testnet
   ```

2. **Point the contract at it**, signing with the *admin* key. This is the one
   step that requires admin authority, and it is why the admin exists:

   ```bash
   stellar contract invoke --id $ORACLE_CONTRACT_ID --source-account $ADMIN_IDENTITY --network testnet -- set_publisher --new_publisher $(stellar keys address landfall-publisher-2)
   ```

3. **Confirm the swap took**, before changing anything in CI:

   ```bash
   stellar contract invoke --id $ORACLE_CONTRACT_ID --network testnet -- publisher
   ```

4. **Replace `ORACLE_ADMIN_SECRET`** in GitHub Actions secrets with the new
   key's secret. (The variable name predates the split; it holds the
   *publisher* secret.)

5. **Watch one hourly run** complete and emit `Published`.

6. **Destroy the old key.** It is already powerless — step 2 revoked it — but
   leaving a dead secret in a vault invites someone to try it later:

   ```bash
   stellar keys rm landfall-publisher
   ```

**Order matters.** Rotate the contract first, CI second. Reversed, CI signs
with a key the contract no longer accepts and every publish fails until you
notice.

---

## Oracle admin key

**Blast radius: total.** This key can hand the contract to anyone.
`AdminChanged` is emitted on every handover, so a takeover is publicly
visible — but nothing currently watches for it, which is stated plainly in
[TRUST.md](TRUST.md).

**If you suspect this key is compromised, act before reading further.**
Transfer admin to a key you control, immediately, then rotate the publisher
as well on the assumption the attacker saw both.

```bash
stellar contract invoke --id $ORACLE_CONTRACT_ID --source-account $ADMIN_IDENTITY --network testnet -- set_admin --new_admin $NEW_ADMIN_ADDRESS
```

For routine rotation, the same call suffices — but the better move is not to
rotate a single hot key repeatedly. It is to make the admin an account that
does not need rotating:

- The admin never signs on a schedule, so **multisig costs nothing
  operationally** here. This is why the role split was worth doing.
- Add the signer **first**, raise the threshold **second**. Reversed, you get
  an account requiring two signatures with one signer, which is not
  recoverable.
- `require_auth()` checks the account's **medium** threshold, so that is the
  one that governs. Low and high are set alongside it only so no operation is
  left with a weaker bar.

```bash
stellar tx new set-options --source-account $ADMIN_IDENTITY --signer $SECOND_SIGNER --signer-weight 1 --network testnet
stellar tx new set-options --source-account $ADMIN_IDENTITY --master-weight 1 --low-threshold 2 --med-threshold 2 --high-threshold 2 --network testnet
```

Verify before trusting it, and **test the whole thing on testnet first** — a
wrong threshold on mainnet is unrecoverable.

---

## `STP_SIGNING_KEY`

**Blast radius: attestations only.** Signs Landfall's attestations. It cannot
alter any ledger-derived figure, because those are recomputed from Horizon
rather than read from an attestation.

1. Generate a new Ed25519 keypair.
2. Publish the new public key wherever the old one is documented, **before**
   switching, so verifiers can accept both across the change.
3. Replace the secret in the GitHub Actions secret store.
4. Leave the old public key published, marked with the date it stopped
   signing. Attestations signed before that date remain verifiable — deleting
   the key silently invalidates history that was true when it was made.

Note that every attestation carries a SHA-256 digest of its canonical form
regardless, so an unsigned or stale-key attestation is still checkable against
its own body.

---

## `OPENROUTER_API_KEY`

**Blast radius: spend, and nothing else.** It generates narrative text. It
cannot alter cited facts, which are computed with no model involved.

Revoke at the provider, issue a new key, replace it in the Vercel environment,
and redeploy. Vercel environment variables only reach deployments created
*after* they are set — an existing deployment keeps the old value until it is
rebuilt.

If it is simply removed, the Investigator degrades to a `null` narrative and
the cited facts still compute. That is the designed behaviour, not an outage.

---

## `DATABASE_URL`

**Blast radius: the application database** — portal users, hashed API keys,
fraud reports and disputes. Not the observation record, which is committed to
the repository.

Rotate the password in Supabase, then update it in **both** the GitHub Actions
secret and the Vercel environment. Missing one leaves either the hourly scan
or the API pointing at a dead credential, and the two fail differently: the
scan goes quiet, while the API returns 503 on every route that needs the
database.

---

## Portal API keys (`lf_live_…`)

Held by users, hashed at rest, revocable by the user in the portal. No
operator action is required to rotate one. If the hash table itself were
exposed, invalidate all of them and require reissue rather than reasoning
about which were reachable.

---

## After any rotation

- Note it in [CHANGELOG.md](../CHANGELOG.md) under **Security** if it followed
  a compromise. A rotation nobody recorded is one nobody can audit later.
- Check the old credential is actually dead, rather than assuming the swap
  revoked it.
- If the rotation followed a leak in a public place, treat the exposure window
  as everything from first publication to revocation, not from when you
  noticed.
