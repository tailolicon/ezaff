-- Indexes for copy_events aggregates and "most used" product sort.
-- Do not edit 001/002 — additive only for existing DBs.

PRAGMA foreign_keys = ON;

-- Speeds correlated COUNT(*) per product (listProducts sort = most_used).
CREATE INDEX IF NOT EXISTS idx_copy_events_product_id ON copy_events(product_id);

-- Speeds GROUP BY reason breakdown on the transparency counter page.
CREATE INDEX IF NOT EXISTS idx_copy_events_reason ON copy_events(reason);
