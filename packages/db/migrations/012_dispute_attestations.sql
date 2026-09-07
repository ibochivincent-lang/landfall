-- ===========================================================
-- Landfall — dispute-response attestations
--
-- Sentinel's "Attested" stage, built for the accused rather than the
-- accuser. See packages/fraud-reports/src/attest.ts for the reasoning; the
-- short version is that signing an accusation would make the claim portable
-- while leaving its safeguards — the disclaimer, the attached response, the
-- "counts are never a verdict" rule — behind in the API payload. So only the
-- response is signed.
--
--   body — the exact canonical payload the signature covers. It carries the
--   responder's own words, the report row id, and proof that control of the
--   account was demonstrated. It deliberately carries no category, no
--   reporter note, and no evidence hash, so a copy of this row cannot be
--   used to spread the allegation it answers.
--
--   sig NULL is a normal state, not a failure. Without STP_SIGNING_KEY the
--   attestation ships with its digest and unsigned, the same convention
--   settlement attestations already use (packages/sdk/src/attest.ts) — an
--   unsigned digest anyone can recompute is honest, a manufactured signature
--   is not.
--
--   report_id UNIQUE — a report takes one response (enforced already by the
--   dispute route's disputed_at guard), so it takes one attestation.
-- ===========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS dispute_attestations (
  id           BIGSERIAL PRIMARY KEY,
  report_id    BIGINT NOT NULL REFERENCES fraud_reports(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  body         JSONB NOT NULL,
  -- SHA-256 of the canonical serialization of body. Recomputable by anyone
  -- holding the body alone, with or without a key.
  digest       TEXT NOT NULL,
  sig          TEXT,
  signer       TEXT NOT NULL,
  attested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report_id)
);

CREATE INDEX IF NOT EXISTS dispute_attestations_subject_idx
  ON dispute_attestations(subject, attested_at DESC);

COMMIT;
