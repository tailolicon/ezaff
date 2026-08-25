/**
 * Shopee authenticated session — Phase 11.
 *
 * SAFETY (non-negotiable):
 * - NEVER read, store, log or transmit the user's Shopee username/password.
 * - Login is ONLY Shopee's own page in a REAL, VISIBLE BrowserWindow.
 * - No script injection into the login page, no form prefill, no screenshots.
 * - Cookies/session stay on this machine; never sent to the Cloudflare Worker.
 * - Worker body remains exactly { platform, shopId, itemId, installId }.
 *
 * Both the login window and every scraper BrowserWindow / in-page fetch MUST
 * use the same persistent partition so a sign-in actually benefits scraping.
 */

import { BROWSER_USER_AGENT } from './urlNormalizer'
import { logWarn } from '../../services/log'

/** Shared partition for login + scraper. Persist so session survives restarts. */
export const SHOPEE_SESSION_PARTITION = 'persist:shopee'

/** Shopee's own buyer login URL — never a custom form. */
export const SHOPEE_LOGIN_URL = 'https://shopee.vn/buyer/login'

/** Lightweight account endpoint used ONLY to probe signed-in status. */
export const SHOPEE_ACCOUNT_PROBE_PATH =
  '/api/v4/account/basic/get_account_info'

/** Login window auto-close timeout (user can always close manually). */
export const SHOPEE_LOGIN_TIMEOUT_MS = 5 * 60_000

/**
 * Anti-bot product lookup while the user is NOT signed in.
 * Suggests Cài đặt → Tài khoản Shopee; manual entry always available.
 */
export const ANTIBOT_UNSIGNED_ERROR_VI =
  'Shopee đang chặn tra cứu sản phẩm khi chưa đăng nhập. Vào Cài đặt → Tài khoản Shopee để đăng nhập, hoặc nhập tay tên, ảnh và giá.'

/**
 * Anti-bot product lookup while the user IS signed in.
 * Do not blame the user — report the finding plainly; manual entry stays open.
 */
export const ANTIBOT_SIGNED_ERROR_VI =
  'Shopee vẫn chặn tra cứu sản phẩm dù bạn đã đăng nhập. Bạn có thể nhập tay tên, ảnh và giá.'

/** Confirm dialog when clearing the local Shopee session. */
export const SHOPEE_SIGNOUT_CONFIRM_VI =
  'Xoá phiên đăng nhập Shopee trên máy này? Ứng dụng sẽ không còn dùng phiên của bạn để quét sản phẩm cho đến khi bạn đăng nhập lại.'

/** Status line labels (Vietnamese). */
export const SHOPEE_STATUS_SIGNED_IN_VI = 'Đã đăng nhập Shopee trên máy này'
export const SHOPEE_STATUS_SIGNED_OUT_VI = 'Chưa đăng nhập Shopee'

/** Shopee anti-bot error code observed on /api/v4/pdp/get_pc for anonymous automation. */
export const SHOPEE_ANTIBOT_ERROR_CODE = 90309999

/**
 * Detect Shopee's anti-bot / traffic block on product API payloads.
 * Does not attempt to forge or reverse-engineer signatures.
 */
export function isShopeeAntiBotError(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const err = (data as Record<string, unknown>).error
  return err === SHOPEE_ANTIBOT_ERROR_CODE || err === String(SHOPEE_ANTIBOT_ERROR_CODE)
}

/**
 * Vietnamese product-lookup failure message.
 * Differentiates signed-in vs signed-out anti-bot; otherwise manual entry.
 */
export function messageForProductLookupFailure(opts: {
  antiBot: boolean
  signedIn: boolean
  fallback?: string
}): string {
  if (opts.antiBot) {
    return opts.signedIn ? ANTIBOT_SIGNED_ERROR_VI : ANTIBOT_UNSIGNED_ERROR_VI
  }
  return opts.fallback ?? ANTIBOT_UNSIGNED_ERROR_VI
}

/**
 * BrowserWindow webPreferences shared by login + scraper windows.
 * Callers add offscreen/show/preload as needed — partition is always this one.
 */
export function shopeePartitionWebPreferences(
  extra: Record<string, unknown> = {},
): {
  partition: string
  contextIsolation: true
  nodeIntegration: false
  sandbox: true
} & Record<string, unknown> {
  return {
    partition: SHOPEE_SESSION_PARTITION,
    contextIsolation: true as const,
    nodeIntegration: false as const,
    sandbox: true as const,
    ...extra,
  }
}

export type ShopeeAuthStatus = {
  signedIn: boolean
  /** Human-readable Vietnamese status line. */
  message: string
}

export type ShopeeLoginResult = {
  signedIn: boolean
  /** How the login window ended. */
  reason: 'signed_in' | 'closed' | 'timeout' | 'error'
  message: string
}

export type ShopeeSignOutResult = {
  signedIn: false
  message: string
}

