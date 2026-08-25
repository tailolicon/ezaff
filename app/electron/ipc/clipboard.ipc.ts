import { clipboard } from 'electron'
import { extractLinks } from '../../shared/linkDetect'
import { registerHandler } from './registry'

export function registerClipboardHandlers(): void {
  /**
   * Read the clipboard and return ONLY the marketplace links found in it.
   * Runs in main so there is no renderer permission prompt, and unrelated
   * clipboard content (passwords, notes) never reaches the renderer.
   */
  registerHandler<null, string[]>('clipboard:readLinks', null, () => {
    return extractLinks(clipboard.readText())
  })
}
