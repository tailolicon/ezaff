/** Spreadsheet formats the importer understands. */
const IMPORTABLE = /\.(csv|xlsx)$/i

export function isImportableName(name: string): boolean {
  return IMPORTABLE.test(name.trim())
}

/**
 * Absolute paths of importable files in a drop event.
 *
 * Electron 32+ removed `File.path`, so the real path has to come from
 * `webUtils.getPathForFile` behind the preload bridge.
 */
export function importablePathsFromDrop(event: DragEvent): string[] {
  const files = event.dataTransfer?.files
  if (!files || files.length === 0) return []

  const paths: string[] = []
  for (const file of Array.from(files)) {
    if (!isImportableName(file.name)) continue
    try {
      const path = window.ezaff?.files?.getPath(file)
      if (path) paths.push(path)
    } catch {
      // Older/newer Electron without the bridge — skip rather than crash.
    }
  }
  return paths
}

/** True when the drag carries files at all (vs. selected text). */
export function dragHasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  return types ? Array.from(types).includes('Files') : false
}

/**
 * Stop the window navigating to a dropped file.
 *
 * Without this, dropping anything onto an Electron window replaces the whole
 * app with that file — the window never comes back without a restart.
 */
export function installDropNavigationGuard(): () => void {
  const prevent = (e: DragEvent): void => {
    e.preventDefault()
  }
  window.addEventListener('dragover', prevent)
  window.addEventListener('drop', prevent)
  return () => {
    window.removeEventListener('dragover', prevent)
    window.removeEventListener('drop', prevent)
  }
}
