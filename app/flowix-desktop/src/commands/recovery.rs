use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::runtime_log;

fn recovery_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Mutex::default)
}

fn recovery_dir() -> PathBuf {
    runtime_log::app_data_dir().join("recovery-drafts")
}

fn recovery_path(identity_key: &str) -> PathBuf {
    let digest = format!("{:x}", Sha256::digest(identity_key.as_bytes()));
    recovery_dir().join(format!("{digest}.json"))
}

#[tauri::command]
pub async fn write_recovery_draft(identity_key: String, draft: Value) -> Result<bool, String> {
    crate::document_io::run("write_recovery_draft", move || {
        let _guard = recovery_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if identity_key.trim().is_empty() {
            return Err("recovery identity is empty".to_string());
        }
        if draft.get("revision").and_then(Value::as_u64).is_none() {
            return Err("recovery revision is missing".to_string());
        }
        let dir = recovery_dir();
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec_pretty(&draft).map_err(|error| error.to_string())?;
        flowix_core::memo_file::atomic_write_bytes(&recovery_path(&identity_key), &bytes)
            .map_err(|error| error.to_string())?;
        Ok(true)
    })
    .await?
}

#[tauri::command]
pub async fn read_recovery_draft(identity_key: String) -> Result<Option<Value>, String> {
    crate::document_io::run("read_recovery_draft", move || {
        let _guard = recovery_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let path = recovery_path(&identity_key);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| error.to_string())
    })
    .await?
}

#[tauri::command]
pub async fn clear_recovery_draft_through(
    identity_key: String,
    saved_revision: u64,
) -> Result<bool, String> {
    crate::document_io::run("clear_recovery_draft_through", move || {
        let _guard = recovery_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let path = recovery_path(&identity_key);
        if !path.exists() {
            return Ok(false);
        }
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        let draft: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let draft_revision = draft
            .get("revision")
            .and_then(Value::as_u64)
            .ok_or_else(|| "recovery revision is missing".to_string())?;
        if draft_revision > saved_revision {
            return Ok(false);
        }
        fs::remove_file(path).map_err(|error| error.to_string())?;
        Ok(true)
    })
    .await?
}

#[tauri::command]
pub async fn list_recovery_drafts() -> Result<Vec<Value>, String> {
    crate::document_io::run("list_recovery_drafts", move || {
        let _guard = recovery_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let dir = recovery_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut drafts = Vec::new();
        for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            if let Ok(draft) = serde_json::from_slice(&bytes) {
                drafts.push(draft);
            }
        }
        Ok(drafts)
    })
    .await?
}
