//! Local Markdown/attachment snapshot and remote-change application.
use super::*;

const FULL_LOCAL_SNAPSHOT_INTERVAL_MS: i64 = 5 * 60 * 1_000;
pub(super) static LAST_FULL_LOCAL_SNAPSHOT_AT: AtomicI64 = AtomicI64::new(0);
static LAST_FULL_LOCAL_SNAPSHOT_BY_NOTEBOOK: OnceLock<std::sync::Mutex<HashMap<String, i64>>> = OnceLock::new();

pub(super) fn record_full_local_snapshot(notebook_scope: Option<&str>) {
    let now = Utc::now().timestamp_millis();
    if let Some(scope) = notebook_scope {
        let snapshots = LAST_FULL_LOCAL_SNAPSHOT_BY_NOTEBOOK
            .get_or_init(|| std::sync::Mutex::new(HashMap::new()));
        snapshots.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(scope.to_string(), now);
    } else {
        LAST_FULL_LOCAL_SNAPSHOT_AT.store(now, Ordering::SeqCst);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ConflictFileOutcome {
    Applied { preserved: Option<PathBuf> },
    Interrupted { preserved: Option<PathBuf> },
}

fn conflict_stage_path(path: &Path, operation_id: &str) -> PathBuf {
    let operation_key: String = operation_id.chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(48).collect();
    let path_hash = flowix_sync::v2_content_hash(path.to_string_lossy().as_bytes());
    path.with_file_name(format!(".flowix-sync-{operation_key}-{}.stage", &path_hash[..8]))
}

pub(super) fn cloud_conflict_copy_path(path: &Path, operation_id: &str) -> PathBuf {
    let operation_key: String = operation_id.chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(48).collect();
    let stem: String = path.file_stem().and_then(|value| value.to_str())
        .unwrap_or("Note").chars().take(80).collect();
    let name = match path.extension().and_then(|value| value.to_str()) {
        Some(extension) => format!("{stem} (Flowix conflict {operation_key}).{extension}"),
        None => format!("{stem} (Flowix conflict {operation_key})"),
    };
    path.with_file_name(name)
}

fn save_conflict_bytes(primary: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if primary.exists() && std::fs::read(primary).map_err(sync_error)? == bytes {
        return Ok(primary.to_path_buf());
    }
    if !primary.exists() {
        match flowix_core::memo_file::atomic_create_bytes(primary, bytes) {
            Ok(()) => return Ok(primary.to_path_buf()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if std::fs::read(primary).map_err(sync_error)? == bytes {
                    return Ok(primary.to_path_buf());
                }
            }
            Err(error) => return Err(sync_error(error)),
        }
    }
    let hash = flowix_sync::v2_content_hash(bytes);
    let stem = primary.file_stem().and_then(|value| value.to_str()).unwrap_or("Note");
    let extension = primary.extension().and_then(|value| value.to_str());
    for suffix in 0..100 {
        let name = match (extension, suffix) {
            (Some(extension), 0) => format!("{stem} (observed-{hash}).{extension}"),
            (Some(extension), suffix) => format!("{stem} (observed-{hash}-{suffix}).{extension}"),
            (None, 0) => format!("{stem} (observed-{hash})"),
            (None, suffix) => format!("{stem} (observed-{hash}-{suffix})"),
        };
        let candidate = primary.with_file_name(name);
        if candidate.exists() {
            if std::fs::read(&candidate).map_err(sync_error)? == bytes {
                return Ok(candidate);
            }
            continue;
        }
        match flowix_core::memo_file::atomic_create_bytes(&candidate, bytes) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if std::fs::read(&candidate).map_err(sync_error)? == bytes {
                    return Ok(candidate);
                }
            }
            Err(error) => return Err(sync_error(error)),
        }
    }
    Err("CLOUD_CONFLICT_COPY_COLLISION: could not allocate a safe copy name".into())
}

fn recover_conflict_stage(path: &Path, stage: &Path, conflict_copy: &Path) -> Result<Option<PathBuf>, String> {
    if !stage.exists() {
        return Ok(None);
    }
    if !path.exists() {
        flowix_core::memo_file::rename_file_noclobber(stage, path).map_err(sync_error)?;
        return Ok(None);
    }
    let bytes = std::fs::read(stage).map_err(sync_error)?;
    let preserved = save_conflict_bytes(conflict_copy, &bytes)?;
    std::fs::remove_file(stage).map_err(sync_error)?;
    Ok(Some(preserved))
}

fn safely_replace_conflict_file_with_hook(
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
    operation_id: &str,
    conflict_copy: &Path,
    after_detach: impl FnOnce(&Path),
) -> Result<ConflictFileOutcome, String> {
    let stage = conflict_stage_path(path, operation_id);
    if let Some(preserved) = recover_conflict_stage(path, &stage, conflict_copy)? {
        return Ok(ConflictFileOutcome::Interrupted { preserved: Some(preserved) });
    }
    let current = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConflictFileOutcome::Interrupted { preserved: None });
        }
        Err(error) => return Err(sync_error(error)),
    };
    if current != expected {
        return Ok(ConflictFileOutcome::Interrupted { preserved: None });
    }
    if let Err(error) = flowix_core::memo_file::rename_file_noclobber(path, &stage) {
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(ConflictFileOutcome::Interrupted { preserved: None });
        }
        return Err(sync_error(error));
    }
    let captured = std::fs::read(&stage).map_err(sync_error)?;
    if captured != expected {
        let preserved = save_conflict_bytes(conflict_copy, &captured)?;
        if !path.exists() {
            let _ = flowix_core::memo_file::rename_file_noclobber(&stage, path);
        }
        if stage.exists() && path.exists() {
            std::fs::remove_file(&stage).map_err(sync_error)?;
        }
        return Ok(ConflictFileOutcome::Interrupted { preserved: Some(preserved) });
    }
    let original_permissions = std::fs::metadata(&stage).map_err(sync_error)?.permissions();
    after_detach(path);
    match flowix_core::memo_file::atomic_create_bytes(path, replacement) {
        Ok(()) => {
            std::fs::set_permissions(path, original_permissions).map_err(sync_error)?;
            let latest = std::fs::read(&stage).map_err(sync_error)?;
            let preserved = if latest == expected {
                None
            } else {
                Some(save_conflict_bytes(conflict_copy, &latest)?)
            };
            std::fs::remove_file(&stage).map_err(sync_error)?;
            Ok(ConflictFileOutcome::Applied { preserved })
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let bytes = std::fs::read(&stage).map_err(sync_error)?;
            let preserved = save_conflict_bytes(conflict_copy, &bytes)?;
            std::fs::remove_file(&stage).map_err(sync_error)?;
            Ok(ConflictFileOutcome::Interrupted { preserved: Some(preserved) })
        }
        Err(error) => {
            if !path.exists() {
                let _ = flowix_core::memo_file::rename_file_noclobber(&stage, path);
            }
            Err(sync_error(error))
        }
    }
}

