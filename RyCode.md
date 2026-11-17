# RyCode

> Dibuat oleh RyMD · 2026-11-17T21:13:39.137Z · 14 file

## Struktur Direktori

```text
RyCode/
├── .github/
│   └── workflows/
│       └── build.yml
├── .setup/
├── src/
│   ├── main.js
│   └── style.css
├── src-tauri/
│   ├── capabilities/
│   │   └── default.json
│   ├── src/
│   │   └── main.rs
│   ├── build.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── .gitignore
├── build.sh
├── index.html
├── package.json
├── README.md
└── vite.config.js
```

## Isi File

### `.github/workflows/build.yml`

```yaml
name: build
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-22.04, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - name: Sync version from tag
        shell: bash
        run: |
          V="${GITHUB_REF_NAME#v}"
          node -e "const fs=require('fs'),f='src-tauri/tauri.conf.json',j=JSON.parse(fs.readFileSync(f,'utf8'));j.version='$V';fs.writeFileSync(f,JSON.stringify(j,null,2))"
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: dtolnay/rust-toolchain@stable
      - uses: swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
      - name: Linux deps
        if: matrix.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
      - run: npm install
      - run: npm run icon
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: RyCode ${{ github.ref_name }}
          releaseDraft: true
```

### `src/main.js`

