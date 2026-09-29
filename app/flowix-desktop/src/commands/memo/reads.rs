// ==================== Reads ====================

use std::fs;
use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::lock_utils::read_lock;
use flowix_core::memo_file::{
    is_ignored_notebook_relative_path, normalize_markdown_encoding_boundaries,
    notebook_path_from_relative, notebook_relative_path, Memo, MemoFile,
    PathTodoEntry, V2NoteEntry,
};
use flowix_core::service::PathNoteSaveOutcome;
use flowix_core::{FlowixError, MemoPage, MemoService};

use crate::app::search_index::rebuild_index_in_background;
use crate::app::state::AppState;
use crate::commands::helpers::start_security_bookmark_access;
use crate::watcher::runtime::mark_self_write_for;

use super::helpers::*;
use super::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownLocation {
    path: String,
    notebook_id: Option<String>,
    relative_path: Option<String>,
    notebook_path: Option<String>,
    indexable: bool,
}

/// Classify a Markdown file independently of its opening UI and legacy memo ID.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn resolve_markdown_location(
    filePath: String,
    app: AppHandle,
) -> Result<MarkdownLocation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let requested = Path::new(&filePath);
        if !requested.is_absolute() {
            return Err("absolute document path required".to_string());
        }
        let path = dunce::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());
        let mut notebooks = memo_file.read_notebook_configs().map_err(|error| error.to_string())?;
        notebooks.sort_by_key(|notebook| std::cmp::Reverse(notebook.path.len()));
        for notebook in notebooks {
            let root = Path::new(&notebook.path);
            let canonical_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
            let Ok(relative_path) = notebook_relative_path(&canonical_root, &path) else {
                continue;
            };
            let relative = Path::new(&relative_path);
            let markdown = relative.extension().and_then(|ext| ext.to_str())
                .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"));
            let indexable = markdown && !is_ignored_notebook_relative_path(relative);
            return Ok(MarkdownLocation {
                path: path.to_string_lossy().into_owned(),
                notebook_id: Some(notebook.id),
                relative_path: Some(relative_path),
                notebook_path: Some(notebook.path),
                indexable,
            });
        }
        Ok(MarkdownLocation {
            path: path.to_string_lossy().into_owned(),
            notebook_id: None,
            relative_path: None,
            notebook_path: None,
            indexable: false,
        })
    }).await.map_err(|error| format!("Markdown location task failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn get_memos(
    notebook_id: Option<String>,
    filter: Option<String>,
    sort: Option<String>,
    tag_id: Option<String>,
    color: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    app: AppHandle,
) -> Result<GetMemosResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // Read the requested notebook directly. Do not switch current notebook here;
        // switching would rebind watcher/reconcile/search and slow down list loading.
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = MemoService::new(&memo_file);
        let filter = filter.as_deref().unwrap_or("all");
        let sort = sort.as_deref().unwrap_or("createdAt");
        // Preserve the old no-pagination behavior for non-migrated transports.
        // The desktop frontend always supplies `limit`, so it uses the bounded
        // page path below without changing the legacy command's result shape.
        let page = if cursor.is_none() && limit.is_none() && color.is_none() {
            MemoPage {
                memos: service.list_memos_filtered(
                    notebook_id.as_deref(),
                    filter,
                    sort,
                    tag_id.as_deref(),
                ),
                next_cursor: None,
                has_more: false,
            }
        } else {
            service
                .list_memos_filtered_page(
                    notebook_id.as_deref(),
                    filter,
                    sort,
                    tag_id.as_deref(),
                    color.as_deref(),
                    cursor.as_deref(),
                    limit,
                )
                .map_err(|error: FlowixError| error.to_string())?
        };
        Ok(GetMemosResponse {
            memos: page.memos,
            next_cursor: page.next_cursor,
            has_more: page.has_more,
        })
    })
    .await
    .map_err(|error| format!("memo list task failed: {error}"))?
}

/// List the notebook's rebuildable note projection by relative path. This is
/// the ID-free list boundary for callers migrating off the legacy memo table.
#[tauri::command]
pub async fn list_notes_by_path(
    notebook_id: String,
    app: AppHandle,
) -> Result<Vec<V2NoteEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        MemoService::new(&memo_file)
            .list_notes_by_path(&notebook_id)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("path-based note list task failed: {error}"))?
}

