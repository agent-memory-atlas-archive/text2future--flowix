use serde::Serialize;
use std::sync::Arc;
use tauri::{Manager, State};

use crate::app::startup::StartupStatus;
use crate::app::state::AppState;
use crate::device_registration::DeviceRegistry;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootFeatures {
    pub experimental: bool,
    pub is_introduct_displayed: bool,
    pub is_onboarding_completed: bool,
}

#[tauri::command]
pub fn get_boot_features(registry: State<'_, Arc<DeviceRegistry>>) -> BootFeatures {
    BootFeatures {
        experimental: registry.experimental(),
        is_introduct_displayed: registry.is_introduct_displayed(),
        is_onboarding_completed: registry.is_onboarding_completed(),
    }
}

#[tauri::command]
pub fn set_boot_intro_displayed(registry: State<'_, Arc<DeviceRegistry>>) -> Result<(), String> {
    registry.set_introduct_displayed(true)
}

#[tauri::command]
pub fn set_boot_onboarding_completed(
    registry: State<'_, Arc<DeviceRegistry>>,
) -> Result<(), String> {
    registry.set_onboarding_completed(true)
}

#[tauri::command]
pub fn get_startup_status(state: State<'_, AppState>) -> StartupStatus {
    state.startup.status()
}

#[tauri::command]
pub fn get_startup_notebook_id(state: State<'_, AppState>) -> Option<String> {
    crate::lock_utils::read_lock(&state.memo_file, "memo_file").current_notebook_id_value()
}

#[tauri::command]
pub fn notify_startup_interactive(state: State<'_, AppState>) {
    state.startup.mark_interactive();
}

#[tauri::command]
pub fn record_startup_stage(
    state: State<'_, AppState>,
    stage: String,
    frontend_elapsed_ms: u64,
    startup_attempt_id: String,
) {
    const ALLOWED: &[&str] = &[
        "native-ready",
        "notebook-selected",
        "first-memo-query-ready",
        "workspace-restored",
        "initial-document-settled",
        "initial-document-skipped",
        "initial-document-superseded",
        "initial-document-timeout",
        "first-workspace-paint",
    ];
    if !ALLOWED.contains(&stage.as_str()) {
        return;
    }
    if startup_attempt_id.len() > 64 || !startup_attempt_id.is_ascii() {
        return;
    }
    crate::runtime_log::record_event(
        "info",
        "startup.stage",
        serde_json::json!({
            "stage": stage,
            "source": "frontend",
            "elapsedMs": state.startup.elapsed_ms(),
            "frontendElapsedMs": frontend_elapsed_ms,
            "startupAttemptId": startup_attempt_id,
        })
        .to_string(),
    );
}

#[tauri::command]
pub async fn wait_for_startup_ready(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().startup.wait_until_ready())
        .await
        .map_err(|error| format!("startup wait task failed: {error}"))?
}