fn safely_replace_conflict_file(
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
    operation_id: &str,
    conflict_copy: &Path,
) -> Result<ConflictFileOutcome, String> {
    safely_replace_conflict_file_with_hook(path, expected, replacement, operation_id, conflict_copy, |_| {})
}

pub(super) fn safely_replace_cloud_file(
    path: &Path,
    expected: Option<&[u8]>,
    replacement: &[u8],
    operation_id: &str,
    conflict_copy: &Path,
) -> Result<ConflictFileOutcome, String> {
    if let Some(expected) = expected {
        return safely_replace_conflict_file(path, expected, replacement, operation_id, conflict_copy);
    }
    match flowix_core::memo_file::atomic_create_bytes(path, replacement) {
        Ok(()) => Ok(ConflictFileOutcome::Applied { preserved: None }),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(ConflictFileOutcome::Interrupted { preserved: None })
        }
        Err(error) => Err(sync_error(error)),
    }
}

fn safely_remove_conflict_file_with_hook(
    path: &Path,
    expected: &[u8],
    operation_id: &str,
    conflict_copy: &Path,
    after_detach: impl FnOnce(&Path),
) -> Result<ConflictFileOutcome, String> {
    let stage = conflict_stage_path(path, operation_id);
    if let Some(preserved) = recover_conflict_stage(path, &stage, conflict_copy)? {
        return Ok(ConflictFileOutcome::Interrupted { preserved: Some(preserved) });
    }
    let current = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConflictFileOutcome::Applied { preserved: None });
        }
        Err(error) => return Err(sync_error(error)),
    };
    if current != expected {
        return Ok(ConflictFileOutcome::Interrupted { preserved: None });
    }
    if let Err(error) = flowix_core::memo_file::rename_file_noclobber(path, &stage) {
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(ConflictFileOutcome::Interrupted { preserved: None });
        }
        return Err(sync_error(error));
    }
    let captured = std::fs::read(&stage).map_err(sync_error)?;
    if captured != expected {
        let preserved = save_conflict_bytes(conflict_copy, &captured)?;
        if !path.exists() {
            let _ = flowix_core::memo_file::rename_file_noclobber(&stage, path);
        }
        if stage.exists() && path.exists() {
            std::fs::remove_file(&stage).map_err(sync_error)?;
        }
        return Ok(ConflictFileOutcome::Interrupted { preserved: Some(preserved) });
    }
    after_detach(path);
    if path.exists() {
        let preserved = save_conflict_bytes(conflict_copy, &captured)?;
        std::fs::remove_file(&stage).map_err(sync_error)?;
        return Ok(ConflictFileOutcome::Interrupted { preserved: Some(preserved) });
    }
    std::fs::remove_file(&stage).map_err(sync_error)?;
    Ok(ConflictFileOutcome::Applied { preserved: None })
}

pub(super) fn safely_remove_conflict_file(
    path: &Path,
    expected: &[u8],
    operation_id: &str,
    conflict_copy: &Path,
) -> Result<ConflictFileOutcome, String> {
    safely_remove_conflict_file_with_hook(path, expected, operation_id, conflict_copy, |_| {})
}

pub(super) fn register_preserved_conflict_copy(
    memo_file: &flowix_core::memo_file::MemoFile,
    notebook_id: &str,
    notebook_root: &Path,
    path: &Path,
    attachment: bool,
) -> Result<(), String> {
    if attachment {
        let relative = flowix_core::memo_file::notebook_relative_path(notebook_root, path)?;
        memo_file.refresh_media_resource_path(notebook_id, &relative).map_err(sync_error)
    } else {
        memo_file.register_existing_file_for_notebook_id(notebook_id, path)
            .map(|_| ()).map_err(sync_error)
    }
}

fn recover_and_register_conflict_stage(
    memo_file: &flowix_core::memo_file::MemoFile,
    notebook_id: &str,
    notebook_root: &Path,
    path: &Path,
    operation_id: &str,
    conflict_copy: &Path,
    attachment: bool,
) -> Result<bool, String> {
    let stage = conflict_stage_path(path, operation_id);
    let Some(preserved) = recover_conflict_stage(path, &stage, conflict_copy)? else {
        return Ok(false);
    };
    register_preserved_conflict_copy(memo_file, notebook_id, notebook_root, &preserved, attachment)?;
    Ok(true)
}

/// Save a rejected local move under a visible conflict name, then remove the
/// move from the durable queue. The next pass bootstraps the current cloud
/// tree and restores its files alongside this preserved local copy.
pub(super) fn resolve_v2_move_conflict(
    state: &AppState,
    app: &AppHandle,
    movement: &flowix_sync::V2PendingMove,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _guard = memo_file.acquire_cross_process_write_lock().map_err(sync_error)?;
    let notebook = memo_file.get_notebook_config_by_id(&movement.notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let root = Path::new(&notebook.path);
    let attachment = movement.to_path.starts_with("attachments/");
    let target = safe_cloud_file_path(root, &movement.to_path, attachment)?;
    let file_name = target.file_name().and_then(|value| value.to_str())
        .ok_or_else(|| "CLOUD_MOVE_CONFLICT_INVALID_NAME".to_string())?;
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("Note");
    let short_stem: String = stem.chars().take(80).collect();
    let extension = path.extension().and_then(|value| value.to_str());
    let conflict_name = match extension {
        Some(extension) => format!("{short_stem} (Flowix conflict {}).{extension}", movement.operation_id),
        None => format!("{short_stem} (Flowix conflict {})", movement.operation_id),
    };
    let primary_conflict_path = target.with_file_name(conflict_name);
    let mut conflict_path = primary_conflict_path.clone();

    if recover_and_register_conflict_stage(
        &memo_file, &movement.notebook_id, root, &target, &movement.operation_id,
        &primary_conflict_path, attachment,
    )? {
        return Err("CLOUD_CONFLICT_LOCAL_CHANGED: recovered a staged move version".into());
    }

    let local = if target.exists() {
        Some(std::fs::read(&target).map_err(sync_error)?)
    } else {
        None
    };
    if let Some(local) = &local {
        if primary_conflict_path.exists()
            && std::fs::read(&primary_conflict_path).map_err(sync_error)? != *local
        {
            // A local edit may arrive after a previous conflict attempt saved
            // its bytes. Keep that earlier copy and make this version visible
            // under a deterministic second conflict name.
            let hash = flowix_sync::v2_content_hash(local);
            let revision_suffix = &hash[..8.min(hash.len())];
            let updated_name = match extension {
                Some(extension) => format!(
                    "{short_stem} (Flowix conflict {} local-{revision_suffix}).{extension}",
                    movement.operation_id,
                ),
                None => format!(
                    "{short_stem} (Flowix conflict {} local-{revision_suffix})",
                    movement.operation_id,
                ),
            };
            conflict_path = target.with_file_name(updated_name);
        }
        if conflict_path.exists() {
            if std::fs::read(&conflict_path).map_err(sync_error)? != *local {
                return Err("CLOUD_CONFLICT_COPY_COLLISION: local move preserved".into());
            }
        } else {
            crate::watcher::runtime::mark_self_write_for(app, &conflict_path);
            flowix_core::memo_file::atomic_create_bytes(&conflict_path, local).map_err(sync_error)?;
        }
    }
    if local.is_none() && !conflict_path.exists() {
        // The user removed the moved file while the move was pending. There
        // are no local bytes to preserve; the bootstrap below restores the
        // current cloud copy and clears the stale move intent.
        return state.cloud_sync.discard_v2_move_after_conflict(movement).map_err(sync_error);
    }

    let conflict_relative = flowix_core::memo_file::notebook_relative_path(root, &conflict_path)?;
    if attachment {
        memo_file.refresh_media_resource_path(&movement.notebook_id, &conflict_relative)
            .map_err(sync_error)?;
    } else {
        memo_file.register_existing_file_for_notebook_id(&movement.notebook_id, &conflict_path)
            .map_err(sync_error)?;
    }

    if let Some(local) = &local {
        match safely_remove_conflict_file(&target, local, &movement.operation_id, &primary_conflict_path)? {
            ConflictFileOutcome::Applied { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file, &movement.notebook_id, root, &preserved, attachment,
                    )?;
                }
            }
            ConflictFileOutcome::Interrupted { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file, &movement.notebook_id, root, &preserved, attachment,
                    )?;
                }
                return Err("CLOUD_CONFLICT_LOCAL_CHANGED: move target changed during recovery".into());
            }
        }
        crate::watcher::runtime::mark_self_write_missing_for(app, &target);
        if attachment {
            memo_file.refresh_media_resource_path(&movement.notebook_id, &movement.to_path)
                .map_err(sync_error)?;
        } else if let Some(memo) = memo_file.find_memo_by_relative_path_for_notebook_id(
            &movement.notebook_id, &movement.to_path,
        ) {
            let _ = memo_file.prune_deleted_memo_for_notebook_id(
                &movement.notebook_id, &movement.to_path, &memo.id,
            ).map_err(sync_error)?;
        }
    }
    state.cloud_sync.discard_v2_move_after_conflict(movement).map_err(sync_error)
}

