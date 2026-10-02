//! Notebook-scoped metadata IPC.
//!
//! Tag navigation state and the Agent empty-state "quick notes" filter are
//! stored in each notebook's `.flowix/system.json`. The legacy global system
//! store is read only to migrate a notebook the first time it is accessed.

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::State;

use crate::app::state::AppState;
use crate::system_data::{
    NotebookCustomViewsData, NotebookFeaturedNotesData,
    NotebookFileTreePreferences, NotebookTagSystemData, SystemFile, TagLayoutItem, TagSystemData,
};

const FEATURED_NOTES_ALLOWED_OPERATORS: [&str; 3] = ["equals", "contains", "excludes"];
const CUSTOM_VIEW_ALLOWED_OPERATORS: [&str; 2] = ["equals", "contains"];
const FILE_TREE_SECTIONS: [&str; 5] = ["agents", "pinned", "views", "files", "repositories"];

#[tauri::command]
pub fn get_tag_system_metadata(
    notebook_id: String,
    state: State<AppState>,
) -> NotebookTagSystemData {
    load_notebook_system(&notebook_id, &state)
        .map(|file| {
            file.tag
                .notebooks
                .get(&notebook_id)
                .cloned()
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_tag_system_layout(
    notebook_id: String,
    layout: Vec<TagLayoutItem>,
    state: State<AppState>,
) -> Result<(), String> {
    let mut file = load_notebook_system(&notebook_id, &state)?;
    let notebook = file.tag.notebooks.entry(notebook_id.clone()).or_default();
    notebook.order = layout.iter().map(|item| item.id.clone()).collect();
    notebook.layout = layout;
    persist_notebook_system(&notebook_id, &state, &file)
}

#[tauri::command]
pub fn set_tag_system_hidden(
    notebook_id: String,
    hidden: Vec<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let mut file = load_notebook_system(&notebook_id, &state)?;
    file.tag
        .notebooks
        .entry(notebook_id.clone())
        .or_default()
        .hidden = hidden;
    persist_notebook_system(&notebook_id, &state, &file)
}

/// Write the MRU pinned list for one parent. An empty list removes that key.
#[tauri::command]
pub fn set_tag_system_pinned(
    notebook_id: String,
    parent_id: String,
    pinned: Vec<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let mut file = load_notebook_system(&notebook_id, &state)?;
    let notebook = file.tag.notebooks.entry(notebook_id.clone()).or_default();
    let key = if parent_id.is_empty() {
        ""
    } else {
        parent_id.as_str()
    };
    if pinned.is_empty() {
        notebook.pinned_by_parent.remove(key);
    } else {
        notebook.pinned_by_parent.insert(key.to_string(), pinned);
    }
    persist_notebook_system(&notebook_id, &state, &file)
}

fn notebook_root(notebook_id: &str, state: &State<AppState>) -> Result<PathBuf, String> {
    state
        .memo_file
        .read()
        .map_err(|_| "memo file lock poisoned".to_string())?
        .get_notebook_config_by_id(notebook_id)
        .map(|config| PathBuf::from(config.path))
        .ok_or_else(|| format!("notebook not found: {notebook_id}"))
}

fn load_notebook_system(notebook_id: &str, state: &State<AppState>) -> Result<SystemFile, String> {
    let root = notebook_root(notebook_id, state)?;
    if let Some(file) =
        crate::system_data::SystemData::read_notebook(&root).map_err(|error| error.to_string())?
    {
        return Ok(file);
    }
    let legacy = state.system_data.get_tag_metadata(notebook_id);
    let mut notebooks = HashMap::new();
    notebooks.insert(notebook_id.to_string(), legacy);
    let file = SystemFile {
        tag: TagSystemData { notebooks },
        featured_notes: Default::default(),
        custom_views: Default::default(),
        file_tree: Default::default(),
    };
    crate::system_data::SystemData::write_notebook(&root, &file)
        .map_err(|error| error.to_string())?;
    Ok(file)
}

/// Read notebook-scoped custom note views from `<notebook>/.flowix/system.json`.
#[tauri::command]
pub fn get_custom_views(
    notebook_id: String,
    state: State<AppState>,
) -> Result<NotebookCustomViewsData, String> {
    let file = load_notebook_system(&notebook_id, &state)?;
    Ok(file
        .custom_views
        .notebooks
        .get(&notebook_id)
        .cloned()
        .unwrap_or_default())
}

/// Replace a notebook's custom view list atomically with the rest of its metadata.
#[tauri::command]
pub fn set_custom_views(
    notebook_id: String,
    views: NotebookCustomViewsData,
    state: State<AppState>,
) -> Result<(), String> {
    for filter in &views.filters {
        if !CUSTOM_VIEW_ALLOWED_OPERATORS.contains(&filter.operator.as_str()) {
            return Err(format!("unsupported custom view operator: {}", filter.operator));
        }
    }
    let mut file = load_notebook_system(&notebook_id, &state)?;
    file.custom_views
        .notebooks
        .insert(notebook_id.clone(), views);
    persist_notebook_system(&notebook_id, &state, &file)
}

#[tauri::command]
pub fn get_notebook_file_tree_preferences(
    notebook_id: String,
    state: State<AppState>,
) -> Result<NotebookFileTreePreferences, String> {
    let file = load_notebook_system(&notebook_id, &state)?;
    Ok(file
        .file_tree
        .notebooks
        .get(&notebook_id)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
pub fn set_notebook_file_tree_section_order(
    notebook_id: String,
    section_order: Vec<String>,
    hidden_sections: Option<Vec<String>>,
    state: State<AppState>,
) -> Result<(), String> {
    if section_order.len() != FILE_TREE_SECTIONS.len()
        || section_order.iter().any(|section| !FILE_TREE_SECTIONS.contains(&section.as_str()))
        || FILE_TREE_SECTIONS
            .iter()
            .any(|section| section_order.iter().filter(|item| item.as_str() == *section).count() != 1)
    {
        return Err("file tree section order must contain agents, pinned, views, files, and repositories once each".to_string());
    }
    if let Some(hidden) = &hidden_sections {
        if hidden.iter().any(|section| !FILE_TREE_SECTIONS.contains(&section.as_str()))
            || FILE_TREE_SECTIONS
                .iter()
                .any(|section| hidden.iter().filter(|item| item.as_str() == *section).count() > 1)
        {
            return Err("invalid file tree hidden sections".to_string());
        }
    }
    let mut file = load_notebook_system(&notebook_id, &state)?;
    let previous_hidden = file.file_tree.notebooks.get(&notebook_id)
        .map(|preferences| preferences.hidden_sections.clone())
        .unwrap_or_default();
    file.file_tree.notebooks.insert(
        notebook_id.clone(),
        NotebookFileTreePreferences {
            section_order,
            hidden_sections: hidden_sections.unwrap_or(previous_hidden),
        },
    );
    persist_notebook_system(&notebook_id, &state, &file)
}

fn persist_notebook_system(
    notebook_id: &str,
    state: &State<AppState>,
    file: &SystemFile,
) -> Result<(), String> {
    let root = notebook_root(notebook_id, state)?;
    crate::system_data::SystemData::write_notebook(&root, file).map_err(|error| error.to_string())
}

/// 读取某笔记本的「常用笔记」筛选条件。
///
/// 未配置过时返回空条件列表, 由前端回落到默认条件 —— 这里不替前端决定默认值,
/// 避免两端各写一份默认配置而漂移。
#[tauri::command]
pub fn get_featured_note_filter(
    notebook_id: String,
    state: State<AppState>,
) -> Result<NotebookFeaturedNotesData, String> {
    let file = load_notebook_system(&notebook_id, &state)?;
    Ok(file
        .featured_notes
        .notebooks
        .get(&notebook_id)
        .cloned()
        .unwrap_or_default())
}

/// 写入某笔记本的「常用笔记」筛选配置。
///
/// 校验放在后端: 写入端是自由文本输入, 只有 operator 是枚举, 非法值会让前端
/// 的匹配逻辑落到 `equals` 分支以外的未定义行为。这里逐条拒绝非法 operator,
/// 而不是静默改写 —— 静默改写会掩盖前端 bug。
#[tauri::command]
pub fn set_featured_note_filter(
    notebook_id: String,
    filter: NotebookFeaturedNotesData,
    state: State<AppState>,
) -> Result<(), String> {
    for condition in &filter.conditions {
        if !FEATURED_NOTES_ALLOWED_OPERATORS.contains(&condition.operator.as_str()) {
            return Err(format!("unsupported operator: {}", condition.operator));
        }
    }
    let mut file = load_notebook_system(&notebook_id, &state)?;
    file.featured_notes
        .notebooks
        .insert(notebook_id.clone(), filter);
    persist_notebook_system(&notebook_id, &state, &file)
}
