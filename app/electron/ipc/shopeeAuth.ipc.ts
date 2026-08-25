/**
 * IPC for optional Shopee sign-in (Phase 11).
 *
 * No credentials ever cross this boundary — only status / open-window / sign-out.
 */
import {
  getShopeeAuthStatus,
  openShopeeLoginWindow,
  signOutShopee,
  type ShopeeAuthStatus,
  type ShopeeLoginResult,
  type ShopeeSignOutResult,
} from '../services/scraper/shopeeSession'
import { registerHandler } from './registry'

export function registerShopeeAuthHandlers(): void {
  registerHandler<undefined, ShopeeAuthStatus>(
    'shopeeAuth:getStatus',
    null,
    async () => getShopeeAuthStatus(),
  )

  registerHandler<undefined, ShopeeLoginResult>(
    'shopeeAuth:openLogin',
    null,
    async () => openShopeeLoginWindow(),
  )

  registerHandler<undefined, ShopeeSignOutResult>(
    'shopeeAuth:signOut',
    null,
    async () => signOutShopee(),
  )
}
