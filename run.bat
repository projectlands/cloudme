@echo off
title CloudMe Server
echo ========================================================
echo   Starting CloudMe Web Cloud Storage (Windows)
echo ========================================================
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js tidak ditemukan! Silakan install Node.js dari https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] Menginstal dependensi...
    call npm install
)

echo [INFO] Menjalankan server CloudMe...
npm start
pause
