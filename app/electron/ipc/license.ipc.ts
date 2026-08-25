import { getDatabase } from '../db/connection'
import { getCopyStats } from '../db/repositories/eventRepo'
import { getLicenseService, type LicenseStatus } from '../services/license.service'
import { registerHandler } from './registry'

/**
 * Public stats for Settings — total copies only.
 * usedOwner / byReason never leave the main process (anti-circumvention).
 */
export type PublicCopyStats = {
  total: number
  /** Always 0 over IPC — real count is main-only. */
  usedOwner: number
  ratePercent: number | null
  byReason: Array<{ reason: string; count: number }>
}

export function registerLicenseHandlers(): void {
  registerHandler<undefined, LicenseStatus>(
    'license:getStatus',
    null,
    async () => getLicenseService().getLicenseStatus(),
  )

  registerHandler<undefined, LicenseStatus>(
    'license:acceptTos',
    null,
    async () => getLicenseService().acceptTos(),
  )

  registerHandler<undefined, PublicCopyStats>(
    'license:getCopyStats',
    null,
    async () => {
      const stats = getCopyStats(getDatabase())
      return {
        total: stats.total,
        usedOwner: 0,
        ratePercent: null,
        byReason: [],
      }
    },
  )
}
