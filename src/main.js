import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as pick, ask } from "@tauri-apps/plugin-dialog";
import { EditorState } from "@codemirror/state";
import { EditorView, scrollPastEnd } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const $ = (s) => document.querySelector(s);
const base = (p) => p.split(/[\\/]/).pop();
const el = (t, x = "") => { const n = document.createElement(t); n.textContent = x; return n; };
let msgT;
function say(text, kind = "ok") {
  const m = $("#msg");
  m.textContent = text;
  m.className = kind;
  clearTimeout(msgT);
  msgT = setTimeout(() => (m.textContent = ""), 4000);
}

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
    "&": { backgroundColor: "#0a0a0f", color: "#d7d7e0", height: "100%" },
    ".cm-content": { caretColor: "#b8ff2c", fontFamily: "var(--mono)" },
    ".cm-cursor": { borderLeftColor: "#b8ff2c" },
    ".cm-scroller": { overflow: "auto", fontFamily: "var(--mono)", lineHeight: "1.5" },
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
  scrollPastEnd(),
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

// ---------- splitter terminal (drag / dblclick / keyboard) ----------
const KEY = "rycode.termh", mainEl = $("main"), gutter = $("#gutter");
let termH = 220;
try { termH = Number(localStorage.getItem(KEY)) || 220; } catch { /* storage tidak tersedia: pakai default */ }
function setTermH(h) {
  const max = mainEl.clientHeight - 200; // sisakan ruang untuk tab + editor
  termH = Math.round(Math.max(80, Math.min(h, max)));
  document.documentElement.style.setProperty("--term-h", termH + "px");
  gutter.setAttribute("aria-valuenow", String(termH));
  view.requestMeasure();
}
const persist = () => { try { localStorage.setItem(KEY, String(termH)); } catch { /* abaikan */ } };
gutter.onpointerdown = (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  gutter.setPointerCapture(e.pointerId);
  document.body.classList.add("drag");
};
gutter.onpointermove = (e) => {
  if (!gutter.hasPointerCapture(e.pointerId)) return;
  setTermH(mainEl.getBoundingClientRect().bottom - $("#bar").offsetHeight - e.clientY);
};
const endDrag = (e) => {
  if (gutter.hasPointerCapture(e.pointerId)) gutter.releasePointerCapture(e.pointerId);
  document.body.classList.remove("drag");
  persist();
};
gutter.onpointerup = endDrag;
gutter.onpointercancel = endDrag;
gutter.ondblclick = () => { setTermH(220); persist(); };
gutter.onkeydown = (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  setTermH(termH + (e.key === "ArrowUp" ? 20 : -20));
  persist();
};
addEventListener("resize", () => setTermH(termH));
setTermH(termH);

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
function show(p, focus = true) {
  if (cur && files.has(cur)) files.get(cur).state = view.state;
  cur = p;
  view.setState(files.get(p).state);
  if (focus) view.focus();
  tabs();
}
async function openFile(p, focus = true) {
  try {
    if (!files.has(p)) files.set(p, { state: await mkState(p, await invoke("read_file", { path: p })), dirty: false });
    show(p, focus);
  } catch (e) { say(String(e), "err"); log(String(e), "err"); }
}
function drop(p) {
  files.delete(p);
  if (cur !== p) return tabs();
  cur = null;
  const n = [...files.keys()].pop();
  if (n) show(n); else { view.setState(blank()); tabs(); }
}
async function close(p) {
  const f = files.get(p);
  if (!f) return;
  if (f.dirty && !(await ask("Perubahan belum disimpan. Tutup tab?", { kind: "warning" }))) return;
  drop(p);
}
async function save() {
  if (!cur) return say("Tidak ada file terbuka", "err");
  files.get(cur).state = view.state;
  try {
    await invoke("write_file", { path: cur, content: view.state.doc.toString() });
    setDirty(cur, false);
    say("Tersimpan: " + base(cur));
  } catch (e) { say("Gagal simpan: " + e, "err"); log(String(e), "err"); }
}

// ---------- explorer: lazy load, seleksi, hapus ----------
let sel = null;
const ctx = $("#ctx");
function select(en, n, w) {
  document.querySelectorAll(".n.on").forEach((x) => x.classList.remove("on"));
  n.classList.add("on");
  sel = { path: en.path, isDir: en.is_dir, wrap: w };
}
async function remove(it) {
  if (!root) return say("Buka folder dulu", "err");
  const label = base(it.path);
  const yes = await ask(
    `Hapus ${it.isDir ? "folder beserta seluruh isinya" : "file"} "${label}" secara permanen?\nTindakan ini tidak bisa dibatalkan.`,
    { title: "RyCode — Hapus", kind: "warning" },
  );
  if (!yes) return;
  try {
    await invoke("delete_item", { root, path: it.path });
  } catch (e) {
    say("Gagal hapus: " + e, "err");
    return log(String(e), "err");
  }
  const inside = (p) => p === it.path || p.startsWith(it.path + "/") || p.startsWith(it.path + "\\");
  [...files.keys()].filter(inside).forEach(drop);
  it.wrap.remove();
  if (sel === it) sel = null;
  say("Dihapus: " + label);
}
function showCtx(x, y) {
  ctx.hidden = false;
  ctx.style.left = Math.max(0, Math.min(x, innerWidth - ctx.offsetWidth - 4)) + "px";
  ctx.style.top = Math.max(0, Math.min(y, innerHeight - ctx.offsetHeight - 4)) + "px";
}
ctx.onclick = () => { ctx.hidden = true; if (sel) remove(sel); };
addEventListener("click", (e) => { if (!ctx.contains(e.target)) ctx.hidden = true; });
$("#tree").onkeydown = (e) => {
  if (e.key === "Delete" && sel) { e.preventDefault(); remove(sel); }
};
async function load(path, host, depth) {
  let list;
  try { list = await invoke("read_dir", { path }); } catch (e) { say(String(e), "err"); return log(String(e), "err"); }
  host.replaceChildren(...list.map((en) => {
    const w = document.createElement("div"), n = document.createElement("div"), kids = document.createElement("div");
    n.className = "n " + (en.is_dir ? "d" : "f");
    n.textContent = en.name;
    n.style.paddingLeft = 10 + depth * 12 + "px";
    w.append(n, kids);
    n.onclick = async () => {
      select(en, n, w);
      if (!en.is_dir) return openFile(en.path, false); // fokus tetap di explorer (seperti VS Code)
      const o = n.classList.toggle("o");
      kids.hidden = !o;
      if (o && !kids.hasChildNodes()) await load(en.path, kids, depth + 1);
    };
    n.oncontextmenu = (e) => {
      e.preventDefault();
      select(en, n, w);
      $("#tree").focus();
      showCtx(e.clientX, e.clientY);
    };
    return w;
  }));
}
async function openFolder() {
  const p = await pick({ directory: true });
  if (!p) return;
  root = p;
  sel = null;
  document.title = "RyCode — " + base(p);
  await load(p, $("#tree"), 0);
  log("cwd: " + p, "cmd");
}

