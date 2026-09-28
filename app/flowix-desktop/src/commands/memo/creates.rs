// ==================== Creates and Imports ====================
//
// Covers creation, import, templates, and path-based moves:
//   - new memo creation (add_document)
//   - external document import (import_external_document_to_memo)
//   - memo templates (list / save / delete / create-from)
// Metadata controls write the document YAML through the frontend save queue.

use std::fmt::Display;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use crate::USER_CONFIG_DIR_NAME;
use flowix_core::memo_file::{
    atomic_write_bytes, extract_body_content, is_ignored_notebook_relative_path, Memo, MemoFile,
};
use flowix_core::MemoService;

use crate::app::search_index::try_index_upsert;
use crate::app::state::AppState;
use crate::template_store;
use crate::watcher::runtime::mark_self_write_for;

use super::helpers::*;
use super::*;

/// Stable creation error shared by both desktop creation entrypoints.
#[derive(Debug, serde::Serialize)]
pub struct MemoCreateError {
    code: &'static str,
    message: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDocumentResult {
    memo: Memo,
    initial_content: String,
}

impl From<flowix_core::FlowixError> for MemoCreateError {
    fn from(error: flowix_core::FlowixError) -> Self {
        use flowix_core::FlowixError;
        let code = match &error {
            FlowixError::InvalidInput(_) => "INVALID_INPUT",
            FlowixError::NotFound(_) => "NOT_FOUND",
            FlowixError::Conflict(_) => "CONFLICT",
            FlowixError::PermissionDenied(_) => "PERMISSION_DENIED",
            FlowixError::Io(_) => "IO_ERROR",
            FlowixError::CorruptData(_) => "CORRUPT_DATA",
            FlowixError::Internal(_) => "INTERNAL_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

fn create_document(
    state: &AppState,
    app: &AppHandle,
    notebook_id: Option<&str>,
    parent_relative_path: Option<&str>,
    title: &str,
    content: &str,
    tag: Option<&str>,
) -> Result<Memo, MemoCreateError> {
    let notebook_key = notebook_id
        .map(str::to_owned)
        .unwrap_or_else(|| current_notebook_id(state));
    let initial_content = match tag {
        Some(tag) => flowix_core::memo_file::replace_frontmatter_tags(content, &[tag.to_owned()])
            .map_err(|error| flowix_core::FlowixError::InvalidInput(error.to_string()))?,
        None => content.to_owned(),
    };
    let created = MemoService::new(&read_lock(&state.memo_file, "memo_file")).create_note_by_path(
        &notebook_key,
        parent_relative_path,
        title,
        &initial_content,
    )?;
    let memo = read_lock(&state.memo_file, "memo_file")
        .register_existing_file_for_notebook_id(&created.notebook.id, &created.path)
        .map_err(flowix_core::FlowixError::Internal)?;
    crate::document_derived::schedule(app, &memo.id, None);
    mark_self_write_for(app, &created.path);
    memo_events::emit(
        app,
        MemoEvent::Created {
            memo: memo.clone(),
            notebook_id: created.notebook.id,
            derived_changed: MemoDerivedChanged::from_memos(None, &memo),
            source: MemoChangeSource::UserNew,
        },
    );
    Ok(memo)
}

#[tauri::command]
pub async fn add_document(
    tag: Option<String>,
    title: Option<String>,
    notebook_id: Option<String>,
    parent_relative_path: Option<String>,
    app: AppHandle,
) -> Result<CreatedDocumentResult, MemoCreateError> {
    let title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
    let tag = tag.filter(|value| !value.trim().is_empty());
    let initial_content = match tag.as_deref() {
        Some(tag) => flowix_core::memo_file::replace_frontmatter_tags("", &[tag.to_string()])
            .map_err(|error| MemoCreateError {
                code: "INVALID_INPUT",
                message: error.to_string(),
            })?,
        None => String::new(),
    };
    let memo = crate::document_io::run("create_document", move || {
        let state = app.state::<AppState>();
        create_document(
            state.inner(),
            &app,
            notebook_id.as_deref(),
            parent_relative_path.as_deref(),
            &title,
            "",
            tag.as_deref(),
        )
    })
    .await
    .map_err(|message| MemoCreateError {
        code: "INTERNAL_ERROR",
        message,
    })??;
    Ok(CreatedDocumentResult {
        memo,
        initial_content,
    })
}

#[tauri::command]
pub async fn create_memo_with_content(
    title: String,
    content: String,
    notebook_id: String,
    parent_relative_path: Option<String>,
    app: AppHandle,
) -> Result<Memo, MemoCreateError> {
    let title = title.trim().to_string();
    if title.is_empty() || notebook_id.trim().is_empty() {
        return Err(flowix_core::FlowixError::InvalidInput(
            "title and notebook id are required".into(),
        )
        .into());
    }
    crate::document_io::run("create_memo_with_content", move || {
        let state = app.state::<AppState>();
        create_document(
            state.inner(),
            &app,
            Some(&notebook_id),
            parent_relative_path.as_deref(),
            &title,
            &content,
            None,
        )
    })
    .await
    .map_err(|message| MemoCreateError {
        code: "INTERNAL_ERROR",
        message,
    })?
}

fn memo_template_dir() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|home| template_store::notes_templates_dir(&home.join(USER_CONFIG_DIR_NAME)))
}

fn notebook_template_dir() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|home| template_store::notebook_templates_dir(&home.join(USER_CONFIG_DIR_NAME)))
}

