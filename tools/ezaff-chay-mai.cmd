@echo off
REM Chạy ezaff liên tục, tự bật lại nếu tiến trình chết.
REM
REM 2026-08-11 23:45: cả mẻ chạy chết vì mất mạng qua đêm
REM ("Failed to resolve graph.facebook.com"), sáng ra không ai đăng tiếp.
REM File này bọc ngoài để chuyện đó không lặp lại.
REM
REM Dùng: bấm đúp file này, hoặc chạy trong cmd. Đóng cửa sổ là dừng hẳn.

cd /d "%~dp0\.."
title ezaff - dang chay (dong cua so nay de dung)

:vonglap
echo.
echo ==========================================================
echo  [%date% %time%] Khoi dong ezaff
echo ==========================================================
set PYTHONIOENCODING=utf-8
REM -u = khong dem output. Thieu no thi log dong bang hang chuc phut du tien
REM trinh van chay, lam den bao suc khoe bao dong gia (gap 2026-08-14).
python -u tools\ezaff-port-local.py

echo.
echo [%date% %time%] Tien trinh da thoat (ma loi %errorlevel%).
echo Cho 60 giay roi chay lai. Bam Ctrl+C hai lan de dung han.
timeout /t 60 /nobreak >nul

REM Khoa mo coi tu lan chet truoc — script tu don duoc, nhung xoa cho chac.
if exist tools\.ezaff.lock del /q tools\.ezaff.lock

goto vonglap
