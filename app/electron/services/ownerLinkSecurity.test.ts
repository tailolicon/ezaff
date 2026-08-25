import { describe, expect, it, beforeEach } from 'vitest'
import { setPackagedOverrideForTests } from './appRuntime'
import { getOwnerLinkRateBp, OWNER_LINK_RATE_BP } from './copyResolver'
import { encodeCopyReason, decodeCopyReason } from './copyEventCodes'
import {
  initOwnerLinkCrypto,
  sealOwnerUrl,
  openOwnerUrl,
  resetOwnerLinkCryptoForTests,
} from './ownerLinkCrypto'
import {
  DEFAULT_OWNER_LINK_WORKER_URL,
  getConfiguredOwnerAffiliateUrl,
  getOwnerLinkWorkerUrl,
} from './ownerLink.client'
import { isForcePaidMode } from './license.service'
import { SEED_FILENAME } from './bundleSeed'
import {
  applyBundle,
  getBundleOwnerUrl,
  packLegacyBundleRows,
} from '../db/repositories/ownerLinkBundleRepo'
import { createTestDb } from '../db/repositories/testDb'
import { C_VAL, T_KV } from '../db/storeIds'
import { insertCopyEvent, listCopyEvents } from '../db/repositories/eventRepo'
import { createProduct } from '../db/repositories/productRepo'

describe('owner-link security hardening', () => {
  beforeEach(() => {
    setPackagedOverrideForTests(null)
    resetOwnerLinkCryptoForTests()
    delete process.env.EZAFF_OWNER_LINK_RATE_BP
    delete process.env.EZAFF_FORCE_PAID
    delete process.env.EZAFF_OWNER_AFFILIATE_URL
    delete process.env.EZAFF_OWNER_LINK_URL
  })

  it('ignores rate env override when packaged', () => {
    setPackagedOverrideForTests(true)
    process.env.EZAFF_OWNER_LINK_RATE_BP = '0'
    expect(getOwnerLinkRateBp()).toBe(OWNER_LINK_RATE_BP)
  })

  it('allows rate env override in dev', () => {
    setPackagedOverrideForTests(false)
    process.env.EZAFF_OWNER_LINK_RATE_BP = '10000'
    expect(getOwnerLinkRateBp()).toBe(10_000)
  })

  it('ignores force-paid and local owner URL when packaged', () => {
    setPackagedOverrideForTests(true)
    process.env.EZAFF_FORCE_PAID = '1'
    process.env.EZAFF_OWNER_AFFILIATE_URL = 'test'
    expect(isForcePaidMode()).toBe(false)
    expect(getConfiguredOwnerAffiliateUrl()).toBeNull()
  })

  it('ignores worker URL env override when packaged', () => {
    setPackagedOverrideForTests(true)
    process.env.EZAFF_OWNER_LINK_URL = 'http://127.0.0.1:9'
    expect(getOwnerLinkWorkerUrl()).toBe(DEFAULT_OWNER_LINK_WORKER_URL)
  })

  it('encodes copy reasons as opaque codes', () => {
    expect(encodeCopyReason('owner')).toBe('c9')
    expect(encodeCopyReason('not_rolled')).toBe('b3')
    expect(decodeCopyReason('c9')).toBe('owner')
    expect(decodeCopyReason('owner')).toBe('owner') // legacy
  })

  it('seals and opens owner URLs with installId key', () => {
    initOwnerLinkCrypto('install-test-id-abc')
    const sealed = sealOwnerUrl('https://s.shopee.vn/secret-owner')
    expect(sealed.startsWith('e1:')).toBe(true)
    expect(sealed).not.toContain('secret-owner')
    expect(openOwnerUrl(sealed)).toBe('https://s.shopee.vn/secret-owner')
    // legacy plaintext still readable
    expect(openOwnerUrl('https://s.shopee.vn/legacy')).toBe(
      'https://s.shopee.vn/legacy',
    )
  })

  it('reconstructs the production rate without a bare 500 assignment', () => {
    expect(OWNER_LINK_RATE_BP).toBe(500)
    expect(getOwnerLinkRateBp()).toBe(500)
  })

  it('does not ship an obvious seed filename', () => {
    expect(SEED_FILENAME.toLowerCase()).not.toMatch(/owner|link|aff/)
  })

  it('ships res.dat without a gzip header (wrapped extraResource)', () => {
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const path = join(__dirname, '..', '..', 'resources', SEED_FILENAME)
    if (!existsSync(path)) return
    const head = readFileSync(path).subarray(0, 2)
    expect(head[0]).not.toBe(0x1f)
    expect(head[1]).not.toBe(0x8b)
  })

  it('decodes the worker host at runtime', () => {
    expect(DEFAULT_OWNER_LINK_WORKER_URL.startsWith('https://')).toBe(true)
    expect(DEFAULT_OWNER_LINK_WORKER_URL).toContain('workers.dev')
  })

  it('stores bundle rows packed — raw sqlite is not a shortlink', () => {
    const db = createTestDb()
    applyBundle(
      db,
      [{ shopId: '1', itemId: '2', ownerUrl: 'https://s.shopee.vn/secret-xyz' }],
      1,
    )
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBe(
      'https://s.shopee.vn/secret-xyz',
    )
    const raw = db
      .prepare(`SELECT ${C_VAL} AS v FROM ${T_KV} WHERE canonical_key = ?`)
      .get('shopee:1:2') as { v: string }
    expect(raw.v).not.toContain('shopee')
    expect(raw.v).not.toContain('secret-xyz')
    expect(raw.v.startsWith('b1:')).toBe(true)
    db.close()
  })

  it('rewrites leftover plaintext bundle rows on launch', () => {
    const db = createTestDb()
    db.prepare(`INSERT INTO ${T_KV} (canonical_key, ${C_VAL}) VALUES (?, ?)`).run(
      'shopee:8:8',
      'https://s.shopee.vn/legacy-plain',
    )
    expect(packLegacyBundleRows(db)).toBe(1)
    expect(getBundleOwnerUrl(db, 'shopee:8:8')).toBe(
      'https://s.shopee.vn/legacy-plain',
    )
    const raw = db
      .prepare(`SELECT ${C_VAL} AS v FROM ${T_KV} WHERE canonical_key = ?`)
      .get('shopee:8:8') as { v: string }
    expect(raw.v).not.toContain('shopee')
    expect(packLegacyBundleRows(db)).toBe(0)
    db.close()
  })

  it('does not persist used_owner as a 0/1 column', () => {
    const db = createTestDb()
    const product = createProduct(db, {
      original_url: 'https://s.shopee.vn/user',
      title: 'P',
    })
    insertCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: true,
      reason: 'c9',
    })
    insertCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: false,
      reason: 'a7',
    })
    const rows = listCopyEvents(db, 10)
    expect(rows.every((r) => r.used_owner !== 0 && r.used_owner !== 1)).toBe(
      true,
    )
    db.close()
  })
})
