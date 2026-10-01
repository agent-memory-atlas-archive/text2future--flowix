//! Notebook-scoped, time ordered document catalog for the folder card view.
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{app::state::AppState, lock_utils::read_lock};
use flowix_core::memo_file::FileManagementPolicy;

const CATALOG_VERSION: &str = "5";
const DEFAULT_LIMIT: usize = 48;
const MAX_LIMIT: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPageFilter {
    pub document_type: String,
    pub key: String,
    pub operator: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPageRequest {
    pub notebook_id: String,
    pub folder_path: String,
    #[serde(default)]
    pub resource_kinds: Vec<String>,
    pub custom_filter: Option<DocumentPageFilter>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    #[serde(default)]
    pub refresh_directories: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPageItem {
    pub full_path: String,
    pub name: String,
    pub resource_kind: String,
    pub size_bytes: Option<u64>,
    pub modified_ms: Option<u64>,
    pub created_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPage {
    pub folders: Vec<DocumentPageItem>,
    pub items: Vec<DocumentPageItem>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

fn ignored(relative: &Path, directory: bool) -> bool {
    let _ = directory;
    FileManagementPolicy::default().is_ignored(relative)
}

fn kind(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "md" | "markdown" => "note",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "ico" | "tif"
        | "tiff" | "heic" => "image",
        "3gp" | "avi" | "flv" | "m2ts" | "m4v" | "mkv" | "mov" | "mp4" | "mpeg" | "mpg" | "mts"
        | "webm" | "wmv" => "video",
        _ => "other",
    }
}

fn setup(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS document_list_entries (
        relative_path TEXT PRIMARY KEY, kind TEXT NOT NULL, modified_ms INTEGER NOT NULL,
        created_ms INTEGER, size_bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_list_order ON document_list_entries(modified_ms DESC, relative_path ASC);
    CREATE INDEX IF NOT EXISTS idx_document_list_kind_order ON document_list_entries(kind, modified_ms DESC, relative_path ASC);
    CREATE TABLE IF NOT EXISTS document_list_memberships (
        scope_path TEXT NOT NULL, relative_path TEXT NOT NULL, modified_ms INTEGER NOT NULL,
        PRIMARY KEY(scope_path, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_document_list_scope_order ON document_list_memberships(scope_path, modified_ms DESC, relative_path ASC);
    CREATE TABLE IF NOT EXISTS media_resources (
        id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('image', 'video')), size_bytes INTEGER NOT NULL, modified_ms INTEGER NOT NULL,
        fingerprint TEXT, properties TEXT NOT NULL DEFAULT '{}', properties_revision INTEGER NOT NULL DEFAULT 0,
        missing_since INTEGER, deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(notebook_id, relative_path)
    );
    CREATE TABLE IF NOT EXISTS document_list_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .map_err(|error| error.to_string())
}

fn insert_file(
    conn: &Connection,
    root: &Path,
    path: &Path,
    policy: &FileManagementPolicy,
) -> Result<(), String> {
    let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
    if policy.is_ignored_at(root, relative) {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() {
        return Ok(());
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as i64);
    let created = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64);
    let relative = relative.to_string_lossy().replace('\\', "/");
    conn.execute("INSERT INTO document_list_entries(relative_path, kind, modified_ms, created_ms, size_bytes)
        VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(relative_path) DO UPDATE SET
        kind=excluded.kind, modified_ms=excluded.modified_ms, created_ms=excluded.created_ms, size_bytes=excluded.size_bytes",
        params![relative, kind(path), modified, created, metadata.len() as i64])
        .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM document_list_memberships WHERE relative_path=?1",
        [&relative],
    )
    .map_err(|error| error.to_string())?;
    let scope = relative.rsplit_once('/').map_or("", |(parent, _)| parent);
    conn.execute("INSERT INTO document_list_memberships(scope_path, relative_path, modified_ms) VALUES(?1, ?2, ?3)", params![scope, relative, modified])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn scan_subtree(conn: &Connection, root: &Path, folder: &Path) -> Result<(), String> {
    if !folder.is_dir() {
        return Ok(());
    }
    let policy = FileManagementPolicy::from_notebook_root(root);
    for entry in fs::read_dir(folder).map_err(|error| error.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::debug!("skip unreadable document catalog entry: {error}");
                continue;
            }
        };
        if entry.file_type().is_ok_and(|kind| kind.is_file()) {
            if let Err(error) = insert_file(conn, root, &entry.path(), &policy) {
                tracing::debug!(path = %entry.path().display(), "skip document catalog entry: {error}");
            }
        }
    }
    Ok(())
}

fn refresh_subtree(conn: &mut Connection, root: &Path, folder: &Path) -> Result<(), String> {
    let relative = folder
        .strip_prefix(root)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    if relative.is_empty() {
        transaction
            .execute("DELETE FROM document_list_memberships", [])
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM document_list_entries", [])
            .map_err(|error| error.to_string())?;
    } else {
        let pattern = format!(
            "{}/%",
            relative
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        transaction.execute("DELETE FROM document_list_memberships WHERE relative_path=?1 OR relative_path LIKE ?2 ESCAPE '\\'", params![relative, pattern]).map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM document_list_entries WHERE relative_path=?1 OR relative_path LIKE ?2 ESCAPE '\\'",
                params![relative, pattern],
            )
            .map_err(|error| error.to_string())?;
    }
    scan_subtree(&transaction, root, folder)?;
    transaction.commit().map_err(|error| error.to_string())
}

fn decode_cursor(cursor: &str) -> Result<(i64, String), String> {
    let (time, path) = cursor.split_once(':').ok_or("INVALID_CURSOR")?;
    let time = time.parse::<i64>().map_err(|_| "INVALID_CURSOR")?;
    if path.contains('\0') {
        return Err("INVALID_CURSOR".into());
    }
    Ok((time, path.to_owned()))
}

#[tauri::command]
pub async fn list_document_page(
    request: DocumentPageRequest,
    state: State<'_, AppState>,
) -> Result<DocumentPage, String> {
    let notebook = {
        let store = read_lock(&state.memo_file, "memo_file");
        let config = store
            .get_notebook_config_by_id(&request.notebook_id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        (
            PathBuf::from(config.path),
            store
                .notebook_db_path(&request.notebook_id)
                .map_err(|error| error.to_string())?,
        )
    };
    let root = dunce::canonicalize(&notebook.0).map_err(|error| error.to_string())?;
    let folder = dunce::canonicalize(&request.folder_path).map_err(|error| error.to_string())?;
    let policy = FileManagementPolicy::from_notebook_root(&root);
    if !folder.is_dir()
        || !folder.starts_with(&root)
        || folder
            .strip_prefix(&root)
            .is_ok_and(|relative| policy.is_ignored_at(&root, relative))
    {
        return Err("INVALID_NOTEBOOK_FOLDER".into());
    }
    let cursor = request.cursor.as_deref().map(decode_cursor).transpose()?;
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = Connection::open(&notebook.1).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|error| error.to_string())?;
        setup(&conn)?;
        let version: Option<String> = conn.query_row("SELECT value FROM document_list_meta WHERE key='version'", [], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
        let catalog_reset = version.as_deref() != Some(CATALOG_VERSION);
        if catalog_reset {
            refresh_subtree(&mut conn, &root, &root)?;
            conn.execute("INSERT INTO document_list_meta(key,value) VALUES('version',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [CATALOG_VERSION]).map_err(|error| error.to_string())?;
        }
        if cursor.is_none() && !catalog_reset {
            for changed in &request.refresh_directories {
                let changed = Path::new(changed);
                // A deleted directory cannot be canonicalized; its existing parent is refreshed instead.
                let target = if changed.exists() { changed } else { changed.parent().unwrap_or(changed) };
                if let Ok(target) = dunce::canonicalize(target) {
                    if target.starts_with(&root) { refresh_subtree(&mut conn, &root, &target)?; }
                }
            }
            refresh_subtree(&mut conn, &root, &folder)?;
        }
        let mut folders = Vec::new();
        if cursor.is_none() {
            for entry in fs::read_dir(&folder).map_err(|error| error.to_string())? {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => { tracing::debug!("skip unreadable document folder entry: {error}"); continue; }
                };
                if !entry.file_type().is_ok_and(|kind| kind.is_dir()) { continue; }
                let path = entry.path();
                let relative = path.strip_prefix(&root).map_err(|error| error.to_string())?;
                if policy.is_ignored_at(&root, relative) { continue; }
                let metadata = match entry.metadata() {
                    Ok(metadata) => metadata,
                    Err(error) => { tracing::debug!(path = %path.display(), "skip unreadable document folder metadata: {error}"); continue; }
                };
                let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| duration.as_millis() as u64);
                let created = metadata.created().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| duration.as_millis() as u64);
                folders.push(DocumentPageItem {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    full_path: path.to_string_lossy().into_owned(),
                    resource_kind: "folder".into(),
                    size_bytes: None,
                    modified_ms: modified,
                    created_ms: created,
                });
            }
            folders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()).then_with(|| left.name.cmp(&right.name)));
        }
        let prefix = folder.strip_prefix(&root).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/");
        let scope = prefix;
        let kinds_json = serde_json::to_string(&request.resource_kinds).map_err(|error| error.to_string())?;
        let filter_kind = request.custom_filter.as_ref().map(|filter| filter.document_type.as_str());
        let has_property_filter = request.custom_filter.as_ref().is_some_and(|filter| !filter.key.trim().is_empty());
        let property_query = "SELECT e.relative_path, e.kind, e.modified_ms, e.created_ms, e.size_bytes,
                CASE WHEN e.kind='note' THEN n.properties_json ELSE r.properties END
            FROM document_list_memberships m JOIN document_list_entries e ON e.relative_path=m.relative_path
            LEFT JOIN notes n ON e.kind='note' AND n.relative_path=e.relative_path
            LEFT JOIN media_resources r ON e.kind IN ('image','video') AND r.relative_path=e.relative_path
                AND r.notebook_id=?6 AND r.missing_since IS NULL AND r.deleted_at IS NULL
            WHERE m.scope_path=?1
              AND (?2 IS NULL OR m.modified_ms < ?2 OR (m.modified_ms = ?2 AND m.relative_path > ?3))
              AND (?4 = '[]' OR e.kind IN (SELECT value FROM json_each(?4)))
              AND (?5 IS NULL OR e.kind = ?5)
            ORDER BY m.modified_ms DESC, m.relative_path ASC";
        let plain_query = "SELECT e.relative_path, e.kind, e.modified_ms, e.created_ms, e.size_bytes, NULL
            FROM document_list_memberships m JOIN document_list_entries e ON e.relative_path=m.relative_path
            WHERE m.scope_path=?1
              AND (?2 IS NULL OR m.modified_ms < ?2 OR (m.modified_ms = ?2 AND m.relative_path > ?3))
              AND (?4 = '[]' OR e.kind IN (SELECT value FROM json_each(?4)))
              AND (?5 IS NULL OR e.kind = ?5)
            ORDER BY m.modified_ms DESC, m.relative_path ASC";
        let mut statement = conn.prepare(if has_property_filter { property_query } else { plain_query })
            .map_err(|error| error.to_string())?;
        let mut rows = if has_property_filter {
            statement.query(params![scope, cursor.as_ref().map(|value| value.0), cursor.as_ref().map(|value| value.1.as_str()), kinds_json, filter_kind, request.notebook_id])
        } else {
            statement.query(params![scope, cursor.as_ref().map(|value| value.0), cursor.as_ref().map(|value| value.1.as_str()), kinds_json, filter_kind])
        }.map_err(|error| error.to_string())?;
        let mut items = Vec::new();
        let mut last = None;
        let mut has_more = false;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let path: String = row.get(0).map_err(|error| error.to_string())?;
            let resource_kind: String = row.get(1).map_err(|error| error.to_string())?;
            let modified: i64 = row.get(2).map_err(|error| error.to_string())?;
            if let Some(filter) = &request.custom_filter {
                if !filter.key.trim().is_empty() {
                    let properties: Option<String> = row.get(5).map_err(|error| error.to_string())?;
                    let value = properties.as_deref().and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
                        .and_then(|object| object.get(&filter.key).cloned());
                    let Some(value) = value else { continue; };
                    let values: Vec<String> = match value { serde_json::Value::Array(values) => values.into_iter().map(|value| match value { serde_json::Value::String(value) => value, other => other.to_string() }).collect(), serde_json::Value::String(value) => vec![value], other => vec![other.to_string()] };
                    let expected = filter.value.trim();
                    if expected.is_empty() || !values.iter().any(|value| if filter.operator == "contains" { value.to_lowercase().contains(&expected.to_lowercase()) } else { value == expected }) { continue; }
                }
            }
            if items.len() == limit { has_more = true; break; }
            last = Some(format!("{modified}:{path}"));
            let full_path = root.join(Path::new(&path));
            items.push(DocumentPageItem {
                name: full_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                full_path: full_path.to_string_lossy().into_owned(), resource_kind,
                modified_ms: Some(modified.max(0) as u64),
                created_ms: row.get::<_, Option<i64>>(3).map_err(|error| error.to_string())?.map(|value| value.max(0) as u64),
                size_bytes: Some(row.get::<_, i64>(4).map_err(|error| error.to_string())?.max(0) as u64),
            });
        }
        Ok(DocumentPage { folders, next_cursor: if has_more { last } else { None }, has_more, items })
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_skips_managed_and_hidden_trees_but_keeps_user_files() {
        let root = tempfile::tempdir().unwrap();
        for name in [
            "notes",
            "node_modules/pkg",
            "bower_components/pkg",
            "attachments",
            ".hidden",
            "images",
        ] {
            fs::create_dir_all(root.path().join(name)).unwrap();
        }
        for name in [
            "notes/a.md",
            "node_modules/pkg/b.md",
            "bower_components/pkg/b.md",
            "attachments/c.md",
            ".hidden/d.md",
            "images/x.png",
            "Thumbs.db",
            "Desktop.ini",
        ] {
            fs::write(root.path().join(name), b"file").unwrap();
        }
        let conn = Connection::open_in_memory().unwrap();
        setup(&conn).unwrap();
        scan_subtree(&conn, root.path(), root.path()).unwrap();
        let mut statement = conn
            .prepare("SELECT relative_path FROM document_list_entries ORDER BY relative_path")
            .unwrap();
        let paths: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(paths, ["images/x.png", "notes/a.md"]);
        let in_notes: Vec<String> = conn
            .prepare("SELECT relative_path FROM document_list_memberships WHERE scope_path='notes'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(in_notes, ["notes/a.md"]);
    }

    #[test]
    fn refresh_removes_deleted_descendants() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes/deep")).unwrap();
        fs::write(root.path().join("notes/deep/a.md"), b"file").unwrap();
        let mut conn = Connection::open_in_memory().unwrap();
        setup(&conn).unwrap();
        refresh_subtree(&mut conn, root.path(), root.path()).unwrap();
        fs::remove_dir_all(root.path().join("notes/deep")).unwrap();
        refresh_subtree(&mut conn, root.path(), &root.path().join("notes")).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM document_list_entries", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
