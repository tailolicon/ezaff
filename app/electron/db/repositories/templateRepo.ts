import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

/** Template row as stored in SQLite. */
export type Template = {
  id: string
  name: string
  content: string
  is_default: boolean
  created_at: number
}

export type CreateTemplateInput = {
  name: string
  content: string
  /** When true, becomes the sole default (clears previous). */
  is_default?: boolean
}

export type UpdateTemplateInput = {
  id: string
  name?: string
  content?: string
  is_default?: boolean
}

type TemplateRow = {
  id: string
  name: string
  content: string
  is_default: number
  created_at: number
}

export const STARTER_TEMPLATE_NAME = 'Mặc định'
export const STARTER_TEMPLATE_CONTENT =
  'sản phẩm em dùng trong video:{link}'

function mapTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    is_default: row.is_default === 1,
    created_at: row.created_at,
  }
}

function requireName(raw: string): string {
  const name = raw.trim()
  if (!name) {
    throw new Error('Tên mẫu không được để trống')
  }
  return name
}

function requireContent(raw: string): string {
  const content = raw.trim()
  if (!content) {
    throw new Error('Nội dung mẫu không được để trống')
  }
  return content
}

/**
 * Seed the starter template when the table is empty (first run).
 * Idempotent — safe to call on every startup.
 */
export function seedDefaultTemplateIfEmpty(db: Database.Database): Template | null {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM templates')
    .get() as { c: number | bigint }
  if (Number(row.c) > 0) {
    return null
  }

  return createTemplate(db, {
    name: STARTER_TEMPLATE_NAME,
    content: STARTER_TEMPLATE_CONTENT,
    is_default: true,
  })
}

export function createTemplate(
  db: Database.Database,
  input: CreateTemplateInput,
): Template {
  const name = requireName(input.name)
  const content = requireContent(input.content)
  const id = randomUUID()
  const now = Date.now()
  const wantDefault = input.is_default === true

  const template: Template = {
    id,
    name,
    content,
    is_default: wantDefault,
    created_at: now,
  }

  const run = db.transaction(() => {
    if (wantDefault) {
      db.prepare('UPDATE templates SET is_default = 0 WHERE is_default = 1').run()
    } else {
      // First template always becomes default so the invariant holds
      const count = db
        .prepare('SELECT COUNT(*) AS c FROM templates')
        .get() as { c: number | bigint }
      if (Number(count.c) === 0) {
        template.is_default = true
      }
    }

    db.prepare(
      `INSERT INTO templates (id, name, content, is_default, created_at)
       VALUES (@id, @name, @content, @is_default, @created_at)`,
    ).run({
      id: template.id,
      name: template.name,
      content: template.content,
      is_default: template.is_default ? 1 : 0,
      created_at: template.created_at,
    })
  })
  run()

  return template
}

export function getTemplateById(
  db: Database.Database,
  id: string,
): Template | null {
  const row = db
    .prepare(
      `SELECT id, name, content, is_default, created_at
       FROM templates WHERE id = ?`,
    )
    .get(id) as TemplateRow | undefined
  return row ? mapTemplate(row) : null
}

export function getDefaultTemplate(db: Database.Database): Template | null {
  const row = db
    .prepare(
      `SELECT id, name, content, is_default, created_at
       FROM templates WHERE is_default = 1 LIMIT 1`,
    )
    .get() as TemplateRow | undefined
  return row ? mapTemplate(row) : null
}

export function listTemplates(db: Database.Database): Template[] {
  const rows = db
    .prepare(
      `SELECT id, name, content, is_default, created_at
       FROM templates
       ORDER BY is_default DESC, created_at ASC, name COLLATE NOCASE ASC`,
    )
    .all() as TemplateRow[]
  return rows.map(mapTemplate)
}

/**
 * Exactly one template may have is_default = 1 at a time.
 * Setting a new default clears the previous one in a single transaction.
 */
export function setDefaultTemplate(
  db: Database.Database,
  id: string,
): Template {
  const existing = getTemplateById(db, id)
  if (!existing) {
    throw new Error('Không tìm thấy mẫu câu mời')
  }

  const run = db.transaction(() => {
    db.prepare('UPDATE templates SET is_default = 0 WHERE is_default = 1').run()
    db.prepare('UPDATE templates SET is_default = 1 WHERE id = ?').run(id)
  })
  run()

  return { ...existing, is_default: true }
}

export function updateTemplate(
  db: Database.Database,
  input: UpdateTemplateInput,
): Template {
  const existing = getTemplateById(db, input.id)
  if (!existing) {
    throw new Error('Không tìm thấy mẫu câu mời')
  }

  const next: Template = {
    ...existing,
    name:
      input.name !== undefined ? requireName(input.name) : existing.name,
    content:
      input.content !== undefined
        ? requireContent(input.content)
        : existing.content,
  }

  const run = db.transaction(() => {
    if (input.is_default === true) {
      db.prepare(
        'UPDATE templates SET is_default = 0 WHERE is_default = 1',
      ).run()
      next.is_default = true
    } else if (input.is_default === false && existing.is_default) {
      // Clearing default without assigning another is allowed;
      // leave zero defaults rather than inventing one.
      next.is_default = false
    }

    db.prepare(
      `UPDATE templates SET
        name = @name,
        content = @content,
        is_default = @is_default
       WHERE id = @id`,
    ).run({
      id: next.id,
      name: next.name,
      content: next.content,
      is_default: next.is_default ? 1 : 0,
    })
  })
  run()

  return next
}

/**
 * Delete a template. If it was the default, promote the oldest remaining
 * template so the single-default invariant still has a candidate.
 */
export function deleteTemplate(db: Database.Database, id: string): boolean {
  const existing = getTemplateById(db, id)
  if (!existing) {
    return false
  }

  const run = db.transaction(() => {
    db.prepare('DELETE FROM templates WHERE id = ?').run(id)

    if (existing.is_default) {
      const next = db
        .prepare(
          `SELECT id FROM templates
           ORDER BY created_at ASC, name COLLATE NOCASE ASC
           LIMIT 1`,
        )
        .get() as { id: string } | undefined
      if (next) {
        db.prepare(
          'UPDATE templates SET is_default = 0 WHERE is_default = 1',
        ).run()
        db.prepare(
          'UPDATE templates SET is_default = 1 WHERE id = ?',
        ).run(next.id)
      }
    }
  })
  run()

  return true
}

/** Count how many templates currently have is_default = 1 (for tests). */
export function countDefaults(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM templates WHERE is_default = 1')
    .get() as { c: number | bigint }
  return Number(row.c)
}
