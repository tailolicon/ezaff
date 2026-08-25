import migration001 from './migrations/001_init.sql?raw'
import migration002 from './migrations/002_fts_diacritics.sql?raw'
import migration003 from './migrations/003_copy_events_indexes.sql?raw'
import migration004 from './migrations/004_product_lookup_cache.sql?raw'
import migration005 from './migrations/005_product_rating_sold.sql?raw'
import migration006 from './migrations/006_category_path.sql?raw'
import migration007 from './migrations/007_owner_link_bundle.sql?raw'
import migration008 from './migrations/008_want_state.sql?raw'
import migration009 from './migrations/009_product_meta.sql?raw'
import migration010 from './migrations/010_opaque_store.sql?raw'

/** Ordered list of SQL migrations (filename → body). */
export const MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  { id: '001_init.sql', sql: migration001 },
  { id: '002_fts_diacritics.sql', sql: migration002 },
  { id: '003_copy_events_indexes.sql', sql: migration003 },
  { id: '004_product_lookup_cache.sql', sql: migration004 },
  { id: '005_product_rating_sold.sql', sql: migration005 },
  { id: '006_category_path.sql', sql: migration006 },
  { id: '007_owner_link_bundle.sql', sql: migration007 },
  { id: '008_want_state.sql', sql: migration008 },
  { id: '009_product_meta.sql', sql: migration009 },
  { id: '010_opaque_store.sql', sql: migration010 },
]
