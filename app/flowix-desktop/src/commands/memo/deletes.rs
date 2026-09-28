// ==================== Deletes ====================

use std::path::Path;

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};

use crate::app::search_index::{force_rebuild_index, try_index_remove};
use crate::app::state::AppState;
use crate::watcher::runtime::mark_self_write_for;
use flowix_core::memo_file::notebook_path_from_relative;
use flowix_core::MemoService;

fn delete_note_path_internal(file_path: &Path, state: &AppState, app: &AppHandle) -> bool {
    if !file_path.is_absolute() {
        return false;
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let (notebook_id, relative_path) =
        match super::helpers::notebook_note_address(&memo_file, file_path) {
            Ok(Some(address)) => address,
            Ok(None) | Err(_) => return false,
        };
    let before = memo_file.find_memo_by_relative_path_for_notebook_id(&notebook_id, &relative_path);
    let artifact_path = before.as_ref().and_then(|memo| {
        match crate::artifact::path_for_memo(&memo.id, &state.memo_file) {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(memo_id = %memo.id, "skip plugin artifact cleanup while deleting pointer note: {error}");
                None
            }
        }
    });
    let absolute_path = file_path.to_path_buf();
    mark_self_write_for(app, &absolute_path);
    let file_was_present = absolute_path.exists();
    let deleted = MemoService::new(&memo_file)
        .delete_note_by_path(&notebook_id, &relative_path)
        .unwrap_or(false);
    drop(memo_file);

    let Some(before) = before else {
        return deleted;
    };

    // The Markdown deletion is authoritative. Clean up optional ID-keyed
    // history and projections afterward without making them a prerequisite.
    let legacy_cleanup =
        MemoService::new(&read_lock(&state.memo_file, "memo_file")).delete_memo(&before.id);
    if legacy_cleanup.is_err() {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let _ = memo_file.unregister_memo_by_path_for_notebook_id(&notebook_id, &absolute_path);
        tracing::warn!(memo_id = %before.id, "note deleted but legacy memo cleanup failed");
    }
    try_index_remove(state, &before.id);
    if let Some(artifact_path) = artifact_path {
        if let Err(error) = crate::artifact::remove_path(&artifact_path) {
            tracing::warn!(path = %artifact_path.display(), "plugin artifact cleanup failed: {error}");
        }
    }
    memo_events::emit(
        app,
        MemoEvent::Deleted {
            id: before.id.clone(),
            path: absolute_path.display().to_string(),
            notebook_id,
            derived_changed: MemoDerivedChanged::from_deleted(&before),
            source: MemoChangeSource::UserDelete,
        },
    );
    deleted || !file_was_present
}

#[tauri::command]
pub fn delete_memo(file_path: String, state: State<AppState>, app: AppHandle) -> bool {
    let deleted = delete_note_path_internal(Path::new(&file_path), state.inner(), &app);
    if deleted {
        force_rebuild_index(state.inner(), &app);
    }
    deleted
}

#[tauri::command]
pub fn clear_memos(notebook_id: Option<String>, state: State<AppState>, app: AppHandle) -> bool {
    let requested_notebook =
        notebook_id.unwrap_or_else(|| super::helpers::current_notebook_id(state.inner()));
    let (notebook, note_paths) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = MemoService::new(&memo_file);
        let notebook = match service.resolve_notebook(&requested_notebook) {
            Ok(notebook) => notebook,
            Err(error) => {
                tracing::warn!("cannot clear notebook notes: {error}");
                return false;
            }
        };
        let note_paths = match memo_file.list_v2_note_paths_from_disk(&notebook.id) {
            Ok(paths) => paths,
            Err(error) => {
                tracing::warn!(notebook_id = %notebook.id, "cannot enumerate note files for clear: {error}");
                return false;
            }
        };
        (notebook, note_paths)
    };

    let mut success = true;
    let mut removed_paths = std::collections::HashSet::new();
    for relative_path in note_paths {
        let absolute_path =
            match notebook_path_from_relative(Path::new(&notebook.path), &relative_path) {
                Ok(path) => path,
                Err(error) => {
                    tracing::warn!(
                        relative_path,
                        "invalid path while clearing notebook: {error}"
                    );
                    success = false;
                    continue;
                }
            };
        removed_paths.insert(relative_path);
        if !delete_note_path_internal(&absolute_path, state.inner(), &app) {
            success = false;
        }
    }

    // Remove legacy index ghosts that have no Markdown path to enumerate.
    let legacy_ghosts = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .list_all_memos(Some(&notebook.id))
        .into_iter()
        .filter(|memo| !removed_paths.contains(&memo.relative_path))
        .collect::<Vec<_>>();
    for memo in legacy_ghosts {
        let absolute_path =
            match notebook_path_from_relative(Path::new(&notebook.path), &memo.relative_path) {
                Ok(path) => path,
                Err(_) => continue,
            };
        if !delete_note_path_internal(&absolute_path, state.inner(), &app) {
            success = false;
        }
    }

    force_rebuild_index(state.inner(), &app);
    success
}