```javascript
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as pick, ask } from "@tauri-apps/plugin-dialog";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const $ = (s) => document.querySelector(s);
const base = (p) => p.split(/[\\/]/).pop();

// Bahasa dimuat lazy: hanya saat file dengan ekstensi itu dibuka.
const L = {
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
};
const EXT = { js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", html: "html", htm: "html", css: "css", json: "json", md: "md", py: "py", rs: "rs" };

const neon = [
  EditorView.theme({
    "&": { backgroundColor: "#0a0a0f", color: "#d7d7e0" },
    ".cm-content": { caretColor: "#b8ff2c", fontFamily: "var(--mono)" },
    ".cm-cursor": { borderLeftColor: "#b8ff2c" },
    ".cm-gutters": { backgroundColor: "#101017", color: "#7a7a90", border: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#16161f" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#b8ff2c33" },
    "&.cm-focused": { outline: "none" },
  }, { dark: true }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword], color: "#ff3cac" },
    { tag: [t.string, t.regexp], color: "#b8ff2c" },
    { tag: [t.number, t.bool, t.null], color: "#ffb454" },
    { tag: t.comment, color: "#6a6a82", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.propertyName], color: "#2cf0ff" },
    { tag: [t.typeName, t.className, t.tagName], color: "#c792ff" },
  ])),
];

const files = new Map(); // path -> { state, dirty }
let root = null, cur = null;
const blank = () => EditorState.create({ doc: "", extensions: [basicSetup, neon] });
const view = new EditorView({ parent: $("#editor"), state: blank() });

// ---------- terminal ----------
const out = $("#out"), hist = [];
let hi = 0, busy = false, last = null;
const setBusy = (b) => { busy = b; document.querySelector(".in i").textContent = b ? ">" : "$"; };
function trim() {
  while (out.childElementCount > 2000) out.firstChild.remove();
  out.scrollTop = out.scrollHeight;
}
function log(text, kind = "") {
  last = null;
  const d = document.createElement("div");
  if (kind) d.className = kind;
  d.textContent = text;
  out.append(d);
  trim();
}
// Output mentah: prompt tanpa newline tetap tampil, \r menimpa baris, ANSI dibuang.
function put(text, kind = "") {
  const clean = text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r\n/g, "\n");
  for (const p of clean.split(/(\n|\r)/)) {
    if (p === "\r") { if (last) last.textContent = ""; continue; }
    if (p !== "\n" && !p) continue;
    if (!last) {
      last = document.createElement("div");
      if (kind) last.className = kind;
      out.append(last);
    }
    if (p === "\n") last = null; else last.textContent += p;
  }
  trim();
}
listen("term", ({ payload: { kind, data } }) => {
  if (kind === "exit") { setBusy(false); log(`[exit ${data}]`, "cmd"); }
  else put(data, kind === "err" ? "err" : "");
});
$("#cmd").onkeydown = async (e) => {
  const i = e.target;
  if (e.key === "Enter" && (busy || i.value.trim())) {
    const c = i.value;
    i.value = "";
    if (busy) {
      put(c + "\n");
      try { await invoke("send_input", { data: c + "\n" }); } catch (er) { log(String(er), "err"); }
      return;
    }
    hist.push(c);
    hi = hist.length;
    if (c.trim() === "clear") return out.replaceChildren();
    log("$ " + c, "cmd");
    setBusy(true);
    try { await invoke("run_command", { cmd: c, cwd: root }); } catch (er) { setBusy(false); log(String(er), "err"); }
  } else if (e.ctrlKey && e.key === "c") invoke("kill_command");
  else if (e.ctrlKey && e.key === "d" && busy) invoke("close_input");
  else if (e.key === "ArrowUp" && hi > 0) i.value = hist[--hi];
  else if (e.key === "ArrowDown") i.value = hist[++hi] ?? ((hi = hist.length), "");
};

// ---------- editor & tabs ----------
async function mkState(path, doc) {
  const k = EXT[path.split(".").pop().toLowerCase()];
  const lang = k ? await L[k]() : [];
  return EditorState.create({
    doc,
    extensions: [basicSetup, neon, lang, EditorView.updateListener.of((u) => u.docChanged && setDirty(path, true))],
  });
}
function setDirty(p, d) {
  const f = files.get(p);
  if (f && f.dirty !== d) { f.dirty = d; tabs(); }
}
function tabs() {
  $("#tabs").replaceChildren(...[...files].map(([p, f]) => {
    const d = document.createElement("div");
    d.className = "t" + (p === cur ? " on" : "") + (f.dirty ? " m" : "");
    d.textContent = base(p);
    d.title = p;
    d.onclick = () => show(p);
    d.onauxclick = (e) => e.button === 1 && close(p);
    return d;
  }));
}
function show(p) {
  if (cur && files.has(cur)) files.get(cur).state = view.state;
  cur = p;
  view.setState(files.get(p).state);
  view.focus();
  tabs();
}
async function openFile(p) {
  try {
    if (!files.has(p)) files.set(p, { state: await mkState(p, await invoke("read_file", { path: p })), dirty: false });
    show(p);
  } catch (e) { log(String(e), "err"); }
}
async function close(p) {
  const f = files.get(p);
  if (!f) return;
  if (f.dirty && !(await ask("Perubahan belum disimpan. Tutup tab?", { kind: "warning" }))) return;
  files.delete(p);
  if (cur !== p) return tabs();
  cur = null;
  const n = [...files.keys()].pop();
  if (n) show(n); else { view.setState(blank()); tabs(); }
}
async function save() {
  if (!cur) return;
  files.get(cur).state = view.state;
  try {
    await invoke("write_file", { path: cur, content: view.state.doc.toString() });
    setDirty(cur, false);
  } catch (e) { log(String(e), "err"); }
}

// ---------- explorer (lazy per folder) ----------
async function load(path, host, depth) {
  let list;
  try { list = await invoke("read_dir", { path }); } catch (e) { return log(String(e), "err"); }
  host.replaceChildren(...list.map((en) => {
    const w = document.createElement("div"), n = document.createElement("div"), kids = document.createElement("div");
    n.className = "n " + (en.is_dir ? "d" : "f");
    n.textContent = en.name;
    n.style.paddingLeft = 10 + depth * 12 + "px";
    w.append(n, kids);
    n.onclick = async () => {
      if (!en.is_dir) {
        document.querySelectorAll(".n.on").forEach((x) => x.classList.remove("on"));
        n.classList.add("on");
        return openFile(en.path);
      }
      const o = n.classList.toggle("o");
      kids.hidden = !o;
      if (o && !kids.hasChildNodes()) await load(en.path, kids, depth + 1);
    };
    return w;
  }));
}
async function openFolder() {
  const p = await pick({ directory: true });
  if (!p) return;
  root = p;
  document.title = "RyCode — " + base(p);
  await load(p, $("#tree"), 0);
  log("cwd: " + p, "cmd");
}

// ---------- quick open (Ctrl+P) ----------
const qo = $("#qo"), qi = $("#qi"), ql = $("#ql");
let timer;
function quick() {
  if (!root) return log("Buka folder dulu (Ctrl+O)", "err");
  qo.hidden = false;
  qi.value = "";
  ql.replaceChildren();
  qi.focus();
}
qi.oninput = () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const q = qi.value.trim();
    if (!q) return ql.replaceChildren();
    const r = await invoke("search_files", { root, query: q, limit: 50 });
    ql.replaceChildren(...r.map((p) => {
      const li = document.createElement("li");
      li.textContent = p.slice(root.length + 1);
      li.onclick = () => { qo.hidden = true; openFile(p); };
      return li;
    }));
  }, 120);
};
qi.onkeydown = (e) => {
  if (e.key === "Escape") { qo.hidden = true; view.focus(); }
  if (e.key === "Enter") ql.firstChild?.click();
};

// ---------- shortcuts ----------
addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const a = {
    s: save,
    o: openFolder,
    p: quick,
    w: () => cur && close(cur),
    "`": () => {
      const h = $("#term").classList.toggle("h");
      if (!h) $("#cmd").focus(); else view.focus();
    },
  }[e.key.toLowerCase()];
  if (a) { e.preventDefault(); a(); }
});
$("#open").onclick = openFolder;
tabs();
```

### `src/style.css`

```css
:root{--bg:#0a0a0f;--s1:#101017;--s2:#16161f;--bd:#262633;--tx:#d7d7e0;--mu:#7a7a90;--neon:#b8ff2c;--pink:#ff3cac;--cy:#2cf0ff;--mono:ui-monospace,"JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace}
*{box-sizing:border-box;margin:0;scrollbar-width:thin;scrollbar-color:var(--bd) transparent}
html,body{height:100%;background:var(--bg);color:var(--tx);font:13px/1.5 var(--mono);overflow:hidden}
#app{display:grid;grid-template-columns:250px 1fr;height:100%}
#side{display:flex;flex-direction:column;min-width:0;background:var(--s1);border-right:2px solid var(--bd)}
#side header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:2px solid var(--bd)}
#side b{letter-spacing:.14em}#side b span{color:var(--neon)}
button{font:inherit;font-weight:700;color:var(--bg);background:var(--neon);border:2px solid var(--neon);padding:2px 10px;cursor:pointer;box-shadow:2px 2px 0 var(--pink)}
button:active{transform:translate(2px,2px);box-shadow:none}
button:focus-visible,input:focus-visible{outline:2px solid var(--cy);outline-offset:2px}
#tree{flex:1;overflow:auto;padding:6px 0}
.n{padding:1px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none}
.n:hover{background:var(--s2)}.n.on{background:var(--s2);color:var(--neon)}
.d::before{content:"▸ ";color:var(--mu)}.d.o::before{content:"▾ "}.f::before{content:"· ";color:var(--mu)}
main{display:grid;grid-template-rows:auto 1fr auto;min-width:0;height:100%}
#tabs{display:flex;overflow-x:auto;min-height:30px;background:var(--s1);border-bottom:2px solid var(--bd)}
.t{padding:4px 14px;border-right:2px solid var(--bd);cursor:pointer;white-space:nowrap;color:var(--mu)}
.t.on{color:var(--neon);background:var(--bg);box-shadow:inset 0 -3px 0 var(--neon)}
.t.m::after{content:" ●";color:var(--pink)}
#editor{position:relative;min-height:0}.cm-editor{position:absolute;inset:0}
#term{display:flex;flex-direction:column;height:220px;background:var(--s1);border-top:2px solid var(--neon)}
#term.h{display:none}
#out{flex:1;overflow:auto;padding:6px 12px;white-space:pre-wrap;word-break:break-all}
#out .err{color:var(--pink)}#out .cmd{color:var(--cy)}
.in{display:flex;gap:8px;padding:4px 12px;border-top:2px solid var(--bd)}.in i{color:var(--neon);font-style:normal}
input{flex:1;font:inherit;color:var(--tx);background:none;border:0}
#qo{position:fixed;inset:12% 0 auto;margin:auto;width:min(560px,90vw);background:var(--s2);border:2px solid var(--neon);box-shadow:6px 6px 0 var(--pink);z-index:9}
#qo input{width:100%;padding:10px 12px;border-bottom:2px solid var(--bd)}
#ql{list-style:none;padding:0;max-height:300px;overflow:auto}
#ql li{padding:4px 12px;cursor:pointer}#ql li:hover{background:var(--bd);color:var(--neon)}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
```

### `src-tauri/capabilities/default.json`

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "RyCode main window",
  "windows": ["main"],
  "permissions": ["core:default", "dialog:default"]
}
```

### `src-tauri/src/main.rs`

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_FILE: u64 = 5 * 1024 * 1024; // batas buka file: jaga RAM
const SKIP: [&str; 4] = [".git", "node_modules", "target", "dist"];

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize, Clone)]
struct Term {
    kind: &'static str,
    data: String,
}