/// A local delete cannot overwrite a concurrent cloud edit. Keep the prior
/// local revision as a named copy (or a notice if its blob has expired), then
/// rebase to the cloud head so the normal pull restores the edited file.
pub(super) fn resolve_v2_delete_conflict(
    state: &AppState,
    app: &AppHandle,
    material: &flowix_sync::V2ConflictMaterial,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _guard = memo_file.acquire_cross_process_write_lock().map_err(sync_error)?;
    let notebook = memo_file.get_notebook_config_by_id(&material.notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;

    if !material.remote.deleted || material.relocated.is_some() {
        let attachment = material.remote.filename.starts_with("attachments/");
        let root = Path::new(&notebook.path);
        let original = if attachment {
            safe_cloud_file_path(root, &material.remote.filename, true)?
        } else {
            safe_cloud_note_path(root, &material.remote.filename)?
        };
        let file_name = original.file_name().and_then(|value| value.to_str())
            .ok_or_else(|| "CLOUD_DELETE_CONFLICT_INVALID_NAME".to_string())?;
        let path = Path::new(file_name);
        let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("Note");
        let short_stem: String = stem.chars().take(80).collect();
        let bytes = material.base_content.as_deref()
            .or_else(|| if attachment { material.remote_content.as_deref() } else { None })
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!(
                "This note was deleted locally while the cloud changed. The cloud version was kept at its current path; review it before deleting again.\n\nCloud revision: {}\n",
                material.remote.revision,
            ).into_bytes());
        let extension = path.extension().and_then(|value| value.to_str());
        let conflict_name = if attachment {
            match extension {
                Some(extension) => format!("{short_stem} (Flowix conflict {}).{extension}", material.operation_id),
                None => format!("{short_stem} (Flowix conflict {})", material.operation_id),
            }
        } else {
            match extension {
                Some(extension) => format!("{short_stem} (Flowix conflict {}).{extension}", material.operation_id),
                None => format!("{short_stem} (Flowix conflict {}).md", material.operation_id),
            }
        };
        let conflict_path = original.with_file_name(conflict_name);
        if conflict_path.exists() {
            if std::fs::read(&conflict_path).map_err(sync_error)? != bytes {
                return Err("CLOUD_CONFLICT_COPY_COLLISION: deleted revision preserved".into());
            }
        } else {
            crate::watcher::runtime::mark_self_write_for(app, &conflict_path);
            flowix_core::memo_file::atomic_create_bytes(&conflict_path, &bytes).map_err(sync_error)?;
        }
        if attachment {
            let relative = flowix_core::memo_file::notebook_relative_path(root, &conflict_path)?;
            memo_file.refresh_media_resource_path(&material.notebook_id, &relative)
                .map_err(sync_error)?;
        } else {
            memo_file.register_existing_file_for_notebook_id(&material.notebook_id, &conflict_path)
                .map_err(sync_error)?;
        }
    }

    if let Some(target) = &material.relocated {
        state.cloud_sync.v2_rebase_moved_conflict(&material.remote, target).map_err(sync_error)
    } else {
        state.cloud_sync.v2_rebase_after_conflict(&material.remote).map_err(sync_error)
    }
}

pub(super) fn scan_cloud_attachments(root: &Path, directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(directory).map_err(sync_error)? {
        let entry = entry.map_err(sync_error)?;
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(sync_error)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            scan_cloud_attachments(root, &path, output)?;
        } else if metadata.is_file() && path.starts_with(root) {
            output.push(path);
        }
    }
    Ok(())
}

