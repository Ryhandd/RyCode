# RyCode

Lightweight code editor. Tauri v2 + Rust backend, Vanilla JS + CodeMirror 6 frontend.

## Fitur
File explorer, tab editor (CodeMirror 6, lazy language loading), quick open (Ctrl+P), terminal lokal.

## Dev
Prasyarat: Node 20+, Rust stable, [dependensi Tauri](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run icon
npm run app:dev
```

## Build
```bash
./build.sh
```
Installer ada di `src-tauri/target/release/bundle/`. Rilis otomatis via GitHub Actions: push tag `v*`.

## Pintasan
Ctrl+O buka folder · Ctrl+P cari file · Ctrl+S simpan · Ctrl+W tutup tab · Ctrl+\` terminal
