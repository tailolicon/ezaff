/**
 * Opaque reason codes stored in copy_events.reason.
 * Casual SQLite inspection should not show "owner" / "not_rolled" strings.
 */

import type { CopyReason } from './copyResolver'

/** Wire codes only — never expose human labels via IPC. */
const REASON_TO_CODE: Record<CopyReason, string> = {
  trial: 'a7',
  not_rolled: 'b3',
  owner: 'c9',
  owner_unavailable: 'd1',
  user_link: 'e4',
  no_owner_mapping: 'f2',
  quota_met: 'g8',
}

const CODE_TO_REASON: Record<string, CopyReason> = Object.fromEntries(
  Object.entries(REASON_TO_CODE).map(([k, v]) => [v, k as CopyReason]),
) as Record<string, CopyReason>

export function encodeCopyReason(reason: CopyReason | string): string {
  if (reason in REASON_TO_CODE) {
    return REASON_TO_CODE[reason as CopyReason]
  }
  // Legacy plaintext reasons already in DB
  if (reason in CODE_TO_REASON) return reason
  return REASON_TO_CODE.user_link
}

export function decodeCopyReason(code: string | null | undefined): string {
  if (!code) return 'user_link'
  if (code in CODE_TO_REASON) return CODE_TO_REASON[code]!
  // Legacy rows stored full reason strings
  return code
}
