-- ===========================================================
-- Landfall — admin authentication and anchor management
--
-- Backs the developer/admin board: real accounts with hashed passwords,
-- server-side sessions that can be revoked, and a DB-editable anchor list
-- that the indexer actually reads (see loadDomains() in
-- packages/indexer/src/cli.ts) — an admin panel that edits a table nobody
-- consults is exactly the kind of claim this project exists to catch other
-- people making.
--
-- Design notes:
--
--   * No plaintext or reversibly-encrypted passwords. `password_hash` stores
--     `scrypt$<salt-hex>$<hash-hex>`, computed with Node's built-in
--     node:crypto (no new dependency for something security-critical).
--   * Sessions are server-side and revocable — logout actually deletes the
--     row, unlike a stateless signed cookie a server can't invalidate.
--   * The session token itself is never stored: only its SHA-256 hash. A
--     leaked database dump should not hand out live sessions.
--   * RLS is enabled for the same reason migration 002 enabled it everywhere
--     else: the app connects as the table owner and bypasses RLS deliberately,
--     but a hosted Postgres front-end (PostgREST/anon) must never be able to
--     read a password hash or forge a session, so no policy is added for it.
-- ===========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_users (
  id             BIGSERIAL PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE CHECK (username = lower(username)),
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash     TEXT PRIMARY KEY,             -- sha256(token), hex
  user_id        BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  user_agent     TEXT
);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions(expires_at);

-- Admin-managed additions to the scanned domain list. The seed list in
-- packages/indexer/data/anchors.json still ships in git and still works; this
-- table is *additional* domains added through the admin board without a
-- redeploy, and removals (active = false) that suppress a seed-list domain
-- without editing the file.
CREATE TABLE IF NOT EXISTS tracked_anchors (
  domain      TEXT PRIMARY KEY,
  active      BOOLEAN NOT NULL DEFAULT true,
  added_by    TEXT,                 -- admin_users.username at time of add
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_users','admin_sessions','tracked_anchors'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

INSERT INTO schema_version (version) VALUES (3) ON CONFLICT DO NOTHING;

COMMIT;
