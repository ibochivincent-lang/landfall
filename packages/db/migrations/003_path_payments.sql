-- Up
ALTER TABLE payments
  ADD COLUMN source_amount NUMERIC(30,7) NULL,
  ADD COLUMN source_asset TEXT NULL;

-- Down
-- ALTER TABLE payments
--  DROP COLUMN source_amount,
--  DROP COLUMN source_asset;
