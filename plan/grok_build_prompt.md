# BRIEF CHO GROK — đọc trước mỗi phase

Bạn đang xây dựng **ezaff**, ứng dụng desktop quản lý link affiliate cho thị trường Việt Nam.

## Tài liệu nguồn (đọc đủ cả hai trước khi code)
1. `specify/template.md` — đặc tả chức năng
2. `plan/current_plan.md` — kiến trúc, lược đồ DB, thứ tự 10 phase

## Quy tắc bất di bất dịch (vi phạm = làm lại)

1. **Không nhúng secret Shopee vào app desktop.** Mọi credential chỉ nằm ở Cloudflare Worker trong `server/`.
2. **Không gửi link affiliate của người dùng ra khỏi máy họ.** Chỉ được gửi lên backend: `platform`, `shopId`, `itemId`, `installId`.
3. **Copy không bao giờ thất bại.** Mọi nhánh lỗi trong `copyResolver.ts` đều fallback về link của người dùng. Hàm này không được throw ra ngoài.
4. **Tỉ lệ 5% khai báo đúng một chỗ:** hằng số `OWNER_LINK_RATE_BP = 500` trong `app/electron/services/copyResolver.ts`. Không hardcode 0.05 ở bất kỳ đâu khác.
5. **Không render link affiliate ở màn hình danh sách.** Chỉ hiện trong hộp thoại Sửa, mặc định che.
6. TypeScript `strict: true`. Không `any` ở biên IPC — validate bằng `zod`.
7. Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Mọi quyền hệ thống đi qua `preload.ts` + IPC có kiểm tra kiểu.
8. Toàn bộ chuỗi hiển thị cho người dùng bằng **tiếng Việt có dấu**.

## Cách làm việc
- Chỉ làm **đúng phase được giao**, không làm trước phase sau.
- Kết thúc phase phải để repo ở trạng thái **chạy được** (`npm run dev` không lỗi, `npx tsc --noEmit` sạch).
- Xong phase thì in ra: danh sách file đã tạo/sửa + lệnh để kiểm chứng thủ công.
- Không tự ý đổi lược đồ DB hay tên file so với `plan/current_plan.md`. Nếu thấy plan sai, dừng lại và nói rõ lý do thay vì tự sửa.
