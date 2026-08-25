import { app, BrowserWindow, Menu, safeStorage, screen, shell } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeDatabase, getDatabase, getDbStatus, openDatabase } from './db/connection'
import { seedDefaultTemplateIfEmpty } from './db/repositories/templateRepo'
import { registerClipboardHandlers } from './ipc/clipboard.ipc'
import { registerCopyHandlers } from './ipc/copy.ipc'
import { registerExcelHandlers } from './ipc/excel.ipc'
import { registerGroupHandlers } from './ipc/groups.ipc'
import { registerLicenseHandlers } from './ipc/license.ipc'
import { registerProductHandlers } from './ipc/products.ipc'
import { registerShopeeAuthHandlers } from './ipc/shopeeAuth.ipc'
import { registerTemplateHandlers } from './ipc/templates.ipc'
import { registerHandler } from './ipc/registry'
import {
  createLicenseService,
  setLicenseService,
} from './services/license.service'
import {
  createSecureStore,
  createWindowsRegistryStore,
} from './services/secureStore'
import { initLogging, logError, logInfo } from './services/log'

function resolveAppIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../../build/icon.ico'),
    join(__dirname, '../../build/icon.png'),
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(app.getAppPath(), 'build', 'icon.png'),
  ]
  return candidates.find((p) => existsSync(p))
}

function placeWindowOnScreen(win: BrowserWindow): void {
  const wa = screen.getPrimaryDisplay().workArea
  const b = win.getBounds()
  const offScreen =
    b.x < -200 ||
    b.y < -200 ||
    b.x > wa.x + wa.width - 80 ||
    b.y > wa.y + wa.height - 80
  if (offScreen || win.isMinimized()) {
    const width = Math.min(1440, Math.max(1040, wa.width - 80))
    const height = Math.min(900, Math.max(640, wa.height - 40))
    win.setBounds({
      x: wa.x + Math.max(20, Math.floor((wa.width - width) / 2)),
      y: wa.y + Math.max(16, Math.floor((wa.height - height) / 4)),
      width,
      height,
    })
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow(): BrowserWindow {
  const icon = resolveAppIcon()
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 640,
    show: true,
    center: true,
    ...(icon ? { icon } : {}),
    // No File/Edit/View menu — the app bar inside the window is the only chrome.
    autoHideMenuBar: true,
    title: 'ezaff — Quản lý link Affiliate',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.setMenuBarVisibility(false)
  placeWindowOnScreen(mainWindow)

  mainWindow.on('ready-to-show', () => {
    placeWindowOnScreen(mainWindow)
  })

  // The default menu also owns the DevTools shortcut; keep F12 during dev only.
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        mainWindow.webContents.toggleDevTools()
      }
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function registerIpc(): void {
  registerHandler('db:getStatus', null, () => getDbStatus())
  registerProductHandlers()
  registerGroupHandlers()
  registerTemplateHandlers()
  registerCopyHandlers()
  registerLicenseHandlers()
  registerExcelHandlers()
  registerShopeeAuthHandlers()
  registerClipboardHandlers()

  registerHandler('app:getVersion', null, () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
  }))
  registerHandler('app:getUpdateState', null, () =>
    updaterHandle?.state() ?? { status: 'idle' },
  )
  // Restarting is the user's call — we only ever offer.
  registerHandler('app:installUpdate', null, () => {
    updaterHandle?.installNow()
    return { ok: true }
  })
}

function initLicense(): void {
  const store = createSecureStore({
    userDataPath: app.getPath('userData'),
    registry: createWindowsRegistryStore(),
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plain) => safeStorage.encryptString(plain),
      decryptString: (buf) => safeStorage.decryptString(buf),
    },
  })
  const service = createLicenseService({ store })
  setLicenseService(service)
  void service
    .ensureInitialized()
    .then(async (record) => {
      // Seal local cache with installId-derived key
      try {
        const { initOwnerLinkCrypto } = await import(
          './services/ownerLinkCrypto'
        )
        initOwnerLinkCrypto(record.installId)
      } catch {
        // non-fatal
      }
      logInfo(
        '[ezaff] License ready — installId=',
        record.installId.slice(0, 8) + '…',
        'installed_at=',
        new Date(record.installed_at).toISOString(),
      )
    })
    .catch((err) => {
      logError('[ezaff] License init failed:', err)
    })
}

/** Live while the app runs; used to install a downloaded build on demand. */
let updaterHandle: import('./services/appUpdater').UpdaterHandle | null = null

function writeCrashLog(kind: string, err: unknown): void {
  try {
    const dir = app.isReady() ? app.getPath('userData') : process.cwd()
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
    writeFileSync(
      join(dir, 'crash.log'),
      `${new Date().toISOString()} ${kind}\n${text}\n`,
    )
  } catch {
    // last resort
  }
}

