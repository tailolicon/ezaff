import { describe, expect, it } from 'vitest'
import {
  WELCOME_SHARE_TEXT,
  WELCOME_STORAGE_KEY,
  hasSeenWelcome,
  markWelcomeSeen,
} from './welcome'

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v
    },
  }
}

describe('welcome persistence', () => {
  it('is unseen on a fresh store', () => {
    expect(hasSeenWelcome(memoryStore())).toBe(false)
  })

  it('remembers after markWelcomeSeen', () => {
    const store = memoryStore()
    markWelcomeSeen(store)
    expect(store.getItem(WELCOME_STORAGE_KEY)).toBe('1')
    expect(hasSeenWelcome(store)).toBe(true)
  })

  it('has a share line that names the app and that it is free', () => {
    expect(WELCOME_SHARE_TEXT.toLowerCase()).toContain('ezaff')
    expect(WELCOME_SHARE_TEXT.toLowerCase()).toMatch(/miễn phí|không thu phí/)
  })
})
