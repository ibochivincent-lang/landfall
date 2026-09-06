-- ===========================================================
-- Landfall — fraud reports
--
-- Backs packages/fraud-reports. This table stores allegations by strangers
-- about named parties, which makes it the most legally loaded thing in this
-- schema. The constraints below are the design, not incidental hygiene:
--
--   evidence_tx_hash NOT NULL — a report with no on-chain evidence is
--   rejected at the API, never stored. Everything here cites a transaction
--   that was checked to exist and to involve the subject.
--
--   status has no 'confirmed' value. The strongest state is 'reviewed',
--   meaning a human read it and the evidence checked out — not that the
--   allegation is true. Nothing in this system can establish that, so no
--   column offers to record it.
--
--   dispute_note lives on the same row as the accusation, so a response
--   cannot end up somewhere a reader will never look.
--
--   UNIQUE (subject, evidence_tx_hash, reporter_ip_hash) stops the same
--   person filing the same transaction repeatedly to manufacture a count.
--   It is a speed bump, not identity — see the summary text in
--   packages/fraud-reports/src/validate.ts, which refuses to treat volume
--   as signal precisely because this cannot be enforced properly.
-- ===========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fraud_reports (
  id                BIGSERIAL PRIMARY KEY,
  subject           TEXT NOT NULL,
  evidence_tx_hash  TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN (
                      'did_not_receive', 'wrong_amount', 'impersonation',
                      'unauthorized_debit', 'other')),
  note              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'unreviewed' CHECK (status IN (
                      'unreviewed', 'reviewed', 'disputed', 'withdrawn', 'rejected')),
  -- Server clock only. A client-supplied timestamp on an accusation is a
  -- client-supplied fact about when someone was accused.
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reporter_ip_hash  TEXT,
  disputed_at       TIMESTAMPTZ,
  dispute_note      TEXT,
  UNIQUE (subject, evidence_tx_hash, reporter_ip_hash)
);

CREATE INDEX IF NOT EXISTS fraud_reports_subject_idx
  ON fraud_reports(subject, submitted_at DESC);

COMMIT;