/// Return one page from the V2 path index without consulting legacy memo IDs.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn get_path_notes(
    notebook_id: String,
    filter: Option<String>,
    sort: Option<String>,
    tag_id: Option<String>,
    color: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    app: AppHandle,
) -> Result<GetPathNotesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = MemoService::new(&memo_file);
        let page = service
            .list_notes_by_path_page(
                &notebook_id,
                filter.as_deref().unwrap_or("all"),
                sort.as_deref().unwrap_or("createdAt"),
                tag_id.as_deref(),
                color.as_deref(),
                cursor.as_deref(),
                limit,
            )
            .map_err(|error: FlowixError| error.to_string())?;
        Ok(GetPathNotesResponse {
            notes: page.notes,
            next_cursor: page.next_cursor,
            has_more: page.has_more,
        })
    })
    .await
    .map_err(|error| format!("path note list task failed: {error}"))?
}

#[tauri::command]
pub fn search_mention_notes(
    query: Option<String>,
    limit: Option<usize>,
    state: State<AppState>,
) -> Vec<MentionNoteSearchItem> {
    let normalized_query = query.unwrap_or_default().trim().to_lowercase();
    let max_items = limit.unwrap_or(200).max(1);

    let memo_file = read_lock(&state.memo_file, "memo_file");
    let previous_notebook_id = memo_file.current_notebook_id_value();
    let mut service = MemoService::new(&memo_file);
    let notebooks = service.list_notebooks().unwrap_or_default();

    let mut ordered_notebooks = notebooks.clone();
    if let Some(current_id) = previous_notebook_id.as_deref() {
        ordered_notebooks.sort_by(|a, b| {
            let a_current = a.id == current_id;
            let b_current = b.id == current_id;
            b_current.cmp(&a_current)
        });
    }

    let mut items = Vec::new();
    for notebook in ordered_notebooks {
        for memo in service.list_memos_filtered(Some(&notebook.id), "all", "updatedAt", None) {
            let title = note_title(&memo.filename);
            if !normalized_query.is_empty() && !title.to_lowercase().contains(&normalized_query) {
                continue;
            }

            let original_path =
                notebook_path_from_relative(Path::new(&notebook.path), &memo.relative_path)
                    .ok()
                    .and_then(|path| path.to_str().map(str::to_string));

            items.push(MentionNoteSearchItem {
                id: memo.id,
                filename: memo.filename,
                title,
                updated_at: memo.updated_at,
                notebook_id: notebook.id.clone(),
                notebook_name: notebook.name.clone(),
                notebook_path: notebook.path.clone(),
                original_path,
            });

            if items.len() >= max_items {
                return items;
            }
        }
    }

    items
}

#[tauri::command]
pub async fn get_used_memo_tag_ids(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<UsedMemoTagIdsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (used_tag_ids, tag_counts, total_memo_count, agent_memo_count, todo_memo_count) =
            MemoService::new(&read_lock(&state.memo_file, "memo_file"))
                .tag_usage_summary(notebook_id.as_deref())
                .unwrap_or_default();
        UsedMemoTagIdsResponse {
            used_tag_ids,
            tag_counts: tag_counts
                .into_iter()
                .map(|(tag_id, count)| MemoTagCount { tag_id, count })
                .collect(),
            total_memo_count,
            agent_memo_count,
            todo_memo_count,
        }
    })
    .await
    .map_err(|error| format!("tag summary task failed: {error}"))
}

#[tauri::command]
pub fn get_memo_todo_metadata(
    notebook_id: Option<String>,
    sort: Option<String>,
    state: State<AppState>,
) -> Vec<PathTodoEntry> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebooks = memo_file.read_notebook_configs().unwrap_or_default();
    let mut entries = notebooks.into_iter()
        .filter(|notebook| notebook_id.as_deref().is_none_or(|id| notebook.id == id))
        .flat_map(|notebook| memo_file.read_v2_path_todos(&notebook.id, sort.as_deref().unwrap_or("createdAt")).unwrap_or_default())
        .collect::<Vec<_>>();
    if sort.as_deref() == Some("updatedAt") {
        entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    } else {
        entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    }
    entries
}

#[tauri::command]
pub fn get_memo_todo_count(notebook_id: Option<String>, state: State<AppState>) -> usize {
    get_memo_todo_metadata(notebook_id, None, state).len()
}