/// Resolve a rejected Markdown put before its old server head is acknowledged.
/// The caller reruns a full snapshot after this function updates the disk and
/// the local revision base. Conflict markers are never written to authored Markdown.
pub(super) fn resolve_v2_markdown_conflict(
    state: &AppState,
    app: &AppHandle,
    material: &flowix_sync::V2ConflictMaterial,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _guard = memo_file.acquire_cross_process_write_lock().map_err(sync_error)?;
    let notebook = memo_file.get_notebook_config_by_id(&material.notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    if material.remote.filename.starts_with("attachments/") {
        let notebook_root = Path::new(&notebook.path);
        let path = safe_cloud_file_path(notebook_root, &material.remote.filename, true)?;
        let stem: String = path.file_stem().and_then(|value| value.to_str())
            .unwrap_or("attachment").chars().take(80).collect();
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("");
        let filename = if extension.is_empty() {
            format!("{stem} (Flowix conflict {})", material.operation_id)
        } else {
            format!("{stem} (Flowix conflict {}).{extension}", material.operation_id)
        };
        let copy_path = path.with_file_name(filename);
        if recover_and_register_conflict_stage(
            &memo_file, &material.notebook_id, notebook_root, &path,
            &material.operation_id, &copy_path, true,
        )? {
            return Err("CLOUD_CONFLICT_LOCAL_CHANGED: recovered a staged attachment version".into());
        }
        let local = std::fs::read(&path).map_err(sync_error)?;
        if copy_path.exists() {
            if std::fs::read(&copy_path).map_err(sync_error)? != local {
                return Err("CLOUD_CONFLICT_COPY_COLLISION: local changes preserved".to_string());
            }
        } else {
            flowix_core::memo_file::atomic_create_bytes(&copy_path, &local).map_err(sync_error)?;
        }
        if flowix_core::memo_file::media_kind_for_path(&copy_path).is_some() {
            memo_file.refresh_media_resource_path(&material.notebook_id,
                &flowix_core::memo_file::notebook_relative_path(Path::new(&notebook.path), &copy_path)?)
                .map_err(sync_error)?;
        }
        if std::fs::read(&path).map_err(sync_error)? != local {
            return Err("CLOUD_CONFLICT_LOCAL_CHANGED: local changes preserved".to_string());
        }
        if material.remote.deleted && material.relocated.is_none() {
            crate::watcher::runtime::mark_self_write_for(app, &path);
            match safely_remove_conflict_file(&path, &local, &material.operation_id, &copy_path)? {
                ConflictFileOutcome::Applied { preserved } => {
                    if let Some(preserved) = preserved {
                        register_preserved_conflict_copy(
                            &memo_file, &material.notebook_id, notebook_root, &preserved, true,
                        )?;
                    }
                }
                ConflictFileOutcome::Interrupted { preserved } => {
                    if let Some(preserved) = preserved {
                        register_preserved_conflict_copy(
                            &memo_file, &material.notebook_id, notebook_root, &preserved, true,
                        )?;
                    }
                    return Err("CLOUD_CONFLICT_LOCAL_CHANGED: attachment changed during recovery".into());
                }
            }
            crate::watcher::runtime::mark_self_write_missing_for(app, &path);
            if flowix_core::memo_file::media_kind_for_path(&path).is_some() {
                memo_file.refresh_media_resource_path(&material.notebook_id, &material.remote.filename)
                    .map_err(sync_error)?;
            }
            let _ = app.emit("media-properties-changed", serde_json::json!({ "notebookId": material.notebook_id }));
            return state.cloud_sync.v2_rebase_after_conflict(&material.remote).map_err(sync_error);
        }
        let remote = material.remote_content.as_deref()
            .ok_or_else(|| "CLOUD_CONFLICT_REMOTE_UNAVAILABLE".to_string())?;
        let destination = if let Some(target) = &material.relocated {
            let destination = safe_cloud_file_path(Path::new(&notebook.path), &target.filename, true)?;
            if destination.exists() {
                return Err("CLOUD_MOVE_TARGET_COLLISION: local changes preserved".to_string());
            }
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(sync_error)?;
            }
            crate::watcher::runtime::mark_self_write_for(app, &path);
            crate::watcher::runtime::mark_self_write_for(app, &destination);
            flowix_core::memo_file::rename_file_noclobber(&path, &destination).map_err(sync_error)?;
            if flowix_core::memo_file::media_kind_for_path(&destination).is_some() {
                if let Err(error) = memo_file.move_media_resource_path(
                    &material.notebook_id, &material.remote.filename, &target.filename,
                ) {
                    let _ = flowix_core::memo_file::rename_file_noclobber(&destination, &path);
                    return Err(sync_error(error));
                }
            }
            destination
        } else {
            crate::watcher::runtime::mark_self_write_for(app, &path);
            path.clone()
        };
        crate::watcher::runtime::mark_self_write_for(app, &destination);
        match safely_replace_conflict_file(
            &destination, &local, remote, &material.operation_id, &copy_path,
        )? {
            ConflictFileOutcome::Applied { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file, &material.notebook_id, notebook_root, &preserved, true,
                    )?;
                }
            }
            ConflictFileOutcome::Interrupted { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file, &material.notebook_id, notebook_root, &preserved, true,
                    )?;
                }
                if material.relocated.is_some() && !path.exists() && destination.exists()
                    && flowix_core::memo_file::rename_file_noclobber(&destination, &path).is_ok()
                {
                    let _ = memo_file.move_media_resource_path(
                        &material.notebook_id,
                        material.relocated.as_ref().map_or(material.remote.filename.as_str(), |item| item.filename.as_str()),
                        &material.remote.filename,
                    );
                }
                return Err("CLOUD_CONFLICT_LOCAL_CHANGED: attachment changed during recovery".into());
            }
        }
        crate::watcher::runtime::mark_self_write_content_for(app, &destination, remote);
        if flowix_core::memo_file::media_kind_for_path(&destination).is_some() {
            memo_file.refresh_media_resource_path(&material.notebook_id,
                material.relocated.as_ref().map_or(material.remote.filename.as_str(), |target| target.filename.as_str()))
                .map_err(sync_error)?;
        }
        let _ = app.emit("media-properties-changed", serde_json::json!({ "notebookId": material.notebook_id }));
        return if let Some(target) = &material.relocated {
            state.cloud_sync.v2_rebase_moved_conflict(&material.remote, target).map_err(sync_error)
        } else {
            state.cloud_sync.v2_rebase_after_conflict(&material.remote).map_err(sync_error)
        };
    }
    let memo = memo_file.find_memo_by_relative_path_for_notebook_id(
        &material.notebook_id, &material.remote.filename,
    )
        .ok_or_else(|| "CLOUD_CONFLICT_LOCAL_NOTE_NOT_FOUND".to_string())?;
    if material.remote.filename != memo.relative_path {
        return Err("CLOUD_PATH_OR_DELETE_CONFLICT: local changes preserved".to_string());
    }
    let path = notebook_path_from_relative(Path::new(&notebook.path), &memo.relative_path)?;
    let conflict_copy = path.with_file_name(format!(
        "{} (Flowix conflict {}).md",
        path.file_stem().and_then(|value| value.to_str()).unwrap_or("Note"),
        material.operation_id,
    ));
    if recover_and_register_conflict_stage(
        &memo_file, &material.notebook_id, Path::new(&notebook.path), &path,
        &material.operation_id, &conflict_copy, false,
    )? {
        return Err("CLOUD_CONFLICT_LOCAL_CHANGED: recovered a staged note version".into());
    }
    let local = std::fs::read(&path).map_err(sync_error)?;
    if material.remote.deleted && material.relocated.is_none() {
        let copy_path = conflict_copy.clone();
        if copy_path.exists() {
            if std::fs::read(&copy_path).map_err(sync_error)? != local {
                return Err("CLOUD_CONFLICT_COPY_COLLISION: local changes preserved".into());
            }
        } else {
            flowix_core::memo_file::atomic_create_bytes(&copy_path, &local).map_err(sync_error)?;
        }
        memo_file.register_existing_file_for_notebook_id(&material.notebook_id, &copy_path)
            .map_err(sync_error)?;
        if std::fs::read(&path).map_err(sync_error)? != local {
            return Err("CLOUD_CONFLICT_LOCAL_CHANGED: local changes preserved".into());
        }
        match safely_remove_conflict_file(&path, &local, &material.operation_id, &copy_path)? {
            ConflictFileOutcome::Applied { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file, &material.notebook_id, Path::new(&notebook.path),
                        &preserved, false,
                    )?;
                }
            }
            ConflictFileOutcome::Interrupted { preserved } => {
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(
                        &memo_file, &material.notebook_id, Path::new(&notebook.path),
                        &preserved, false,
                    )?;
                }
                return Err("CLOUD_CONFLICT_LOCAL_CHANGED: local note changed during recovery".into());
            }
        }
        crate::watcher::runtime::mark_self_write_for(app, &path);
        if !memo_file.prune_deleted_memo_for_notebook_id(
            &material.notebook_id, &material.remote.filename, &memo.id,
        ).map_err(sync_error)? {
            return Err("CLOUD_CONFLICT_LOCAL_CHANGED: local note reappeared during recovery".into());
        }
        crate::watcher::runtime::mark_self_write_missing_for(app, &path);
        return state.cloud_sync.v2_rebase_after_conflict(&material.remote).map_err(sync_error);
    }
    let remote = material.remote_content.as_deref()
        .ok_or_else(|| "CLOUD_CONFLICT_REMOTE_UNAVAILABLE".to_string())?;
    let outcome = material.base_content.as_deref()
        .map(|base| flowix_sync::text_merge::merge_markdown(base, &local, remote))
        .unwrap_or(flowix_sync::text_merge::MergeOutcome::Conflict);
    let next = match outcome {
        flowix_sync::text_merge::MergeOutcome::Merged(bytes) => bytes,
        flowix_sync::text_merge::MergeOutcome::Conflict
        | flowix_sync::text_merge::MergeOutcome::Unsupported => {
            let copy_path = conflict_copy.clone();
            if copy_path.exists() {
                if std::fs::read(&copy_path).map_err(sync_error)? != local {
                    return Err("CLOUD_CONFLICT_COPY_COLLISION: local changes preserved".to_string());
                }
            } else {
                flowix_core::memo_file::atomic_create_bytes(&copy_path, &local)
                    .map_err(sync_error)?;
            }
            memo_file.register_existing_file_for_notebook_id(&material.notebook_id, &copy_path)
                .map_err(sync_error)?;
            remote.to_vec()
        }
    };
    if std::fs::read(&path).map_err(sync_error)? != local {
        return Err("CLOUD_CONFLICT_LOCAL_CHANGED: local changes preserved".to_string());
    }
    let destination = if let Some(target) = &material.relocated {
        let destination = safe_cloud_note_path(Path::new(&notebook.path), &target.filename)?;
        if destination.exists() {
            return Err("CLOUD_MOVE_TARGET_COLLISION: local changes preserved".to_string());
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(sync_error)?;
        }
        crate::watcher::runtime::mark_self_write_for(app, &path);
        crate::watcher::runtime::mark_self_write_for(app, &destination);
        flowix_core::memo_file::rename_file_noclobber(&path, &destination).map_err(sync_error)?;
        if let Err(error) = memo_file.rename_memo_file_for_notebook_id(
            &material.notebook_id, &path, &destination,
        ) {
            let _ = flowix_core::memo_file::rename_file_noclobber(&destination, &path);
            return Err(error);
        }
        destination
    } else {
        crate::watcher::runtime::mark_self_write_for(app, &path);
        path.clone()
    };
    match safely_replace_conflict_file(
        &destination, &local, &next, &material.operation_id, &conflict_copy,
    )? {
        ConflictFileOutcome::Applied { preserved } => {
            if let Some(preserved) = preserved {
                register_preserved_conflict_copy(
                    &memo_file, &material.notebook_id, Path::new(&notebook.path),
                    &preserved, false,
                )?;
            }
        }
        ConflictFileOutcome::Interrupted { preserved } => {
            if let Some(preserved) = preserved {
                register_preserved_conflict_copy(
                    &memo_file, &material.notebook_id, Path::new(&notebook.path),
                    &preserved, false,
                )?;
            }
            if material.relocated.is_some() && !path.exists() && destination.exists()
                && flowix_core::memo_file::rename_file_noclobber(&destination, &path).is_ok()
            {
                let _ = memo_file.rename_memo_file_for_notebook_id(
                    &material.notebook_id, &destination, &path,
                );
            }
            return Err("CLOUD_CONFLICT_LOCAL_CHANGED: local note changed during recovery".into());
        }
    }
    crate::watcher::runtime::mark_self_write_content_for(app, &destination, &next);
    let updated = memo_file.register_existing_file_for_notebook_id(&material.notebook_id, &destination)
        .map_err(sync_error)?;
    memo_events::emit(app, MemoEvent::Updated {
        id: updated.id.clone(),
        path: destination.to_string_lossy().into_owned(),
        notebook_id: material.notebook_id.clone(),
        derived_changed: MemoDerivedChanged { tags: true, todos: true, agents: true },
        memo: updated,
        source: MemoChangeSource::CloudSync,
    });
    if let Some(target) = &material.relocated {
        state.cloud_sync.v2_rebase_moved_conflict(&material.remote, target).map_err(sync_error)
    } else {
        state.cloud_sync.v2_rebase_after_conflict(&material.remote).map_err(sync_error)
    }
}

