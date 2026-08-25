-- Full marketplace category chain, e.g.
--   "Điện Thoại & Phụ Kiện > Phụ kiện điện thoại > Pin dự phòng > Trên 20.000 mAh"
--
-- `category` keeps the short leaf used for chips; `category_path` keeps every
-- level so the library can be split by category properly.

ALTER TABLE products ADD COLUMN category_path TEXT;

ALTER TABLE product_lookup_cache ADD COLUMN category_path TEXT;

CREATE INDEX IF NOT EXISTS idx_products_category_path
  ON products(category_path);
