#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod scan;

use scan::{filetime_ms, Ctx, Dir, Volume};
use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct AppState {
    tree: Mutex<Option<Arc<Dir>>>,
    ctx: Mutex<Option<Arc<Ctx>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    idx: u32,
    name: String,
    size: u64,
    alloc: u64,
    files: u64,
    dirs: u64,
    mtime: u64,
    kids: bool,
    denied: bool,
}

fn dir_row(d: &Dir, idx: u32) -> Row {
    Row {
        idx,
        name: d.name.to_string(),
        size: d.size,
        alloc: d.alloc,
        files: d.files,
        dirs: d.dirs,
        mtime: filetime_ms(d.mtime),
        kids: !d.subs.is_empty() || !d.own.is_empty(),
        denied: d.denied,
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    files: u64,
    dirs: u64,
    bytes: u64,
    errors: u64,
    current: String,
    elapsed_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    root: Row,
    path: String,
    volume: Option<Volume>,
    errors: u64,
    elapsed_ms: u64,
    cancelled: bool,
}

#[derive(Serialize)]
struct Children {
    dirs: Vec<Row>,
    files: Option<Row>,
}

#[derive(Serialize)]
struct Locations {
    drives: Vec<Volume>,
    home: String,
}

#[tauri::command]
fn locations() -> Locations {
    Locations { drives: scan::drives(), home: std::env::var("USERPROFILE").unwrap_or_default() }
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    let p = app.dialog().file().blocking_pick_folder()?;
    p.into_path().ok().map(|p| p.display().to_string())
}

#[tauri::command]
async fn start_scan(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> Result<ScanResult, String> {
    let canon = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    let root_w = scan::wide(&canon);
    let shown = scan::display(&root_w);
    let ctx = Arc::new(Ctx::default());
    if let Some(old) = state.ctx.lock().unwrap().replace(ctx.clone()) {
        old.cancel.store(true, Relaxed);
    }
    *state.tree.lock().unwrap() = None;

    let start = Instant::now();
    let (c, a) = (ctx.clone(), app.clone());
    std::thread::spawn(move || {
        while !c.done.load(Relaxed) {
            std::thread::sleep(Duration::from_millis(80));
            let _ = a.emit("scan-progress", Progress {
                files: c.files.load(Relaxed),
                dirs: c.dirs.load(Relaxed),
                bytes: c.bytes.load(Relaxed),
                errors: c.errors.load(Relaxed),
                current: c.current.lock().map(|s| s.clone()).unwrap_or_default(),
                elapsed_ms: start.elapsed().as_millis() as u64,
            });
        }
    });

    let c = ctx.clone();
    let name = shown.clone();
    let mut tree = tauri::async_runtime::spawn_blocking(move || scan::scan(root_w, name, &c))
        .await
        .map_err(|e| e.to_string())?;
    ctx.done.store(true, Relaxed);
    if let Ok(m) = std::fs::metadata(&canon).and_then(|m| m.modified()) {
        let ms = m.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        tree.mtime = tree.mtime.max((ms + 11_644_473_600_000) * 10_000);
    }
    let res = ScanResult {
        root: dir_row(&tree, 0),
        volume: scan::volume(&shown),
        path: shown,
        errors: ctx.errors.load(Relaxed),
        elapsed_ms: start.elapsed().as_millis() as u64,
        cancelled: ctx.cancel.load(Relaxed),
    };
    // A newer scan replaced us while we ran: don't clobber its tree.
    if !state.ctx.lock().unwrap().as_ref().is_some_and(|c| Arc::ptr_eq(c, &ctx)) {
        return Err("superseded".into());
    }
    *state.tree.lock().unwrap() = Some(Arc::new(tree));
    Ok(res)
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    if let Some(c) = state.ctx.lock().unwrap().as_ref() {
        c.cancel.store(true, Relaxed);
    }
}

fn with_dir<T>(state: &AppState, path: &[u32], f: impl FnOnce(&Dir) -> T) -> Result<T, String> {
    let tree = state.tree.lock().unwrap().clone().ok_or("no scan")?;
    let mut d: &Dir = &tree;
    for &i in path {
        d = d.subs.get(i as usize).ok_or("stale path")?;
    }
    Ok(f(d))
}

#[tauri::command]
fn children(state: State<'_, AppState>, path: Vec<u32>) -> Result<Children, String> {
    with_dir(&state, &path, |d| Children {
        dirs: d.subs.iter().enumerate().map(|(i, s)| dir_row(s, i as u32)).collect(),
        files: (!d.own.is_empty()).then(|| Row {
            idx: u32::MAX,
            name: format!("[{} Files]", d.own.len()),
            size: d.own.iter().map(|f| f.size).sum(),
            alloc: d.own.iter().map(|f| f.alloc).sum(),
            files: d.own.len() as u64,
            dirs: 0,
            mtime: filetime_ms(d.own.iter().map(|f| f.mtime).max().unwrap_or(0)),
            kids: true,
            denied: false,
        }),
    })
}

#[tauri::command]
fn files(state: State<'_, AppState>, path: Vec<u32>) -> Result<Vec<Row>, String> {
    with_dir(&state, &path, |d| {
        d.own
            .iter()
            .enumerate()
            .map(|(i, f)| Row {
                idx: i as u32,
                name: f.name.to_string(),
                size: f.size,
                alloc: f.alloc,
                files: 1,
                dirs: 0,
                mtime: filetime_ms(f.mtime),
                kids: false,
                denied: false,
            })
            .collect()
    })
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    Command::new("explorer").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    Command::new("explorer").raw_arg(format!("/select,\"{path}\"")).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn wz(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

#[tauri::command]
fn open_with(path: String) -> Result<(), String> {
    Command::new("rundll32").raw_arg(format!("shell32.dll,OpenAs_RunDLL {path}")).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_terminal(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
    // Windows Terminal if installed, else a classic console.
    Command::new("wt")
        .arg("-d")
        .arg(dir)
        .spawn()
        .or_else(|_| Command::new("cmd").arg("/K").current_dir(dir).creation_flags(0x10 /* CREATE_NEW_CONSOLE */).spawn())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Native Explorer "Properties" sheet. Sync command => runs on the (STA) main thread, which it needs.
#[tauri::command]
fn properties(path: String) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::SHObjectProperties;
    let ok = unsafe { SHObjectProperties(std::ptr::null_mut(), 2 /* SHOP_FILEPATH */, wz(&path).as_ptr(), std::ptr::null()) };
    if ok != 0 { Ok(()) } else { Err("Could not open Properties".into()) }
}

/// Moves to the Recycle Bin. Returns whether the path is gone afterwards.
#[tauri::command]
fn recycle(path: String) -> Result<bool, String> {
    use windows_sys::Win32::UI::Shell::{SHFileOperationW, SHFILEOPSTRUCTW};
    let mut from = wz(&path);
    from.push(0); // pFrom is a double-null-terminated list
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = 3; // FO_DELETE
    op.pFrom = from.as_ptr();
    // ALLOWUNDO = recycle; NOCONFIRMATION since we asked already; WANTNUKEWARNING keeps the shell
    // prompt if an item is too big for the bin and would otherwise be destroyed permanently.
    op.fFlags = 0x0040 | 0x0010 | 0x4000;
    let rc = unsafe { SHFileOperationW(&mut op) };
    let gone = !std::path::Path::new(&path).exists();
    if rc != 0 && !gone {
        return Err(format!("Could not move to Recycle Bin (code {rc:#x})"));
    }
    Ok(gone)
}

fn main() {
    // No "insert disk" popups when probing empty card readers / optical drives.
    unsafe { windows_sys::Win32::System::Diagnostics::Debug::SetErrorMode(0x0001 | 0x8000) };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            locations, pick_folder, start_scan, cancel_scan, children, files, open_path, reveal_path,
            open_with, open_terminal, properties, recycle
        ])
        .run(tauri::generate_context!())
        .expect("error while running TreeView");
}
