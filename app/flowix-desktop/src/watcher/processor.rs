//! Apply filesystem events to the path index and publish document updates.
//! Registration is read-only. Only confirmed old/new paths establish a rename.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::memo_events::{emit, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use crate::watcher::event::{FsEventKind, RawFsEvent};
use flowix_core::memo_file::{
    is_ignored_notebook_relative_path, notebook_path_from_relative, notebook_relative_path, Memo,
    MemoFile,
};

#[derive(Debug, Clone)]
pub struct NotebookWatchContext {
    pub notebook_id: String,
    pub root: PathBuf,
}

/// 业务处理�?—状态由调用方注�?(memo_file / app)�?///
/// 故意不做�?struct 持字�? 而是 stateless: `process` 接收所有依赖。原�?
/// manager �?notify 回调�?��已经�?`move |res| { ... }`, �?��捕获
/// Arc<MemoFile> / AppHandle 引用, 不需�?processor 内部再持一份�?
pub struct MemoEventProcessor;

/// �?��数分流结�? dispatcher 决定�?emit �?��事件 + 附带的副作用数据�?
#[derive(Debug)]
pub(crate) enum DispatchOutcome {
    /// �?Updated �?��, 无副作用
    Updated(MemoEvent),
    /// �?Created �?��, 需�?caller �?mark_self_write(new_abs_path) 抑制
    /// 鍚庣画 notify 浜嬩欢
    Created {
        event: MemoEvent,
        new_abs_path: PathBuf,
    },
}

fn emit_updated_for_context(
    ctx: &NotebookWatchContext,
    before: Option<&Memo>,
    memo: Memo,
) -> DispatchOutcome {
    let entry_path = notebook_path_from_relative(&ctx.root, &memo.relative_path)
        .unwrap_or_else(|_| ctx.root.join(&memo.filename))
        .display()
        .to_string();
    let derived_changed = MemoDerivedChanged::from_memos(before, &memo);
    DispatchOutcome::Updated(MemoEvent::Updated {
        id: memo.id.clone(),
        path: entry_path,
        notebook_id: ctx.notebook_id.clone(),
        memo,
        derived_changed,
        source: MemoChangeSource::ExternalTool,
    })
}

fn emit_created_for_context(
    ctx: &NotebookWatchContext,
    memo: Memo,
    new_abs_path: PathBuf,
) -> DispatchOutcome {
    let derived_changed = MemoDerivedChanged::from_memos(None, &memo);
    DispatchOutcome::Created {
        event: MemoEvent::Created {
            notebook_id: ctx.notebook_id.clone(),
            derived_changed,
            memo,
            source: MemoChangeSource::ExternalTool,
        },
        new_abs_path,
    }
}

/// Path-first dispatch. Indexing and reload never modify Markdown.
#[cfg(test)]
pub(crate) fn dispatch_modify_event(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    event_kind: FsEventKind,
) -> Result<DispatchOutcome, String> {
    dispatch_modify_event_with_mark(memo_file, ctx, path, event_kind, |_: &Path| {})
}

fn dispatch_modify_event_with_mark(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    _event_kind: FsEventKind,
    _mark: impl Fn(&Path),
) -> Result<DispatchOutcome, String> {
    let relative_path = notebook_relative_path(&ctx.root, path)?;
    refresh_v2_note_path(memo_file, ctx, &relative_path);
    if let Some(existing) =
        memo_file.find_memo_by_relative_path_for_notebook_id(&ctx.notebook_id, &relative_path)
    {
        let refreshed = memo_file
            .reload_memo_from_disk_by_filename_for_notebook_id(&ctx.notebook_id, &relative_path)?;
        if memo_file
            .consume_pending_external_memo_create(&existing.id, &ctx.notebook_id)
            .unwrap_or(false)
        {
            return Ok(emit_created_for_context(ctx, refreshed, path.to_path_buf()));
        }
        return Ok(emit_updated_for_context(ctx, Some(&existing), refreshed));
    }
    let memo = memo_file.register_existing_file_for_notebook_id(&ctx.notebook_id, path)?;
    Ok(emit_created_for_context(ctx, memo, path.to_path_buf()))
}

