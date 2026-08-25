# Spec: ezaff — Trình quản lý link Affiliate (Desktop)

> Trạng thái: v1.0 — chốt sau 3 vòng hỏi đáp với chủ dự án (2026-08-05)
> Mô hình kinh doanh: người dùng không trả tiền; sau 1 ngày dùng thử, ~5% số lần copy sẽ dùng link affiliate của tác giả app.

---

## 1. Quyết định đã chốt

| Hạng mục | Quyết định |
|---|---|
| Stack | Electron + React + TypeScript + SQLite (better-sqlite3) |
| Sàn hỗ trợ | Đa sàn tổng quát. Shopee = quét sâu; sàn khác = quét OpenGraph + sửa tay |
| Link aff của tác giả | Backend proxy trên Cloudflare Workers (app KHÔNG chứa secret) |
| Shopee Open API | **Chưa có credential** → backend thiết kế dạng provider, tạm dùng mapping table |
| Trial | 1 ngày, offline hoàn toàn, chống chỉnh giờ hệ thống |
| Cơ chế 5% | Random mỗi lần copy; nếu không lấy được link tác giả → **fallback link user** (không bao giờ copy hụt) |
| Group | Chỉ dùng để lọc/phân loại. Không copy hàng loạt |
| Template | Thư viện dùng chung, chọn khi copy, hỗ trợ biến `{link}` `{ten}` `{gia}` |
| Excel | Xuất/nhập đầy đủ kể cả link gốc (để backup) |
| Ngôn ngữ UI | Tiếng Việt |

---

## 2. Yêu cầu chức năng

### FR-1 — Điều khoản sử dụng (gate bắt buộc)
- Lần chạy đầu tiên hiện modal toàn màn hình, **không đóng được bằng Esc / click ra ngoài**.
- Nút "Đồng ý" chỉ bật khi: (a) người dùng đã cuộn xuống cuối văn bản, VÀ (b) đã tick checkbox riêng biệt:
  > ☐ Tôi hiểu rằng sau 1 ngày dùng thử, khoảng **5% số lần sao chép** sẽ sử dụng link affiliate của tác giả app thay cho link của tôi. Đây là hình thức thanh toán cho phần mềm.
- Lưu `tos_version` + `tos_accepted_at`. Đổi phiên bản điều khoản ⇒ hiện lại.
- Điều khoản luôn xem lại được ở **Cài đặt → Điều khoản & Phí sử dụng**, kèm bộ đếm minh bạch:
  `Tổng lượt copy: N — Lượt dùng link tác giả: M (tỉ lệ thực tế: M/N %)`

### FR-2 — Thêm link affiliate
- Ô dán link ở đầu app; hỗ trợ dán 1 link hoặc nhiều link (mỗi dòng 1 link).
- Nhận diện sàn từ domain → chọn scraper tương ứng.
- Quét tự động và hiển thị: **tên sản phẩm, ảnh, giá, danh mục, tên shop**.
- Trạng thái quét hiển thị rõ: `Đang quét` → `Xong` / `Lỗi (nhập tay)`.
- Quét thất bại **không chặn việc lưu**: vẫn lưu link, cho user tự điền tên/ảnh.
- Chống trùng: cùng `canonical_key` (platform + shopId + itemId, hoặc URL đã chuẩn hoá) → cảnh báo và hỏi ghi đè hay bỏ qua.

### FR-3 — Nhận diện & quét Shopee (sâu)
Định dạng đầu vào phải xử lý được:
- `https://shopee.vn/<slug>-i.<shopId>.<itemId>`
- `https://shopee.vn/product/<shopId>/<itemId>`
- `https://s.shopee.vn/<code>` (shortlink → phải theo redirect)
- Link đã gắn tham số affiliate (`af_id`, `smtt`, `utm_*`, `pid`, `sub_id`…)

Quy trình:
1. Theo redirect để lấy URL cuối (dùng `net` của Electron, giữ User-Agent thật).
2. Regex bóc `shopId` / `itemId`.
3. Gọi endpoint chi tiết sản phẩm của Shopee với header trình duyệt hợp lệ.
4. Nếu bị chặn → fallback mở `BrowserWindow` ẩn, render trang, đọc thẻ `og:title` / `og:image` / JSON-LD.
5. Tải ảnh về `userData/images/<hash>.jpg` để hiển thị offline; URL gốc vẫn lưu.

### FR-4 — Quét sàn khác (OpenGraph)
- Đọc `og:title`, `og:image`, `og:description`, `product:price:amount`, JSON-LD `Product`.
- Thiếu trường nào để trống, user tự điền. Có nút "Quét lại".

### FR-5 — Ẩn link trong giao diện
- Card sản phẩm hiển thị: ảnh, tên, giá, chip nhóm, ghi chú. **Tuyệt đối không render link.**
- Link chỉ hiện trong hộp thoại *Sửa sản phẩm*, mặc định che (`https://s.shopee.vn/••••••`), có nút 👁 để hiện.

### FR-6 — Nhóm (Group)
- Quan hệ nhiều-nhiều: 1 sản phẩm thuộc nhiều nhóm.
- Nhóm có tên + màu. Sidebar liệt kê nhóm kèm số lượng.
- Dùng để **lọc** danh sách. Không có chức năng copy hàng loạt.