pub(super) fn should_run_full_local_snapshot(
    state: &AppState,
    notebook_scope: Option<&str>,
) -> Result<bool, String> {
    let enabled = state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?;
    let now = Utc::now().timestamp_millis();
    let all_last = LAST_FULL_LOCAL_SNAPSHOT_AT.load(Ordering::SeqCst);
    if let Some(scope) = notebook_scope {
        let scoped_last = LAST_FULL_LOCAL_SNAPSHOT_BY_NOTEBOOK.get()
            .and_then(|snapshots| snapshots.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()).get(scope).copied())
            .unwrap_or(0);
        let last = all_last.max(scoped_last);
        let interval_elapsed = last == 0 || now.saturating_sub(last) >= FULL_LOCAL_SNAPSHOT_INTERVAL_MS;
        return Ok(enabled
            .iter()
            .find(|notebook| notebook.notebook_id == scope)
            .is_some_and(|notebook| notebook.bootstrap_required || interval_elapsed));
    }
    if enabled.is_empty() {
        return Ok(false);
    }
    if enabled.iter().any(|notebook| notebook.bootstrap_required) {
        return Ok(true);
    }
    Ok(all_last == 0 || now.saturating_sub(all_last) >= FULL_LOCAL_SNAPSHOT_INTERVAL_MS)
}

