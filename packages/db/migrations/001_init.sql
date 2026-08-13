-- ===========================================================
-- Landfall — initial schema
--
-- Design notes that matter:
--
--   * Every amount is NUMERIC(30,7), never float. Stellar carries seven
--     decimal places and the indexer does its arithmetic in integer stroops;
--     the database must not undo that.
--   * Nothing here is derived-only. Raw payments and raw events are stored
--     verbatim so that every published figure can be recomputed from source
--     rather than trusted. If a metric and its inputs ever disagree, the
--     inputs win.
--   * Cursors live in the database, not on disk, so an interrupted indexer
--     resumes wherever it stopped. Degradation is stale, never wrong.
-- ===========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- anchors and their declared accounts ----------

CREATE TABLE IF NOT EXISTS anchors (
  domain          TEXT PRIMARY KEY,
  org_name        TEXT,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_resolved_at TIMESTAMPTZ,
  -- A domain that fails to resolve is a finding, not a gap. We keep the
  -- reason so the report can say why rather than silently omitting it.
  resolve_error   TEXT
);

CREATE TYPE account_role AS ENUM ('declared', 'issuer');

CREATE TABLE IF NOT EXISTS anchor_accounts (
  account_id     TEXT PRIMARY KEY CHECK (account_id ~ '^G[A-Z2-7]{55}$'),
  domain         TEXT NOT NULL REFERENCES anchors(domain) ON DELETE CASCADE,
  role           account_role NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lifetime liveness, read OUTSIDE any analysis window. An account dormant
  -- since before the window still has a real last-activity date; conflating
  -- the two once hid the most dormant account in the whole set.
  last_activity_at TIMESTAMPTZ,
  has_lifetime_activity BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS anchor_accounts_domain_idx ON anchor_accounts(domain);
CREATE INDEX IF NOT EXISTS anchor_accounts_activity_idx ON anchor_accounts(last_activity_at DESC NULLS LAST);

-- ---------- raw ledger data ----------

-- Where a row came from. REST is the Horizon /payments endpoint; CAP-67 is
-- the unified event stream, where classic payments now emit transfer / mint /
-- burn alongside contract events.
CREATE TYPE record_source AS ENUM ('horizon_rest', 'cap67_event');

CREATE TABLE IF NOT EXISTS payments (
  id             BIGSERIAL PRIMARY KEY,
  paging_token   TEXT NOT NULL,
  tx_hash        TEXT NOT NULL,
  op_type        TEXT NOT NULL,
  from_account   TEXT NOT NULL,
  to_account     TEXT NOT NULL,
  amount         NUMERIC(30,7) NOT NULL CHECK (amount >= 0),
  asset          TEXT NOT NULL,          -- 'native' or 'CODE:ISSUER'
  memo           TEXT,                   -- SEP-24 leg correlation lives here
  memo_type      TEXT,
  ledger_seq     BIGINT,
  created_at     TIMESTAMPTZ NOT NULL,
  source         record_source NOT NULL DEFAULT 'horizon_rest',
  is_dust        BOOLEAN NOT NULL DEFAULT false,
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (paging_token, source)
);
CREATE INDEX IF NOT EXISTS payments_to_idx      ON payments(to_account, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_from_idx    ON payments(from_account, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_created_idx ON payments(created_at DESC);
CREATE INDEX IF NOT EXISTS payments_memo_idx    ON payments(memo) WHERE memo IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_asset_idx   ON payments(asset);

-- CAP-67 unified asset events. Topics are standardised across classic
-- operations and Soroban contracts, which is what lets one stream cover both.
CREATE TYPE cap67_topic AS ENUM ('transfer', 'mint', 'burn', 'clawback', 'fee', 'set_authorized');

CREATE TABLE IF NOT EXISTS ledger_events (
  id            BIGSERIAL PRIMARY KEY,
  ledger_seq    BIGINT NOT NULL,
  tx_hash       TEXT NOT NULL,
  event_index   INTEGER NOT NULL,
  topic         cap67_topic NOT NULL,
  contract_id   TEXT,                    -- null for classic-operation events
  from_account  TEXT,
  to_account    TEXT,
  asset         TEXT,                    -- SEP-0011 canonical form
  amount        NUMERIC(30,7),
  authorize     BOOLEAN,                 -- set_authorized only
  to_muxed_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, event_index)
);
CREATE INDEX IF NOT EXISTS ledger_events_topic_idx  ON ledger_events(topic, created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_events_ledger_idx ON ledger_events(ledger_seq DESC);
CREATE INDEX IF NOT EXISTS ledger_events_to_idx     ON ledger_events(to_account, created_at DESC);

-- ---------- resume state ----------

CREATE TABLE IF NOT EXISTS cursors (
  stream        TEXT NOT NULL,           -- 'payments' | 'events'
  key           TEXT NOT NULL,           -- account id, or 'global' for events
  cursor        TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stream, key)
);

-- ---------- scans and computed metrics ----------

CREATE TABLE IF NOT EXISTS scans (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  horizon_url   TEXT NOT NULL,
  options       JSONB NOT NULL,
  accounts_seen INTEGER,
  notes         TEXT
);

CREATE TYPE liveness AS ENUM ('live', 'slow', 'dark', 'no_activity');

CREATE TABLE IF NOT EXISTS account_metrics (
  scan_id           BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  account_id        TEXT   NOT NULL REFERENCES anchor_accounts(account_id) ON DELETE CASCADE,
  sampled           INTEGER NOT NULL,
  dust_excluded     INTEGER NOT NULL DEFAULT 0,
  window_start      TIMESTAMPTZ,
  window_end        TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ,
  hours_since_activity NUMERIC(12,2),
  state             liveness NOT NULL,
  inbound_count     INTEGER NOT NULL DEFAULT 0,
  outbound_count    INTEGER NOT NULL DEFAULT 0,
  inbound_counterparties  INTEGER NOT NULL DEFAULT 0,
  outbound_counterparties INTEGER NOT NULL DEFAULT 0,
  refund_count      INTEGER NOT NULL DEFAULT 0,
  -- NULL rather than 0 when there is no inbound traffic. A rate over nothing
  -- is not zero, it is unknown, and the difference has to survive to the API.
  refund_rate       NUMERIC(8,6),
  median_refund_hours NUMERIC(12,2),
  top_counterparty_share NUMERIC(6,4),
  PRIMARY KEY (scan_id, account_id)
);
CREATE INDEX IF NOT EXISTS account_metrics_state_idx ON account_metrics(scan_id, state);

CREATE TABLE IF NOT EXISTS asset_totals (
  scan_id     BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  account_id  TEXT   NOT NULL,
  direction   TEXT   NOT NULL CHECK (direction IN ('inbound','outbound')),
  asset       TEXT   NOT NULL,
  count       INTEGER NOT NULL,
  volume      NUMERIC(30,7) NOT NULL,
  PRIMARY KEY (scan_id, account_id, direction, asset)
);

-- How confident we are that an outbound payment really is a return of a
-- specific inbound one. 'memo' means the SEP-24 memo tied the two legs
-- together; 'heuristic' means we inferred it from counterparty, asset,
-- amount tolerance and time window, and could be wrong in both directions.
CREATE TYPE match_confidence AS ENUM ('memo', 'heuristic');

CREATE TABLE IF NOT EXISTS refund_pairs (
  id            BIGSERIAL PRIMARY KEY,
  scan_id       BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  account_id    TEXT   NOT NULL,
  counterparty  TEXT   NOT NULL,
  asset         TEXT   NOT NULL,
  in_amount     NUMERIC(30,7) NOT NULL,
  out_amount    NUMERIC(30,7) NOT NULL,
  in_at         TIMESTAMPTZ NOT NULL,
  out_at        TIMESTAMPTZ NOT NULL,
  latency_hours NUMERIC(12,2) NOT NULL,
  in_tx_hash    TEXT NOT NULL,
  out_tx_hash   TEXT NOT NULL,
  confidence    match_confidence NOT NULL DEFAULT 'heuristic',
  is_partial    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS refund_pairs_scan_idx ON refund_pairs(scan_id, account_id);

-- ---------- layer 2: attested settlement ----------

-- The fiat leg is invisible on-chain, so it has to be attested. Every receipt
-- is bound to a real on-chain transaction and signed by the key that made it,
-- which is what makes spamming attestations cost actual money.
CREATE TABLE IF NOT EXISTS attestations (
  id             BIGSERIAL PRIMARY KEY,
  quote_id       TEXT,                       -- SEP-38 quote reference
  stellar_tx     TEXT NOT NULL,
  signer         TEXT NOT NULL CHECK (signer ~ '^G[A-Z2-7]{55}$'),
  anchor_domain  TEXT REFERENCES anchors(domain) ON DELETE SET NULL,
  quoted_amount  NUMERIC(30,7),
  landed_amount  NUMERIC(30,7),
  quote_asset    TEXT,
  landed_asset   TEXT,
  landed_at      TIMESTAMPTZ,
  signature      TEXT NOT NULL,
  -- false until the signature is checked against the referenced transaction.
  -- Unverified receipts must never reach a published figure.
  verified       BOOLEAN NOT NULL DEFAULT false,
  verified_at    TIMESTAMPTZ,
  reject_reason  TEXT,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stellar_tx, signer)
);
CREATE INDEX IF NOT EXISTS attestations_verified_idx ON attestations(verified, anchor_domain);

-- ---------- layer 3: on-chain oracle ----------

CREATE TABLE IF NOT EXISTS oracle_publications (
  id            BIGSERIAL PRIMARY KEY,
  scan_id       BIGINT REFERENCES scans(id) ON DELETE SET NULL,
  digest        TEXT NOT NULL,              -- sha256 of the published dataset
  ledger_seq    BIGINT,
  tx_hash       TEXT,
  contract_id   TEXT,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (digest)
);

-- ---------- convenience view for the API ----------

CREATE OR REPLACE VIEW latest_scan AS
  SELECT * FROM scans WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1;

CREATE OR REPLACE VIEW current_accounts AS
  SELECT
    m.*,
    a.domain,
    a.role,
    an.org_name
  FROM account_metrics m
  JOIN anchor_accounts a  ON a.account_id = m.account_id
  JOIN anchors        an  ON an.domain    = a.domain
  WHERE m.scan_id = (SELECT id FROM latest_scan);

INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;

COMMIT;
