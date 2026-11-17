#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
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
struct Proc(Mutex<Option<Child>>);

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

fn pipe<R: Read + Send + 'static>(app: AppHandle, r: R, kind: &'static str) {
    thread::spawn(move || {
        for line in BufReader::new(r).lines().map_while(Result::ok) {
            let _ = app.emit("term", Term { kind, data: line });
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
    c.arg(flag).arg(&cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
            let _ = app.emit("term", Term { kind: "exit", data: code.to_string() });
            break;
        }
    });
    Ok(())
}

#[tauri::command]
fn kill_command(state: State<'_, Proc>) -> Result<(), String> {
    if let Some(c) = state.0.lock().map_err(|e| e.to_string())?.as_mut() {
        c.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Proc::default())
        .invoke_handler(tauri::generate_handler![
            read_dir, read_file, write_file, search_files, run_command, kill_command
        ])
        .run(tauri::generate_context!())
        .expect("gagal menjalankan RyCode");
}