### FR-7 — Thư viện câu mời chào (Template)
- CRUD template ở Cài đặt. Mỗi template: tên gợi nhớ + nội dung.
- Biến hỗ trợ: `{link}` (bắt buộc), `{ten}`, `{gia}`, `{shop}`.
- Nếu nội dung không chứa `{link}` → tự nối link vào cuối.
- Ví dụ: `sản phẩm em dùng trong video:{link}` → `sản phẩm em dùng trong video:https://s.shopee.vn/abc123`
- Đánh dấu 1 template là mặc định.
- Trên card: nút **Sao chép** (dùng template mặc định) + mũi tên xổ danh sách chọn template khác. Có mục "Chỉ link (không câu mời)".

### FR-8 — Tìm kiếm & lọc
- Tìm full-text theo tên + ghi chú + tên shop + danh mục (SQLite FTS5), gõ tới đâu lọc tới đó.
- Lọc theo: nhóm, sàn, khoảng giá, ngày thêm.
- Sắp xếp: mới nhất / tên A-Z / giá / hay dùng nhất.

### FR-9 — Xuất / nhập Excel
- **Xuất** (.xlsx, exceljs) — cột: `Tên sản phẩm | Link aff | URL ảnh | Nhóm (phân tách bằng ;) | Sàn | Danh mục | Giá | Tên shop | Ghi chú | Template | Ngày thêm`
- **Nhập**: chọn file → **màn hình xem trước** (số dòng hợp lệ / trùng / lỗi) → xác nhận mới ghi vào DB.
- Dòng lỗi được xuất ra file `loi_nhap_<timestamp>.xlsx` kèm cột lý do.
- Nhập xong tự động xếp hàng quét bổ sung cho các dòng thiếu tên/ảnh.

### FR-10 — Dùng thử & cơ chế 5%
- Trial 1 ngày (24 giờ) kể từ lần chạy đầu.
- Trong trial: **100% dùng link của user**. Banner đếm ngược thời gian còn lại.
- Hết trial: mỗi lần copy gieo xác suất 5% (`OWNER_LINK_RATE_BP = 500` basis point, khai báo hằng số 1 chỗ).
  - Trúng → gọi backend lấy link tác giả (timeout 1500ms, có cache local 30 ngày).
  - Backend lỗi / không có link → **dùng link của user**, ghi nhận `used_owner = false`.
- Mọi lần copy ghi vào bảng `copy_events` để hiển thị bộ đếm minh bạch ở FR-1.
- Ứng dụng **không bao giờ báo copy thất bại** vì lý do backend.

### FR-11 — Chống chỉnh giờ hệ thống
- Lưu `installed_at` và `max_seen_time` (mốc thời gian lớn nhất từng thấy).
- Mỗi lần khởi động: nếu `now < max_seen_time - 5 phút` ⇒ đánh dấu `clock_tampered = true` ⇒ coi như hết trial.
- Lưu ở 2 nơi: file mã hoá bằng Electron `safeStorage` trong `userData`, và bản sao ở `HKCU\Software\ezaff`. Thiếu 1 trong 2 hoặc lệch nhau ⇒ lấy mốc **cũ nhất** (bất lợi cho việc reset trial).

---

## 3. Yêu cầu phi chức năng

- **Riêng tư:** app **chỉ** gửi lên backend `platform`, `shopId`, `itemId`, `installId` (ngẫu nhiên). **Không bao giờ** gửi link affiliate của người dùng, danh sách sản phẩm, hay bất kỳ dữ liệu cá nhân nào. Phải ghi rõ điều này trong điều khoản.
- **Offline-first:** toàn bộ dữ liệu nằm trong SQLite local. Mất mạng vẫn dùng được mọi chức năng trừ quét link mới.
- **Bảo mật Electron:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, mọi quyền hệ thống đi qua preload + IPC có kiểm tra kiểu.
- **Hiệu năng:** danh sách 5.000 sản phẩm phải cuộn mượt (virtualized list). Copy phải phản hồi < 200ms ở nhánh không gọi mạng.
- **Kiểu dữ liệu:** TypeScript strict, không `any` ở biên IPC. Validate bằng zod.

---

## 4. Ngoài phạm vi v1
- Đồng bộ nhiều máy / tài khoản đám mây.
- Copy hàng loạt cả nhóm.
- Bản macOS / Linux (code không được khoá cứng vào Windows, nhưng chỉ build & test Windows).
- Thống kê doanh thu affiliate.

---

## 5. Rủi ro đã ghi nhận

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Chính sách affiliate của sàn cấm sai lệch quy kết hoa hồng → khoá tài khoản tác giả | **Cao** | Điều khoản minh bạch có checkbox riêng + bộ đếm công khai. Tỉ lệ chỉnh được ở 1 hằng số để hạ/tắt nhanh |
| Shopee đổi API / chặn bot | Cao | 3 tầng: API → webview ẩn → nhập tay. Không tầng nào chặn việc lưu link |
| Chưa có Shopee Open API credential | Trung bình | Backend dạng provider; bật Open API sau bằng biến môi trường, không phải sửa app |
| User bẻ khoá trial | Trung bình | Chấp nhận. Trial offline không thể chống tuyệt đối |
| Lộ secret | Thấp | Secret chỉ nằm ở Cloudflare Worker, không nằm trong app |
