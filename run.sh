#!/usr/bin/env bash
echo "========================================================"
echo "  Starting CloudMe Web Cloud Storage (Linux)"
echo "========================================================"

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed. Please install Node.js 18+"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "[INFO] Installing dependencies..."
    npm install
fi

echo "[INFO] Starting CloudMe server..."
npm start
