#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v cargo >/dev/null || { echo "Install Rust dulu: https://rustup.rs"; exit 1; }
npm install
[ -f src-tauri/icons/icon.ico ] || npm run icon
npm run app:build
