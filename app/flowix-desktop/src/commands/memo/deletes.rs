// ==================== Deletes ====================

use std::path::Path;

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};

use crate::app::search_index::{force_rebuild_index, try_index_remove};
use crate::app::state::AppState;
use crate::watcher::runtime::mark_self_write_for;
use flowix_core::memo_file::notebook_path_from_relative;
use flowix_core::{MemoService, NoteService};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeleteMemoOutcome {
    Deleted,
    MissingCleaned,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PruneMissingMemoOutcome {
    Present,
    MissingCleaned,
}

fn delete_note_path_internal(
    file_path: &Path,
    state: &AppState,
    app: &AppHandle,
    prune_only: bool,
) -> Result<Option<DeleteMemoOutcome>, String> {
    if !file_path.is_absolute() {
        return Err("absolute note path required".into());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let (notebook_id, relative_path) = super::helpers::notebook_note_address(&memo_file, file_path)?
        .ok_or_else(|| "note path is outside a notebook or is not Markdown".to_string())?;
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
    let deleted = if prune_only {
        if !memo_file
            .prune_missing_note_by_path(&notebook_id, &relative_path)
            .map_err(|error| error.to_string())?
        {
            return Ok(None);
        }
        false
    } else {
        mark_self_write_for(app, &absolute_path);
        NoteService::new(&memo_file)
            .delete(&notebook_id, &relative_path)
            .map_err(|error| error.to_string())?
    };
    drop(memo_file);
    let outcome = if deleted {
        DeleteMemoOutcome::Deleted
    } else {
        DeleteMemoOutcome::MissingCleaned
    };

    let Some(before) = before else {
        return Ok(Some(outcome));
    };

    // The Markdown deletion is authoritative. Clean up optional ID-keyed
    // history and projections afterward without making them a prerequisite.
    let legacy_cleanup = read_lock(&state.memo_file, "memo_file")
        .prune_deleted_memo_for_notebook_id(&notebook_id, &relative_path, &before.id)
        .map_err(|error| error.to_string())?;
    if !legacy_cleanup {
        return Ok(None);
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
    Ok(Some(outcome))
}

#[tauri::command]
pub fn delete_memo(
    file_path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<DeleteMemoOutcome, String> {
    let outcome = delete_note_path_internal(Path::new(&file_path), state.inner(), &app, false)?
        .ok_or_else(|| "note deletion did not complete".to_string())?;
    force_rebuild_index(state.inner(), &app);
    Ok(outcome)
}

#[tauri::command]
pub fn prune_missing_memo(
    file_path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<PruneMissingMemoOutcome, String> {
    let outcome = delete_note_path_internal(Path::new(&file_path), state.inner(), &app, true)?;
    if outcome.is_some() {
        force_rebuild_index(state.inner(), &app);
        Ok(PruneMissingMemoOutcome::MissingCleaned)
    } else {
        Ok(PruneMissingMemoOutcome::Present)
    }
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
        let note_paths = match memo_file.list_note_paths_from_disk(&notebook.id) {
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
        if !matches!(delete_note_path_internal(&absolute_path, state.inner(), &app, false), Ok(Some(_))) {
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
        if !matches!(delete_note_path_internal(&absolute_path, state.inner(), &app, false), Ok(Some(_))) {
            success = false;
        }
    }

    force_rebuild_index(state.inner(), &app);
    success
}
