-- Expand country denylist + store geo-block reason (admin logs / owner PM).
ALTER TABLE channels
  MODIFY COLUMN geo_block_countries TEXT NULL,
  ADD COLUMN geo_block_reason VARCHAR(500) NULL AFTER geo_block_countries,
  ADD COLUMN geo_block_show_reason TINYINT(1) NOT NULL DEFAULT 0 AFTER geo_block_reason;

ALTER TABLE records
  MODIFY COLUMN geo_block_countries TEXT NULL,
  ADD COLUMN geo_block_reason VARCHAR(500) NULL AFTER geo_block_countries,
  ADD COLUMN geo_block_show_reason TINYINT(1) NOT NULL DEFAULT 0 AFTER geo_block_reason;