fn is_template_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
            .unwrap_or(false)
}

fn template_name_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Untitled")
        .to_string()
}

fn next_template_filename(dir: &Path, title: &str) -> String {
    let base = MemoFile::sanitize_memo_filename_component(title);
    let base = if base.is_empty() {
        "template".to_string()
    } else {
        base
    };

    let primary = format!("{base}.md");
    if !dir.join(&primary).exists() {
        return primary;
    }

    let mut n = 1u32;
    loop {
        let candidate = format!("{base}-{n}.md");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

#[tauri::command]
pub fn list_memo_templates() -> Vec<MemoTemplate> {
    let Some(dir) = memo_template_dir() else {
        return vec![];
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };

    let mut templates: Vec<MemoTemplate> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_template_file(path))
        .filter_map(|path| {
            let id = path.file_name()?.to_str()?.to_string();
            Some(MemoTemplate {
                name: template_name_from_path(&path),
                id,
            })
        })
        .collect();

    templates.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    templates
}

#[tauri::command]
pub fn save_memo_template(title: String, content: String) -> Result<MemoTemplate, String> {
    let dir = memo_template_dir().ok_or_else(|| "template directory not available".to_string())?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("create template directory failed: {error}"))?;
    let body = extract_body_content(&content).to_string();
    let filename = next_template_filename(&dir, &title);
    let path = dir.join(&filename);

    atomic_write_bytes(&path, body.as_bytes()).map_err(|e| format!("save template failed: {e}"))?;

    Ok(MemoTemplate {
        name: template_name_from_path(&path),
        id: filename,
    })
}

