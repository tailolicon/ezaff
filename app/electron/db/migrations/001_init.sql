-- ezaff v1 initial schema
-- Source of truth: plan/current_plan.md section 2

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY NOT NULL,
  platform TEXT NOT NULL,
  original_url TEXT NOT NULL,
  canonical_key TEXT NOT NULL UNIQUE,
  item_id TEXT,
  shop_id TEXT,
  title TEXT,
  image_url TEXT,
  image_local TEXT,
  price INTEGER,
  currency TEXT NOT NULL DEFAULT 'VND',
  category TEXT,
  shop_name TEXT,
  note TEXT,
  scrape_status TEXT,
  scrape_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS product_groups (
  product_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY (product_id, group_id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS copy_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT,
  template_id TEXT,
  used_owner INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS owner_link_cache (
  canonical_key TEXT PRIMARY KEY NOT NULL,
  owner_url TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- FTS5 virtual table over products (title, note, shop_name, category)
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  title,
  note,
  shop_name,
  category,
  content='products',
  content_rowid='rowid'
);

-- Keep FTS5 in sync with products
CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, title, note, shop_name, category)
  VALUES (new.rowid, new.title, new.note, new.shop_name, new.category);
END;

CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, title, note, shop_name, category)
  VALUES ('delete', old.rowid, old.title, old.note, old.shop_name, old.category);
END;

CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, title, note, shop_name, category)
  VALUES ('delete', old.rowid, old.title, old.note, old.shop_name, old.category);
  INSERT INTO products_fts(rowid, title, note, shop_name, category)
  VALUES (new.rowid, new.title, new.note, new.shop_name, new.category);
END;

CREATE INDEX IF NOT EXISTS idx_products_platform ON products(platform);
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at);
CREATE INDEX IF NOT EXISTS idx_copy_events_created_at ON copy_events(created_at);
CREATE INDEX IF NOT EXISTS idx_product_groups_group_id ON product_groups(group_id);
