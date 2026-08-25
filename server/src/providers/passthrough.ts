import type { OwnerLinkProvider } from '../types'

/**
 * Terminal provider: always yields null so the desktop app falls back
 * to the user's own affiliate link (copy never fails).
 */
export const passthroughProvider: OwnerLinkProvider = {
  name: 'passthrough',
  async resolve() {
    return { ownerUrl: null, source: 'passthrough' }
  },
}
