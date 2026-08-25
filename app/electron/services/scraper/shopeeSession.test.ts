/**
 * Phase 11 — Shopee session partition, anti-bot messages, sign-out.
 * No real Shopee credentials required.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ANTIBOT_SIGNED_ERROR_VI,
  ANTIBOT_UNSIGNED_ERROR_VI,
  assertSharedShopeePartition,
  accountPayloadLooksSignedIn,
  getShopeeAuthStatus,
  isShopeeAntiBotError,
  isShopeeAuthFlowUrl,
  messageForProductLookupFailure,
  SHOPEE_ANTIBOT_ERROR_CODE,
  SHOPEE_SESSION_PARTITION,
  SHOPEE_STATUS_SIGNED_IN_VI,
  SHOPEE_STATUS_SIGNED_OUT_VI,
  shopeePartitionWebPreferences,
  signOutShopee,
} from './shopeeSession'
import {
  OWNER_LINK_BODY_KEYS,
  buildOwnerLinkBody,
  assertOwnerLinkBodyKeys,
} from '../ownerLink.client'
import { productLookupFailureResult } from './shopee.scraper'

describe('SHOPEE_SESSION_PARTITION — shared between login and scraper', () => {
  it('uses a persistent partition name', () => {
    expect(SHOPEE_SESSION_PARTITION).toBe('persist:shopee')
  })

  it('webPreferences always pin the same partition', () => {
    const prefs = shopeePartitionWebPreferences({ offscreen: true })
    expect(prefs.partition).toBe(SHOPEE_SESSION_PARTITION)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.sandbox).toBe(true)
    expect(prefs.offscreen).toBe(true)
    assertSharedShopeePartition(prefs.partition)
  })

  it('assertSharedShopeePartition rejects other partitions', () => {
    expect(() => assertSharedShopeePartition('persist:other')).toThrow(
      /persist:shopee/,
    )
    expect(() => assertSharedShopeePartition('')).toThrow()
  })
})

describe('isShopeeAntiBotError', () => {
  it('detects error code 90309999', () => {
    expect(isShopeeAntiBotError({ error: SHOPEE_ANTIBOT_ERROR_CODE })).toBe(
      true,
    )
    expect(isShopeeAntiBotError({ error: 90309999 })).toBe(true)
    expect(isShopeeAntiBotError({ error: '90309999' })).toBe(true)
  })

  it('rejects success or unrelated errors', () => {
    expect(isShopeeAntiBotError({ error: 0 })).toBe(false)
    expect(isShopeeAntiBotError({ error: 1 })).toBe(false)
    expect(isShopeeAntiBotError(null)).toBe(false)
    expect(isShopeeAntiBotError({})).toBe(false)
  })
})

describe('messageForProductLookupFailure — signed-in vs signed-out', () => {
  it('suggests Cài đặt when anti-bot and NOT signed in', () => {
    const msg = messageForProductLookupFailure({
      antiBot: true,
      signedIn: false,
    })
    expect(msg).toBe(ANTIBOT_UNSIGNED_ERROR_VI)
    expect(msg).toMatch(/Cài đặt/)
    expect(msg).toMatch(/Tài khoản Shopee/)
    expect(msg).toMatch(/nhập tay/)
    expect(/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i.test(
      msg,
    )).toBe(true)
  })

  it('does not blame the user when anti-bot AND signed in', () => {
    const msg = messageForProductLookupFailure({
      antiBot: true,
      signedIn: true,
    })
    expect(msg).toBe(ANTIBOT_SIGNED_ERROR_VI)
    expect(msg).toMatch(/đã đăng nhập/)
    expect(msg).not.toMatch(/Cài đặt/)
    expect(msg).toMatch(/nhập tay/)
    expect(msg).not.toBe(ANTIBOT_UNSIGNED_ERROR_VI)
  })

  it('uses fallback when not anti-bot', () => {
    expect(
      messageForProductLookupFailure({
        antiBot: false,
        signedIn: false,
        fallback: 'Tùy chỉnh',
      }),
    ).toBe('Tùy chỉnh')
  })
})

describe('productLookupFailureResult', () => {
  it('embeds unsigned message when antiBot + signedIn false', async () => {
    const r = await productLookupFailureResult({
      antiBot: true,
      signedIn: false,
      shopId: '1',
      itemId: '2',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe(ANTIBOT_UNSIGNED_ERROR_VI)
    expect(r.shop_id).toBe('1')
    expect(r.item_id).toBe('2')
  })

  it('embeds signed message when antiBot + signedIn true', async () => {
    const r = await productLookupFailureResult({
      antiBot: true,
      signedIn: true,
      shopId: '9',
      itemId: '8',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe(ANTIBOT_SIGNED_ERROR_VI)
    expect(r.error).not.toBe(ANTIBOT_UNSIGNED_ERROR_VI)
  })
})

describe('accountPayloadLooksSignedIn — endpoint probe (no cookie parsing)', () => {
  it('returns true when userid / username present', () => {
    expect(
      accountPayloadLooksSignedIn({
        error: 0,
        data: { userid: 12345, username: 'user_x' },
      }),
    ).toBe(true)
    expect(
      accountPayloadLooksSignedIn({
        error: 0,
        data: { user_id: '99' },
      }),
    ).toBe(true)
  })

  it('returns false when error or empty account', () => {
    expect(
      accountPayloadLooksSignedIn({ error: 90309999, data: {} }),
    ).toBe(false)
    expect(accountPayloadLooksSignedIn({ error: 0, data: {} })).toBe(false)
    expect(accountPayloadLooksSignedIn(null)).toBe(false)
    expect(
      accountPayloadLooksSignedIn({ error: 0, data: { userid: 0 } }),
    ).toBe(false)
  })
})

describe('isShopeeAuthFlowUrl', () => {
  it('treats login / signup / verify as still-in-auth-flow', () => {
    expect(isShopeeAuthFlowUrl('https://shopee.vn/buyer/login')).toBe(true)
    expect(isShopeeAuthFlowUrl('https://shopee.vn/buyer/signup')).toBe(true)
    expect(
      isShopeeAuthFlowUrl('https://shopee.vn/verify/traffic/error?x=1'),
    ).toBe(true)
  })

  it('treats homepage / product as left auth flow', () => {
    expect(isShopeeAuthFlowUrl('https://shopee.vn/')).toBe(false)
    expect(
      isShopeeAuthFlowUrl('https://shopee.vn/product/1/2'),
    ).toBe(false)
  })
})

describe('signOutShopee clears partition (injectable)', () => {
  it('calls clearPartition and reports signed-out', async () => {
    const clearPartition = vi.fn(async () => undefined)
    const result = await signOutShopee({ clearPartition })
    expect(clearPartition).toHaveBeenCalledOnce()
    expect(result.signedIn).toBe(false)
    expect(result.message).toBe(SHOPEE_STATUS_SIGNED_OUT_VI)
  })
})

describe('getShopeeAuthStatus with injectable probe', () => {
  it('maps probe true/false to Vietnamese status lines', async () => {
    const inStatus = await getShopeeAuthStatus({
      probeSignedIn: async () => true,
    })
    expect(inStatus.signedIn).toBe(true)
    expect(inStatus.message).toBe(SHOPEE_STATUS_SIGNED_IN_VI)

    const outStatus = await getShopeeAuthStatus({
      probeSignedIn: async () => false,
    })
    expect(outStatus.signedIn).toBe(false)
    expect(outStatus.message).toBe(SHOPEE_STATUS_SIGNED_OUT_VI)
  })
})

describe('Worker payload still only four allowed fields (Phase 11 re-assert)', () => {
  it('buildOwnerLinkBody never gains cookies/session/credentials fields', () => {
    const body = buildOwnerLinkBody({
      platform: 'shopee',
      shopId: 's1',
      itemId: 'i1',
      installId: 'inst-1',
    })
    expect(Object.keys(body).sort()).toEqual([...OWNER_LINK_BODY_KEYS].sort())
    expect(body).toEqual({
      platform: 'shopee',
      shopId: 's1',
      itemId: 'i1',
      installId: 'inst-1',
    })
    // Explicit absences — session must never leave the machine
    expect(body).not.toHaveProperty('cookie')
    expect(body).not.toHaveProperty('cookies')
    expect(body).not.toHaveProperty('session')
    expect(body).not.toHaveProperty('password')
    expect(body).not.toHaveProperty('username')
    expect(body).not.toHaveProperty('token')
    assertOwnerLinkBodyKeys(body as unknown as Record<string, unknown>)
  })
})

describe('no credential handling surface in shopeeSession pure API', () => {
  it('status / message helpers never accept password or username params', () => {
    // Structural guard: message helpers only take antiBot + signedIn flags
    const msg = messageForProductLookupFailure({
      antiBot: true,
      signedIn: false,
    })
    expect(typeof msg).toBe('string')
    // Partition helper has no credential-related keys
    const prefs = shopeePartitionWebPreferences()
    expect(Object.keys(prefs)).not.toContain('password')
    expect(Object.keys(prefs)).not.toContain('username')
    expect(Object.keys(prefs)).not.toContain('credentials')
  })
})