fn refresh_v2_note_path(memo_file: &MemoFile, ctx: &NotebookWatchContext, relative_path: &str) {
    let relative = Path::new(relative_path);
    let is_markdown = relative
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
        });
    if !is_markdown || is_ignored_notebook_relative_path(relative) {
        return;
    }
    if let Err(error) = memo_file.refresh_v2_note_path(&ctx.notebook_id, relative_path) {
        tracing::warn!(
            notebook_id = %ctx.notebook_id,
            relative_path,
            "watcher could not refresh the V2 note projection: {error}"
        );
    }
}

/// Rebase only an explicit OS rename pair, including descendants of a directory.
fn dispatch_path_rename(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    old: &Path,
    new: &Path,
) -> Vec<Result<DispatchOutcome, String>> {
    let Ok(old_relative) = notebook_relative_path(&ctx.root, old) else {
        return vec![];
    };
    let Ok(new_relative) = notebook_relative_path(&ctx.root, new) else {
        return vec![];
    };
    let prefix = format!("{old_relative}/");
    memo_file
        .read_all_memos_for_notebook_id(Some(&ctx.notebook_id))
        .into_iter()
        .filter(|memo| {
            memo.relative_path == old_relative || memo.relative_path.starts_with(&prefix)
        })
        .map(|before| {
            let suffix = before
                .relative_path
                .strip_prefix(&old_relative)
                .unwrap_or("");
            let target =
                notebook_path_from_relative(&ctx.root, &format!("{new_relative}{suffix}"))?;
            let source = notebook_path_from_relative(&ctx.root, &before.relative_path)?;
            let updated =
                memo_file.rename_memo_file_for_notebook_id(&ctx.notebook_id, &source, &target)?;
            Ok(emit_updated_at(ctx, Some(&before), updated, &target))
        })
        .collect()
}

/// path �?��在当�?notebook �?`attachments/` �?���? 这层判断�?���?/// [`crate::watcher::WhitelistConfig`], 因为 whitelist �?? preference.json
/// 瑕嗙洊, 鐢ㄦ埛鐨勬棫閰嶇疆鍙兘婕忛厤 `attachments`. processor 鍦ㄥ叆鍙ｈ蛋杩欓亾闃茬嚎,
/// �?attachments/ 下的任何 .md 文件 (无�?�?���??复制进来的另一台笔记本
/// 的笔�? 都直接拒�? 避免"幽灵笔�?"污染 memo 列表.
///
/// �?[`crate::watcher::path::normalize_for_compare`] 而不�?�� `starts_with`:
/// - canonicalize 任一边失败都退�?父目�?canonicalize + join"回退�?��,
///   文件刚写盘但 fs 元数�?��就绪时仍能给出�?�?���?/// - 同一�?normalize �?watcher 抑制�?(`SelfWriteSuppressor` /
///   `Debouncer`) 口径一�? 避免半状态路�?(canonical vs �?canonical)
///   缁曡繃杩欓亾闃茬嚎
/// - 不再�?component-level 匹配 (`parent.file_name == "attachments"`),
///   那�?匹配会�?杀 `bar/attachments/foo.md` 这�?"嵌�?同名子目�?�?��.
fn is_under_attachments_dir(ctx: &NotebookWatchContext, path: &Path) -> bool {
    let attachments_dir =
        crate::watcher::path::normalize_for_compare(&ctx.root.join("attachments"));
    let path_norm = crate::watcher::path::normalize_for_compare(path);
    path_norm.starts_with(&attachments_dir)
}

/// �?[`emit_updated`] 但路径用事件原�? path (rename 场景下是新位�?��绝�?�?��)�?
fn emit_updated_at(
    ctx: &NotebookWatchContext,
    before: Option<&Memo>,
    memo: Memo,
    abs_path: &Path,
) -> DispatchOutcome {
    let entry_path = abs_path.display().to_string();
    let derived_changed = MemoDerivedChanged::from_memos(before, &memo);
    DispatchOutcome::Updated(MemoEvent::Updated {
        id: memo.id.clone(),
        path: entry_path,
        notebook_id: ctx.notebook_id.clone(),
        memo,
        derived_changed,
        source: MemoChangeSource::ExternalTool,
    })
}