#[tauri::command]
pub fn read_memo(id: String, state: State<AppState>) -> Option<Memo> {
    let (memo, path) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = MemoService::new(&memo_file);
        let memo = service.memo_metadata(&id).ok()?;
        let path = service.resolve_memo(&id).ok()?.path;
        (memo, path)
    };
    // Keep stale index entries from opening an empty editor when the file is gone.
    start_security_bookmark_access(&state, &path);
    if !path.exists() {
        tracing::info!(
            "[read_memo] file gone, unregistering ghost: {}",
            path.display()
        );
        let _ = MemoService::new(&read_lock(&state.memo_file, "memo_file")).delete_memo(&memo.id);
        return None;
    }
    Some(memo)
}

/// Resolve the authoritative memo metadata, path and body in one IPC.
///
/// The browser-column host uses this at activation time so inactive tabs remain
/// cheap and a document switch does not need separate `read_memo` +
/// `read_document` calls.
#[tauri::command]
pub fn open_memo_session(id: String, state: State<AppState>) -> Option<OpenMemoSessionResponse> {
    let (memo, notebook_id, notebook_path, path) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = MemoService::new(&memo_file);
        let resolved = service.resolve_memo(&id).ok()?;
        (
            MemoFile::index_entry_to_memo(&resolved.entry),
            resolved.notebook.id,
            resolved.notebook.path,
            resolved.path,
        )
    };

    start_security_bookmark_access(&state, &path);
    let content = match fs::read_to_string(&path) {
        Ok(content) => normalize_markdown_encoding_boundaries(&content).into_owned(),
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                tracing::info!(
                    "[open_memo_session] file gone, unregistering ghost: {}",
                    path.display()
                );
                let _ = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
                    .delete_memo(&memo.id);
            }
            return None;
        }
    };

    Some(OpenMemoSessionResponse {
        memo,
        notebook_id,
        notebook_path,
        path: path.to_string_lossy().to_string(),
        content,
    })
}

