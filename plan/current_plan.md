# Kế hoạch kiến trúc — ezaff v1

> Nguồn: `specify/template.md` v1.0. Tuân thủ `.specify/memory/constitution.md` (typed, error handling ở biên, self-documenting).

## 1. Cấu trúc thư mục

```
ezaff/
├─ app/                          # Electron desktop
│  ├─ electron/
│  │  ├─ main.ts                 # tạo cửa sổ, đăng ký IPC, khởi tạo DB
│  │  ├─ preload.ts              # contextBridge, chỉ expose API đã khai kiểu
│  │  ├─ ipc/
│  │  │  ├─ registry.ts          # bọc handler + zod validate + try/catch chuẩn
│  │  │  ├─ products.ipc.ts
│  │  │  ├─ groups.ipc.ts
│  │  │  ├─ templates.ipc.ts
│  │  │  ├─ copy.ipc.ts
│  │  │  ├─ excel.ipc.ts
│  │  │  └─ license.ipc.ts
│  │  ├─ db/
│  │  │  ├─ connection.ts        # better-sqlite3, WAL, foreign_keys ON
│  │  │  ├─ migrations/001_init.sql …
│  │  │  └─ repositories/*.ts    # productRepo, groupRepo, templateRepo, eventRepo
│  │  └─ services/
│  │     ├─ scraper/
│  │     │  ├─ types.ts          # interface Scraper { match(url); scrape(url) }
│  │     │  ├─ registry.ts       # chọn scraper theo domain
│  │     │  ├─ shopee.scraper.ts
│  │     │  ├─ opengraph.scraper.ts   # mặc định cho mọi sàn khác
│  │     │  ├─ urlNormalizer.ts  # canonical_key, theo redirect
│  │     │  └─ imageCache.ts
│  │     ├─ ownerLink.client.ts  # gọi Cloudflare Worker, cache 30 ngày
│  │     ├─ copyResolver.ts      # ⭐ TOÀN BỘ logic 5% nằm ở đây, 1 file duy nhất
│  │     ├─ templateRenderer.ts  # thay {link} {ten} {gia} {shop}
│  │     ├─ license.service.ts   # trial + chống chỉnh giờ
│  │     ├─ secureStore.ts       # safeStorage + registry HKCU
│  │     └─ excel.service.ts
│  └─ src/                       # React renderer (Vite)
│     ├─ App.tsx
│     ├─ pages/{Library,Settings,Terms}.tsx
│     ├─ components/{ProductCard,ProductGrid,AddLinkBar,GroupSidebar,
│     │              CopyButton,TemplatePicker,EditProductDialog,
│     │              ImportPreview,TrialBanner,TermsGate}.tsx
│     ├─ store/                  # zustand
│     └─ styles/
├─ server/                       # Cloudflare Worker (Hono)
│  ├─ src/index.ts
│  ├─ src/providers/{shopeeOpenApi,mappingTable,passthrough}.ts
│  └─ wrangler.toml
└─ shared/types.ts               # kiểu dùng chung app ↔ server
```

## 2. Lược đồ SQLite

```sql
products(
  id TEXT PK, platform TEXT, original_url TEXT, canonical_key TEXT UNIQUE,
  item_id TEXT, shop_id TEXT, title TEXT, image_url TEXT, image_local TEXT,
  price INTEGER, currency TEXT DEFAULT 'VND', category TEXT, shop_name TEXT,
  note TEXT, scrape_status TEXT, scrape_error TEXT,
  created_at INTEGER, updated_at INTEGER
)
groups(id TEXT PK, name TEXT UNIQUE, color TEXT, sort_order INTEGER, created_at INTEGER)
product_groups(product_id, group_id, PRIMARY KEY(product_id, group_id))  -- nhiều-nhiều
templates(id TEXT PK, name TEXT, content TEXT, is_default INTEGER, created_at INTEGER)
copy_events(id INTEGER PK, product_id TEXT, template_id TEXT,
            used_owner INTEGER, reason TEXT, created_at INTEGER)
owner_link_cache(canonical_key TEXT PK, owner_url TEXT, fetched_at INTEGER, expires_at INTEGER)
settings(key TEXT PK, value TEXT)
products_fts  -- FTS5 ảo trên title, note, shop_name, category
```

## 3. `copyResolver.ts` — hợp đồng duy nhất của cơ chế 5%