#[tauri::command]
pub fn delete_memo_template(template_id: String) -> Result<bool, String> {
    let template_name = Path::new(&template_id)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid template id".to_string())?;

    if template_name != template_id {
        return Err("invalid template id".to_string());
    }

    let dir = memo_template_dir().ok_or_else(|| "template directory not available".to_string())?;
    let path = dir.join(template_name);
    if !is_template_file(&path) {
        return Ok(false);
    }

    fs::remove_file(&path).map_err(|e| format!("delete template failed: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn create_memo_from_template(
    template_id: String,
    notebook_id: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Memo, String> {
    let template_name = Path::new(&template_id)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid template id".to_string())?;

    if template_name != template_id {
        return Err("invalid template id".to_string());
    }

    let dir = memo_template_dir().ok_or_else(|| "template directory not available".to_string())?;
    let path = dir.join(template_name);
    if !is_template_file(&path) {
        return Err("template not found".to_string());
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("read template failed: {e}"))?;
    let body = extract_body_content(&content).to_string();
    let title = template_name_from_path(&path);

    let abs = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .preview_create_path(notebook_id.as_deref(), &title)
        .map_err(|e| format!("prepare memo from template failed: {e}"))?;
    mark_self_write_for(&app, &abs);

    let memo = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .create_memo_named(notebook_id.as_deref(), &title, &body)
        .map_err(|e| format!("create memo from template failed: {e}"))?
        .memo;

    try_index_upsert(state.inner(), &memo.id);
    if let Ok(resolved) =
        MemoService::new(&read_lock(&state.memo_file, "memo_file")).resolve_memo(&memo.id)
    {
        mark_self_write_for(&app, &resolved.path);
    }
    memo_events::emit(
        &app,
        MemoEvent::Created {
            memo: memo.clone(),
            notebook_id: notebook_id_for_memo(state.inner(), &memo.id),
            derived_changed: MemoDerivedChanged::from_memos(None, &memo),
            source: MemoChangeSource::UserNew,
        },
    );

    Ok(memo)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn import_external_document_to_memo(
    file_path: String,
    content: String,
    notebook_id: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Memo, String> {
    let abs = std::path::PathBuf::from(&file_path);

    // Import by creating a normal memo from the external file stem and content.
    let title = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported")
        .to_string();
    let body = if content.is_empty() {
        String::new()
    } else {
        content.clone()
    };

    // Mark the likely new path before writing.
    let abs_new = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .preview_create_path(notebook_id.as_deref(), &title)
        .map_err(|e| format!("prepare imported memo failed: {e}"))?;
    mark_self_write_for(&app, &abs_new);

    let memo = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .create_memo_named(notebook_id.as_deref(), &title, &body)
        .map_err(|e| format!("create_memo failed: {e}"))?
        .memo;

    try_index_upsert(state.inner(), &memo.id);
    let _ = abs;
    memo_events::emit(
        &app,
        MemoEvent::Created {
            memo: memo.clone(),
            notebook_id: notebook_id_for_memo(state.inner(), &memo.id),
            derived_changed: MemoDerivedChanged::from_memos(None, &memo),
            source: MemoChangeSource::UserImport,
        },
    );
    Ok(memo)
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NotebookTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source_directory: String,
    pub icon: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotebookTemplateIndex {
    templates: Vec<NotebookTemplate>,
}

struct NotebookTemplateFileInput {
    path: String,
    content: String,
}

const MAX_NOTEBOOK_TEMPLATE_FILES: usize = 2_000;
const MAX_NOTEBOOK_TEMPLATE_BYTES: usize = 10 * 1024 * 1024;
const NOTEBOOK_TEMPLATE_INIT_MARKER: &str = ".flowix/notebook-template-initializing.json";

fn validate_notebook_template(template: &NotebookTemplate) -> Result<(), String> {
    if template.id.trim().is_empty()
        || template.id.len() > 128
        || template.id.chars().any(char::is_control)
        || template.name.trim().is_empty()
    {
        return Err("INVALID_NOTEBOOK_TEMPLATE_INDEX".to_string());
    }

    let source = Path::new(&template.source_directory);
    let mut components = source.components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("INVALID_NOTEBOOK_TEMPLATE_DIRECTORY".to_string());
    }

    Ok(())
}

fn read_notebook_template_index() -> Result<Vec<NotebookTemplate>, String> {
    let directory =
        notebook_template_dir().ok_or_else(|| "template directory not available".to_string())?;
    let path = directory.join("index.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("read notebook template index failed: {error}"))?;
    let index: NotebookTemplateIndex = serde_json::from_str(&content)
        .map_err(|error| format!("parse notebook template index failed: {error}"))?;

    let mut ids = std::collections::HashSet::with_capacity(index.templates.len());
    for template in &index.templates {
        validate_notebook_template(template)?;
        if !ids.insert(template.id.clone()) {
            return Err("DUPLICATE_NOTEBOOK_TEMPLATE_ID".to_string());
        }
    }

    Ok(index.templates)
}

#[tauri::command]
pub fn list_notebook_templates() -> Result<Vec<NotebookTemplate>, String> {
    let home = dirs::home_dir().ok_or_else(|| "template directory not available".to_string())?;
    template_store::initialize_notebook_templates(&home.join(USER_CONFIG_DIR_NAME))?;
    read_notebook_template_index()
}

fn load_notebook_template_files(
    template: &NotebookTemplate,
) -> Result<Vec<NotebookTemplateFileInput>, String> {
    let template_root =
        notebook_template_dir().ok_or_else(|| "template directory not available".to_string())?;
    load_notebook_template_files_from_root(&template_root, template)
}

fn load_notebook_template_files_from_root(
    template_root: &Path,
    template: &NotebookTemplate,
) -> Result<Vec<NotebookTemplateFileInput>, String> {
    validate_notebook_template(template)?;

    let template_root = fs::canonicalize(template_root)
        .map_err(|error| format!("resolve notebook template directory failed: {error}"))?;
    let source = fs::canonicalize(template_root.join(&template.source_directory))
        .map_err(|error| format!("resolve notebook template failed: {error}"))?;
    if !source.starts_with(&template_root)
        || !fs::metadata(&source)
            .map_err(|error| format!("inspect notebook template failed: {error}"))?
            .is_dir()
    {
        return Err("INVALID_NOTEBOOK_TEMPLATE_DIRECTORY".to_string());
    }

    let mut files = Vec::new();
    let mut total_bytes = 0usize;
    for entry in walkdir::WalkDir::new(&source).follow_links(false) {
        let entry = entry.map_err(|error| format!("scan notebook template failed: {error}"))?;
        if !entry.file_type().is_file() {
            continue;
        }

        let filename = entry.file_name().to_string_lossy();
        if filename == ".DS_Store" || filename.starts_with("._") {
            continue;
        }

        let relative = entry
            .path()
            .strip_prefix(&source)
            .map_err(|_| "INVALID_TEMPLATE_PATH".to_string())?;
        let path = relative
            .components()
            .map(|component| {
                component
                    .as_os_str()
                    .to_str()
                    .ok_or_else(|| "INVALID_TEMPLATE_PATH".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
            .join("/");
        let path = canonicalize_notebook_template_skill_path(&path);
        validate_notebook_template_path(&path)?;

        let content = fs::read_to_string(entry.path())
            .map_err(|error| format!("read notebook template file failed: {error}"))?;
        total_bytes = total_bytes
            .checked_add(path.len())
            .and_then(|total| total.checked_add(content.len()))
            .ok_or_else(|| "NOTEBOOK_TEMPLATE_TOO_LARGE".to_string())?;
        if total_bytes > MAX_NOTEBOOK_TEMPLATE_BYTES || files.len() >= MAX_NOTEBOOK_TEMPLATE_FILES {
            return Err("NOTEBOOK_TEMPLATE_TOO_LARGE".to_string());
        }

        files.push(NotebookTemplateFileInput { path, content });
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    if files.is_empty() {
        return Err("EMPTY_NOTEBOOK_TEMPLATE".to_string());
    }
    Ok(files)
}

/// DSH's filesystem skill provider recognizes directory skills only when the
/// entry file is named `SKILL.md`. Older user-installed notebook templates
/// may still carry Flowix's former lowercase filename; normalize the path as
/// the template is materialized so newly created notebooks are discoverable.
fn canonicalize_notebook_template_skill_path(path: &str) -> String {
    let Some(skill_path) = path.strip_prefix(".agents/skills/") else {
        return path.to_string();
    };
    let Some((skill_id, filename)) = skill_path.split_once('/') else {
        return path.to_string();
    };
    if filename == "skill.md" && !skill_id.contains('/') {
        format!(".agents/skills/{skill_id}/SKILL.md")
    } else {
        path.to_string()
    }
}

fn validate_notebook_template_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains('\\') || path.contains('\0') {
        return Err("INVALID_TEMPLATE_PATH".to_string());
    }

    let relative = Path::new(path);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("INVALID_TEMPLATE_PATH".to_string());
    }

    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err("INVALID_TEMPLATE_PATH".to_string());
        };
        let name = name.to_string_lossy();
        if name.starts_with('.') && name != ".agents" && name != ".gitignore" {
            return Err("UNSUPPORTED_TEMPLATE_PATH".to_string());
        }
        if (name == ".agents" && index != 0) || (name == ".gitignore" && index != 0) {
            return Err("UNSUPPORTED_TEMPLATE_PATH".to_string());
        }
    }

    let filename = relative
        .file_name()
        .and_then(|filename| filename.to_str())
        .ok_or_else(|| "INVALID_TEMPLATE_PATH".to_string())?;
    if !filename.ends_with(".md") && filename != ".gitignore" && filename != "CODEOWNERS" {
        return Err("UNSUPPORTED_TEMPLATE_FILE".to_string());
    }

    Ok(relative.to_path_buf())
}

fn ensure_notebook_template_parent(
    notebook_root: &Path,
    parent_relative: Option<&Path>,
) -> Result<PathBuf, String> {
    let mut parent = notebook_root.to_path_buf();
    if let Some(parent_relative) = parent_relative {
        for component in parent_relative.components() {
            let Component::Normal(name) = component else {
                return Err("INVALID_TEMPLATE_PATH".to_string());
            };
            parent.push(name);
            match fs::create_dir(&parent) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("create template folder failed: {error}")),
            }

            parent = fs::canonicalize(&parent)
                .map_err(|error| format!("resolve template folder failed: {error}"))?;
            if !parent.starts_with(notebook_root) {
                return Err("TEMPLATE_PATH_OUTSIDE_NOTEBOOK".to_string());
            }
            if !fs::metadata(&parent)
                .map_err(|error| format!("inspect template folder failed: {error}"))?
                .is_dir()
            {
                return Err("TEMPLATE_PARENT_NOT_DIRECTORY".to_string());
            }
        }
    }
    Ok(parent)
}

fn notebook_root_has_no_user_content(notebook_root: &Path) -> Result<bool, String> {
    let entries = fs::read_dir(notebook_root)
        .map_err(|error| format!("read notebook directory failed: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("read notebook directory entry failed: {error}"))?;
        let name = entry.file_name();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect notebook directory entry failed: {error}"))?;

        if file_type.is_file() && matches!(name.to_str(), Some(".DS_Store" | ".localized")) {
            continue;
        }

        // Flowix owns all data inside this reserved directory. It can be
        // populated as soon as a notebook is registered, even when the user
        // selected an otherwise empty folder for template initialization.
        if name == ".flowix" && file_type.is_dir() {
            continue;
        }

        return Ok(false);
    }
    Ok(true)
}

fn notebook_template_file_failure(path: &str, error: impl Display) -> String {
    let reason = error.to_string();
    let details = serde_json::json!({ "path": path, "reason": reason });
    let message = format!("NOTEBOOK_TEMPLATE_FILE_FAILED:{details}");
    crate::runtime_log::record_event("error", "notebook.template.file_failed", &message);
    message
}

#[cfg(test)]
mod notebook_template_destination_tests {
    use super::notebook_root_has_no_user_content;
    use std::fs;

    #[test]
    fn allows_flowix_metadata_in_an_otherwise_empty_notebook_folder() {
        let directory = tempfile::tempdir().expect("temporary notebook directory");
        let flowix = directory.path().join(".flowix");
        fs::create_dir_all(&flowix).expect("create Flowix metadata directory");
        fs::write(flowix.join("notebook.db"), []).expect("write notebook database");
        fs::write(flowix.join("agent.json"), "{}").expect("write notebook agent config");

        assert!(notebook_root_has_no_user_content(directory.path()).unwrap());
    }

    #[test]
    fn refuses_visible_user_content_in_a_notebook_folder() {
        let directory = tempfile::tempdir().expect("temporary notebook directory");
        fs::write(directory.path().join("README.md"), "User content").expect("write user document");

        assert!(!notebook_root_has_no_user_content(directory.path()).unwrap());
    }
}

#[cfg(test)]
mod notebook_template_content_tests {
    use super::{
        ensure_notebook_template_parent, load_notebook_template_files_from_root,
        validate_notebook_template_path, NotebookTemplateIndex,
    };
    use flowix_core::memo_file::{
        atomic_write_bytes, extract_frontmatter_key, is_ignored_notebook_relative_path, MemoFile,
        NotebookConfig,
    };
    use flowix_core::MemoService;
    use std::fs;
    use std::path::Path;

    #[test]
    fn novel_template_creates_all_indexed_notes_and_replaces_source_keys() {
        let directory = tempfile::tempdir().expect("temporary template test directory");
        let config_dir = directory.path().join("config");
        crate::template_store::initialize_notebook_templates(&config_dir)
            .expect("seed notebook templates");
        let template_root = crate::template_store::notebook_templates_dir(&config_dir);
        let index: NotebookTemplateIndex = serde_json::from_slice(
            &fs::read(template_root.join("index.json")).expect("read template index"),
        )
        .expect("parse template index");
        let template = index
            .templates
            .into_iter()
            .find(|template| template.id == "novel-writing")
            .expect("find novel-writing template");
        let files = load_notebook_template_files_from_root(&template_root, &template)
            .expect("load novel template files");

        let notebook_root = directory.path().join("notebook");
        fs::create_dir_all(&notebook_root).expect("create notebook root");
        let mut memo_file = MemoFile::new(config_dir);
        memo_file
            .write_notebook_configs(&[NotebookConfig {
                id: "nb_template_test".to_string(),
                name: "Template test".to_string(),
                icon: None,
                path: format!("{}/", notebook_root.display()),
                is_default: true,
                sort: 0,
                created_at: 1,
                updated_at: 1,
            }])
            .expect("register test notebook");
        memo_file.set_current_notebook(Some("nb_template_test".to_string()));
        let notebook_root = fs::canonicalize(&notebook_root).expect("resolve notebook root");

        let expected_note_count = files
            .iter()
            .filter(|file| {
                let path = Path::new(&file.path);
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
                    && !is_ignored_notebook_relative_path(path)
            })
            .count();
        let mut created_notes = Vec::with_capacity(expected_note_count);

        for file in files {
            let relative =
                validate_notebook_template_path(&file.path).expect("valid template path");
            let parent_relative = relative
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty());
            let parent = ensure_notebook_template_parent(&notebook_root, parent_relative)
                .expect("create template parent");
            let filename = relative.file_name().expect("template filename");
            let is_markdown = relative
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));

            if is_markdown && !is_ignored_notebook_relative_path(&relative) {
                let title = relative
                    .file_stem()
                    .and_then(|title| title.to_str())
                    .expect("template note title");
                let parent_relative =
                    parent_relative.map(|parent| parent.to_string_lossy().replace('\\', "/"));
                let created = MemoService::new(&memo_file)
                    .create_memo_named_with_tag_in_directory(
                        Some("nb_template_test"),
                        parent_relative.as_deref(),
                        title,
                        &file.content,
                        None,
                    )
                    .unwrap_or_else(|error| panic!("create {}: {error}", file.path));
                created_notes.push((created.memo.id, created.path));
            } else {
                atomic_write_bytes(&parent.join(filename), file.content.as_bytes())
                    .unwrap_or_else(|error| panic!("copy {}: {error}", file.path));
            }
        }

        assert_eq!(created_notes.len(), expected_note_count);
        for (_id, path) in created_notes {
            let content = fs::read_to_string(path).expect("read created template note");
            assert_eq!(extract_frontmatter_key(&content), None);
        }
    }
}

fn read_notebook_template_init_marker(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "inspect template initialization marker failed: {error}"
            ))
        }
    };
    if !metadata.file_type().is_file() {
        return Err("INVALID_NOTEBOOK_TEMPLATE_MARKER".to_string());
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Marker {
        template_id: String,
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("read template initialization marker failed: {error}"))?;
    let marker: Marker = serde_json::from_str(&content)
        .map_err(|_| "INVALID_NOTEBOOK_TEMPLATE_MARKER".to_string())?;
    Ok(Some(marker.template_id))
}

