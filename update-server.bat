@echo off
title CloudMe Server 1-Click Update
color 0a
echo ========================================================
echo   CloudMe Server - 1-Click Update from GitHub
echo ========================================================
echo.

where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git tidak ditemukan!
    pause
    exit /b 1
)

echo [1/3] Mengunduh pembaruan terbaru dari GitHub...
git pull origin main

echo.
echo [2/3] Memperbarui dependensi jika ada...
call npm install --omit=dev

echo.
echo [3/3] Me-restart service CloudMe...
where pm2 >nul 2>nul
if %errorlevel% equ 0 (
    pm2 restart cloudme
    echo [SUKSES] CloudMe berhasil diperbarui dan di-restart di PM2!
) else (
    echo [INFO] Me-restart via script deploy...
    node scripts/deploy-setup.js
)

echo.
echo ========================================================
echo   Pembaruan Selesai! Server CloudMe Sudah Terupdate.
echo ========================================================
pause
