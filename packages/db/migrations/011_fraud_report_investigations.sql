-- ===========================================================
-- Landfall — fraud report investigations
--
-- Backs packages/investigator, the "Analyzed" stage of Sentinel
-- (Reported -> Observed -> Analyzed -> Reviewed -> Attested). One row per
-- report, holding two strictly separate things:
--
--   cited_facts, relevant_signals — deterministic, computed with no AI,
--   from the report's own fields, the cited transaction, and the subject's
--   existing Trust Check flags. Always present once an investigation runs.
--
--   narrative, narrative_model — an optional AI-written summary of exactly
--   those cited facts, explicitly labeled with the model that wrote it.
--   Both are NULL whenever no model is configured at investigation time —
--   the same degrade-gracefully shape packages/stp uses for an unsigned
--   digest. A NULL narrative is not an error state; it is the honest
--   answer when there is no model to ask.
--
--   report_id UNIQUE — an investigation is re-run in place (upsert), not
--   accumulated, so a stale narrative from before a dispute was filed
--   cannot sit next to a newer one and confuse a reader about which is
--   current.
-- ===========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fraud_report_investigations (
  id                BIGSERIAL PRIMARY KEY,
  report_id         BIGINT NOT NULL REFERENCES fraud_reports(id) ON DELETE CASCADE,
  cited_facts       JSONB NOT NULL,
  relevant_signals  JSONB NOT NULL,
  narrative         TEXT,
  narrative_model   TEXT,
  investigated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report_id)
);

COMMIT;
