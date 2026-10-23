use std::path::Path;

use super::local_adapter::{
    cloud_conflict_copy_path, register_preserved_conflict_copy, safe_cloud_note_path,
    safely_remove_conflict_file, ConflictFileOutcome, RemoteApplyError, RemoteConflict,
};
use flowix_core::memo_file::MemoFile;
use flowix_sync::{v2_content_hash, v2_local_content_diverged, SyncManager};

pub(super) fn delete_cloud_note_locked(
    memo_file: &MemoFile,
    sync: &SyncManager,
    notebook_id: &str,
    note_id: &str,
    relative_path: &str,
    before_delete: impl FnOnce(&Path),
) -> Result<bool, RemoteApplyError> {
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let path = safe_cloud_note_path(Path::new(&notebook.path), relative_path)?;

    let local_bytes = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err((format!("CLOUD_DELETE_READ_FAILED: {}: {error}", path.display())).into())
        }
    };
    let local_hash = local_bytes.as_ref().map(|bytes| v2_content_hash(bytes));
    let baseline = sync
        .v2_note_state(note_id)
        .map_err(|error| error.to_string())?;
    let pending = sync
        .has_pending_v2_note_change(note_id)
        .map_err(|error| error.to_string())?;
    if v2_local_content_diverged(
        local_hash.as_deref(),
        baseline
            .as_ref()
            .and_then(|state| state.content_hash.as_deref()),
        pending,
    ) {
        return Err(RemoteApplyError::conflict(
            RemoteConflict::NoteDelete,
            format!("local changes preserved: {}", path.display()),
        ));
    }
    before_delete(&path);
    let had_local_file = local_bytes.is_some();
    if let Some(expected) = local_bytes.as_deref() {
        let copy = cloud_conflict_copy_path(&path, note_id);
        match safely_remove_conflict_file(&path, expected, note_id, &copy)? {
            ConflictFileOutcome::Applied { preserved: None } => {}
            outcome => {
                let preserved = match outcome {
                    ConflictFileOutcome::Applied { preserved }
                    | ConflictFileOutcome::Interrupted { preserved } => preserved,
                };
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        memo_file,
                        notebook_id,
                        Path::new(&notebook.path),
                        &preserved,
                        false,
                    )?;
                }
                return Err(RemoteApplyError::conflict(
                    RemoteConflict::NoteDelete,
                    format!("local changes preserved: {}", path.display()),
                ));
            }
        }
    }
    memo_file
        .refresh_note_path(notebook_id, relative_path)
        .map_err(|error| format!("CLOUD_DELETE_INDEX_FAILED: {error}"))?;
    if path.exists() {
        return Err(RemoteApplyError::conflict(
            RemoteConflict::NoteDelete,
            format!("path was recreated: {}", path.display()),
        ));
    }
    Ok(had_local_file)
}

#[cfg(test)]
mod tests;
