@echo off
echo ========================================================
echo   CloudMe Android APK Local Builder
echo ========================================================
echo.

echo [1/3] Sinkronisasi aset frontend ke proyek Android...
call npx cap sync android
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Gagal sinkronisasi Capacitor.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [2/3] Memeriksa Android Gradle...
cd android
if exist gradlew.bat (
    echo [3/3] Mengompilasi Debug APK...
    call gradlew.bat assembleDebug
    if %ERRORLEVEL% EQU 0 (
        echo.
        echo ========================================================
        echo [SUKSES] APK berhasil dikompilasi!
        echo Lokasi file: android\app\build\outputs\apk\debug\app-debug.apk
        echo ========================================================
    ) else (
        echo.
        echo [CATATAN] Kompilasi lokal memerlukan JDK 17 dan Android SDK.
        echo Jika belum terinstal di PC, Anda bisa menggunakan build otomatis
        echo via GitHub Actions (.github/workflows/build-apk.yml).
    )
) else (
    echo [ERROR] gradlew.bat tidak ditemukan di direktori android.
)
cd ..
pause
