/**
 * App auto-update over GitHub Releases.
 *
 * Why this exists at all: the app has hard dependencies it cannot control.
 * The scraper tracks Shopee's markup, the owner-link Worker URL is compiled
 * in, and the bundle wire format will have to change once the mapping table
 * outgrows a single 25 MB KV value. Without a way to ship a fix, the day any
 * of those moves is the day every installed copy breaks for good.
 *
 * ── Deliberately quiet ────────────────────────────────────────────────────
 * Checks once at startup and then on a long timer, downloads in the
 * background, and never interrupts. The user is told a restart is pending and
 * decides when. Copying links is the job; an update dialog in the middle of
 * it is not.
 *
 * Unsigned builds update fine — code signing only affects the SmartScreen
 * warning on first install, which is a separate decision.
 */

import type { AppUpdater } from 'electron-updater'
import { isVerbose } from './log'

/** First check after launch: late enough not to compete with startup work. */
export const UPDATE_FIRST_CHECK_MS = 30_000
/** Then every six hours while the app stays open. */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'none' }
  | { status: 'error'; message: string }

export type UpdaterDeps = {
  /** Inject in tests. */
  updater?: Pick<
    AppUpdater,
    'on' | 'checkForUpdates' | 'quitAndInstall' | 'autoDownload' | 'autoInstallOnAppQuit'
  >
  /** Called on every state change so the UI can reflect it. */
  onState?: (state: UpdateState) => void
  isPackaged?: boolean
  setInterval?: typeof setInterval
  setTimeout?: typeof setTimeout
}

/**
 * A dev build has no published release to compare against, and running the
 * updater there just produces confusing errors on every launch.
 */
export function shouldRunUpdater(isPackaged: boolean): boolean {
  return isPackaged
}

export type UpdaterHandle = {
  state: () => UpdateState
  /** Install now — the renderer calls this when the user accepts a restart. */
  installNow: () => void
  stop: () => void
}

/**
 * Wire the updater's events to a single state value.
 *
 * Every failure path lands on 'error' and nothing throws: a broken update
 * check must never take the app down or block the copy flow.
 */
export function startAppUpdater(deps: UpdaterDeps = {}): UpdaterHandle {
  let state: UpdateState = { status: 'idle' }
  let timer: ReturnType<typeof setInterval> | null = null

  const setState = (next: UpdateState): void => {
    state = next
    try {
      deps.onState?.(next)
    } catch {
      // A UI listener throwing must not break the updater.
    }
  }

  const isPackaged = deps.isPackaged ?? false
  if (!shouldRunUpdater(isPackaged)) {
    setState({ status: 'idle' })
    return {
      state: () => state,
      installNow: () => {},
      stop: () => {},
    }
  }

  const updater = deps.updater
  if (!updater) {
    setState({ status: 'error', message: 'updater unavailable' })
    return { state: () => state, installNow: () => {}, stop: () => {} }
  }

  /*
   * electron-updater keeps its own logger, so silencing ours is not enough —
   * in a released build it was still printing "Checking for update" and a
   * full HTTP stack trace on every failed check. Errors still reach the user
   * through the update state; they do not need to reach the console.
   */
  if (!isVerbose()) {
    ;(updater as unknown as { logger: unknown }).logger = null
  }

  // Download silently; only the install needs the user's say-so.
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true

  updater.on('checking-for-update', () => setState({ status: 'checking' }))
  updater.on('update-available', (info: { version: string }) =>
    setState({ status: 'available', version: info.version }),
  )
  updater.on('update-not-available', () => setState({ status: 'none' }))
  updater.on('download-progress', (p: { percent: number }) =>
    setState({
      status: 'downloading',
      version: 'version' in state ? state.version : '',
      percent: Math.round(p.percent),
    }),
  )
  updater.on('update-downloaded', (info: { version: string }) =>
    setState({ status: 'ready', version: info.version }),
  )
  updater.on('error', (err: Error) =>
    setState({ status: 'error', message: err?.message ?? 'update failed' }),
  )

  const check = (): void => {
    try {
      void updater.checkForUpdates()?.catch((err: Error) => {
        setState({ status: 'error', message: err?.message ?? 'check failed' })
      })
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'check failed',
      })
    }
  }

  const timeoutFn = deps.setTimeout ?? setTimeout
  const intervalFn = deps.setInterval ?? setInterval

  timeoutFn(check, UPDATE_FIRST_CHECK_MS)
  timer = intervalFn(check, UPDATE_INTERVAL_MS)

  return {
    state: () => state,
    installNow: () => {
      // Only meaningful once a build is on disk; ignore otherwise.
      if (state.status !== 'ready') return
      try {
        updater.quitAndInstall()
      } catch {
        // Nothing useful to do — the pending build installs on next quit
        // anyway because autoInstallOnAppQuit is on.
      }
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
