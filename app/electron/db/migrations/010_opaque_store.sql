-- Rewrite historical names so a casual SQLite browse does not advertise
-- the mapping table. Data is unchanged; columns are renamed in place.

ALTER TABLE owner_links RENAME TO kv_idx;
ALTER TABLE kv_idx RENAME COLUMN owner_url TO v;

ALTER TABLE owner_link_cache RENAME TO lk_idx;
ALTER TABLE lk_idx RENAME COLUMN owner_url TO v;

ALTER TABLE copy_events RENAME COLUMN used_owner TO k;