pub(crate) fn wait_for_markdown_copy_to_settle(path: &Path) {
    let mut last_len = None;
    let mut stable_samples = 0;

    for _ in 0..8 {
        let Ok(meta) = std::fs::metadata(path) else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        if !meta.is_file() {
            return;
        }

        let len = meta.len();
        if Some(len) == last_len {
            stable_samples += 1;
            if stable_samples >= 2 && std::fs::File::open(path).is_ok() {
                return;
            }
        } else {
            last_len = Some(len);
            stable_samples = 0;
        }

        std::thread::sleep(Duration::from_millis(50));
    }
}

fn try_update_search_index(app: &AppHandle, id: &str) {
    if let Some(state) = app.try_state::<crate::app::state::AppState>() {
        crate::app::search_index::try_index_upsert(state.inner(), id);
    }
}

fn try_remove_from_search_index(app: &AppHandle, id: &str) {
    if let Some(state) = app.try_state::<crate::app::state::AppState>() {
        crate::app::search_index::try_index_remove(state.inner(), id);
    }
}

impl MemoEventProcessor {
    /// Process a filtered filesystem event. Confirmed rename pairs update
    /// the old and new paths together; other events are resolved by path.
    pub fn process(
        event: &RawFsEvent,
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
    ) {
        // 防御性拦�? 附件�?��下的 .md 文件不是 memo, 一律不处理.
        // 后�? `save_attachment` / `save_attachment_content` 会把任意�?�?        // �?��文件复制�?`<notebook>/attachments/`, 包括用户选了另一�?        // notebook 的笔�?.md —这�?情况 attachment �?��里会出现一�?        // 不�?出现�?memo 列表里的"幽灵笔�?".
        //
        // 这道防线�?���?whitelist (whitelist �?���?��户的 preference.json
        // 覆盖, 或�?hot-update 期间窗口�?��不一�?, �?processor 入口
        // 拒掉, �?create / modify / remove 三�? kind 的最后一道闸�?
        if is_under_attachments_dir(ctx, &event.path) {
            tracing::debug!(
                "[MemoWatcher] processor skipped attachments/ path: {}",
                event.path.display()
            );
            return;
        }

        if let Some(old_path) = &event.rename_from {
            if let Ok(mf) = memo_file.read() {
                if let Ok(_guard) = mf.acquire_cross_process_write_lock() {
                    for outcome in dispatch_path_rename(&mf, ctx, old_path, &event.path) {
                        match outcome {
                            Ok(DispatchOutcome::Updated(event)) => {
                                if let MemoEvent::Updated { id, .. } = &event {
                                    try_update_search_index(app, id);
                                }
                                emit(app, event);
                            }
                            Err(error) => {
                                tracing::warn!("path rename reconciliation failed: {error}")
                            }
                            _ => {}
                        }
                    }
                    if let Err(error) = mf.reconcile_v2_note_index(&ctx.notebook_id) {
                        tracing::warn!(
                            notebook_id = %ctx.notebook_id,
                            "V2 note index reconciliation after rename failed: {error}"
                        );
                    }
                }
            }
        }
        match event.kind {
            FsEventKind::Create | FsEventKind::Modify => {
                let path = &event.path;
                if !path.exists() {
                    // Modify 事件但文件没�?—�?Delete �?��
                    Self::unregister_and_emit(app, memo_file, ctx, path);
                    return;
                }
                // Resolve an existing indexed path or register a new file.
                let outcome = match memo_file.read() {
                    Ok(mf) => match mf.acquire_cross_process_write_lock() {
                        Ok(_guard) => {
                            dispatch_modify_event_with_mark(&mf, ctx, path, event.kind, |path| {
                                crate::watcher::runtime::mark_self_write_for(app, path)
                            })
                        }
                        Err(error) => Err(error.to_string()),
                    },
                    Err(_) => return,
                };
                match outcome {
                    Ok(DispatchOutcome::Updated(event)) => {
                        if let MemoEvent::Updated { id, .. } = &event {
                            try_update_search_index(app, id);
                        }
                        emit(app, event);
                    }
                    Ok(DispatchOutcome::Created {
                        event,
                        new_abs_path,
                    }) => {
                        tracing::info!("[MemoWatcher] registered: {}", new_abs_path.display(),);
                        if let Some(w) = crate::watcher::current_watcher(app) {
                            if let Ok(g) = w.read() {
                                g.mark_self_write(&new_abs_path);
                            }
                        }
                        if let MemoEvent::Created { memo, .. } = &event {
                            try_update_search_index(app, &memo.id);
                        }
                        emit(app, event);
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[MemoWatcher] dispatch_modify_event failed for {}: {e}",
                            path.display()
                        );
                    }
                }
            }
            FsEventKind::Remove => {
                // An unpaired removal deletes the old path association. A
                // confirmed rename is handled above before this branch.
                Self::unregister_and_emit(app, memo_file, ctx, &event.path);
            }
            FsEventKind::DirectoryChange => {
                Self::reconcile_directory_change(app, memo_file, ctx);
            }
            FsEventKind::Other => {
                // Access / Other —忽略
            }
        }
    }

    fn reconcile_directory_change(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
    ) {
        let Ok(mf) = memo_file.read() else {
            return;
        };
        match mf.reconcile_v2_note_index(&ctx.notebook_id) {
            Ok(report) => tracing::info!(
                notebook_id = %ctx.notebook_id,
                added = report.added,
                updated = report.updated,
                removed = report.removed,
                "V2 note index reconciliation completed"
            ),
            Err(error) => tracing::warn!(
                notebook_id = %ctx.notebook_id,
                "V2 note index reconciliation failed: {error}"
            ),
        }
        let before = mf.read_all_memos_for_notebook_id(Some(&ctx.notebook_id));
        let before_by_id = before
            .iter()
            .map(|memo| (memo.id.clone(), memo.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let report = match mf.reconcile_notebook_with_disk_bidirectional(&ctx.notebook_id) {
            Ok(report) => report,
            Err(error) => {
                tracing::warn!(
                    notebook_id = %ctx.notebook_id,
                    %error,
                    "directory change reconciliation failed"
                );
                return;
            }
        };
        let reconciled_added_ids = report
            .added_memos
            .iter()
            .map(|memo| memo.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let pending_external_create_ids = mf
            .pending_external_memo_creates_for_notebook(&ctx.notebook_id)
            .unwrap_or_default();
        let after = mf.read_all_memos_for_notebook_id(Some(&ctx.notebook_id));
        let after_ids = after
            .iter()
            .map(|memo| memo.id.as_str())
            .collect::<std::collections::HashSet<_>>();

        let mut changes = Vec::new();
        for memo in &after {
            let was_registered_by_reconcile = reconciled_added_ids.contains(memo.id.as_str());
            let pending_external_create = (was_registered_by_reconcile
                || pending_external_create_ids.contains(&memo.id))
                && mf
                    .consume_pending_external_memo_create(&memo.id, &ctx.notebook_id)
                    .unwrap_or(false);
            if was_registered_by_reconcile || pending_external_create {
                changes.push((
                    Some(memo.id.clone()),
                    MemoEvent::Created {
                        memo: memo.clone(),
                        notebook_id: ctx.notebook_id.clone(),
                        derived_changed: MemoDerivedChanged::from_memos(None, memo),
                        source: MemoChangeSource::ExternalTool,
                    },
                ));
                continue;
            }

            match before_by_id.get(&memo.id) {
                // A memo may have been added by an in-app command between
                // the before snapshot and reconciliation. Its own command
                // already published the create event.
                None => {}
                Some(previous) if previous.relative_path != memo.relative_path => {
                    let path = notebook_path_from_relative(&ctx.root, &memo.relative_path)
                        .unwrap_or_else(|_| ctx.root.join(&memo.filename));
                    changes.push((
                        Some(memo.id.clone()),
                        MemoEvent::Updated {
                            id: memo.id.clone(),
                            path: path.to_string_lossy().into_owned(),
                            notebook_id: ctx.notebook_id.clone(),
                            memo: memo.clone(),
                            derived_changed: MemoDerivedChanged::from_memos(Some(previous), memo),
                            source: MemoChangeSource::ExternalTool,
                        },
                    ));
                }
                _ => {}
            }
        }
        for memo in before
            .iter()
            .filter(|memo| !after_ids.contains(memo.id.as_str()))
        {
            let path = notebook_path_from_relative(&ctx.root, &memo.relative_path)
                .unwrap_or_else(|_| ctx.root.join(&memo.filename));
            changes.push((
                None,
                MemoEvent::Deleted {
                    id: memo.id.clone(),
                    path: path.to_string_lossy().into_owned(),
                    notebook_id: ctx.notebook_id.clone(),
                    derived_changed: MemoDerivedChanged::from_deleted(memo),
                    source: MemoChangeSource::ExternalTool,
                },
            ));
        }
        drop(mf);
        for (upsert_id, event) in changes {
            if let Some(id) = upsert_id {
                try_update_search_index(app, &id);
            } else if let MemoEvent::Deleted { id, .. } = &event {
                try_remove_from_search_index(app, id);
            }
            emit(app, event);
        }
        tracing::info!(
            notebook_id = %ctx.notebook_id,
            added = report.added,
            removed = report.removed,
            "directory change reconciliation completed"
        );
    }

    pub(crate) fn unregister_and_emit(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        path: &Path,
    ) {
        // v2: inode 还在 tracker 里的�? 这是 rename 的旧位置, 跳过 unregister
        // (�?Create(new) �?rename 配�?�?��)�?process() 已经先做了一次�?�?
        // 这里�?defense-in-depth 一欰�?
        let Ok(mf) = memo_file.read() else {
            return;
        };
        let _write_guard = match mf.acquire_cross_process_write_lock() {
            Ok(guard) => guard,
            Err(error) => {
                tracing::warn!(%error, "failed to lock memo deletion observation");
                return;
            }
        };
        if let Ok(relative_path) = notebook_relative_path(&ctx.root, path) {
            refresh_v2_note_path(&mf, ctx, &relative_path);
        }
        // 鐗╃悊鏂囦欢鍚嶆槸 `<title>.md` (id 璺熸枃浠跺悕瑙ｈ€?, 鏃у疄鐜颁細鎶婄┖ id 鍙戝埌鍓嶇,
        // �?`handleMemoDeleted` �?`memos.filter(m => m.id !== "")` 一条都
        // 过滤不掉 -> 幽灵笔�?�?        //
        // �?��: **�?`unregister_memo_by_path` 之前**�?filename 反查 memo index
        // 拿到真实 id。`unregister_memo_by_path` 内部就是用同一 filename 匹配 + �?        // entry, 所以这里查到的 id 跟它即将删的那条�?��一�? 不存�?race -- 都是
        // �?`current_index_io` 锁串行化, 内部�?? + �?memo index 一欰�?        //
        // 拿不�?id 的两种情�?
        // - �?��里没有合法的 .md 文件�?(�?`..`): 直接放弃 emit, 反�?
        //   `unregister_memo_by_path` 也会 return false, memo index 没动�?        // - filename 不在 memo index (孤立 .md / 已经�?���?: 同样放弃 emit, 不凭�?        //   generate id, 保持 id 一定来�?memo index 这个不变量�?
        let Ok(relative_path) = notebook_relative_path(&ctx.root, path) else {
            return;
        };
        let Some(memo) =
            mf.find_memo_by_relative_path_for_notebook_id(&ctx.notebook_id, &relative_path)
        else {
            tracing::debug!(
                "[MemoWatcher] unregister_and_emit: no memo index entry for relative_path={}, skipping emit (unregister will also no-op)",
                relative_path
            );
            return;
        };
        let id = memo.id.clone();
        let derived_changed = MemoDerivedChanged::from_deleted(&memo);
        if !mf.unregister_memo_by_path_for_notebook_id(&ctx.notebook_id, path) {
            return;
        }
        let entry_path = path.display().to_string();
        drop(_write_guard);
        drop(mf);
        try_remove_from_search_index(app, &id);
        // emit 带真�?id �?Deleted, 让前�?handleMemoDeleted 能精准从
        // 列表 filter �?(避免 id=“�?�?filter 什么都不丢、只能靠
        // triggerRefresh 重拉补救)�?path 依然传出, 供会话点�?path 匹配�?
        emit(
            app,
            MemoEvent::Deleted {
                id,
                path: entry_path,
                notebook_id: ctx.notebook_id.clone(),
                derived_changed,
                source: MemoChangeSource::ExternalTool,
            },
        );
    }
}

#[cfg(test)]
mod tests;
