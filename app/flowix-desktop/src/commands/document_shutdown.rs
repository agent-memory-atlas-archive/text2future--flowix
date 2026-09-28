use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
struct Shutdown {
    windows: HashSet<String>,
    waiting: Option<(u64, HashSet<String>, i32)>,
    sequence: u64,
    approved: bool,
}
fn state() -> &'static Mutex<Shutdown> {
    static STATE: OnceLock<Mutex<Shutdown>> = OnceLock::new();
    STATE.get_or_init(Mutex::default)
}

#[tauri::command]
pub fn register_document_window(window: tauri::WebviewWindow) {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .windows
        .insert(window.label().into());
}

pub fn forget_window(label: &str) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    state.windows.remove(label);
    if let Some((_, windows, _)) = state.waiting.as_mut() {
        windows.remove(label);
    }
}

/// Return false while registered editor windows protect their drafts.
pub fn request_exit(app: &AppHandle, code: i32) -> bool {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    if state.approved || state.windows.is_empty() {
        return true;
    }
    if state.waiting.is_some() {
        return false;
    }
    state.sequence += 1;
    let request = state.sequence;
    let windows = state.windows.clone();
    state.waiting = Some((request, windows.clone(), code));
    drop(state);
    let timeout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        if state_reset(request) {
            let _ = timeout_app.emit("document:exit-cancelled", request);
        }
    });
    for window in windows {
        if let Err(error) = app.emit_to(&window, "document:prepare-exit", request) {
            tracing::error!("cannot prepare document window for exit: {error}");
            if state_reset(request) {
                let _ = app.emit("document:exit-cancelled", request);
            }
        }
    }
    false
}

fn state_reset(request: u64) -> bool {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    if state
        .waiting
        .as_ref()
        .is_some_and(|(id, _, _)| *id == request)
    {
        state.waiting = None;
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn flush_document_background() -> bool {
    crate::document_derived::flush().await
}

#[tauri::command]
pub fn finish_document_shutdown(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: u64,
    ready: bool,
) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    let Some((active_request, windows, code)) = state.waiting.as_mut() else {
        return;
    };
    if *active_request != request {
        return;
    }
    if !ready {
        state.waiting = None;
        drop(state);
        let _ = app.emit("document:exit-cancelled", request);
        return;
    }
    windows.remove(window.label());
    if !windows.is_empty() {
        return;
    }
    let code = *code;
    state.approved = true;
    state.waiting = None;
    drop(state);
    app.exit(code);
}
