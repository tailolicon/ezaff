# ezaff

**ezaff** là ứng dụng desktop (Windows) giúp bạn lưu, phân loại và sao chép link affiliate — dành cho thị trường Việt Nam.

- Thêm link (Shopee quét sâu; sàn khác OpenGraph + sửa tay)
- Nhóm, tìm kiếm FTS, thư viện câu mời chào (template)
- Xuất / nhập Excel (backup đầy đủ kể cả link gốc)
- Sao chép nhanh: template mặc định hoặc chỉ link

## Dùng thử 1 ngày và cơ chế 5%

| Giai đoạn | Hành vi khi sao chép |
|---|---|
| **1 ngày dùng thử** (24 giờ kể từ lần chạy đầu) | **100%** dùng link affiliate của bạn |
| **Sau hết dùng thử** | Khoảng **5%** lượt copy dùng link affiliate của **tác giả app**; ~95% vẫn dùng link của bạn |

Đây là hình thức thanh toán cho phần mềm (không thu phí tiền mặt). Ứng dụng **không bao giờ** copy hụt vì backend lỗi: nếu không lấy được link tác giả thì luôn fallback về link của bạn.

- Tỉ lệ 5% khai báo đúng **một chỗ**: `OWNER_LINK_RATE_BP = 500` trong `app/electron/services/copyResolver.ts` (500/10000 = 5,00%).
- App **không** nhúng secret Shopee. Secret chỉ nằm ở Cloudflare Worker (`server/`).
- App **không** gửi link affiliate của bạn ra khỏi máy. Chỉ gửi: `platform`, `shopId`, `itemId`, `installId`.

Chi tiết điều khoản hiển thị trong app (gate bắt buộc lần đầu + Cài đặt → Điều khoản & Phí sử dụng), kèm bộ đếm minh bạch.

## Cấu trúc repo

```
ezaff/
├─ app/       # Electron + React + SQLite (better-sqlite3)
├─ server/    # Cloudflare Worker (Hono) — proxy link tác giả
├─ plan/      # Kế hoạch & brief Grok
└─ specify/   # Đặc tả chức năng
```

## Chạy development

### Ứng dụng desktop

Yêu cầu: Node.js 20+, Windows (khuyến nghị).

```bash
cd app
npm install
npm run dev
```

`npm run dev` mở Electron + Vite HMR. Dữ liệu SQLite nằm trong thư mục userData của Electron.

### Worker (tuỳ chọn, để test 5% với backend thật)

```bash
cd server
npm install
# Tạo file .dev.vars nếu cần (xem server/README.md)
npm run dev
# → http://127.0.0.1:8787
```

Trỏ app tới worker local bằng biến môi trường (process của Electron):

```text
EZAFF_OWNER_LINK_URL=http://127.0.0.1:8787
```

Nếu không chạy worker, sau hết trial app vẫn copy bình thường bằng link của bạn (fallback).

## Chạy kiểm thử

### Desktop (`app/`)

```bash
cd app
npm test
```

Script sẽ: rebuild `better-sqlite3` cho Node → chạy vitest → rebuild lại cho Electron.

Kiểm tra kiểu TypeScript:

```bash
cd app
npm run typecheck
```

### Worker (`server/`)

```bash
cd server
npm test
npm run typecheck
```

## Đóng gói installer Windows (NSIS x64)

```bash
cd app
npm install
npm run dist
```

Lệnh này:

1. `electron-vite build` (main / preload / renderer → `out/`)
2. Rebuild native `better-sqlite3` cho ABI Electron
3. `electron-builder --win nsis --x64`

Installer ra:

```text
app/dist/ezaff-<version>-setup.exe
```

Cấu hình: `app/electron-builder.yml`

- `appId`: `com.ezaff.app`
- `productName`: `ezaff`
- `asarUnpack`: `better-sqlite3` + file `.node` (bắt buộc để mở DB sau khi đóng gói)
- Ngôn ngữ installer: tiếng Việt (LCID 1066) nếu NSIS hỗ trợ
- Icon placeholder: `app/build/icon.ico` (thay bằng icon chính thức khi có)

