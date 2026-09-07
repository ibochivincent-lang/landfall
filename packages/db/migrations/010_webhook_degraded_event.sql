-- ===========================================================
-- Landfall — make webhook subscriptions match the events that exist
--
-- user_webhooks.events defaulted to '{"anchor.dark","refund.spike"}'.
-- Neither has ever delivered anything:
--
--   * anchor.dark fires on a transition INTO the dark state. Across every
--     tracked account and a month of stored scans, zero such transitions
--     have been observed — every dark account was already dark the first
--     time it was seen (see /api/v1/trends.json). Meanwhile 15 live -> slow
--     degradations occurred and alerted nobody.
--
--   * refund.spike has no producer at all. Nothing in scripts/ or api/
--     emits it. It was subscribable and unimplemented.
--
-- scripts/dispatch-webhooks.mjs now emits anchor.degraded for any move to a
-- weaker state, keeping anchor.dark with its identical payload for the
-- specific case of reaching dark.
--
-- Existing rows are backfilled rather than left alone. Someone who
-- subscribed to anchor.dark asked to be told when an anchor stops settling;
-- the event they picked has never fired, and anchor.degraded is that same
-- request expressed as something that actually happens. Leaving them
-- subscribed only to a dead event would be honouring the letter of the
-- subscription while ignoring its point.
--
-- refund.spike is left in place, unfired. Removing it would silently drop a
-- subscription someone chose; it stays until there is either a producer for
-- it or a decision to retire it.
-- ===========================================================

BEGIN;

ALTER TABLE user_webhooks
  ALTER COLUMN events SET DEFAULT '{"anchor.dark","anchor.degraded"}';

-- Backfill: anyone subscribed to anchor.dark also wants anchor.degraded.
UPDATE user_webhooks
   SET events = array_append(events, 'anchor.degraded')
 WHERE 'anchor.dark' = ANY(events)
   AND NOT ('anchor.degraded' = ANY(events));

COMMIT;
