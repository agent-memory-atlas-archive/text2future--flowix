//! Local Markdown/attachment snapshot and remote-change application.
use super::*;

const FULL_LOCAL_SNAPSHOT_INTERVAL_MS: i64 = 5 * 60 * 1_000;
pub(super) static LAST_FULL_LOCAL_SNAPSHOT_AT: AtomicI64 = AtomicI64::new(0);

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
        for memo in memo_file.read_all_memos_for_notebook_id(Some(&config.id)) {
            if dirty_note_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&memo.id))
            {
                continue;
            }
            let path = notebook_path_from_relative(Path::new(&config.path), &memo.relative_path)
                .unwrap_or_else(|_| PathBuf::from(&config.path).join(&memo.filename));
            let content = std::fs::read(&path)
                .map_err(|error| format!("READ_NOTE_FAILED {}: {error}", path.display()))?;
            let attachments =
                collect_v2_attachments(&PathBuf::from(&config.path).join("attachments"), &content)?;
            notes.push(V2LocalNote {
                id: memo.id,
                notebook_id: config.id.clone(),
                filename: memo.filename,
                content,
                attachments,
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

pub(super) fn safe_cloud_note_path(base: &Path, filename: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(filename);
    if candidate.file_name().and_then(|value| value.to_str()) != Some(filename)
        || !candidate.is_md()
    {
        return Err("INVALID_CLOUD_FILENAME".to_string());
    }
    Ok(base.join(filename))
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
    let mut occupied: Vec<String> = memo_file
        .read_all_memos_for_notebook_id(Some(notebook_id))
        .into_iter()
        .map(|memo| memo.filename)
        .collect();

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
        if *deleted {
            if let Some(memo) = deletion::delete_cloud_note_locked(
                &memo_file,
                &state.cloud_sync,
                notebook_id,
                note_id,
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
            let current_memo = memo_file.read_memo_for_notebook_id(notebook_id, note_id);
            if current_memo.is_none() {
                if let Some(location) = memo_file
                    .resolve_memo_location(note_id)
                    .map_err(sync_error)?
                {
                    return Err(format!(
                        "CLOUD_NOTE_ID_COLLISION: note {} belongs to local notebook {}",
                        note_id, location.notebook.id
                    ));
                }
            }
            let old_path = current_memo.as_ref().map(|memo| {
                notebook_path_from_relative(&base, &memo.relative_path)
                    .unwrap_or_else(|_| base.join(&memo.filename))
            });
            let mut desired_path = safe_cloud_note_path(&base, filename)?;
            if desired_path.exists() && old_path.as_ref() != Some(&desired_path) {
                let title = Path::new(filename)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Cloud note");
                let safe_title = sanitize_filename_component(&format!("{title} (Cloud)"));
                let safe_filename = resolve_filename_conflict(&base, &safe_title, &occupied);
                desired_path = base.join(&safe_filename);
                occupied.push(safe_filename);
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
                    .register_existing_file_with_cache_id(notebook_id, &desired_path, note_id)
                    .map_err(sync_error)?;
                if memo.id != *note_id {
                    return Err(format!(
                        "CLOUD_NOTE_ID_MISMATCH: expected {}, registered {}",
                        note_id, memo.id
                    ));
                }
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
                continue;
            }
            if let Some(path) = &old_path {
                crate::watcher::runtime::mark_self_write_for(app, path);
            }
            let stamped_content = markdown;
            crate::watcher::runtime::write_note_atomic(
                app,
                &desired_path,
                stamped_content.as_bytes(),
            )
            .map_err(sync_error)?;
            let memo = memo_file
                .register_existing_file_for_notebook_id(notebook_id, &desired_path)
                .map_err(sync_error)?;
            if memo.id != *note_id {
                return Err(format!(
                    "CLOUD_NOTE_ID_MISMATCH: expected {}, registered {}",
                    note_id, memo.id
                ));
            }
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

/// Legacy entry point: validate readability without injecting identity fields.
pub(super) fn canonicalize_local_keys(
    state: &AppState,
    _app: &AppHandle,
    notebook_id: &str,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file
        .get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    for memo in memo_file.read_all_memos_for_notebook_id(Some(notebook_id)) {
        let path =
            notebook_path_from_relative(&PathBuf::from(&notebook.path), &memo.relative_path)?;
        std::fs::read_to_string(path).map_err(sync_error)?;
    }
    Ok(())
}