```ts
export const OWNER_LINK_RATE_BP = 500; // 500/10000 = 5.00% — chỉnh tỉ lệ DUY NHẤT tại đây

export async function resolveCopyText(productId, templateId): Promise<CopyResult> {
  // 1. trial còn hạn  → link user, reason 'trial'
  // 2. crypto.randomInt(10000) >= RATE → link user, reason 'not_rolled'
  // 3. trúng: cache local → hit thì dùng
  // 4. cache miss: gọi Worker, timeout 1500ms
  //    thành công → link tác giả, used_owner = true
  //    lỗi/không có → LINK USER, used_owner = false, reason 'owner_unavailable'
  // 5. render qua templateRenderer, ghi copy_events, trả về chuỗi hoàn chỉnh
}
```
Bất biến: **hàm này không bao giờ throw ra ngoài**. Mọi nhánh lỗi đều trả về link của user.

## 4. Cloudflare Worker

- `POST /v1/owner-link` → body `{platform, itemId, shopId, installId}` → `{ownerUrl: string|null, source}`
- Chuỗi provider theo thứ tự, provider đầu tiên trả kết quả thì dừng:
  1. `shopeeOpenApiProvider` — chỉ bật khi có `SHOPEE_APP_ID` + `SHOPEE_SECRET` trong env (hiện **tắt**)
  2. `mappingTableProvider` — tra KV `owner:{platform}:{shopId}:{itemId}`, do chủ app nạp sẵn
  3. `passthroughProvider` — trả `null` (app tự fallback)
- KV cache 30 ngày. Rate limit 60 req/phút theo `installId`.
- Worker **không ghi log** link affiliate của người dùng (app cũng không gửi).

## 5. Thứ tự thực hiện (mỗi bước phải chạy được rồi mới sang bước sau)

| # | Bước | Định nghĩa "xong" |
|---|---|---|
| 1 | Khung Electron + Vite + TS strict + SQLite + migrations | `npm run dev` mở app, DB tạo được bảng |
| 2 | CRUD sản phẩm + grid ảo hoá + ẩn link | Thêm/sửa/xoá tay chạy được, không chỗ nào lộ link |
| 3 | Scraper registry + OpenGraph + Shopee + cache ảnh | Dán link Shopee ra đúng tên/ảnh/giá; sàn khác ra og |
| 4 | Nhóm + tìm kiếm FTS + bộ lọc | Lọc theo nhóm, gõ tìm ra kết quả tức thì |
| 5 | Template + nút copy + templateRenderer | Copy ra `câu mời + link` đúng định dạng |
| 6 | License service + chống chỉnh giờ + TermsGate | Trial đếm ngược; chỉnh lùi giờ ⇒ hết trial |
| 7 | Cloudflare Worker + ownerLink client + copyResolver 5% | Test tỉ lệ: 10.000 lần copy giả lập ⇒ 500 ± 50 lượt owner |
| 8 | Excel xuất/nhập + màn hình xem trước | Xuất rồi nhập lại ⇒ dữ liệu khớp 100% |
| 9 | Trang Điều khoản & bộ đếm minh bạch | Hiện đúng M/N |
| 10 | Đóng gói electron-builder (NSIS) | Ra file .exe cài được |

## 6. Kiểm thử bắt buộc (vitest)

- `copyResolver`: trial ⇒ luôn link user; hết trial + backend chết ⇒ luôn link user; 10.000 vòng ⇒ tỉ lệ 5% ±1%.
- `urlNormalizer`: 8 định dạng link Shopee ⇒ cùng 1 `canonical_key`.
- `templateRenderer`: thiếu `{link}` ⇒ tự nối cuối; các biến thay đúng.
- `license.service`: chỉnh giờ lùi ⇒ `clock_tampered`; xoá 1 trong 2 kho lưu ⇒ lấy mốc cũ nhất.
- `excel.service`: vòng xuất → nhập giữ nguyên dữ liệu; dòng lỗi vào file lỗi.

## 7. Điều bắt buộc không được vi phạm

1. Không nhúng secret Shopee vào app desktop.
2. Không gửi link affiliate của người dùng ra khỏi máy họ.
3. Copy không bao giờ thất bại vì backend.
4. Tỉ lệ 5% chỉ khai báo tại `OWNER_LINK_RATE_BP`, không rải rác.
5. Không render link affiliate ở màn hình danh sách.
