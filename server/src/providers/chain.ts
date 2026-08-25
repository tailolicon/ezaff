import type {
  OwnerLinkProvider,
  OwnerLinkRequest,
  ProviderContext,
  ProviderResult,
} from '../types'
import { mappingTableProvider } from './mappingTable'
import { passthroughProvider } from './passthrough'
import { shopeeOpenApiProvider } from './shopeeOpenApi'

/** Default production provider order — first non-null ownerUrl wins. */
export const DEFAULT_PROVIDERS: OwnerLinkProvider[] = [
  shopeeOpenApiProvider,
  mappingTableProvider,
  passthroughProvider,
]

/**
 * Run providers in order. Stop at the first result with a non-null ownerUrl.
 * If every provider returns null / empty, return the last result (passthrough).
 */
export async function runProviderChain(
  req: OwnerLinkRequest,
  ctx: ProviderContext,
  providers: OwnerLinkProvider[] = DEFAULT_PROVIDERS,
): Promise<ProviderResult> {
  let last: ProviderResult = { ownerUrl: null, source: 'passthrough' }

  for (const provider of providers) {
    const result = await provider.resolve(req, ctx)
    if (result == null) {
      continue
    }
    last = result
    if (result.ownerUrl != null && result.ownerUrl.trim() !== '') {
      return {
        ownerUrl: result.ownerUrl.trim(),
        source: result.source,
      }
    }
  }

  return last
}
