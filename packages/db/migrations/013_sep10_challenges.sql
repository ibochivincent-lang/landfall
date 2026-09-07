-- ===========================================================
-- Landfall — SEP-10 challenge single-use ledger
--
-- Records every challenge nonce that has been redeemed for a token, so it
-- can never be redeemed twice.
--
-- Without this, a signed challenge is a bearer credential for its entire
-- 15-minute validity window: anyone who captures one — from a log, a
-- reverse proxy, a shared machine, a browser history — can replay it for as
-- many tokens as they want, and the account holder has no way to tell. The
-- signature proves control of the account at the moment of signing; it does
-- not, on its own, prove that the person presenting it is that holder.
--
-- The UNIQUE constraint on nonce IS the mechanism. The insert is the check:
-- a conflict means this challenge was already spent, and the request is
-- refused. Doing it as a constraint rather than a SELECT-then-INSERT is what
-- makes it safe against two requests racing with the same captured
-- challenge — the database decides, not the application.
--
-- expires_at exists only so spent nonces can be swept. A row is worthless
-- once the challenge it records could no longer have been accepted anyway.
-- ===========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS sep10_challenges (
  nonce       TEXT PRIMARY KEY,
  account     TEXT NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sep10_challenges_expiry_idx
  ON sep10_challenges(expires_at);

COMMIT;