fn begin_notebook_template_initialization(
    notebook_root: &Path,
    template_id: &str,
    is_new_notebook: bool,
) -> Result<PathBuf, String> {
    let marker_path = notebook_root.join(NOTEBOOK_TEMPLATE_INIT_MARKER);
    if let Some(existing_template_id) = read_notebook_template_init_marker(&marker_path)? {
        if existing_template_id == template_id {
            return Ok(marker_path);
        }
        return Err("NOTEBOOK_TEMPLATE_INITIALIZATION_IN_PROGRESS".to_string());
    }

    let root_is_empty = notebook_root_has_no_user_content(notebook_root)?;
    if !is_new_notebook && !root_is_empty {
        return Err("NOTEBOOK_ALREADY_REGISTERED".to_string());
    }
    if !root_is_empty {
        return Err("NOTEBOOK_NOT_EMPTY".to_string());
    }

    let internal_dir = notebook_root.join(".flowix");
    fs::create_dir_all(&internal_dir)
        .map_err(|error| format!("create notebook metadata directory failed: {error}"))?;
    let canonical_internal_dir = fs::canonicalize(&internal_dir)
        .map_err(|error| format!("resolve notebook metadata directory failed: {error}"))?;
    if !canonical_internal_dir.starts_with(notebook_root) {
        return Err("TEMPLATE_PATH_OUTSIDE_NOTEBOOK".to_string());
    }

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Marker<'a> {
        template_id: &'a str,
    }

    let content = serde_json::to_vec(&Marker { template_id })
        .map_err(|error| format!("serialize template initialization marker failed: {error}"))?;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker_path)
    {
        Ok(mut file) => {
            if let Err(error) = file.write_all(&content) {
                let _ = fs::remove_file(&marker_path);
                return Err(format!(
                    "write template initialization marker failed: {error}"
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing_template_id = read_notebook_template_init_marker(&marker_path)?
                .ok_or_else(|| "INVALID_NOTEBOOK_TEMPLATE_MARKER".to_string())?;
            if existing_template_id != template_id {
                return Err("NOTEBOOK_TEMPLATE_INITIALIZATION_IN_PROGRESS".to_string());
            }
        }
        Err(error) => {
            return Err(format!(
                "create template initialization marker failed: {error}"
            ))
        }
    }

    Ok(marker_path)
}

/// Copy a locally managed notebook template into a notebook while retaining
/// its folder structure and indexing visible Markdown documents.
#[tauri::command]
pub async fn initialize_notebook_template(
    notebook_id: String,
    template_id: String,
    is_new_notebook: bool,
    app: AppHandle,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let watched_notebook_id = notebook_id.clone();
        let started = std::time::Instant::now();
        // A retried template may already be watched; unbind it before any writes.
        crate::commands::helpers::set_notebook_watching_suspended(&app, &notebook_id, true);
        crate::commands::helpers::refresh_notebook_watcher(state.inner(), &app, &notebook_id);
        let suspend_ms = started.elapsed().as_millis();
        let write_started = std::time::Instant::now();
        let result = initialize_notebook_template_inner(
            notebook_id,
            template_id,
            is_new_notebook,
            state,
            &app,
        );
        let write_ms = write_started.elapsed().as_millis();
        let resume_started = std::time::Instant::now();
        let state = app.state::<AppState>();
        crate::commands::helpers::set_notebook_watching_suspended(
            &app,
            &watched_notebook_id,
            false,
        );
        crate::commands::helpers::refresh_notebook_watcher(state.inner(), &app, &watched_notebook_id);
        crate::runtime_log::record_event(
            "info", "notebook.template.timing",
            format!("notebook={} suspend_ms={} write_ms={} resume_ms={} total_ms={} success={} created={}",
                watched_notebook_id, suspend_ms, write_ms,
                resume_started.elapsed().as_millis(), started.elapsed().as_millis(),
                result.is_ok(), result.as_ref().copied().unwrap_or(0)),
        );
        result
    })
    .await
    .map_err(|error| format!("notebook template initialization task failed: {error}"))?
}

