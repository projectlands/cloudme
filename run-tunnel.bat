@echo off
title CloudMe Cloudflare Public Tunnel
color 0b
echo ========================================================
echo   CloudMe Cloudflare Public HTTPS Tunnel
echo ========================================================
echo.

set PORT=8081
if exist .env (
    for /f "tokens=1,2 delims==" %%a in (.env) do (
        if "%%a"=="PORT" set PORT=%%b
    )
)

echo [INFO] Menjalankan Tunnel ke http://localhost:%PORT% ...
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:%PORT%
pause