pub(super) fn v2_account_snapshot(
    state: &AppState,
    full_scan: bool,
    notebook_scope: Option<&str>,
) -> Result<(Vec<V2LocalNotebook>, Vec<V2LocalNote>), String> {
    let enabled: std::collections::HashSet<String> = state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?
        .into_iter()
        .map(|notebook| notebook.notebook_id)
        .collect();
    let dirty_note_ids = if full_scan {
        None
    } else {
        Some(state.cloud_sync.v2_dirty_note_ids().map_err(sync_error)?)
    };
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let configs = memo_file.read_notebook_configs().map_err(sync_error)?;
    let mut notebooks = Vec::new();
    let mut notes = Vec::new();
    for config in configs
        .into_iter()
        .filter(|config| enabled.contains(&config.id))
        .filter(|config| notebook_scope.is_none_or(|scope| config.id == scope))
    {
        let root = Path::new(&config.path);
        if !root.is_dir() {
            return Err(format!("CLOUD_NOTEBOOK_UNAVAILABLE: {}", root.display()));
        }
        if full_scan {
            memo_file.reconcile_notebook_with_disk_bidirectional(&config.id)?;
        }
        for memo in memo_file.read_all_memos_for_notebook_id(Some(&config.id)) {
            let cloud_id = flowix_sync::v2_path_note_id(&config.id, &memo.relative_path);
            if dirty_note_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&cloud_id))
            {
                continue;
            }
            let path = notebook_path_from_relative(Path::new(&config.path), &memo.relative_path)
                .unwrap_or_else(|_| PathBuf::from(&config.path).join(&memo.filename));
            let content = std::fs::read(&path)
                .map_err(|error| format!("READ_NOTE_FAILED {}: {error}", path.display()))?;
            notes.push(V2LocalNote {
                id: cloud_id,
                notebook_id: config.id.clone(),
                filename: memo.relative_path,
                content,
                attachments: Vec::new(),
            });
        }
        let mut attachment_paths = Vec::new();
        scan_cloud_attachments(root, &root.join("attachments"), &mut attachment_paths)?;
        for path in attachment_paths {
            let relative_path = flowix_core::memo_file::notebook_relative_path(root, &path)?;
            let cloud_id = flowix_sync::v2_path_note_id(&config.id, &relative_path);
            if dirty_note_ids.as_ref().is_some_and(|ids| !ids.contains(&cloud_id)) {
                continue;
            }
            notes.push(V2LocalNote {
                id: cloud_id,
                notebook_id: config.id.clone(),
                filename: relative_path,
                content: std::fs::read(&path).map_err(sync_error)?,
                attachments: Vec::new(),
            });
        }
        notebooks.push(V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        });
    }
    Ok((notebooks, notes))
}

pub(super) fn safe_cloud_file_path(base: &Path, filename: &str, attachment: bool) -> Result<PathBuf, String> {
    let candidate = Path::new(filename);
    if (!attachment && !candidate.is_md())
        || (attachment && !filename.starts_with("attachments/"))
        || filename.contains('\\') || filename.starts_with('/')
        || candidate.components().any(|component| !matches!(component, std::path::Component::Normal(_)))
        || candidate.components().any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
    {
        return Err("INVALID_CLOUD_FILENAME".to_string());
    }
    let mut path = base.to_path_buf();
    for component in candidate.components() {
        path.push(component.as_os_str());
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() {
                return Err("CLOUD_PATH_SYMLINK".to_string());
            }
        }
    }
    Ok(path)
}

pub(super) fn safe_cloud_note_path(base: &Path, filename: &str) -> Result<PathBuf, String> {
    safe_cloud_file_path(base, filename, false)
}

pub(super) fn write_cloud_attachments(
    base: &Path,
    attachments: &[flowix_sync::V2RemoteAttachment],
) -> Result<(), String> {
    for attachment in attachments {
        let filename = &attachment.metadata.filename;
        let relative = Path::new(filename);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            || relative.components().next() == Some(std::path::Component::CurDir)
            || attachment.metadata.size_bytes
                != i64::try_from(attachment.content.len()).map_err(|_| "ATTACHMENT_TOO_LARGE")?
            || v2_content_hash(&attachment.content) != attachment.metadata.content_hash
        {
            return Err(format!("CLOUD_ATTACHMENT_INVALID: {filename}"));
        }
        let relative_name = match relative.strip_prefix("attachments") {
            Ok(path) => format!("attachments/{}", path.display()),
            Err(_) => format!("attachments/{filename}"),
        };
        let path = safe_cloud_file_path(base, &relative_name, true)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(sync_error)?;
        }
        match flowix_core::memo_file::atomic_create_bytes(&path, &attachment.content) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if std::fs::read(&path).map_err(sync_error)? != attachment.content {
                    return Err(format!("CLOUD_ATTACHMENT_EDIT_CONFLICT: {filename}"));
                }
            },
            Err(error) => return Err(sync_error(error)),
        }
    }
    Ok(())
}

