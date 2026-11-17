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
let hi = 0;
function log(text, kind = "") {
  const d = document.createElement("div");
  if (kind) d.className = kind;
  d.textContent = text;
  out.append(d);
  while (out.childElementCount > 2000) out.firstChild.remove();
  out.scrollTop = out.scrollHeight;
}
listen("term", ({ payload: { kind, data } }) => {
  if (kind === "exit") log(`[exit ${data}]`, "cmd");
  else log(data, kind === "err" ? "err" : "");
});
$("#cmd").onkeydown = async (e) => {
  const i = e.target;
  if (e.key === "Enter" && i.value.trim()) {
    const c = i.value;
    i.value = "";
    hist.push(c);
    hi = hist.length;
    if (c.trim() === "clear") return out.replaceChildren();
    log("$ " + c, "cmd");
    try { await invoke("run_command", { cmd: c, cwd: root }); } catch (er) { log(String(er), "err"); }
  } else if (e.key === "c" && e.ctrlKey) invoke("kill_command");
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