Chỉ build thư mục (không NSIS), để debug:

```bash
cd app
npm run dist:dir
```

## Deploy Cloudflare Worker

```bash
cd server
npm install

# 1. Tạo KV namespace thật
npx wrangler kv namespace create ezaff-owner
npx wrangler kv namespace create ezaff-owner --preview

# 2. Ghi id vào wrangler.toml (binding OWNER_KV)

# 3. (Tuỳ chọn) bật Shopee Open API — xem mục biến môi trường bên dưới
npx wrangler secret put SHOPEE_APP_ID
npx wrangler secret put SHOPEE_SECRET

# 4. Nạp mapping thủ công (khi chưa có Open API)
npx wrangler kv key put --binding=OWNER_KV "owner:shopee:SHOP_ID:ITEM_ID" "https://s.shopee.vn/your-aff-code"

# 5. Deploy
npm run deploy
```

Sau deploy, cấu hình máy client (biến môi trường hệ thống hoặc shortcut):

```text
EZAFF_OWNER_LINK_URL=https://<worker-subdomain>.workers.dev
```

Chi tiết endpoint, provider chain và rate limit: `server/README.md`.

## Biến môi trường — bật Shopee Open API (sau này)

Hiện **chưa** có credential Shopee. Backend thiết kế dạng provider; bật Open API **không** cần sửa app desktop.

| Biến | Nơi đặt | Ý nghĩa |
|---|---|---|
| `SHOPEE_APP_ID` | Worker secret / `.dev.vars` | App ID Shopee Affiliate Open API |
| `SHOPEE_SECRET` | Worker secret / `.dev.vars` | Secret Shopee Affiliate Open API |

Cả hai phải **không rỗng** thì `shopeeOpenApiProvider` mới chạy. Thiếu một trong hai → provider tắt, fallback `mappingTable` → `passthrough` (`ownerUrl: null`).

| Biến (desktop) | Ý nghĩa |
|---|---|
| `EZAFF_OWNER_LINK_URL` | Base URL Worker (mặc định `http://127.0.0.1:8787`) |

**Tuyệt đối không** đặt `SHOPEE_SECRET` / `SHOPEE_APP_ID` trong app desktop hay commit vào git.

## Đăng nhập Shopee (tuỳ chọn)

Shopee đôi khi chặn tra cứu chi tiết sản phẩm (tên, giá, ảnh) với phiên ẩn danh. Bạn có thể **đăng nhập tài khoản Shopee của chính mình** trong app:

**Cài đặt → Tài khoản Shopee → Đăng nhập Shopee**

- Mở trang đăng nhập **chính thức của Shopee** trong cửa sổ thật (không headless).
- ezaff **không bao giờ** nhìn, lưu hay gửi tên đăng nhập / mật khẩu Shopee.
- Cookie / phiên chỉ lưu **trên máy này** (partition `persist:shopee`), dùng chung cho cửa sổ đăng nhập và bộ quét.
- **Không** gửi cookie hay phiên lên Cloudflare Worker. Body worker vẫn chỉ: `platform`, `shopId`, `itemId`, `installId`.
- Có thể **Đăng xuất / xoá phiên** bất cứ lúc nào.
- Không bắt buộc: không đăng nhập vẫn dùng app; khi quét thất bại bạn nhập tay tên/ảnh/giá.

## Quyền riêng tư (tóm tắt)

- Toàn bộ sản phẩm / link của bạn nằm local (SQLite).
- Phiên Shopee (nếu có) chỉ local — không rời máy.
- Mất mạng: vẫn dùng được mọi chức năng trừ quét link mới và (sau trial) lấy link tác giả — copy vẫn luôn fallback link của bạn.
- Không đồng bộ đám mây, không tài khoản người dùng ezaff.

## Giấy phép / mô hình

Phần mềm miễn phí tiền mặt. Chi phí vận hành bù bằng cơ chế ~5% lượt copy sau 1 ngày dùng thử, minh bạch trong điều khoản và bộ đếm trong app.
