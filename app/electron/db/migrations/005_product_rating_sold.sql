-- Phase: product social proof from share-preview JSON-LD
-- rating = star average (e.g. 4.89); rating_count = number of reviews;
-- sold = units sold when available (often null while product API is anti-bot).

ALTER TABLE products ADD COLUMN rating REAL;
ALTER TABLE products ADD COLUMN rating_count INTEGER;
ALTER TABLE products ADD COLUMN sold INTEGER;

ALTER TABLE product_lookup_cache ADD COLUMN rating REAL;
ALTER TABLE product_lookup_cache ADD COLUMN rating_count INTEGER;
ALTER TABLE product_lookup_cache ADD COLUMN sold INTEGER;
