-- Security/readiness hardening: rate limiting, webhook delivery audit.
--
-- Closes gaps documented in docs/gaps.md's "14 August 2026" entries:
-- no rate limiting, webhooks that never fire. (The forgot-password
-- token-leak and the contact form were both already fixed on main by the
-- time this landed — see docs/gaps.md — so this migration only adds what
-- was still missing.)

-- Fixed 60-second-window request counter. One row per (bucket, minute).
-- Shared by: per-IP auth-endpoint throttling (bucket = 'auth:<route>:<ip>'),
-- per-API-key elevated limits (bucket = 'apikey:<id>'), and anonymous public
-- read throttling (bucket = 'anon:<ip>'). Self-prunes opportunistically from
-- the application code rather than needing a cron job — see rateLimit() in
-- api/[...path].js.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key   TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket_key, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_counters_window_idx
  ON rate_limit_counters(window_start);

-- Audit trail for outbound webhook deliveries, so "nothing tells anyone the
-- dispatcher stopped" (the same complaint docs/gaps.md makes about scan
-- staleness) doesn't become true of this feature too. Read by the admin
-- board's health view.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              BIGSERIAL PRIMARY KEY,
  webhook_id      INTEGER NOT NULL REFERENCES user_webhooks(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  account_id      TEXT,
  domain          TEXT,
  status          TEXT NOT NULL CHECK (status IN ('delivered', 'failed')),
  attempts        INTEGER NOT NULL,
  response_status INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx
  ON webhook_deliveries(webhook_id, created_at DESC);

INSERT INTO schema_version (version) VALUES (7) ON CONFLICT DO NOTHING;
