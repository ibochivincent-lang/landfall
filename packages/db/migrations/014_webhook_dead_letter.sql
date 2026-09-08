-- ===========================================================
-- Landfall — make a failed webhook delivery replayable
--
-- webhook_deliveries recorded that a delivery failed, and how many attempts
-- it took to fail, but not *what was sent*. That made the row an epitaph
-- rather than a dead letter: enough to know a subscriber missed a
-- degradation event, not enough to ever hand them that event again.
--
-- Three attempts over roughly four seconds is a narrow window. A subscriber
-- restarting a process during it loses a notification permanently, and the
-- only recovery was to notice the gap and reconcile against the API by hand.
--
-- Two columns close it:
--
--   payload   — the exact object that was POSTed. A replay must resend the
--               original event, not a freshly rebuilt one: the account may
--               have changed state again since, and delivering current state
--               under an old event's timestamp would be a different lie from
--               the one we are fixing.
--
--   replay_of — self-reference. A replay is a NEW row pointing at the
--               delivery it retries, so the original failure is never
--               rewritten. The delivery history stays append-only, and
--               "this failed, then succeeded on replay" remains legible as
--               two facts rather than collapsing into one edited row.
--
-- payload is nullable because rows written before this migration genuinely
-- do not have one. Those are not replayable, and the replay script skips
-- them rather than inventing a payload to fit.
-- ===========================================================

BEGIN;

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS payload   JSONB,
  ADD COLUMN IF NOT EXISTS replay_of BIGINT REFERENCES webhook_deliveries(id) ON DELETE SET NULL;

-- The replay worker's query: failed, has a payload to resend, and has not
-- already been replayed successfully. Partial, because delivered rows are
-- the overwhelming majority and are never candidates.
CREATE INDEX IF NOT EXISTS webhook_deliveries_failed_idx
  ON webhook_deliveries (created_at DESC)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS webhook_deliveries_replay_of_idx
  ON webhook_deliveries (replay_of)
  WHERE replay_of IS NOT NULL;

COMMIT;
