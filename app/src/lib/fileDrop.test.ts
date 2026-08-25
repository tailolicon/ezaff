import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dragHasFiles,
  importablePathsFromDrop,
  isImportableName,
} from './fileDrop'

/** Minimal DragEvent stand-in — jsdom is not needed for these paths. */
function dropEvent(
  files: Array<{ name: string }>,
  types: string[] = ['Files'],
): DragEvent {
  return {
    dataTransfer: { files, types },
  } as unknown as DragEvent
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window
})

function stubBridge(pathFor: (file: { name: string }) => string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = {
    ezaff: { files: { getPath: pathFor } },
  }
}

describe('isImportableName', () => {
  it('accepts the spreadsheet formats the importer reads', () => {
    expect(isImportableName('export.csv')).toBe(true)
    expect(isImportableName('Lấy link hàng loạt.CSV')).toBe(true)
    expect(isImportableName('backup.xlsx')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isImportableName('photo.png')).toBe(false)
    expect(isImportableName('notes.txt')).toBe(false)
    expect(isImportableName('archive.csv.zip')).toBe(false)
  })
})

describe('dragHasFiles', () => {
  it('separates a file drag from a text drag', () => {
    expect(dragHasFiles(dropEvent([], ['Files']))).toBe(true)
    expect(dragHasFiles(dropEvent([], ['text/plain']))).toBe(false)
    expect(dragHasFiles({ dataTransfer: null } as unknown as DragEvent)).toBe(
      false,
    )
  })
})

describe('importablePathsFromDrop', () => {
  it('resolves paths through the preload bridge', () => {
    stubBridge((f) => `E:/Download/${f.name}`)
    expect(
      importablePathsFromDrop(dropEvent([{ name: 'export.csv' }])),
    ).toEqual(['E:/Download/export.csv'])
  })

  it('keeps only importable files out of a mixed drop', () => {
    stubBridge((f) => `C:/tmp/${f.name}`)
    const paths = importablePathsFromDrop(
      dropEvent([
        { name: 'photo.png' },
        { name: 'links.csv' },
        { name: 'backup.xlsx' },
      ]),
    )
    expect(paths).toEqual(['C:/tmp/links.csv', 'C:/tmp/backup.xlsx'])
  })

  it('returns nothing when there are no files', () => {
    stubBridge(() => 'x')
    expect(importablePathsFromDrop(dropEvent([]))).toEqual([])
  })

  it('does not throw when the bridge is unavailable', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = {}
    expect(() =>
      importablePathsFromDrop(dropEvent([{ name: 'a.csv' }])),
    ).not.toThrow()
    expect(importablePathsFromDrop(dropEvent([{ name: 'a.csv' }]))).toEqual([])
  })

  it('skips a file whose path cannot be resolved', () => {
    stubBridge(() => {
      throw new Error('no path')
    })
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(importablePathsFromDrop(dropEvent([{ name: 'a.csv' }]))).toEqual([])
    spy.mockRestore()
  })
})