// ---------- quick open (Ctrl+P) ----------
const qo = $("#qo"), qi = $("#qi"), ql = $("#ql");
let timer;
function quick() {
  if (!root) return say("Buka folder dulu (Ctrl+O)", "err");
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
    try {
      const r = await invoke("search_files", { root, query: q, limit: 50 });
      ql.replaceChildren(...r.map((p) => {
        const li = document.createElement("li");
        li.textContent = p.slice(root.length + 1);
        li.onclick = () => { qo.hidden = true; openFile(p); };
        return li;
      }));
    } catch (e) { say("Pencarian gagal: " + e, "err"); }
  }, 120);
};
qi.onkeydown = (e) => {
  if (e.key === "Escape") { qo.hidden = true; view.focus(); }
  if (e.key === "Enter") ql.firstChild?.click();
};

// ---------- cheat sheet shortcut (F1 / tombol status bar) ----------
const hp = $("#hp"), card = $("#hpcard");
let prevFocus = null;
const KEYS = {
  "Aplikasi (Ctrl = Cmd di macOS)": [
    ["Ctrl+O", "Buka folder"], ["Ctrl+P", "Cari file (quick open)"], ["Ctrl+S", "Simpan file"],
    ["Ctrl+W", "Tutup tab (klik tengah juga bisa)"], ["Ctrl+`", "Tampil/sembunyi terminal"],
    ["F1", "Buka/tutup daftar ini"], ["Esc", "Tutup panel / menu"],
  ],
  "Explorer": [
    ["Klik", "Pilih item, file dibuka tanpa memindah fokus"], ["Klik kanan", "Menu hapus"],
    ["Delete", "Hapus item terpilih (fokus di explorer, ada konfirmasi)"],
  ],
  "Editor": [
    ["Ctrl+F", "Cari di file"], ["Ctrl+Z / Ctrl+Y", "Undo / Redo"], ["Ctrl+/", "Komentar baris"],
    ["Ctrl+D", "Pilih kemunculan berikutnya"], ["Alt+Up / Down", "Pindah baris"],
    ["Shift+Alt+Up / Down", "Duplikat baris"], ["Ctrl+Shift+K", "Hapus baris"], ["Ctrl+Space", "Autocomplete"],
    ["Scroll / Shift+Scroll", "Gulir vertikal / horizontal"],
  ],
  "Terminal": [
    ["Drag pemisah", "Ubah tinggi terminal (klik 2x = reset, panah atas/bawah saat fokus)"],
    ["Enter", "Jalankan perintah / kirim input ke proses"], ["Ctrl+C", "Hentikan proses"],
    ["Ctrl+D", "Tutup stdin (EOF)"], ["Up / Down", "Riwayat perintah"], ["clear", "Bersihkan layar"],
  ],
};
card.replaceChildren(el("h3", "KEYBOARD SHORTCUTS"), ...Object.entries(KEYS).flatMap(([g, rows]) => [
  el("h4", g),
  ...rows.map(([k, d]) => { const r = el("div"); r.className = "row"; r.append(el("kbd", k), el("span", d)); return r; }),
]));
function openHelp() { prevFocus = document.activeElement; hp.hidden = false; card.focus(); }
function closeHelp() { hp.hidden = true; if (prevFocus && prevFocus.focus) prevFocus.focus(); }
const help = () => (hp.hidden ? openHelp() : closeHelp());
hp.onclick = (e) => { if (e.target === hp) closeHelp(); };
$("#hbtn").onclick = help;

// ---------- shortcut global ----------
function toggleTerm() {
  const hidden = mainEl.classList.toggle("noterm");
  if (hidden) view.focus(); else { setTermH(termH); $("#cmd").focus(); }
}
// Capture phase + e.code: tetap jalan walau fokus di editor dan apa pun layout keyboardnya.
addEventListener("keydown", (e) => {
  if (e.key === "F1") { e.preventDefault(); return help(); }
  if (e.key === "Escape") {
    if (!hp.hidden) closeHelp();
    qo.hidden = true;
    ctx.hidden = true;
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const a = { KeyS: save, KeyO: openFolder, KeyP: quick, KeyW: () => cur && close(cur), Backquote: toggleTerm }[e.code];
  if (a) { e.preventDefault(); e.stopPropagation(); a(); }
}, true);
$("#open").onclick = openFolder;
tabs();
