//! Keep the notebook path index aligned with filesystem changes.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use flowix_core::memo_file::{
    is_ignored_notebook_relative_path, notebook_relative_path, MemoFile,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::watcher::event::{FsEventKind, RawFsEvent};

#[derive(Debug, Clone)]
pub struct NotebookWatchContext {
    pub notebook_id: String,
    pub root: PathBuf,
}

pub struct PathNoteEventProcessor;

#[derive(Debug)]
pub(crate) enum DispatchOutcome {
    PathIndexed { relative_path: String },
}

fn indexable_relative_path(ctx: &NotebookWatchContext, path: &Path) -> Result<String, String> {
    let relative_path = notebook_relative_path(&ctx.root, path)?;
    let relative = Path::new(&relative_path);
    let markdown = relative.extension().and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "md" | "markdown"));
    if !markdown || is_ignored_notebook_relative_path(relative) {
        return Err("not an indexable Markdown path".to_string());
    }
    Ok(relative_path)
}

#[cfg(test)]
pub(crate) fn dispatch_modify_event(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    _event_kind: FsEventKind,
) -> Result<DispatchOutcome, String> {
    refresh_path(memo_file, ctx, path)
}

fn refresh_path(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
) -> Result<DispatchOutcome, String> {
    let relative_path = indexable_relative_path(ctx, path)?;
    memo_file.refresh_v2_note_path(&ctx.notebook_id, &relative_path)
        .map_err(|error| error.to_string())?;
    Ok(DispatchOutcome::PathIndexed { relative_path })
}

fn emit_path_changed(app: &AppHandle, ctx: &NotebookWatchContext, relative_path: &str, deleted: bool) {
    let _ = app.emit("flowix:path-note-changed", serde_json::json!({
        "notebookId": ctx.notebook_id,
        "relativePath": relative_path,
        "deleted": deleted,
    }));
}

/// Ignore attachments even when a user preference broadens the watcher filter.
fn is_under_attachments_dir(ctx: &NotebookWatchContext, path: &Path) -> bool {
    let attachments = crate::watcher::path::normalize_for_compare(&ctx.root.join("attachments"));
    crate::watcher::path::normalize_for_compare(path).starts_with(&attachments)
}

pub(crate) fn wait_for_markdown_copy_to_settle(path: &Path) {
    let mut last_len = None;
    let mut stable_samples = 0;
    for _ in 0..8 {
        let Ok(meta) = std::fs::metadata(path) else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        if !meta.is_file() { return; }
        let len = meta.len();
        if Some(len) == last_len {
            stable_samples += 1;
            if stable_samples >= 2 && std::fs::File::open(path).is_ok() { return; }
        } else {
            last_len = Some(len);
            stable_samples = 0;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

impl PathNoteEventProcessor {
    pub fn process(
        event: &RawFsEvent,
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
    ) {
        if event.rename_from.is_none() && is_under_attachments_dir(ctx, &event.path) { return; }
        if let (Some(old_path), Some(old_notebook_id), Some(old_root)) = (
            event.rename_from.as_ref(),
            event.rename_from_notebook_id.as_ref(),
            event.rename_from_root.as_ref(),
        ) {
            let old_ctx = NotebookWatchContext { notebook_id: old_notebook_id.clone(), root: old_root.clone() };
            if let (Ok(old_relative), Ok(new_relative)) = (
                notebook_relative_path(&old_ctx.root, old_path),
                notebook_relative_path(&ctx.root, &event.path),
            ) {
                let state = app.state::<crate::app::state::AppState>();
                if let Err(error) = state.thread_manager.rebase_agent_note_paths(
                    old_notebook_id,
                    &ctx.notebook_id,
                    &old_relative,
                    &new_relative,
                    &old_path.to_string_lossy(),
                    &event.path.to_string_lossy(),
                ) {
                    tracing::warn!(old_notebook_id, new_notebook_id = %ctx.notebook_id, "agent cross-notebook path rebase failed: {error}");
                }
            }
            return;
        }
        let Ok(memo_file) = memo_file.read() else { return; };
        let Ok(_write_guard) = memo_file.acquire_cross_process_write_lock() else { return; };

        if let Some(old_path) = &event.rename_from {
            let rebase = notebook_relative_path(&ctx.root, old_path).ok()
                .zip(notebook_relative_path(&ctx.root, &event.path).ok());
            if let Err(error) = memo_file.reconcile_v2_note_index(&ctx.notebook_id) {
                tracing::warn!(notebook_id = %ctx.notebook_id, "path rename reconciliation failed: {error}");
            }
            let mut emitted = false;
            if let Ok(relative_path) = indexable_relative_path(ctx, old_path) {
                emit_path_changed(app, ctx, &relative_path, true);
                emitted = true;
            }
            if let Ok(relative_path) = indexable_relative_path(ctx, &event.path) {
                emit_path_changed(app, ctx, &relative_path, false);
                emitted = true;
            }
            if !emitted { emit_path_changed(app, ctx, "", false); }
            drop(_write_guard);
            drop(memo_file);
            if let Some((old_relative, new_relative)) = rebase {
                let state = app.state::<crate::app::state::AppState>();
                if let Err(error) = state.thread_manager.rebase_agent_note_paths(
                    &ctx.notebook_id,
                    &ctx.notebook_id,
                    &old_relative,
                    &new_relative,
                    &old_path.to_string_lossy(),
                    &event.path.to_string_lossy(),
                ) {
                    tracing::warn!(notebook_id = %ctx.notebook_id, "agent path rebase failed: {error}");
                }
            }
            return;
        }

        match event.kind {
            FsEventKind::Create | FsEventKind::Modify | FsEventKind::Remove => {
                match refresh_path(&memo_file, ctx, &event.path) {
                    Ok(DispatchOutcome::PathIndexed { relative_path }) => {
                        emit_path_changed(app, ctx, &relative_path, !event.path.exists());
                    }
                    Err(error) => tracing::debug!(path = %event.path.display(), "path refresh skipped: {error}"),
                }
            }
            FsEventKind::DirectoryChange => {
                Self::reconcile_directory_change(app, &memo_file, ctx);
            }
            FsEventKind::Other => {}
        }
    }

    fn reconcile_directory_change(app: &AppHandle, memo_file: &MemoFile, ctx: &NotebookWatchContext) {
        match memo_file.reconcile_v2_note_index(&ctx.notebook_id) {
            Ok(report) => tracing::info!(notebook_id = %ctx.notebook_id,
                added = report.added, updated = report.updated, removed = report.removed,
                "path index reconciliation completed"),
            Err(error) => tracing::warn!(notebook_id = %ctx.notebook_id,
                "path index reconciliation failed: {error}"),
        }
        emit_path_changed(app, ctx, "", false);
    }

    pub(crate) fn unregister_and_emit(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        path: &Path,
    ) {
        let Ok(memo_file) = memo_file.read() else { return; };
        let Ok(_write_guard) = memo_file.acquire_cross_process_write_lock() else { return; };
        if let Ok(DispatchOutcome::PathIndexed { relative_path }) = refresh_path(&memo_file, ctx, path) {
            emit_path_changed(app, ctx, &relative_path, !path.exists());
        }
    }
}

#[cfg(test)]
mod tests;
