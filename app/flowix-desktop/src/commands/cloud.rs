use std::collections::{HashMap, HashSet};
mod coordinator;
mod deletion;
mod local_adapter;
pub(crate) use coordinator::{
    schedule_notebook_sync, schedule_notebook_sync_observation, start_cloud_sync_polling,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::Utc;
use flowix_core::memo_file::{
    atomic_write_bytes, notebook_path_from_relative, resolve_filename_conflict,
    sanitize_filename_component, IsMd, MergeOverrides, CANONICAL_FRONTMATTER_KEY,
};
use flowix_sync::{
    collect_v2_attachments, v2_content_hash, v2_local_content_diverged, CloudCheckout,
    CloudMembership, CloudNotebook, CloudProduct, CloudState, SyncError, V2AccountSyncReport,
    V2LocalNote, V2LocalNotebook, V2RemoteApply, V2SyncedNotebook,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::app::state::AppState;
use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncResult {
    pub notebooks: usize,
    pub uploaded: usize,
    pub deleted: usize,
    pub downloaded: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    pub notebook_id: String,
    pub run_id: String,
    pub state: String,
    pub phase: String,
    pub uploaded: usize,
    pub deleted: usize,
    pub downloaded: usize,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
}

impl CloudSyncStatus {
    fn new(notebook_id: &str, run_id: &str, state: &str, phase: &str, started_at: i64) -> Self {
        Self {
            notebook_id: notebook_id.to_string(),
            run_id: run_id.to_string(),
            state: state.to_string(),
            phase: phase.to_string(),
            uploaded: 0,
            deleted: 0,
            downloaded: 0,
            started_at,
            finished_at: None,
            last_error: None,
        }
    }
}

fn sync_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn cloud_error(error: SyncError) -> String {
    match error {
        SyncError::Api { code, details, .. }
            if code == "MEMBERSHIP_REQUIRED" || code == "STORAGE_QUOTA_EXCEEDED" =>
        {
            format!("{code}:{}", details.unwrap_or(serde_json::Value::Null))
        }
        other => other.to_string(),
    }
}

fn emit_sync_status(app: &AppHandle, status: &CloudSyncStatus) {
    let _ = app.emit("cloud-sync-status-changed", status);
}

fn emit_cloud_state(app: &AppHandle, state: &CloudState) {
    let _ = app.emit("cloud-state-changed", state);
}

fn persist_rotated_token(state: &AppState) -> Result<(), String> {
    state.cloud_sync.with_current_refresh_token(|token| {
        if let Some(token) = token {
            state
                .user_config
                .save_cloud_refresh_token(token)
                .map_err(sync_error)?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn cloud_get_state(state: State<AppState>) -> Result<CloudState, String> {
    state.cloud_sync.state().map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_register(
    email: String,
    password: String,
    display_name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    state
        .cloud_sync
        .register(email.trim(), &password, display_name.trim())
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_login(
    email: String,
    password: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    state
        .cloud_sync
        .login(email.trim(), &password)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_sign_in_with_apple(
    window: WebviewWindow,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    state
        .cloud_sync
        .sign_in_with_apple(&authorization)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_link_apple(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    let next_state = state
        .cloud_sync
        .link_apple(&authorization)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_logout(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let logout_result = state
        .cloud_sync
        .logout_with_cleanup(|| {
            state
                .user_config
                .delete_cloud_refresh_token()
                .map_err(|error| SyncError::InvalidState(error.to_string()))
        })
        .await
        .map_err(sync_error);
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    logout_result?;
    Ok(next_state)
}

#[tauri::command]
pub fn cloud_set_enabled(
    enabled: bool,
    state: State<AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let next_state = state.cloud_sync.set_enabled(enabled).map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub fn cloud_get_notebook_state(
    notebook_id: String,
    state: State<AppState>,
) -> Result<Option<V2SyncedNotebook>, String> {
    state
        .cloud_sync
        .v2_notebook(&notebook_id)
        .map_err(sync_error)
}

#[tauri::command]
pub fn cloud_list_notebook_states(state: State<AppState>) -> Result<Vec<V2SyncedNotebook>, String> {
    state.cloud_sync.v2_enabled_notebooks().map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_notebooks(
    state: State<'_, AppState>,
) -> Result<Vec<CloudNotebook>, String> {
    let notebooks_result = state.cloud_sync.v2_remote_notebooks().await;
    persist_rotated_token(state.inner())?;
    notebooks_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_link_notebook(
    notebook_id: String,
    cloud_notebook_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<V2SyncedNotebook, String> {
    if notebook_id != cloud_notebook_id {
        return Err("CLOUD_NOTEBOOK_ID_MISMATCH".to_string());
    }
    let config = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let link_result = state.cloud_sync.set_v2_notebook_enabled(
        &V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        },
        true,
    );
    persist_rotated_token(state.inner())?;
    let link = link_result.map_err(cloud_error)?;
    if let Ok(next_state) = state.cloud_sync.state() {
        emit_cloud_state(&app, &next_state);
    }
    Ok(link)
}

#[tauri::command]
pub async fn cloud_set_notebook_enabled(
    notebook_id: String,
    enabled: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<V2SyncedNotebook, String> {
    let config = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let link_result = state.cloud_sync.set_v2_notebook_enabled(
        &V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        },
        enabled,
    );
    persist_rotated_token(state.inner())?;
    let link = link_result.map_err(cloud_error)?;
    if let Ok(next_state) = state.cloud_sync.state() {
        emit_cloud_state(&app, &next_state);
    }
    Ok(link)
}

#[tauri::command]
pub async fn cloud_refresh_membership(
    state: State<'_, AppState>,
) -> Result<CloudMembership, String> {
    let membership_result = state.cloud_sync.refresh_membership().await;
    persist_rotated_token(state.inner())?;
    membership_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_products(state: State<'_, AppState>) -> Result<Vec<CloudProduct>, String> {
    state.cloud_sync.products().await.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_create_checkout(
    product_id: String,
    state: State<'_, AppState>,
) -> Result<CloudCheckout, String> {
    let idempotency_key = format!("desktop-{}", uuid::Uuid::new_v4());
    let checkout_result = state
        .cloud_sync
        .create_checkout(&product_id, &idempotency_key)
        .await;
    persist_rotated_token(state.inner())?;
    checkout_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_sync_now(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<CloudSyncResult, String> {
    coordinator::sync_now(notebook_id, app).await
}