#[derive(Default)]
struct Proc(Mutex<Option<Child>>, Mutex<Option<ChildStdin>>);

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut v: Vec<Entry> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| e.file_name() != ".git")
        .map(|e| Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .collect();
    v.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(v)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE {
        return Err("File > 5 MB, tidak dibuka (hemat RAM)".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "Bukan teks UTF-8".to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn search_files(root: String, query: String, limit: usize) -> Vec<String> {
    let q = query.to_lowercase();
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.filter_map(Result::ok) {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if !SKIP.contains(&name.as_str()) {
                    stack.push(e.path());
                }
            } else if name.to_lowercase().contains(&q) {
                out.push(e.path().to_string_lossy().into_owned());
                if out.len() >= limit {
                    return out;
                }
            }
        }
    }
    out
}

// Baca per chunk (bukan per baris) supaya prompt tanpa newline tetap tampil.
fn pipe<R: Read + Send + 'static>(app: AppHandle, mut r: R, kind: &'static str) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut carry: Vec<u8> = Vec::new();
        while let Ok(n) = r.read(&mut buf) {
            if n == 0 {
                break;
            }
            carry.extend_from_slice(&buf[..n]);
            let mut valid = match std::str::from_utf8(&carry) {
                Ok(s) => s.len(),
                Err(e) => e.valid_up_to(),
            };
            if valid == 0 {
                if carry.len() < 4 {
                    continue; // karakter UTF-8 belum lengkap
                }
                valid = carry.len();
            }
            let rest = carry.split_off(valid);
            let data = String::from_utf8_lossy(&carry).into_owned();
            carry = rest;
            let _ = app.emit("term", Term { kind, data });
        }
    });
}