process.on('uncaughtException', (err) => {
  writeCrashLog('uncaughtException', err)
  console.error(err)
})
process.on('unhandledRejection', (err) => {
  writeCrashLog('unhandledRejection', err)
  console.error(err)
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) placeWindowOnScreen(win)
})

app.whenReady().then(() => {
  if (!gotLock) return
  // Decide logging before anything can log: released builds stay silent
  // unless EZAFF_DEBUG=1.
  initLogging(app.isPackaged)

  // Drop the default File/Edit/View/Window/Help menu app-wide.
  Menu.setApplicationMenu(null)

  const status = openDatabase()
  if (!status.ok) {
    logError('[ezaff] DB init failed:', status.error)
  } else {
    logInfo('[ezaff] DB ready at', status.path)
    logInfo('[ezaff] Tables:', status.tables.join(', '))
    try {
      const seeded = seedDefaultTemplateIfEmpty(getDatabase())
      if (seeded) {
        logInfo('[ezaff] Seeded starter template:', seeded.name)
      }
    } catch (err) {
      logError('[ezaff] Template seed failed:', err)
    }

    /*
     * Seed the shipped mapping table, then sync — in that order, because a
     * seeded version is what makes the first sync a small delta instead of a
     * full re-download of what the installer already carried.
     *
     * Dynamic import, not require: electron-vite bundles the main process and
     * a relative require() does not resolve in the output. It failed silently
     * here for exactly that reason — the seed never ran and every launch
     * pulled the whole bundle over the network instead.
     */
    void (async () => {
      try {
        const { importSeedBundle, readSeedFile, resolveSeedPath } =
          await import('./services/bundleSeed')
        const seedPath = resolveSeedPath(process.resourcesPath, app.getAppPath())
        const result = importSeedBundle(getDatabase(), {
          readSeed: () => readSeedFile(seedPath),
        })
        logInfo(
          result.imported > 0
            ? `[ezaff] Seeded catalog v${result.version} (${result.imported})`
            : `[ezaff] Seed: ${result.reason}`,
        )
        const { packLegacyBundleRows } = await import(
          './db/repositories/ownerLinkBundleRepo'
        )
        packLegacyBundleRows(getDatabase())
      } catch (err) {
        logError('[ezaff] Seed import failed:', err)
      }

      try {
        const { scheduleBundleSync } = await import('./services/bundleSync')
        scheduleBundleSync(getDatabase())
      } catch (err) {
        logError('[ezaff] Bundle sync failed to start:', err)
      }
    })()

    // Product metadata — optional, runs after the link bundle so a slow
    // connection spends what it has on the one that actually matters.
    void import('./services/metaSync')
      .then(({ scheduleMetaSync }) => scheduleMetaSync(getDatabase()))
      .catch((err) => logError('[ezaff] Meta sync failed to start:', err))

    // Report what the bundle still does not cover — the coverage meter.
    void import('./services/wantReport')
      .then(({ scheduleWantReport }) => scheduleWantReport(getDatabase()))
      .catch((err) => logError('[ezaff] Want report failed to start:', err))

    /*
     * Auto-update against github.com/tailolicon/ezaff-releases.
     *
     * This block used to sit behind an unconditional `return`, added while
     * publish.owner was still a placeholder so the app would not hit a
     * non-existent repo. The repo is real now, and that guard had become the
     * reason updates silently never ran — no log, no request, nothing.
     */
    void (async () => {
      try {
        if (!app.isPackaged) return
        const { startAppUpdater } = await import('./services/appUpdater')

        /*
         * electron-updater is CommonJS. Depending on how the main bundle is
         * emitted, `await import()` hands back either the module itself or
         * `{ default: module }` — and in the packaged build it was the latter,
         * so `autoUpdater` came out undefined and updates silently never ran.
         * Nothing surfaced in dev because the updater is disabled there.
         */
        const mod = (await import('electron-updater')) as unknown as {
          autoUpdater?: typeof import('electron-updater').autoUpdater
          default?: { autoUpdater?: typeof import('electron-updater').autoUpdater }
        }
        const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
        if (!autoUpdater) {
          logError('[ezaff] electron-updater không trả về autoUpdater')
          return
        }

        updaterHandle = startAppUpdater({
          updater: autoUpdater,
          isPackaged: app.isPackaged,
          onState: (state) => {
            /*
             * Log every state in debug builds. Only logging 'ready' and
             * 'error' made a working check indistinguishable from one that
             * never ran — both printed nothing.
             */
            logInfo('[ezaff] Update:', JSON.stringify(state))
            for (const win of BrowserWindow.getAllWindows()) {
              win.webContents.send('app:updateState', state)
            }
          },
        })
      } catch (err) {
        logError('[ezaff] Updater failed to start:', err)
      }
    })()
  }

  initLicense()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  closeDatabase()
})