#[tauri::command]
pub async fn read_document(
    window: tauri::WebviewWindow,
    file_path: String,
    app: AppHandle,
) -> Option<String> {
    crate::document_io::run("read", move || {
        let state = app.state::<AppState>();
        if !crate::commands::helpers::can_access_document_path(
            Path::new(&file_path),
            window.label(),
            &state,
        ) {
            eprintln!("[read_document] refused out-of-scope path: {}", file_path);
            return None;
        }
        let requested_path = Path::new(&file_path);
        start_security_bookmark_access(&state, requested_path);
        let memo_file = read_lock(&state.memo_file, "memo_file");
        match notebook_note_address(&memo_file, requested_path) {
            Ok(Some((notebook_id, relative_path))) => {
                let mut service = MemoService::new(&memo_file);
                if let Err(error) = service.get_note_by_path(&notebook_id, &relative_path) {
                    tracing::debug!(
                        notebook_id = %notebook_id,
                        relative_path = %relative_path,
                        "note read is falling back to Markdown after path-index failure: {error}"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(path = %requested_path.display(), "refusing note path: {error}");
                return None;
            }
            Ok(None) => {}
        }
        fs::read_to_string(requested_path)
            .ok()
            .map(|content| normalize_markdown_encoding_boundaries(&content).into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDocumentResult {
    pub path: String,
    pub content: String,
    #[serde(flatten)]
    pub commit: Option<crate::document_mutation::DocumentCommit>,
}

/// Save a notebook note by path. Standalone documents use the independent
/// `write_external_document` command and never enter this path.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn write_document(
    operation_id: Option<String>,
    filePath: String,
    content: String,
    expectedContent: Option<String>,
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<WriteDocumentResult>, String> {
    crate::commands::document_operations::run(
        "save",
        operation_id,
        window.label().to_owned(),
        move || {
            let state = app.state::<AppState>();
            write_document_internal(
                &filePath,
                &content,
                expectedContent.as_deref(),
                &state,
                &app,
            )
        },
    )
    .await
}

/// Save the existing file at an exact absolute path with content validation.
fn write_document_internal(
    file_path: &str,
    content: &str,
    expected_content: Option<&str>,
    state: &State<AppState>,
    app: &AppHandle,
) -> Result<Option<WriteDocumentResult>, String> {
    if !Path::new(file_path).is_absolute() {
        return Err("absolute document path required".into());
    }
    start_security_bookmark_access(state.inner(), Path::new(file_path));
    let requested_path = Path::new(file_path);
    let (notebook_id, relative_path) =
        notebook_note_address(&read_lock(&state.memo_file, "memo_file"), requested_path)?
            .ok_or_else(|| {
                "document is not a Markdown note inside a registered notebook".to_string()
            })?;

    let current_content = fs::read_to_string(requested_path).map_err(|error| error.to_string())?;
    if expected_content
        .is_some_and(|expected| !cas_content_matches(&current_content, expected, content))
    {
        return Ok(None);
    }

    let (saved_path, saved_content) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = MemoService::new(&memo_file);
        mark_self_write_for(app, requested_path);
        match service.save_note_by_path(
            &notebook_id,
            &relative_path,
            content,
            Some(&current_content),
        ) {
            Ok(PathNoteSaveOutcome::Saved(document)) => (document.path, document.body),
            Ok(PathNoteSaveOutcome::Conflict { .. }) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        }
    };

    mark_self_write_for(app, &saved_path);
    let _ = app.emit("flowix:path-note-changed", serde_json::json!({
        "notebookId": notebook_id,
        "relativePath": relative_path,
    }));

    Ok(Some(WriteDocumentResult {
        path: saved_path.display().to_string(),
        content: saved_content,
        commit: None,
    }))
}

#[tauri::command]
pub fn get_launch_open_files(window: tauri::WebviewWindow, state: State<AppState>) -> Vec<String> {
    if window.label() != "main" {
        return Vec::new();
    }
    crate::commands::helpers::markdown_paths_from_args(std::env::args())
        .into_iter()
        .filter_map(|path| dunce::canonicalize(path).ok())
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| state.document_access.grant(window.label(), Path::new(path)))
        .collect()
}

#[tauri::command]
pub fn search_memos(
    notebook_id: Option<String>,
    query: String,
    limit: Option<usize>,
    state: State<AppState>,
    app: AppHandle,
) -> SearchMemosResponse {
    let idx = read_lock(&state.search, "search");
    if let Some(ref nb) = notebook_id {
        if idx.current_notebook() != Some(nb.as_str()) {
            drop(idx);
            rebuild_index_in_background(state.inner(), &app);
            return SearchMemosResponse {
                hits: vec![],
                index_ready: false,
            };
        }
    }
    drop(idx);

    let needs_rebuild = {
        let idx = read_lock(&state.search, "search");
        let current_nb = read_lock(&state.memo_file, "memo_file").current_notebook_id_value();
        !idx.is_loaded() || idx.current_notebook() != current_nb.as_deref()
    };
    if needs_rebuild {
        rebuild_index_in_background(state.inner(), &app);
    }

    let idx = read_lock(&state.search, "search");
    let index_ready = idx.is_loaded();
    let hits = idx.search(&query, limit.unwrap_or(30));
    SearchMemosResponse { hits, index_ready }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathNoteSearchHit {
    notebook_id: String,
    relative_path: String,
    title: String,
    snippet: String,
    matched_in: &'static str,
}

#[tauri::command]
pub fn search_path_notes(
    notebook_id: String,
    query: String,
    limit: Option<usize>,
    state: State<AppState>,
) -> Result<Vec<PathNoteSearchHit>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() { return Ok(Vec::new()); }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file.get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "notebook not found".to_string())?;
    let mut entries = memo_file.read_v2_note_entries(&notebook_id).map_err(|e| e.to_string())?;
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
    let mut hits = Vec::new();
    for entry in entries {
        let title_match = entry.title.to_lowercase().contains(&query);
        let tag_match = entry.tags.iter().any(|tag| tag.to_lowercase().contains(&query));
        let path = notebook_path_from_relative(Path::new(&notebook.path), &entry.relative_path)
            .map_err(|error| error.to_string())?;
        let body = fs::read_to_string(&path).unwrap_or_default();
        let body_lower = body.to_lowercase();
        let body_match = body_lower.find(&query);
        if !title_match && !tag_match && body_match.is_none() { continue; }
        let snippet = body_match.map(|_| body.chars().take(130).collect::<String>()
            .replace(['\r', '\n'], " ")).unwrap_or_default();
        hits.push(PathNoteSearchHit {
            notebook_id: notebook_id.clone(),
            relative_path: entry.relative_path,
            title: entry.title,
            snippet,
            matched_in: if title_match { "title" } else if tag_match { "tag" } else { "body" },
        });
        if hits.len() >= limit.unwrap_or(30).clamp(1, 100) { break; }
    }
    Ok(hits)
}