#[tauri::command]
fn run_command(app: AppHandle, state: State<'_, Proc>, cmd: String, cwd: Option<String>) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Err("Proses masih berjalan (Ctrl+C untuk stop)".into());
    }
    let (sh, flag) = if cfg!(windows) { ("cmd", "/C") } else { ("sh", "-c") };
    let mut c = Command::new(sh);
    c.env("NO_COLOR", "1").arg(flag).arg(&cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    if let Some(o) = child.stdout.take() {
        pipe(app.clone(), o, "out");
    }
    if let Some(e) = child.stderr.take() {
        pipe(app.clone(), e, "err");
    }
    if let Some(i) = child.stdin.take() {
        if let Ok(mut g) = state.1.lock() {
            *g = Some(i);
        }
    }
    *slot = Some(child);
    drop(slot);

    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(80));
        let st = app.state::<Proc>();
        let Ok(mut g) = st.0.lock() else { break };
        let code = match g.as_mut().map(|c| c.try_wait()) {
            Some(Ok(None)) => None,
            Some(Ok(Some(s))) => Some(s.code().unwrap_or(-1)),
            _ => Some(-1),
        };
        if let Some(code) = code {
            *g = None;
            drop(g);
            if let Ok(mut s) = st.1.lock() {
                *s = None; // tutup stdin
            }
            thread::sleep(Duration::from_millis(60)); // beri waktu output terakhir
            let _ = app.emit("term", Term { kind: "exit", data: code.to_string() });
            break;
        }
    });
    Ok(())
}

