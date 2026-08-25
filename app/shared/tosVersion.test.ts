import { describe, expect, it } from 'vitest'
import { TOS_VERSION as shared } from './tosVersion'
import { TOS_VERSION as fromLicense } from '../electron/services/license.service'
import { TOS_VERSION as fromRenderer } from '../src/lib/tos'

/**
 * Guard against silent drift: both process boundaries must use the shared constant.
 */
describe('TOS_VERSION single source of truth', () => {
  it('shared, license.service, and renderer tos.ts all match', () => {
    expect(shared).toBe('2.0')
    expect(fromLicense).toBe(shared)
    expect(fromRenderer).toBe(shared)
  })
})
