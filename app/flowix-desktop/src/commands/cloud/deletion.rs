use std::path::Path;

use flowix_core::memo_file::{notebook_path_from_relative, Memo, MemoFile};
use flowix_sync::{v2_content_hash, v2_local_content_diverged, SyncManager};

pub(super) fn delete_cloud_note_locked(
    memo_file: &MemoFile,
    sync: &SyncManager,
    notebook_id: &str,
    note_id: &str,
    relative_path: Option<&str>,
    before_delete: impl FnOnce(&Path),
) -> Result<Option<Memo>, String> {
    let memo = if let Some(path) = relative_path {
        memo_file.find_memo_by_relative_path_for_notebook_id(notebook_id, path)
    } else {
        let location = memo_file.resolve_memo_location(note_id).map_err(|error| error.to_string())?;
        if location.as_ref().is_some_and(|location| location.notebook.id != notebook_id) {
            return Err(format!("CLOUD_NOTE_ID_COLLISION: {note_id}"));
        }
        location.and_then(|_| memo_file.read_memo_for_notebook_id(notebook_id, note_id))
    };
    let Some(memo) = memo else { return Ok(None) };
    let notebook = memo_file.get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let path = notebook_path_from_relative(
        Path::new(&notebook.path),
        &memo.relative_path,
    )
    .unwrap_or_else(|_| Path::new(&notebook.path).join(&memo.filename));
    let local_hash = match std::fs::read(&path) {
        Ok(bytes) => Some(v2_content_hash(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "CLOUD_DELETE_READ_FAILED: {}: {error}",
                path.display()
            ))
        }
    };
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
        return Err(format!(
            "CLOUD_DELETE_CONFLICT: local changes preserved: {}",
            path.display()
        ));
    }
    before_delete(&path);
    if memo_file
        .delete_memo_result_for_notebook_id(notebook_id, &memo.id)
        .map_err(|error| error.to_string())?
    {
        Ok(Some(memo))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests;
