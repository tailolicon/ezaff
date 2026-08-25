import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

/** Group row as stored in SQLite. */
export type Group = {
  id: string
  name: string
  color: string | null
  sort_order: number
  created_at: number
}

/** Group with product membership count for the sidebar. */
export type GroupWithCount = Group & {
  product_count: number
}

export type CreateGroupInput = {
  name: string
  color?: string | null
  sort_order?: number
}

export type UpdateGroupInput = {
  id: string
  name?: string
  color?: string | null
  sort_order?: number
}

type GroupRow = {
  id: string
  name: string
  color: string | null
  sort_order: number
  created_at: number
}

type GroupCountRow = GroupRow & { product_count: number | bigint }

function mapGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    sort_order: row.sort_order,
    created_at: row.created_at,
  }
}

function isUniqueNameError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('unique constraint failed') ||
    msg.includes('constraint failed: groups.name')
  )
}

function requireName(raw: string): string {
  const name = raw.trim()
  if (!name) {
    throw new Error('Tên nhóm không được để trống')
  }
  return name
}

export function createGroup(
  db: Database.Database,
  input: CreateGroupInput,
): Group {
  const name = requireName(input.name)
  const id = randomUUID()
  const now = Date.now()
  const color =
    input.color === undefined ? null : input.color?.trim() || null
  const sort_order =
    input.sort_order !== undefined && Number.isFinite(input.sort_order)
      ? Math.trunc(input.sort_order)
      : 0

  const group: Group = {
    id,
    name,
    color,
    sort_order,
    created_at: now,
  }

  try {
    db.prepare(
      `INSERT INTO groups (id, name, color, sort_order, created_at)
       VALUES (@id, @name, @color, @sort_order, @created_at)`,
    ).run(group)
  } catch (err) {
    if (isUniqueNameError(err)) {
      throw new Error('Tên nhóm đã tồn tại. Vui lòng chọn tên khác.')
    }
    throw err
  }

  return group
}

export function getGroupById(
  db: Database.Database,
  id: string,
): Group | null {
  const row = db
    .prepare(
      `SELECT id, name, color, sort_order, created_at FROM groups WHERE id = ?`,
    )
    .get(id) as GroupRow | undefined
  return row ? mapGroup(row) : null
}

export function updateGroup(
  db: Database.Database,
  input: UpdateGroupInput,
): Group {
  const existing = getGroupById(db, input.id)
  if (!existing) {
    throw new Error('Không tìm thấy nhóm')
  }

  const next: Group = {
    ...existing,
    name:
      input.name !== undefined ? requireName(input.name) : existing.name,
    color:
      input.color !== undefined
        ? input.color?.trim() || null
        : existing.color,
    sort_order:
      input.sort_order !== undefined && Number.isFinite(input.sort_order)
        ? Math.trunc(input.sort_order)
        : existing.sort_order,
  }

  try {
    db.prepare(
      `UPDATE groups SET
        name = @name,
        color = @color,
        sort_order = @sort_order
       WHERE id = @id`,
    ).run(next)
  } catch (err) {
    if (isUniqueNameError(err)) {
      throw new Error('Tên nhóm đã tồn tại. Vui lòng chọn tên khác.')
    }
    throw err
  }

  return next
}

/** Rename is a convenience wrapper around updateGroup. */
export function renameGroup(
  db: Database.Database,
  id: string,
  name: string,
): Group {
  return updateGroup(db, { id, name })
}

/**
 * Delete a group. product_groups join rows cascade via FK ON DELETE CASCADE.
 */
export function deleteGroup(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM groups WHERE id = ?').run(id)
  return result.changes > 0
}

/** List groups with product counts, ordered by sort_order then name. */
export function listGroups(db: Database.Database): GroupWithCount[] {
  const rows = db
    .prepare(
      `SELECT
         g.id, g.name, g.color, g.sort_order, g.created_at,
         COUNT(pg.product_id) AS product_count
       FROM groups g
       LEFT JOIN product_groups pg ON pg.group_id = g.id
       GROUP BY g.id
       ORDER BY g.sort_order ASC, g.name COLLATE NOCASE ASC`,
    )
    .all() as GroupCountRow[]

  return rows.map((row) => ({
    ...mapGroup(row),
    product_count: Number(row.product_count),
  }))
}

export function assignProductToGroup(
  db: Database.Database,
  productId: string,
  groupId: string,
): void {
  const product = db
    .prepare('SELECT id FROM products WHERE id = ?')
    .get(productId) as { id: string } | undefined
  if (!product) {
    throw new Error('Không tìm thấy sản phẩm')
  }
  const group = getGroupById(db, groupId)
  if (!group) {
    throw new Error('Không tìm thấy nhóm')
  }

  db.prepare(
    `INSERT OR IGNORE INTO product_groups (product_id, group_id)
     VALUES (?, ?)`,
  ).run(productId, groupId)
}

/**
 * Add many products to one group in a single transaction (bulk bar).
 * Already-assigned products are ignored, not duplicated.
 */
export function assignProductsToGroup(
  db: Database.Database,
  productIds: string[],
  groupId: string,
): number {
  if (!getGroupById(db, groupId)) {
    throw new Error('Không tìm thấy nhóm')
  }
  const unique = [...new Set(productIds)]
  if (unique.length === 0) return 0

  const insert = db.prepare(
    `INSERT OR IGNORE INTO product_groups (product_id, group_id) VALUES (?, ?)`,
  )
  const run = db.transaction((list: string[]) => {
    let added = 0
    for (const productId of list) {
      added += insert.run(productId, groupId).changes
    }
    return added
  })
  return run(unique) as number
}

export function unassignProductFromGroup(
  db: Database.Database,
  productId: string,
  groupId: string,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM product_groups
       WHERE product_id = ? AND group_id = ?`,
    )
    .run(productId, groupId)
  return result.changes > 0
}

export function listGroupsForProduct(
  db: Database.Database,
  productId: string,
): Group[] {
  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.color, g.sort_order, g.created_at
       FROM groups g
       INNER JOIN product_groups pg ON pg.group_id = g.id
       WHERE pg.product_id = ?
       ORDER BY g.sort_order ASC, g.name COLLATE NOCASE ASC`,
    )
    .all(productId) as GroupRow[]
  return rows.map(mapGroup)
}

/**
 * Replace all group memberships for a product.
 * A product may belong to multiple groups (many-to-many).
 */
export function setProductGroups(
  db: Database.Database,
  productId: string,
  groupIds: string[],
): Group[] {
  const product = db
    .prepare('SELECT id FROM products WHERE id = ?')
    .get(productId) as { id: string } | undefined
  if (!product) {
    throw new Error('Không tìm thấy sản phẩm')
  }

  const uniqueIds = [...new Set(groupIds)]
  for (const gid of uniqueIds) {
    if (!getGroupById(db, gid)) {
      throw new Error(`Không tìm thấy nhóm: ${gid}`)
    }
  }

  const run = db.transaction(() => {
    db.prepare('DELETE FROM product_groups WHERE product_id = ?').run(
      productId,
    )
    const insert = db.prepare(
      `INSERT INTO product_groups (product_id, group_id) VALUES (?, ?)`,
    )
    for (const gid of uniqueIds) {
      insert.run(productId, gid)
    }
  })
  run()

  return listGroupsForProduct(db, productId)
}