fn initialize_notebook_template_inner(
    notebook_id: String,
    template_id: String,
    is_new_notebook: bool,
    state: State<AppState>,
    app: &AppHandle,
) -> Result<usize, String> {
    if notebook_id.trim().is_empty() {
        return Err("INVALID_NOTEBOOK_TEMPLATE".to_string());
    }

    let template = read_notebook_template_index()?
        .into_iter()
        .find(|template| template.id == template_id)
        .ok_or_else(|| "UNKNOWN_NOTEBOOK_TEMPLATE".to_string())?;
    let files = load_notebook_template_files(&template)?;

    let notebook_root = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .map(|config| PathBuf::from(config.path))
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    fs::create_dir_all(&notebook_root)
        .map_err(|error| format!("create notebook directory failed: {error}"))?;
    let notebook_root = fs::canonicalize(&notebook_root)
        .map_err(|error| format!("resolve notebook directory failed: {error}"))?;
    let initialization_marker =
        begin_notebook_template_initialization(&notebook_root, &template_id, is_new_notebook)?;

    let mut seen_paths = std::collections::HashSet::with_capacity(files.len());
    let mut created = 0usize;
    for file in files {
        let relative = validate_notebook_template_path(&file.path)
            .map_err(|error| notebook_template_file_failure(&file.path, error))?;
        if !seen_paths.insert(relative.clone()) {
            return Err(notebook_template_file_failure(
                &file.path,
                "DUPLICATE_TEMPLATE_PATH",
            ));
        }

        let parent_relative = relative
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty());
        let parent = ensure_notebook_template_parent(&notebook_root, parent_relative)
            .map_err(|error| notebook_template_file_failure(&file.path, error))?;

        let filename = relative
            .file_name()
            .ok_or_else(|| notebook_template_file_failure(&file.path, "INVALID_TEMPLATE_PATH"))?;
        let target = parent.join(filename);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_file() => continue,
            Ok(_) => {
                return Err(notebook_template_file_failure(
                    &file.path,
                    "template destination exists but is not a regular file",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(notebook_template_file_failure(&file.path, error));
            }
        }

        let is_markdown = relative
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
        if is_markdown && !is_ignored_notebook_relative_path(&relative) {
            let title = relative
                .file_stem()
                .and_then(|title| title.to_str())
                .ok_or_else(|| {
                    notebook_template_file_failure(&file.path, "INVALID_TEMPLATE_PATH")
                })?;
            let parent_relative =
                parent_relative.map(|parent| parent.to_string_lossy().replace('\\', "/"));
            let expected_path = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
                .preview_create_path_in_directory(
                    Some(&notebook_id),
                    parent_relative.as_deref(),
                    title,
                )
                .map_err(|error| notebook_template_file_failure(&file.path, error))?;
            mark_self_write_for(app, &expected_path);

            let memo = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
                .create_memo_named_with_tag_in_directory(
                    Some(&notebook_id),
                    parent_relative.as_deref(),
                    title,
                    &file.content,
                    None,
                )
                .map_err(|error| notebook_template_file_failure(&file.path, error))?
                .memo;

            mark_self_write_for(app, &notebook_root.join(&memo.relative_path));
            // A template normally targets a new, inactive notebook. Its search
            // index will load on demand; don't globally resolve every note just
            // to discover that it does not belong to the active search index.
            let index_is_target = {
                let index = read_lock(&state.search, "search");
                index.is_loaded() && index.current_notebook() == Some(notebook_id.as_str())
            };
            if index_is_target {
                try_index_upsert(state.inner(), &memo.id);
            }
            memo_events::emit(
                app,
                MemoEvent::Created {
                    memo: memo.clone(),
                    notebook_id: notebook_id.clone(),
                    derived_changed: MemoDerivedChanged::from_memos(None, &memo),
                    source: MemoChangeSource::NotebookTemplate,
                },
            );
        } else {
            mark_self_write_for(app, &target);
            atomic_write_bytes(&target, file.content.as_bytes())
                .map_err(|error| notebook_template_file_failure(&file.path, error))?;
            mark_self_write_for(app, &target);
        }
        created += 1;
    }

    fs::remove_file(&initialization_marker).map_err(|error| {
        let message = format!("NOTEBOOK_TEMPLATE_FINALIZE_FAILED:{error}");
        crate::runtime_log::record_event("error", "notebook.template.finalize_failed", &message);
        message
    })?;

    Ok(created)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameMemoTitleResult {
    pub memo: Option<Memo>,
    pub path: String,
    pub filename: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveMemoResult {
    pub path: String,
}

/// Move a notebook note by relative path. Updating the legacy memo projection
/// is optional and happens only when a compatibility row already exists.
#[tauri::command]
pub fn move_memo_to_directory(
    file_path: String,
    notebook_id: String,
    parent_relative_path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<MoveMemoResult, String> {
    let requested_path = Path::new(&file_path);
    if !requested_path.is_absolute() {
        return Err("absolute document path required".into());
    }
    let (moved, before, compatibility_memo) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let (source_notebook_id, relative_path) =
            notebook_note_address(&memo_file, requested_path)?.ok_or_else(|| {
                "document is not a Markdown note inside a registered notebook".to_string()
            })?;
        if source_notebook_id != notebook_id {
            return Err("note does not belong to the selected notebook".into());
        }
        let before = memo_file
            .find_memo_by_relative_path_for_notebook_id(&source_notebook_id, &relative_path);
        let mut service = MemoService::new(&memo_file);
        let original = service
            .get_note_by_path(&source_notebook_id, &relative_path)
            .map_err(|error| error.to_string())?;
        mark_self_write_for(&app, &original.path);
        let moved = service
            .move_note_by_path(&source_notebook_id, &relative_path, &parent_relative_path)
            .map_err(|error| error.to_string())?;
        drop(service);
        mark_self_write_for(&app, &moved.path);
        let compatibility_memo = before.as_ref().and_then(|_| {
            memo_file
                .rename_memo_file_for_notebook_id(
                    &source_notebook_id,
                    &original.path,
                    &moved.path,
                )
                .ok()
        });
        (moved, before, compatibility_memo)
    };
    if let Some(memo) = compatibility_memo.as_ref() {
        let derived_changed = MemoDerivedChanged::from_memos(before.as_ref(), memo);
        emit_updated_memo_event(
            &app,
            &memo.id,
            moved.path.to_string_lossy().into_owned(),
            memo.clone(),
            moved.notebook.id.clone(),
            derived_changed,
            MemoChangeSource::UserEdit,
            None,
        );
    } else if before.is_some() {
        tracing::warn!(
            notebook_id = %moved.notebook.id,
            relative_path = %moved.entry.relative_path,
            "path-based note move succeeded; legacy memo projection could not be updated"
        );
    }
    Ok(MoveMemoResult {
        path: moved.path.to_string_lossy().into_owned(),
    })
}

/// Rename a memo independently from its Markdown content.
#[tauri::command]
pub async fn rename_memo_title(
    operation_id: Option<String>,
    file_path: String,
    title: String,
    expected_filename: Option<String>,
    expected_content: Option<String>,
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<RenameMemoTitleResult, String> {
    crate::commands::document_operations::run(
        "rename",
        operation_id,
        window.label().to_owned(),
        move || {
            let state = app.state::<AppState>();
            rename_memo_title_blocking(
                file_path,
                title,
                expected_filename,
                expected_content,
                state,
                app.clone(),
                window,
            )
        },
    )
    .await
    .map_err(|error| error.to_string())
}

fn rename_memo_title_blocking(
    file_path: String,
    title: String,
    expected_filename: Option<String>,
    expected_content: Option<String>,
    state: State<AppState>,
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<RenameMemoTitleResult, String> {
    let title = title.trim().trim_end_matches(".md").trim();
    if title.is_empty() {
        return Err("memo title cannot be empty".to_string());
    }

    let requested_path = Path::new(&file_path);
    if !requested_path.is_absolute() {
        return Err("absolute document path required".into());
    }
    let (renamed, compatibility_memo, before) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let (notebook_id, relative_path) = notebook_note_address(&memo_file, requested_path)?
            .ok_or_else(|| {
                "document is not a Markdown note inside a registered notebook".to_string()
            })?;
        if expected_filename.as_deref().is_some_and(|expected| {
            expected != relative_path.rsplit('/').next().unwrap_or(&relative_path)
        }) {
            return Err("note filename changed before rename".into());
        }
        let before =
            memo_file.find_memo_by_relative_path_for_notebook_id(&notebook_id, &relative_path);
        let mut service = MemoService::new(&memo_file);
        let original = service
            .get_note_by_path(&notebook_id, &relative_path)
            .map_err(|error| error.to_string())?;
        if expected_content.as_deref().is_some_and(|expected| {
            !super::helpers::cas_content_matches(&original.body, expected, expected)
        }) {
            return Err("note changed before rename".into());
        }
        mark_self_write_for(&app, &original.path);
        let renamed = service
            .rename_note_by_path(
                &notebook_id,
                &relative_path,
                title,
                expected_content.as_deref(),
            )
            .map_err(|error| error.to_string())?;
        drop(service);
        mark_self_write_for(&app, &renamed.path);
        let compatibility_memo = if before.is_some() {
            memo_file.rename_memo_file_for_notebook_id(&notebook_id, &original.path, &renamed.path)
        } else {
            memo_file.register_existing_file_for_notebook_id(&notebook_id, &renamed.path)
        }
        .ok();
        (renamed, compatibility_memo, before)
    };

    let path = renamed.path.to_string_lossy().into_owned();
    if let Some(memo) = compatibility_memo.as_ref() {
        let derived_changed = MemoDerivedChanged::from_memos(before.as_ref(), memo);
        if before.is_some() {
            emit_updated_memo_event(
                &app,
                &memo.id,
                path.clone(),
                memo.clone(),
                renamed.notebook.id.clone(),
                derived_changed,
                MemoChangeSource::UserEdit,
                Some(window.label()),
            );
        } else {
            memo_events::emit(
                &app,
                MemoEvent::Created {
                    memo: memo.clone(),
                    notebook_id: renamed.notebook.id.clone(),
                    derived_changed,
                    source: MemoChangeSource::ExternalTool,
                },
            );
        }
    } else {
        tracing::warn!(
            notebook_id = %renamed.notebook.id,
            relative_path = %renamed.entry.relative_path,
            "path-based note rename succeeded; legacy memo projection could not be updated"
        );
    }

    Ok(RenameMemoTitleResult {
        memo: compatibility_memo,
        path,
        filename: renamed
            .entry
            .relative_path
            .rsplit('/')
            .next()
            .unwrap_or(&renamed.entry.relative_path)
            .to_owned(),
    })
}
