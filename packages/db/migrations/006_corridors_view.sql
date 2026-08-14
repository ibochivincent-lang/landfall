-- ===========================================================
-- Landfall — corridors view
--
-- Fixes a real gap found while building the GraphQL API: GET /api/v1/corridors
-- and corridorRows() in api/[...path].js query a `corridors` table that was
-- never created by any migration and is never written by the indexer. On a
-- correctly-migrated database (this one included, before this file) the
-- route throws "relation \"corridors\" does not exist" — a live bug behind
-- a README row that reads "Settlement corridors API + dashboard: shipping".
--
-- 003_path_payments.sql already added `source_amount` / `source_asset` to
-- `payments` for exactly this purpose. A corridor is nothing but a payment
-- whose source asset differs from its destination asset, grouped by that
-- pair — that's a VIEW over existing data, not a new table needing a
-- background job to keep in sync. If `source_asset` is ever populated
-- for a row, it shows up here on the next query, no scan or migration
-- required.
-- ===========================================================

BEGIN;

CREATE OR REPLACE VIEW corridors AS
  SELECT
    source_asset AS from_asset,
    asset         AS to_asset,
    COUNT(*)::int AS count,
    SUM(amount)   AS volume,
    MIN(created_at) AS first_seen,
    MAX(created_at) AS last_seen
  FROM payments
  WHERE source_asset IS NOT NULL
    AND source_asset <> asset
  GROUP BY source_asset, asset;

-- Same reasoning as 002_hosted_lockdown.sql section 4: a view runs with its
-- definer's rights by default, which would let this view read past RLS on
-- `payments` if it were ever granted to anon. The app connects as the table
-- owner today so this is defense in depth, not a live gap - but it is the
-- established convention for every view in this schema, so this one follows
-- it too rather than being the one exception nobody remembers why.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'ALTER VIEW public.corridors SET (security_invoker = true)';
  END IF;
END $$;

INSERT INTO schema_version (version) VALUES (6) ON CONFLICT DO NOTHING;

COMMIT;
