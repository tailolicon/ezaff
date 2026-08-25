-- Owner-link bundle: the whole author-link table, synced from the Worker and
-- answered locally.
--
-- Replaces the per-product worker lookup that ran on every add. At a few
-- thousand users with a few thousand links each that was millions of requests;
-- one daily bundle sync makes it one request per user per day and every copy
-- resolves without touching the network.
--
-- Stored in plaintext, unlike owner_link_cache: the bundle is handed to every
-- client from a public endpoint, so sealing rows locally would cost CPU on
-- 130k inserts while protecting nothing that is not already public.

CREATE TABLE IF NOT EXISTS owner_links (
  -- Matches products.canonical_key exactly: "<platform>:<shopId>:<itemId>".
  canonical_key TEXT PRIMARY KEY,
  owner_url     TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS bundle_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  -- Last version applied. Sent as ?since= so the Worker can answer with a delta.
  version     INTEGER NOT NULL DEFAULT 0,
  synced_at   INTEGER,
  entry_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO bundle_state (id, version, synced_at, entry_count)
VALUES (1, 0, NULL, 0);
