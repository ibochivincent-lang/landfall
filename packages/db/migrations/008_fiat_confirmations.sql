-- ===========================================================
-- Landfall — recipient fiat-leg confirmations
--
-- Backs the recipient-confirmation binder in
-- packages/adapters/src/fiatConfirmation.ts: the weakest of three ways to
-- turn a bare DERIVED-tier transfer (Tron, Solana) into evidence that the
-- fiat leg it triggers actually landed. See
-- docs/architecture/FIAT_CONFIRMATION.md for the full reasoning — this
-- table exists to enforce, at the storage layer, the one thing the
-- application logic cannot enforce on its own: that each on-chain transfer
-- can be confirmed exactly once.
--
-- UNIQUE(chain, reference) is the load-bearing line. Without it, a second
-- submission for the same transfer could overwrite a truthful "not
-- received" with a false "received" — the exact tampering this scheme's
-- honesty depends on not being possible. First submission wins, permanently;
-- there is no update path, by design, not by omission.
-- ===========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fiat_confirmations (
  id                BIGSERIAL PRIMARY KEY,
  chain             TEXT NOT NULL,
  reference         TEXT NOT NULL,
  respondent        TEXT NOT NULL CHECK (respondent IN ('recipient', 'sender')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('received', 'not_received', 'partial')),
  reported_amount   TEXT,
  reported_currency TEXT,
  note              TEXT,
  -- Set from the request handler's own clock (now()), never from the
  -- request body — see evaluateConfirmation's "too-early"/"too-late" checks,
  -- which only mean anything if this timestamp cannot be supplied by the
  -- same party being evaluated.
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_ip_hash TEXT,
  UNIQUE (chain, reference)
);

CREATE INDEX IF NOT EXISTS fiat_confirmations_chain_ref_idx
  ON fiat_confirmations(chain, reference);

COMMIT;
