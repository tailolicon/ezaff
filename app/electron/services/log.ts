/**
 * Main-process logging that stays quiet in released builds.
 *
 * Packaged builds print nothing by default: a shipped app has no business
 * narrating its internals into a console the user can attach to, and lines
 * like "Seeded 132178 owner links" are an invitation to go poking.
 *
 * ── What this is and is not ───────────────────────────────────────────────
 * This is noise reduction, not protection. Anyone who wants to read the
 * owner-link logic will unpack app.asar and read it directly — the log was
 * never the way in. What actually raises the bar is the electronFuses block
 * in electron-builder.yml (`onlyLoadAppFromAsar` plus asar integrity
 * validation), which makes a patched bundle refuse to run.
 *
 * Errors still print. A silent crash costs more than the information it
 * withholds, and error text alone gives nothing away about how the app works.
 *
 * Set EZAFF_DEBUG=1 to get everything back — without it, diagnosing a user's
 * problem in a released build would mean shipping them a special version.
 */

/** Assigned once at startup; dev builds and EZAFF_DEBUG=1 stay verbose. */
let verbose = true

export function initLogging(isPackaged: boolean): void {
  const forced =
    typeof process !== 'undefined' && process.env['EZAFF_DEBUG'] === '1'
  verbose = forced || !isPackaged
}

export function isVerbose(): boolean {
  return verbose
}

/** Progress and state. Silent in a released build. */
export function logInfo(...args: unknown[]): void {
  if (verbose) console.log(...args)
}

/** Recoverable problems. Silent in a released build. */
export function logWarn(...args: unknown[]): void {
  if (verbose) console.warn(...args)
}

/** Always printed — a silent failure is worse than a visible one. */
export function logError(...args: unknown[]): void {
  console.error(...args)
}
