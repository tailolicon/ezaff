-- Tracks the daily "which products does the bundle not cover" report.
--
-- Separate from bundle_state because the two run on their own clocks: a sync
-- can succeed while the report fails, and neither should reset the other.

CREATE TABLE IF NOT EXISTS want_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  reported_at  INTEGER,
  reported_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO want_state (id, reported_at, reported_count)
VALUES (1, NULL, 0);
