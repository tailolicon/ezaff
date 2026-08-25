@echo off
REM ═══════════════════════════════════════════════════════════════════
REM  ezaff — BẤM ĐÚP FILE NÀY LÀ CHẠY ĐƯỢC TẤT CẢ
REM
REM  Mở 2 cửa sổ:
REM    1. Trình chạy  — đăng video, tự bật lại nếu chết
REM    2. Giao diện   — quản lý kênh/Page, tự mở trình duyệt
REM
REM  Đóng cửa sổ nào là tắt phần đó. Cả hai đều sống độc lập, không phụ
REM  thuộc vào cửa sổ chat hay bất kỳ chương trình nào khác.
REM ═══════════════════════════════════════════════════════════════════

cd /d "%~dp0\.."

echo Dang mo trinh chay (cua so rieng) ...
start "ezaff - trinh chay" cmd /k "tools\ezaff-chay-mai.cmd"

timeout /t 3 /nobreak >nul

echo Dang mo giao dien ...
set PYTHONIOENCODING=utf-8
start "ezaff - giao dien" cmd /k "python -u tools\ezaff-ui.py"

echo.
echo Xong. Hai cua so da mo, trinh duyet se tu bat len.
echo Cua so nay dong duoc.
timeout /t 6 /nobreak >nul
