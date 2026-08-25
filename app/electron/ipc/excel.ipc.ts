import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import { getDatabase } from '../db/connection'
import {
  confirmImport,
  exportProductsToFile,
  previewImportFromFile,
  type ConfirmImportResult,
  type ExportResult,
  type ImportPreview,
} from '../services/excel.service'
import { registerHandler } from './registry'

const confirmSchema = z.object({
  filePath: z.string().min(1, 'Đường dẫn file không hợp lệ'),
  overwrite: z.boolean().optional(),
})

const previewPathSchema = z.object({
  filePath: z.string().min(1, 'Đường dẫn file không hợp lệ'),
})

/** Optional selection — omit to export the whole library. */
const exportSchema = z
  .object({
    productIds: z.array(z.string().uuid()).optional(),
  })
  .nullish()

function activeWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

export type ExportDialogResult =
  | { cancelled: true }
  | { cancelled: false; result: ExportResult }

export type PreviewDialogResult =
  | { cancelled: true }
  | { cancelled: false; preview: ImportPreview }

export function registerExcelHandlers(): void {
  registerHandler<z.infer<typeof exportSchema>, ExportDialogResult>(
    'excel:export',
    exportSchema,
    async (_event, input) => {
      const selection = input?.productIds ?? null
      const win = activeWindow()
      const stamp = new Date().toISOString().slice(0, 10)
      const dialogOpts = {
        title:
          selection && selection.length > 0
            ? `Xuất ${selection.length} sản phẩm đã chọn`
            : 'Xuất danh sách sản phẩm',
        defaultPath:
          selection && selection.length > 0
            ? `ezaff_da_chon_${stamp}.xlsx`
            : `ezaff_san_pham_${stamp}.xlsx`,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      }
      const { canceled, filePath } = win
        ? await dialog.showSaveDialog(win, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts)

      if (canceled || !filePath) {
        return { cancelled: true }
      }

      const path = filePath.endsWith('.xlsx') ? filePath : `${filePath}.xlsx`
      const result = await exportProductsToFile(getDatabase(), path, selection)
      return { cancelled: false, result }
    },
  )

  registerHandler<void, PreviewDialogResult>(
    'excel:previewImport',
    null,
    async () => {
      const win = activeWindow()
      const dialogOpts = {
        title: 'Nhập sản phẩm từ Excel / CSV',
        filters: [
          { name: 'Excel hoặc CSV', extensions: ['xlsx', 'csv'] },
          { name: 'Excel', extensions: ['xlsx'] },
          { name: 'CSV (Shopee Affiliate)', extensions: ['csv'] },
        ],
        properties: ['openFile' as const],
      }
      const { canceled, filePaths } = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)

      if (canceled || !filePaths[0]) {
        return { cancelled: true }
      }

      const parsed = await previewImportFromFile(getDatabase(), filePaths[0])
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      // Do not send full row payloads to renderer (can be large); counts + summary
      const preview: ImportPreview = {
        ...parsed.preview,
        detection: parsed.preview.detection,
        // Keep rows for potential future detail UI; strip heavy payloads if huge
        rows: parsed.preview.rows.map((r) => ({
          rowNumber: r.rowNumber,
          status: r.status,
          reason: r.reason,
          original: r.original,
          // payload not needed in preview UI
        })),
      }
      return { cancelled: false, preview }
    },
  )

  /** Preview a file dropped onto the window — no open dialog. */
  registerHandler<z.infer<typeof previewPathSchema>, PreviewDialogResult>(
    'excel:previewImportPath',
    previewPathSchema,
    async (_event, input) => {
      const parsed = await previewImportFromFile(getDatabase(), input.filePath)
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      return { cancelled: false, preview: parsed.preview }
    },
  )

  registerHandler<z.infer<typeof confirmSchema>, ConfirmImportResult>(
    'excel:confirmImport',
    confirmSchema,
    async (_event, input) => {
      return confirmImport(getDatabase(), {
        filePath: input.filePath,
        overwrite: input.overwrite,
        queueRescrape: true,
        // Let the library refresh as each product finishes scraping.
        onRescrapeProgress: (done, total) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('products:rescrapeProgress', { done, total })
          }
        },
      })
    },
  )
}
