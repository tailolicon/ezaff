-- Product metadata synced from the Worker: name, shop, price, sold, rating,
-- commission.
--
-- What it is for: adding a link currently means scraping Shopee for these
-- fields — the slowest and most fragile step in the app, paced at over a
-- second per product and liable to hit an anti-bot wall. For any product the
-- harvest already covers, this table answers instantly with no network.
--
-- It does NOT replace the scraper. Products listed after the last harvest are
-- not here, and neither are images; both still go through the scraper.

CREATE TABLE IF NOT EXISTS product_meta (
  -- Matches products.canonical_key: "<platform>:<shopId>:<itemId>".
  canonical_key   TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  shop_name       TEXT NOT NULL DEFAULT '',
  price_vnd       INTEGER NOT NULL DEFAULT 0,
  historical_sold INTEGER NOT NULL DEFAULT 0,
  rating          INTEGER NOT NULL DEFAULT 0,
  commission_pct  INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  version     INTEGER NOT NULL DEFAULT 0,
  synced_at   INTEGER,
  entry_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO meta_state (id, version, synced_at, entry_count)
VALUES (1, 0, NULL, 0);
