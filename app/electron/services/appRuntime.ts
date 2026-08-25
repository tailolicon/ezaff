/**
 * Runtime mode helpers for monetization / owner-link hardening.
 *
 * Packaged production builds MUST ignore developer override env vars
 * (rate, force-paid, local test owner URL). Those exist only for author testing.
 */

let packagedOverride: boolean | null = null

/** Inject for unit tests (null = re-read from Electron). */
export function setPackagedOverrideForTests(value: boolean | null): void {
  packagedOverride = value
}

/**
 * True when running inside a packaged app (NSIS/exe), not `electron-vite dev`.
 */
export function isAppPackaged(): boolean {
  if (packagedOverride !== null) return packagedOverride
  try {
    // Lazy require so vitest pure unit tests without electron still work.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    return Boolean(app?.isPackaged)
  } catch {
    return false
  }
}

/**
 * Dev-only overrides (EZAFF_FORCE_PAID, EZAFF_OWNER_LINK_RATE_BP, test owner URL)
 * are allowed only when NOT packaged.
 */
export function isDevOwnerOverridesAllowed(): boolean {
  return !isAppPackaged()
}
