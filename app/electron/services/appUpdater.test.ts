import { describe, expect, it, vi } from 'vitest'
import {
  shouldRunUpdater,
  startAppUpdater,
  UPDATE_FIRST_CHECK_MS,
  UPDATE_INTERVAL_MS,
  type UpdateState,
} from './appUpdater'

/** Stand-in for electron-updater's event emitter surface. */
function fakeUpdater() {
  const handlers = new Map<string, (payload?: unknown) => void>()
  const checkForUpdates = vi.fn(async () => ({}))
  const quitAndInstall = vi.fn()
  return {
    updater: {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      on: (event: string, fn: (payload?: unknown) => void) => {
        handlers.set(event, fn)
      },
      checkForUpdates,
      quitAndInstall,
    } as never,
    emit: (event: string, payload?: unknown) => handlers.get(event)?.(payload),
    checkForUpdates,
    quitAndInstall,
  }
}

function harness(overrides: { isPackaged?: boolean } = {}) {
  const f = fakeUpdater()
  const states: UpdateState[] = []
  const timeouts: Array<[() => void, number]> = []
  const intervals: Array<[() => void, number]> = []

  const handle = startAppUpdater({
    updater: f.updater,
    isPackaged: overrides.isPackaged ?? true,
    onState: (s) => states.push(s),
    setTimeout: ((fn: () => void, ms: number) => {
      timeouts.push([fn, ms])
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout,
    setInterval: ((fn: () => void, ms: number) => {
      intervals.push([fn, ms])
      return 0 as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval,
  })

  return { ...f, handle, states, timeouts, intervals }
}

describe('shouldRunUpdater', () => {
  it('runs only in packaged builds', () => {
    expect(shouldRunUpdater(true)).toBe(true)
    // A dev build has no published release to compare against; checking there
    // just produces an error on every launch.
    expect(shouldRunUpdater(false)).toBe(false)
  })
})

describe('startAppUpdater', () => {
  it('does nothing at all in a dev build', () => {
    const h = harness({ isPackaged: false })
    expect(h.checkForUpdates).not.toHaveBeenCalled()
    expect(h.timeouts).toHaveLength(0)
    expect(h.intervals).toHaveLength(0)
    expect(h.handle.state()).toEqual({ status: 'idle' })
  })

  it('delays the first check and then repeats on a long interval', () => {
    const h = harness()
    expect(h.timeouts[0]?.[1]).toBe(UPDATE_FIRST_CHECK_MS)
    expect(h.intervals[0]?.[1]).toBe(UPDATE_INTERVAL_MS)
    // Nothing fires until the timer does — startup stays uncontended.
    expect(h.checkForUpdates).not.toHaveBeenCalled()
    h.timeouts[0]?.[0]()
    expect(h.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('downloads on its own but never installs on its own', () => {
    const h = harness()
    expect(h.updater.autoDownload).toBe(true)
    h.emit('update-downloaded', { version: '1.2.0' })
    expect(h.handle.state()).toEqual({ status: 'ready', version: '1.2.0' })
    // Downloaded is not installed — the restart waits for the user.
    expect(h.quitAndInstall).not.toHaveBeenCalled()
  })

  it('tracks the whole lifecycle into one state value', () => {
    const h = harness()
    h.emit('checking-for-update')
    expect(h.handle.state()).toEqual({ status: 'checking' })

    h.emit('update-available', { version: '1.2.0' })
    expect(h.handle.state()).toEqual({ status: 'available', version: '1.2.0' })

    h.emit('download-progress', { percent: 41.7 })
    expect(h.handle.state()).toMatchObject({
      status: 'downloading',
      percent: 42,
    })

    h.emit('update-downloaded', { version: '1.2.0' })
    expect(h.handle.state()).toEqual({ status: 'ready', version: '1.2.0' })
  })

  it('reports "none" when already current', () => {
    const h = harness()
    h.emit('update-not-available')
    expect(h.handle.state()).toEqual({ status: 'none' })
  })

  it('turns an updater error into state, not a crash', () => {
    const h = harness()
    expect(() => h.emit('error', new Error('network down'))).not.toThrow()
    expect(h.handle.state()).toEqual({
      status: 'error',
      message: 'network down',
    })
  })

  it('installNow does nothing unless a build is actually downloaded', () => {
    const h = harness()
    h.handle.installNow()
    expect(h.quitAndInstall).not.toHaveBeenCalled()

    h.emit('update-downloaded', { version: '1.2.0' })
    h.handle.installNow()
    expect(h.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('a throwing UI listener cannot break the updater', () => {
    const f = fakeUpdater()
    const handle = startAppUpdater({
      updater: f.updater,
      isPackaged: true,
      onState: () => {
        throw new Error('renderer gone')
      },
      setTimeout: (() => 0) as unknown as typeof setTimeout,
      setInterval: (() => 0) as unknown as typeof setInterval,
    })
    expect(() => f.emit('update-not-available')).not.toThrow()
    expect(handle.state()).toEqual({ status: 'none' })
  })
})
