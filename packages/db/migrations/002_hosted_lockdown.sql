-- ===========================================================
-- Landfall — lock the schema down for hosted Postgres
--
-- Why this exists
-- ---------------
-- On a local Docker Postgres nothing here matters: the only role that can
-- reach port 5432 is the one in DATABASE_URL. On Supabase it matters a great
-- deal, and the failure mode is quiet.
--
-- Supabase puts PostgREST in front of the `public` schema and exposes it on
-- the internet, authenticated by the `anon` key — a key that is *designed* to
-- be published in a browser. Supabase also ships default privileges that
-- grant `anon` and `authenticated` full DML on new tables in `public`. Create
-- these tables with a plain migration and walk away, and anyone who views the
-- page source of any Supabase project on the same instance can issue
--
--     DELETE FROM payments;
--
-- over HTTPS. Row-level security is what stops that, and it is off by default
-- on tables created by raw SQL. So: RLS on everywhere, read-only policies
-- where public reads are wanted, and the grants revoked besides.
--
-- Landfall's data is public ledger data — exposure is not the risk. Mutation
-- is. Everything published rests on the claim that the dataset is a faithful
-- copy of the ledger, and a dataset a stranger can edit cannot carry it.
--
-- Written to be a harmless no-op on a plain Postgres that has never heard of
-- Supabase: every reference to the Supabase roles is guarded on the role
-- actually existing.
--
-- The application connects as the table owner, and an owner bypasses RLS
-- unless FORCE ROW LEVEL SECURITY is set. That is deliberate — the indexer
-- must still be able to write.
-- ===========================================================

BEGIN;

-- ---------- 1. RLS on every table ----------
--
-- Enabled with no policy means: deny all, for every role that is not the
-- owner. Read policies are added selectively below.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'schema_version','anchors','anchor_accounts','payments','ledger_events',
    'cursors','scans','account_metrics','asset_totals','refund_pairs',
    'attestations','oracle_publications'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- ---------- 2. Revoke the Supabase default grants ----------

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      -- And for anything a later migration creates.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ---------- 3. Grant reads back, deliberately ----------
--
-- Landfall's own API is the intended read path, because it is where the
-- caveats live: `asOf`, `staleHours`, the return-rate note. A raw PostgREST
-- query returns the number without the sentence that qualifies it, which is
-- exactly the kind of decontextualised statistic this project exists to
-- argue against.
--
-- So the direct read grant is opt-in. Uncomment the block below if you want
-- PostgREST reads as well as the API; leave it alone and `anon` can reach
-- nothing at all.
--
-- DO $$
-- DECLARE t text;
-- BEGIN
--   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
--     GRANT USAGE ON SCHEMA public TO anon;
--     FOREACH t IN ARRAY ARRAY['anchors','anchor_accounts','payments',
--                              'scans','account_metrics','asset_totals'] LOOP
--       IF to_regclass('public.' || t) IS NOT NULL THEN
--         EXECUTE format('GRANT SELECT ON public.%I TO anon', t);
--         EXECUTE format(
--           'CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (true)',
--           'read_' || t, t);
--       END IF;
--     END LOOP;
--   END IF;
-- END $$;

-- ---------- 4. Views inherit nothing; say so out loud ----------
--
-- A view runs with its definer's rights by default, so `current_accounts`
-- would happily bypass the RLS on account_metrics if it were ever granted to
-- anon. security_invoker makes the caller's own permissions apply.
-- Postgres 15+; skipped silently on 14 and below, where the grant above is
-- simply never made.

DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'ALTER VIEW public.latest_scan      SET (security_invoker = true)';
    EXECUTE 'ALTER VIEW public.current_accounts SET (security_invoker = true)';
  END IF;
END $$;

-- ---------- 5. Indexes the hosted read path needs ----------
--
-- Locally the tables are small enough that a sequential scan is invisible. On
-- a hosted instance the dashboard's keyset pagination (`WHERE id < $cursor
-- ORDER BY id DESC`) is the hottest query in the system and it must not scan.

CREATE INDEX IF NOT EXISTS payments_account_id_desc
  ON payments (from_account, id DESC);
CREATE INDEX IF NOT EXISTS payments_to_account_id_desc
  ON payments (to_account, id DESC);
CREATE INDEX IF NOT EXISTS payments_asset_id_desc
  ON payments (asset, id DESC);

INSERT INTO schema_version (version) VALUES (2) ON CONFLICT DO NOTHING;

COMMIT;