/** Injectable deps for unit tests (no real Electron / network). */
export type ShopeeSessionDeps = {
  probeSignedIn?: () => Promise<boolean>
  openLogin?: () => Promise<ShopeeLoginResult>
  clearPartition?: () => Promise<void>
}

let activeLoginWindow: Electron.BrowserWindow | null = null

/**
 * Electron session for the Shopee partition (login + scraper).
 */
export function getShopeeSession(): Electron.Session {
  // Lazy require so vitest unit tests that only import pure helpers stay clean.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { session } = require('electron') as typeof import('electron')
  return session.fromPartition(SHOPEE_SESSION_PARTITION)
}

/**
 * Probe signed-in status via a lightweight Shopee account endpoint using the
 * partition session. Never parses cookies by hand; never reads credentials.
 */
export async function probeShopeeSignedIn(
  deps: ShopeeSessionDeps = {},
): Promise<boolean> {
  if (deps.probeSignedIn) {
    return deps.probeSignedIn()
  }

  try {
    const ses = getShopeeSession()
    // session.fetch attaches partition cookies automatically (Electron 28+).
    const res = await ses.fetch(
      `https://shopee.vn${SHOPEE_ACCOUNT_PROBE_PATH}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'x-api-source': 'pc',
          'User-Agent': BROWSER_USER_AGENT,
          Referer: 'https://shopee.vn/',
        },
      },
    )

    if (!res.ok) return false

    let body: unknown
    try {
      body = await res.json()
    } catch {
      return false
    }

    return accountPayloadLooksSignedIn(body)
  } catch (err) {
    logWarn('[ezaff] Shopee auth probe failed:', err)
    return false
  }
}

/**
 * Pure helper: decide whether an account-info JSON body indicates a session.
 * Exported for tests — does not touch cookies or credentials.
 */
export function accountPayloadLooksSignedIn(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const root = body as Record<string, unknown>

  // Non-zero top-level error ⇒ not usable / not signed in
  if (Object.prototype.hasOwnProperty.call(root, 'error')) {
    const err = root.error
    if (err !== null && err !== undefined && err !== 0 && err !== '0' && err !== false && err !== '') {
      return false
    }
  }

  const data =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root

  // Common Shopee account fields when a session cookie is valid
  if (data.userid != null && String(data.userid).trim() !== '' && String(data.userid) !== '0') {
    return true
  }
  if (data.user_id != null && String(data.user_id).trim() !== '' && String(data.user_id) !== '0') {
    return true
  }
  if (typeof data.username === 'string' && data.username.trim() !== '') {
    return true
  }
  if (typeof data.email === 'string' && data.email.trim() !== '') {
    return true
  }
  if (typeof data.phone === 'string' && data.phone.trim() !== '') {
    return true
  }

  // Nested account object
  if (data.account && typeof data.account === 'object' && !Array.isArray(data.account)) {
    return accountPayloadLooksSignedIn({ data: data.account, error: 0 })
  }

  return false
}

export async function getShopeeAuthStatus(
  deps: ShopeeSessionDeps = {},
): Promise<ShopeeAuthStatus> {
  const signedIn = await probeShopeeSignedIn(deps)
  return {
    signedIn,
    message: signedIn ? SHOPEE_STATUS_SIGNED_IN_VI : SHOPEE_STATUS_SIGNED_OUT_VI,
  }
}

/**
 * Paths that still mean "user is in an auth flow" — do not auto-close yet.
 */
export function isShopeeAuthFlowUrl(href: string): boolean {
  if (!href || typeof href !== 'string') return true
  try {
    const u = new URL(href)
    if (!u.hostname.toLowerCase().includes('shopee')) return true
    const path = u.pathname.toLowerCase()
    if (
      path.includes('login') ||
      path.includes('signup') ||
      path.includes('sign-up') ||
      path.includes('buyer/login') ||
      path.includes('authenticate') ||
      path.includes('/verify/') ||
      path.includes('captcha') ||
      path.includes('otp')
    ) {
      return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * Open a REAL, VISIBLE Shopee login window on the shared partition.
 * Never injects scripts, never reads form fields, never screenshots.
 * Closes itself once a post-login navigation probes as signed-in.
 */
export async function openShopeeLoginWindow(
  deps: ShopeeSessionDeps = {},
): Promise<ShopeeLoginResult> {
  if (deps.openLogin) {
    return deps.openLogin()
  }

  let BrowserWindow: typeof import('electron').BrowserWindow
  try {
    ;({ BrowserWindow } = await import('electron'))
  } catch (err) {
    return {
      signedIn: false,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  // Reuse / focus an existing login window instead of opening a second one
  if (activeLoginWindow && !activeLoginWindow.isDestroyed()) {
    activeLoginWindow.focus()
    activeLoginWindow.show()
    return waitForLoginWindow(activeLoginWindow, deps)
  }

  const win = new BrowserWindow({
    width: 520,
    height: 780,
    minWidth: 400,
    minHeight: 560,
    show: true, // NEVER hidden / headless — user must see what they log into
    title: 'Đăng nhập Shopee — ezaff',
    autoHideMenuBar: true,
    webPreferences: shopeePartitionWebPreferences({
      // No preload — nothing can snoop the login form
    }),
  })

  activeLoginWindow = win
  win.setMenuBarVisibility(false)

  try {
    win.webContents.setUserAgent(BROWSER_USER_AGENT)
  } catch {
    // ignore
  }

  // Block opening extra popups as app windows; allow Shopee to keep main flow.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  void win.loadURL(SHOPEE_LOGIN_URL, {
    userAgent: BROWSER_USER_AGENT,
    httpReferrer: 'https://shopee.vn/',
  })

  return waitForLoginWindow(win, deps)
}

async function waitForLoginWindow(
  win: Electron.BrowserWindow,
  deps: ShopeeSessionDeps,
): Promise<ShopeeLoginResult> {
  return new Promise((resolve) => {
    let settled = false

    const finish = async (
      reason: ShopeeLoginResult['reason'],
    ): Promise<void> => {
      if (settled) return
      settled = true
      cleanup()
      let signedIn = false
      try {
        signedIn = await probeShopeeSignedIn(deps)
      } catch {
        signedIn = false
      }
      if (activeLoginWindow === win) {
        activeLoginWindow = null
      }
      if (!win.isDestroyed()) {
        try {
          win.close()
        } catch {
          // ignore
        }
      }
      resolve({
        signedIn,
        reason: signedIn && reason !== 'error' ? 'signed_in' : reason,
        message: signedIn
          ? SHOPEE_STATUS_SIGNED_IN_VI
          : SHOPEE_STATUS_SIGNED_OUT_VI,
      })
    }

    const tryCloseIfSignedIn = async (): Promise<void> => {
      if (settled || win.isDestroyed()) return
      const href = win.webContents.getURL()
      if (isShopeeAuthFlowUrl(href)) return
      try {
        const signedIn = await probeShopeeSignedIn(deps)
        if (signedIn) {
          await finish('signed_in')
        }
      } catch {
        // stay open
      }
    }

    const onClosed = (): void => {
      void finish('closed')
    }

    const onNav = (): void => {
      void tryCloseIfSignedIn()
    }

    const timer = setTimeout(() => {
      void finish('timeout')
    }, SHOPEE_LOGIN_TIMEOUT_MS)

    const cleanup = (): void => {
      clearTimeout(timer)
      if (!win.isDestroyed()) {
        win.removeListener('closed', onClosed)
        win.webContents.removeListener('did-navigate', onNav)
        win.webContents.removeListener('did-navigate-in-page', onNav)
        win.webContents.removeListener('did-finish-load', onNav)
      }
    }

    win.on('closed', onClosed)
    win.webContents.on('did-navigate', onNav)
    win.webContents.on('did-navigate-in-page', onNav)
    win.webContents.on('did-finish-load', onNav)
  })
}

/**
 * Clear cookies, storage and cache for the Shopee partition ONLY.
 * Does not touch the default session or other partitions.
 */
export async function signOutShopee(
  deps: ShopeeSessionDeps = {},
): Promise<ShopeeSignOutResult> {
  if (deps.clearPartition) {
    await deps.clearPartition()
  } else {
    const ses = getShopeeSession()
    try {
      await ses.clearStorageData()
    } catch (err) {
      logWarn('[ezaff] clearStorageData failed:', err)
    }
    try {
      await ses.clearCache()
    } catch (err) {
      logWarn('[ezaff] clearCache failed:', err)
    }
    try {
      // Extra belt: drop all cookies on shopee hosts in this partition
      const cookies = await ses.cookies.get({})
      await Promise.all(
        cookies.map((c) => {
          const url = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '')}${c.path || '/'}`
          return ses.cookies.remove(url, c.name).catch(() => undefined)
        }),
      )
    } catch (err) {
      logWarn('[ezaff] cookie clear failed:', err)
    }
  }

  // Close login window if still open
  if (activeLoginWindow && !activeLoginWindow.isDestroyed()) {
    try {
      activeLoginWindow.close()
    } catch {
      // ignore
    }
    activeLoginWindow = null
  }

  return {
    signedIn: false,
    message: SHOPEE_STATUS_SIGNED_OUT_VI,
  }
}

/**
 * Test helper: assert partition string is the shared one (login === scraper).
 */
export function assertSharedShopeePartition(partition: string): void {
  if (partition !== SHOPEE_SESSION_PARTITION) {
    throw new Error(
      `Shopee windows must use ${SHOPEE_SESSION_PARTITION}; got ${partition}`,
    )
  }
}
