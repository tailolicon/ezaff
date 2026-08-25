import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ZodType } from 'zod'

export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

type Handler<TInput, TOutput> = (
  event: IpcMainInvokeEvent,
  input: TInput,
) => TOutput | Promise<TOutput>

/**
 * Registers an IPC invoke handler with optional zod validation and
 * standardized try/catch envelope.
 */
export function registerHandler<TInput, TOutput>(
  channel: string,
  schema: ZodType<TInput> | null,
  handler: Handler<TInput, TOutput>,
): void {
  ipcMain.handle(
    channel,
    async (event, raw: unknown): Promise<IpcResult<TOutput>> => {
      try {
        const input =
          schema === null
            ? (undefined as TInput)
            : schema.parse(raw === undefined ? null : raw)
        const data = await handler(event, input)
        return { success: true, data }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message }
      }
    },
  )
}
