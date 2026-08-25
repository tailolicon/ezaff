-- Rebuild products_fts with unicode61 diacritic folding for Vietnamese search.
-- Also re-create sync triggers so FTS stays correct on INSERT / UPDATE / DELETE.
-- Do not edit 001_init.sql — this migration is additive for existing DBs.

PRAGMA foreign_keys = ON;

DROP TRIGGER IF EXISTS products_ai;
DROP TRIGGER IF EXISTS products_ad;
DROP TRIGGER IF EXISTS products_au;
DROP TABLE IF EXISTS products_fts;

CREATE VIRTUAL TABLE products_fts USING fts5(
  title,
  note,
  shop_name,
  category,
  content='products',
  content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Populate from existing products (external-content FTS5 rebuild).
INSERT INTO products_fts(products_fts) VALUES('rebuild');

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