pub(super) fn apply_v2_note_changes(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
    changes: &[&V2RemoteApply],
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _write_guard = memo_file
        .acquire_cross_process_write_lock()
        .map_err(sync_error)?;
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let base = PathBuf::from(&notebook.path);
    for change in changes {
        let V2RemoteApply::Note {
            note_id,
            filename,
            content_hash,
            content,
            deleted,
            attachments,
            ..
        } = change
        else {
            continue;
        };
        if filename.starts_with("attachments/") {
            let path = safe_cloud_file_path(&base, filename, true)?;
            let local_bytes = match std::fs::read(&path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(format!("CLOUD_ATTACHMENT_READ_FAILED: {error}")),
            };
            let local_hash = local_bytes.as_ref().map(|bytes| v2_content_hash(bytes));
            let baseline_hash = state.cloud_sync.v2_note_state(note_id).map_err(sync_error)?
                .and_then(|value| value.content_hash);
            let pending = state.cloud_sync.has_pending_v2_note_change(note_id).map_err(sync_error)?;
            if *deleted {
                if v2_local_content_diverged(local_hash.as_deref(), baseline_hash.as_deref(), pending) {
                    return Err(format!("CLOUD_ATTACHMENT_DELETE_CONFLICT: {filename}"));
                }
                if let Some(expected) = local_bytes.as_deref() {
                    crate::watcher::runtime::mark_self_write_for(app, &path);
                    let copy = cloud_conflict_copy_path(&path, note_id);
                    match safely_remove_conflict_file(&path, expected, note_id, &copy)? {
                        ConflictFileOutcome::Applied { preserved: None } => {},
                        outcome => {
                            let preserved = match outcome {
                                ConflictFileOutcome::Applied { preserved } | ConflictFileOutcome::Interrupted { preserved } => preserved,
                            };
                            if let Some(preserved) = preserved {
                                register_preserved_conflict_copy(&memo_file, notebook_id, &base, &preserved, true)?;
                            }
                            return Err(format!("CLOUD_ATTACHMENT_DELETE_CONFLICT: {filename}"));
                        }
                    }
                }
                continue;
            }
            let bytes = content.as_ref().ok_or_else(|| format!("CLOUD_ATTACHMENT_CONTENT_MISSING: {filename}"))?;
            let expected_hash = content_hash.as_deref()
                .ok_or_else(|| format!("CLOUD_ATTACHMENT_HASH_MISSING: {filename}"))?;
            if v2_content_hash(bytes) != expected_hash {
                return Err(format!("CLOUD_ATTACHMENT_HASH_MISMATCH: {filename}"));
            }
            if local_hash.as_deref() == Some(expected_hash) { continue; }
            if v2_local_content_diverged(local_hash.as_deref(), baseline_hash.as_deref(), pending) {
                return Err(format!("CLOUD_ATTACHMENT_EDIT_CONFLICT: {filename}"));
            }
            if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(sync_error)?; }
            crate::watcher::runtime::mark_self_write_for(app, &path);
            let copy = cloud_conflict_copy_path(&path, note_id);
            match safely_replace_cloud_file(&path, local_bytes.as_deref(), bytes, note_id, &copy)? {
                ConflictFileOutcome::Applied { preserved: None } => {},
                outcome => {
                    let preserved = match outcome {
                        ConflictFileOutcome::Applied { preserved } | ConflictFileOutcome::Interrupted { preserved } => preserved,
                    };
                    if let Some(preserved) = preserved {
                        register_preserved_conflict_copy(&memo_file, notebook_id, &base, &preserved, true)?;
                    }
                    return Err(format!("CLOUD_ATTACHMENT_EDIT_CONFLICT: {filename}"));
                }
            }
            continue;
        }
        if *deleted {
            if let Some(memo) = deletion::delete_cloud_note_locked(
                &memo_file,
                &state.cloud_sync,
                notebook_id,
                note_id,
                Some(filename),
                |path| crate::watcher::runtime::mark_self_write_for(app, path),
            )? {
                let path = notebook_path_from_relative(&base, &memo.relative_path)
                    .unwrap_or_else(|_| base.join(&memo.filename));
                let derived_changed = MemoDerivedChanged::from_deleted(&memo);
                memo_events::emit(
                    app,
                    MemoEvent::Deleted {
                        id: note_id.clone(),
                        path: path.to_string_lossy().into_owned(),
                        notebook_id: notebook_id.to_string(),
                        derived_changed,
                        source: MemoChangeSource::CloudSync,
                    },
                );
            }
        } else {
            let bytes = content
                .as_ref()
                .ok_or_else(|| format!("CLOUD_NOTE_CONTENT_MISSING: {note_id}"))?;
            let expected_hash = content_hash
                .as_deref()
                .ok_or_else(|| format!("CLOUD_NOTE_HASH_MISSING: {note_id}"))?;
            let actual_hash = v2_content_hash(bytes);
            if actual_hash != expected_hash {
                return Err(format!(
                        "CLOUD_NOTE_HASH_MISMATCH: note {note_id} expected {expected_hash} got {actual_hash}"
                    ));
            }
            let markdown = std::str::from_utf8(bytes)
                .map_err(|_| format!("CLOUD_NOTE_NOT_UTF8: {note_id}"))?;
            write_cloud_attachments(&base, attachments)?;
            let current_memo = memo_file.find_memo_by_relative_path_for_notebook_id(notebook_id, filename);
            let old_path = current_memo.as_ref().map(|memo| {
                notebook_path_from_relative(&base, &memo.relative_path)
                    .unwrap_or_else(|_| base.join(&memo.filename))
            });
            let desired_path = safe_cloud_note_path(&base, filename)?;
            if desired_path.exists() && old_path.as_ref() != Some(&desired_path) {
                memo_file.register_existing_file_for_notebook_id(notebook_id, &desired_path)
                    .map_err(sync_error)?;
                if std::fs::read(&desired_path).map_err(sync_error)? != *bytes {
                    return Err(format!("CLOUD_PATH_COLLISION: local file preserved at {filename}"));
                }
                continue;
            }
            // P0-2: 单端同步回声抑制。本端 push 后紧接的 pull 会用旧 cursor 把刚推上去
            // 的内容再拉回来（协议暂无 device 维度去重）。若此时本地磁盘正文与远端
            // content_hash 一致，说明是回声而非真实远端更新，跳过覆盖写与 Updated 事件
            // ——否则文件监听器会把这次“内容未变”的写盘误判为外部编辑，弹“文档已被外部
            // 修改”。附件已由上方 write_cloud_attachments 幂等落盘，filename/位置未变时
            // 无需重写正文。
            // 本地磁盘当前正文哈希：P0-2 回声判据与 P1-3 本地编辑判据共用。
            let disk_bytes = match std::fs::read(&desired_path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(sync_error(error)),
            };
            let disk_hash = disk_bytes.as_ref().map(|bytes| v2_content_hash(bytes));

            // P0-2: 回声 / 内容已一致 → 跳过写盘与事件（避免监听器把“内容未变”的
            // 写盘误判为外部编辑）。
            if matches!(&old_path, Some(path) if path == &desired_path)
                && disk_hash.as_deref() == Some(expected_hash)
            {
                let memo = memo_file
                    .register_existing_file_for_notebook_id(notebook_id, &desired_path)
                    .map_err(sync_error)?;
                let _ = memo;
                continue;
            }

            // P1-3: 本地有未同步编辑时不接受远端覆盖（本地会在下次 push 以最新远端
            // revision 为 base 补推上去）。两条判据取或：
            //   ① has_pending_v2_note_change —— sync dirty 队列，但由 watcher 处理编辑器
            //     保存事件后才打标记，有 ~400ms settle 延迟；
            //   ② 磁盘正文偏离同步基线 note_state.content_hash —— 即时读盘+读同步状态，
            //     堵住 ① 的延迟窗口：快速编辑时编辑器刚保存、watcher 还没 mark dirty，
            //     但磁盘已领先于同步基线，据此判定本地已编辑、不覆盖。
            let baseline_hash = state
                .cloud_sync
                .v2_note_state(note_id)
                .ok()
                .flatten()
                .and_then(|stored| stored.content_hash);
            let has_pending_change = state
                .cloud_sync
                .has_pending_v2_note_change(note_id)
                .unwrap_or(false);
            let locally_edited = v2_local_content_diverged(
                disk_hash.as_deref(),
                baseline_hash.as_deref(),
                has_pending_change,
            );
            if locally_edited {
                return Err(format!("CLOUD_LOCAL_EDIT_CONFLICT: local file preserved at {filename}"));
            }
            if let Some(path) = &old_path {
                crate::watcher::runtime::mark_self_write_for(app, path);
            }
            if let Some(parent) = desired_path.parent() {
                std::fs::create_dir_all(parent).map_err(sync_error)?;
            }
            let copy = cloud_conflict_copy_path(&desired_path, note_id);
            match safely_replace_cloud_file(&desired_path, disk_bytes.as_deref(), markdown.as_bytes(), note_id, &copy)? {
                ConflictFileOutcome::Applied { preserved: None } => {},
                outcome => {
                    let preserved = match outcome {
                        ConflictFileOutcome::Applied { preserved } | ConflictFileOutcome::Interrupted { preserved } => preserved,
                    };
                    if let Some(preserved) = preserved {
                        register_preserved_conflict_copy(&memo_file, notebook_id, &base, &preserved, false)?;
                    }
                    return Err(format!("CLOUD_LOCAL_EDIT_CONFLICT: local file preserved at {filename}"));
                }
            }
            let memo = memo_file
                .register_existing_file_for_notebook_id(notebook_id, &desired_path)
                .map_err(sync_error)?;
            if let Some(path) = old_path.filter(|path| path != &desired_path) {
                if path.exists() {
                    std::fs::remove_file(&path).map_err(sync_error)?;
                }
            }
            memo_events::emit(
                app,
                MemoEvent::Updated {
                    id: memo.id.clone(),
                    path: desired_path.to_string_lossy().into_owned(),
                    notebook_id: notebook_id.to_string(),
                    derived_changed: MemoDerivedChanged {
                        tags: true,
                        todos: true,
                        agents: true,
                    },
                    memo,
                    source: MemoChangeSource::CloudSync,
                },
            );
        }
    }
    Ok(())
}

