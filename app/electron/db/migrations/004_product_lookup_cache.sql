-- Phase 12: local product lookup cache (by canonical_key).
-- Re-pasting / re-scraping the same product is instant; no Shopee hit when fresh.
CREATE TABLE IF NOT EXISTS product_lookup_cache (
  canonical_key TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  image_url TEXT,
  price INTEGER,
  currency TEXT NOT NULL DEFAULT 'VND',
  category TEXT,
  shop_name TEXT,
  shop_id TEXT,
  item_id TEXT,
  description TEXT,
  source TEXT,
  scraped_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_lookup_cache_expires
  ON product_lookup_cache(expires_at);