fn kill_tree(c: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &c.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .status();
    }
    let _ = c.kill();
}

#[tauri::command]
fn kill_command(state: State<'_, Proc>) -> Result<(), String> {
    if let Some(c) = state.0.lock().map_err(|e| e.to_string())?.as_mut() {
        kill_tree(c);
    }
    Ok(())
}

#[tauri::command]
fn send_input(state: State<'_, Proc>, data: String) -> Result<(), String> {
    let mut g = state.1.lock().map_err(|e| e.to_string())?;
    let i = g.as_mut().ok_or("Tidak ada proses yang berjalan")?;
    i.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    i.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn close_input(state: State<'_, Proc>) {
    if let Ok(mut g) = state.1.lock() {
        *g = None;
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Proc::default())
        .invoke_handler(tauri::generate_handler![
            read_dir, read_file, write_file, search_files, run_command, kill_command, send_input, close_input
        ])
        .run(tauri::generate_context!())
        .expect("gagal menjalankan RyCode");
}
```

### `src-tauri/build.rs`

```rust
fn main() {
    tauri_build::build()
}
```

### `src-tauri/Cargo.toml`

```toml
[package]
name = "rycode"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }

[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

### `src-tauri/tauri.conf.json`

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "RyCode",
  "version": "0.1.0",
  "identifier": "dev.ryzu.rycode",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": false,
    "windows": [
      { "title": "RyCode", "width": 1280, "height": 800, "minWidth": 640, "minHeight": 400 }
    ],
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]
  }
}
```

### `.gitignore`

```gitignore
node_modules/
dist/
src-tauri/target/
src-tauri/gen/
.env
.setup
```

### `build.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v cargo >/dev/null || { echo "Install Rust dulu: https://rustup.rs"; exit 1; }
npm install
[ -f src-tauri/icons/icon.ico ] || npm run icon
npm run app:build
```

### `index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RyCode</title>
  <link rel="stylesheet" href="/src/style.css">
</head>
<body>
  <div id="app">
    <aside id="side">
      <header><b>RY<span>CODE</span></b><button id="open" title="Buka folder (Ctrl+O)">Open</button></header>
      <div id="tree"></div>
    </aside>
    <main>
      <div id="tabs"></div>
      <div id="editor"></div>
      <section id="term">
        <div id="out"></div>
        <div class="in"><i>$</i><input id="cmd" spellcheck="false" autocomplete="off" aria-label="Terminal"></div>
      </section>
    </main>
  </div>
  <div id="qo" hidden><input id="qi" placeholder="Cari file…" aria-label="Cari file"><ul id="ql"></ul></div>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
```

### `package.json`

```json
{
  "name": "rycode",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri",
    "icon": "tauri icon app-icon.png",
    "app:dev": "tauri dev",
    "app:build": "tauri build"
  },
  "dependencies": {
    "@codemirror/lang-css": "^6.0.0",
    "@codemirror/lang-html": "^6.0.0",
    "@codemirror/lang-javascript": "^6.0.0",
    "@codemirror/lang-json": "^6.0.0",
    "@codemirror/lang-markdown": "^6.0.0",
    "@codemirror/lang-python": "^6.0.0",
    "@codemirror/lang-rust": "^6.0.0",
    "@codemirror/language": "^6.0.0",
    "@codemirror/state": "^6.0.0",
    "@codemirror/view": "^6.0.0",
    "@lezer/highlight": "^1.0.0",
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-dialog": "^2.0.0",
    "codemirror": "^6.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "vite": "^5.0.0"
  }
}
```

### `README.md`

````markdown
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
````

### `vite.config.js`

```javascript
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "esnext", chunkSizeWarningLimit: 900 },
});
```