pub(super) fn apply_v2_report(
    state: &AppState,
    app: &AppHandle,
    report: &V2AccountSyncReport,
) -> Result<(), String> {
    let mut note_changes = HashMap::<String, Vec<&V2RemoteApply>>::new();
    let mut notebook_metadata =
        HashMap::<String, (Option<String>, Option<String>, Option<i64>, bool)>::new();
    for change in &report.remote {
        match change {
            V2RemoteApply::Notebook {
                notebook_id,
                name,
                icon,
                sort_order,
                deleted,
                ..
            } => {
                notebook_metadata.insert(
                    notebook_id.clone(),
                    (name.clone(), icon.clone(), *sort_order, *deleted),
                );
            }
            V2RemoteApply::Note { notebook_id, .. } => {
                note_changes
                    .entry(notebook_id.clone())
                    .or_default()
                    .push(change);
            }
        }
    }

    for (notebook_id, changes) in note_changes {
        apply_v2_note_changes(state, app, &notebook_id, &changes)?;
    }

    if !notebook_metadata.is_empty() {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut configs = memo_file.read_notebook_configs().map_err(sync_error)?;
        let mut changed = false;
        configs.retain(|config| {
            let deleted = notebook_metadata
                .get(&config.id)
                .is_some_and(|(_, _, _, deleted)| *deleted);
            if deleted {
                changed = true;
                if state.agent_access.remove_notebook(&config.id) {
                    crate::events::emit_to(
                        app,
                        crate::commands::agent_access::AGENT_ACCESS_CHANGED_EVENT,
                        (),
                    );
                }
            }
            !deleted
        });
        for config in &mut configs {
            let Some((name, icon, sort_order, deleted)) = notebook_metadata.get(&config.id) else {
                continue;
            };
            if *deleted {
                continue;
            }
            if let Some(name) = name {
                if config.name != *name {
                    config.name.clone_from(name);
                    changed = true;
                }
            }
            if config.icon != *icon {
                config.icon.clone_from(icon);
                changed = true;
            }
            if let Some(sort_order) = sort_order {
                if config.sort != *sort_order {
                    config.sort = *sort_order;
                    changed = true;
                }
            }
        }
        if changed {
            memo_file
                .write_notebook_configs(&configs)
                .map_err(sync_error)?;
            drop(memo_file);
            crate::events::emit_to(app, crate::commands::notebook::NOTEBOOKS_CHANGED_EVENT, ());
            crate::commands::helpers::refresh_watcher_roots(state, app);
        }
    }
    Ok(())
}

#[cfg(test)]
mod conflict_file_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn attachment_manifest_rejects_symlink_directory() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), temp.path().join("attachments")).unwrap();
        let bytes = b"image".to_vec();
        let attachment = flowix_sync::V2RemoteAttachment {
            metadata: flowix_sync::V2Attachment {
                filename: "image.png".into(),
                content_hash: v2_content_hash(&bytes),
                size_bytes: bytes.len() as i64,
                mime_type: "image/png".into(),
            },
            content: bytes,
        };
        assert!(write_cloud_attachments(temp.path(), &[attachment]).is_err());
        assert!(!outside.path().join("image.png").exists());
    }

    #[test]
    fn external_atomic_save_after_detach_is_not_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("note.md");
        let conflict = temp.path().join("note (Flowix conflict op).md");
        std::fs::write(&path, b"local version").unwrap();

        let outcome = safely_replace_conflict_file_with_hook(
            &path, b"local version", b"merged version", "op", &conflict,
            |path| flowix_core::memo_file::atomic_write_bytes(path, b"external save").unwrap(),
        ).unwrap();

        assert!(matches!(outcome, ConflictFileOutcome::Interrupted { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"external save");
        assert_eq!(std::fs::read(&conflict).unwrap(), b"local version");
        assert!(!conflict_stage_path(&path, "op").exists());
    }

    #[test]
    fn external_atomic_save_after_detach_survives_conflict_delete() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("note.md");
        let conflict = temp.path().join("note (Flowix conflict op).md");
        std::fs::write(&path, b"local version").unwrap();

        let outcome = safely_remove_conflict_file_with_hook(
            &path, b"local version", "op", &conflict,
            |path| flowix_core::memo_file::atomic_write_bytes(path, b"external save").unwrap(),
        ).unwrap();

        assert!(matches!(outcome, ConflictFileOutcome::Interrupted { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"external save");
        assert_eq!(std::fs::read(&conflict).unwrap(), b"local version");
        assert!(!conflict_stage_path(&path, "op").exists());
    }

    #[test]
    fn captured_conflict_bytes_do_not_overwrite_an_existing_copy() {
        let temp = tempfile::tempdir().unwrap();
        let conflict = temp.path().join("note (Flowix conflict op).md");
        std::fs::write(&conflict, b"previous conflict").unwrap();

        let preserved = save_conflict_bytes(&conflict, b"newly captured version").unwrap();

        assert_ne!(preserved, conflict);
        assert_eq!(std::fs::read(&conflict).unwrap(), b"previous conflict");
        assert_eq!(std::fs::read(preserved).unwrap(), b"newly captured version");
    }
}
