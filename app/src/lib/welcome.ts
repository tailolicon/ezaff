/** First-run welcome. Bump the key when the copy must be shown again. */
export const WELCOME_STORAGE_KEY = 'ezaff.welcome.v4'

export const WELCOME_SHARE_TEXT =
  'ezaff — trình quản lý link affiliate miễn phí. Không thu phí, không khóa. Mình đang dùng, thấy hữu ích — gửi bạn dùng chung.'

export function hasSeenWelcome(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): boolean {
  try {
    return storage.getItem(WELCOME_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function markWelcomeSeen(
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(WELCOME_STORAGE_KEY, '1')
  } catch {
    // Private mode / quota — treat as seen so we do not loop.
  }
}
