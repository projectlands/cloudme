@echo off
title CloudMe 1-Click Server Setup & Deploy
color 0b
echo ========================================================
echo   CloudMe Windows Server - 1-Click Auto Deploy
echo   Auto-Detect Free Port + PM2 24/7 + Clean Setup
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0c
    echo [ERROR] Node.js tidak ditemukan di sistem ini!
    echo Silakan download dan install Node.js (LTS) dari: https://nodejs.org
    echo Setelah diinstal, klik dua kali file ini kembali.
    echo.
    pause
    exit /b 1
)

echo [1/3] Menginstal dependensi Node.js...
call npm install --omit=dev
if %errorlevel% neq 0 (
    echo [WARNING] npm install mengalami kendala, mencoba melanjutkan...
)

echo.
echo [2/3] Mendeteksi port bebas dan mengonfigurasi server...
node scripts/deploy-setup.js

echo.
echo [3/3] Selesai! Tekan sembarang tombol untuk keluar.
pause
