import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import {
  countDefaults,
  createTemplate,
  deleteTemplate,
  getDefaultTemplate,
  listTemplates,
  seedDefaultTemplateIfEmpty,
  setDefaultTemplate,
  STARTER_TEMPLATE_CONTENT,
  STARTER_TEMPLATE_NAME,
  updateTemplate,
} from './templateRepo'
import { createTestDb } from './testDb'

describe('templateRepo', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
  })

  it('seed: tạo mẫu mặc định khi bảng trống', () => {
    const seeded = seedDefaultTemplateIfEmpty(db)
    expect(seeded).not.toBeNull()
    expect(seeded!.name).toBe(STARTER_TEMPLATE_NAME)
    expect(seeded!.content).toBe(STARTER_TEMPLATE_CONTENT)
    expect(seeded!.is_default).toBe(true)
    expect(countDefaults(db)).toBe(1)

    // Idempotent
    expect(seedDefaultTemplateIfEmpty(db)).toBeNull()
    expect(listTemplates(db)).toHaveLength(1)
  })

  it('bất biến single-default: chỉ một is_default = 1 qua nhiều lần cập nhật', () => {
    const a = createTemplate(db, {
      name: 'A',
      content: 'a {link}',
      is_default: true,
    })
    expect(countDefaults(db)).toBe(1)
    expect(getDefaultTemplate(db)?.id).toBe(a.id)

    const b = createTemplate(db, {
      name: 'B',
      content: 'b {link}',
      is_default: true,
    })
    expect(countDefaults(db)).toBe(1)
    expect(getDefaultTemplate(db)?.id).toBe(b.id)

    const c = createTemplate(db, {
      name: 'C',
      content: 'c {link}',
      is_default: false,
    })
    expect(countDefaults(db)).toBe(1)
    expect(getDefaultTemplate(db)?.id).toBe(b.id)

    // setDefault repeatedly
    setDefaultTemplate(db, a.id)
    expect(countDefaults(db)).toBe(1)
    expect(getDefaultTemplate(db)?.id).toBe(a.id)

    setDefaultTemplate(db, c.id)
    expect(countDefaults(db)).toBe(1)
    expect(getDefaultTemplate(db)?.id).toBe(c.id)

    setDefaultTemplate(db, b.id)
    setDefaultTemplate(db, a.id)
    setDefaultTemplate(db, c.id)
    expect(countDefaults(db)).toBe(1)
    expect(getDefaultTemplate(db)?.id).toBe(c.id)

    // update with is_default
    updateTemplate(db, { id: a.id, is_default: true })
    expect(countDefaults(db)).toBe(1)
    expect(getDefaultTemplate(db)?.id).toBe(a.id)

    updateTemplate(db, { id: b.id, name: 'B2', is_default: true })
    expect(countDefaults(db)).toBe(1)
    expect(getDefaultTemplate(db)?.id).toBe(b.id)

    // All rows: at most one default
    const defaults = listTemplates(db).filter((t) => t.is_default)
    expect(defaults).toHaveLength(1)
  })

  it('xoá template mặc định → promote mẫu còn lại', () => {
    const a = createTemplate(db, {
      name: 'A',
      content: 'a',
      is_default: true,
    })
    const b = createTemplate(db, {
      name: 'B',
      content: 'b',
      is_default: false,
    })

    expect(deleteTemplate(db, a.id)).toBe(true)
    expect(countDefaults(db)).toBe(1)
    expect(getDefaultTemplate(db)?.id).toBe(b.id)
  })

  it('CRUD cơ bản', () => {
    const t = createTemplate(db, {
      name: 'Video',
      content: '{ten} {link}',
    })
    expect(t.id).toBeTruthy()
    expect(listTemplates(db).some((x) => x.id === t.id)).toBe(true)

    const updated = updateTemplate(db, {
      id: t.id,
      name: 'Live',
      content: 'mua {link}',
    })
    expect(updated.name).toBe('Live')
    expect(updated.content).toBe('mua {link}')

    expect(deleteTemplate(db, t.id)).toBe(true)
    expect(listTemplates(db).find((x) => x.id === t.id)).toBeUndefined()
  })
})
