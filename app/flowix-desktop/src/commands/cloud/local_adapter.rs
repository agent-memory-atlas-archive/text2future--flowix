//! Local Markdown/attachment snapshot and remote-change application.
use super::*;

const FULL_LOCAL_SNAPSHOT_INTERVAL_MS: i64 = 5 * 60 * 1_000;
pub(super) static LAST_FULL_LOCAL_SNAPSHOT_AT: AtomicI64 = AtomicI64::new(0);

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

    if target.exists() {
        let latest = std::fs::read(&target).map_err(sync_error)?;
        if local.as_ref().is_some_and(|previous| previous != &latest) {
            // Preserve a save that raced with conflict handling after the
            // first copy was taken. The write lock covers Flowix writers;
            // this second read also protects external editors that bypass it.
            let hash = flowix_sync::v2_content_hash(&latest);
            let revision_suffix = &hash[..8.min(hash.len())];
            let updated_name = match extension {
                Some(extension) => format!(
                    "{short_stem} (Flowix conflict {} observed-{revision_suffix}).{extension}",
                    movement.operation_id,
                ),
                None => format!(
                    "{short_stem} (Flowix conflict {} observed-{revision_suffix})",
                    movement.operation_id,
                ),
            };
            let updated_conflict = target.with_file_name(updated_name);
            if updated_conflict.exists() {
                if std::fs::read(&updated_conflict).map_err(sync_error)? != latest {
                    return Err("CLOUD_CONFLICT_COPY_COLLISION: concurrent move edit preserved".into());
                }
            } else {
                crate::watcher::runtime::mark_self_write_for(app, &updated_conflict);
                flowix_core::memo_file::atomic_create_bytes(&updated_conflict, &latest).map_err(sync_error)?;
            }
            if attachment {
                let relative = flowix_core::memo_file::notebook_relative_path(root, &updated_conflict)?;
                memo_file.refresh_media_resource_path(&movement.notebook_id, &relative)
                    .map_err(sync_error)?;
            } else {
                memo_file.register_existing_file_for_notebook_id(&movement.notebook_id, &updated_conflict)
                    .map_err(sync_error)?;
            }
        }
        crate::watcher::runtime::mark_self_write_for(app, &target);
        if attachment {
            std::fs::remove_file(&target).map_err(sync_error)?;
            memo_file.refresh_media_resource_path(&movement.notebook_id, &movement.to_path)
                .map_err(sync_error)?;
        } else if let Some(memo) = memo_file.find_memo_by_relative_path_for_notebook_id(
            &movement.notebook_id, &movement.to_path,
        ) {
            memo_file.delete_memo_result_for_notebook_id(&movement.notebook_id, &memo.id)
                .map_err(sync_error)?;
        } else {
            std::fs::remove_file(&target).map_err(sync_error)?;
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
        let path = safe_cloud_file_path(Path::new(&notebook.path), &material.remote.filename, true)?;
        let local = std::fs::read(&path).map_err(sync_error)?;
        let stem: String = path.file_stem().and_then(|value| value.to_str())
            .unwrap_or("attachment").chars().take(80).collect();
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("");
        let filename = if extension.is_empty() {
            format!("{stem} (Flowix conflict {})", material.operation_id)
        } else {
            format!("{stem} (Flowix conflict {}).{extension}", material.operation_id)
        };
        let copy_path = path.with_file_name(filename);
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
            std::fs::remove_file(&path).map_err(sync_error)?;
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
            std::fs::rename(&path, &destination).map_err(sync_error)?;
            if flowix_core::memo_file::media_kind_for_path(&destination).is_some() {
                if let Err(error) = memo_file.move_media_resource_path(
                    &material.notebook_id, &material.remote.filename, &target.filename,
                ) {
                    let _ = std::fs::rename(&destination, &path);
                    return Err(sync_error(error));
                }
            }
            destination
        } else {
            crate::watcher::runtime::mark_self_write_for(app, &path);
            path.clone()
        };
        atomic_write_bytes(&destination, remote).map_err(sync_error)?;
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
    let local = std::fs::read(&path).map_err(sync_error)?;
    if material.remote.deleted && material.relocated.is_none() {
        let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("Note");
        let short_stem: String = stem.chars().take(80).collect();
        let copy_path = path.with_file_name(format!("{short_stem} (Flowix conflict {}).md", material.operation_id));
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
        crate::watcher::runtime::mark_self_write_for(app, &path);
        memo_file.delete_memo_result_for_notebook_id(&material.notebook_id, &memo.id)
            .map_err(sync_error)?;
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
            let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("Note");
            let short_stem: String = stem.chars().take(80).collect();
            let filename = format!("{short_stem} (Flowix conflict {}).md", material.operation_id);
            let copy_path = path.with_file_name(filename);
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
        std::fs::rename(&path, &destination).map_err(sync_error)?;
        if let Err(error) = memo_file.rename_memo_file_for_notebook_id(
            &material.notebook_id, &path, &destination,
        ) {
            let _ = std::fs::rename(&destination, &path);
            return Err(error);
        }
        destination
    } else {
        crate::watcher::runtime::mark_self_write_for(app, &path);
        path.clone()
    };
    crate::watcher::runtime::write_note_atomic(app, &destination, &next).map_err(sync_error)?;
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
    if let Some(scope) = notebook_scope {
        return Ok(enabled
            .iter()
            .find(|notebook| notebook.notebook_id == scope)
            .is_some_and(|notebook| notebook.bootstrap_required));
    }
    if enabled.is_empty() {
        return Ok(false);
    }
    if enabled.iter().any(|notebook| notebook.bootstrap_required) {
        return Ok(true);
    }
    let now = Utc::now().timestamp_millis();
    let last = LAST_FULL_LOCAL_SNAPSHOT_AT.load(Ordering::SeqCst);
    Ok(last == 0 || now.saturating_sub(last) >= FULL_LOCAL_SNAPSHOT_INTERVAL_MS)
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
    let directory = base.join("attachments");
    std::fs::create_dir_all(&directory).map_err(sync_error)?;
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
        let path = match relative.strip_prefix("attachments") {
            Ok(path) => base.join("attachments").join(path),
            Err(_) => directory.join(relative),
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(sync_error)?;
        }
        atomic_write_bytes(&path, &attachment.content).map_err(sync_error)?;
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
            let local_hash = match std::fs::read(&path) {
                Ok(bytes) => Some(v2_content_hash(&bytes)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(format!("CLOUD_ATTACHMENT_READ_FAILED: {error}")),
            };
            let baseline_hash = state.cloud_sync.v2_note_state(note_id).map_err(sync_error)?
                .and_then(|value| value.content_hash);
            let pending = state.cloud_sync.has_pending_v2_note_change(note_id).map_err(sync_error)?;
            if *deleted {
                if v2_local_content_diverged(local_hash.as_deref(), baseline_hash.as_deref(), pending) {
                    return Err(format!("CLOUD_ATTACHMENT_DELETE_CONFLICT: {filename}"));
                }
                if path.exists() {
                    crate::watcher::runtime::mark_self_write_for(app, &path);
                    std::fs::remove_file(&path).map_err(sync_error)?;
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
            atomic_write_bytes(&path, bytes).map_err(sync_error)?;
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
            let disk_hash = std::fs::read(&desired_path)
                .ok()
                .map(|bytes| v2_content_hash(&bytes));

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
            let stamped_content = markdown;
            if let Some(parent) = desired_path.parent() {
                std::fs::create_dir_all(parent).map_err(sync_error)?;
            }
            crate::watcher::runtime::write_note_atomic(
                app,
                &desired_path,
                stamped_content.as_bytes(),
            )
            .map_err(sync_error)?;
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
