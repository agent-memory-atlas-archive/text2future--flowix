use futures::future::{AbortHandle, Abortable};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::Update;
use tauri_plugin_updater::UpdaterExt;

#[path = "app_update_cache.rs"]
mod update_cache;
#[path = "app_update_download.rs"]
mod update_download;
#[path = "app_update_state.rs"]
mod update_state;
use self::update_cache::{prepare_update_package, verify_cached_package, PreparedUpdate};
use self::update_state::UpdatePhase;

#[cfg(target_os = "windows")]
use std::path::PathBuf;

#[derive(Clone, Default)]
pub struct AppUpdateState {
    active: Arc<Mutex<ActiveUpdate>>,
    check_lock: Arc<tokio::sync::Mutex<()>>,
    prepared: Arc<Mutex<Option<PreparedUpdate>>>,
}

#[derive(Default)]
struct ActiveUpdate {
    phase: UpdatePhase,
    abort: Option<AbortHandle>,
}

// Once installing, this guard belongs to the blocking worker. Dropping the
// awaiting command cannot allow another update while that worker is active.
struct ActiveUpdateGuard(Arc<Mutex<ActiveUpdate>>);

impl Drop for ActiveUpdateGuard {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = ActiveUpdate::default();
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notify: bool,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInstallResult {
    pub status: String,
    pub message: Option<String>,
}

/// Read and clear the result left by a quiet Windows NSIS update.
#[tauri::command]
pub fn consume_app_update_result(app: AppHandle) -> Option<AppUpdateInstallResult> {
    #[cfg(target_os = "windows")]
    {
        let path = app_update_result_path()?;
        let content = std::fs::read_to_string(&path).ok()?;
        let target_path = app_update_target_path()?;
        let target_version = std::fs::read_to_string(&target_path)
            .ok()
            .map(|value| value.trim().to_string());
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(target_path);
        let (status, message) = content.trim().split_once('|')?;
        let current_version = app.package_info().version.to_string();
        return match status {
            "success" if target_version.as_deref() == Some(current_version.as_str()) => {
                Some(AppUpdateInstallResult {
                    status: "success".to_string(),
                    message: None,
                })
            }
            "success" => Some(AppUpdateInstallResult {
                status: "failed".to_string(),
                message: Some(format!(
                    "Installer reported success for {}, but Flowix started as {current_version}.",
                    target_version.as_deref().unwrap_or("the requested version")
                )),
            }),
            "failed" => Some(AppUpdateInstallResult {
                status: "failed".to_string(),
                message: (!message.is_empty()).then(|| message.to_string()),
            }),
            "pending" => Some(AppUpdateInstallResult {
                status: "failed".to_string(),
                message: Some(format!(
                    "Installer did not report a completed update to {message}; Flowix started as {current_version}."
                )),
            }),
            _ => None,
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        None
    }
}

#[cfg(target_os = "windows")]
fn app_update_result_path() -> Option<PathBuf> {
    crate::runtime_state::windows_state_dir()
        .ok()
        .map(|path| path.join("app-update-result.txt"))
}

#[cfg(target_os = "windows")]
fn app_update_target_path() -> Option<PathBuf> {
    crate::runtime_state::windows_state_dir()
        .ok()
        .map(|path| path.join("app-update-target.txt"))
}

#[cfg(target_os = "windows")]
fn write_pending_app_update_result(version: &str) -> Result<(), String> {
    let target_path =
        app_update_target_path().ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
    let parent = target_path
        .parent()
        .ok_or_else(|| "update target path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create update target directory: {error}"))?;
    std::fs::write(target_path, version)
        .map_err(|error| format!("failed to persist update target version: {error}"))?;
    write_app_update_result("pending", version)
}

#[cfg(target_os = "windows")]
fn write_app_update_result(status: &str, message: &str) -> Result<(), String> {
    let path = app_update_result_path().ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "update result path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create update result directory: {error}"))?;
    std::fs::write(path, format!("{status}|{message}\n"))
        .map_err(|error| format!("failed to persist update result: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn write_pending_app_update_result(_version: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn write_app_update_result(_status: &str, _message: &str) -> Result<(), String> {
    Ok(())
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = match std::env::consts::OS {
        "macos" => "https://download.flowix.cc/updater/macos/latest.json",
        "windows" => "https://download.flowix.cc/updater/windows/latest.json",
        "linux" => "https://download.flowix.cc/updater/linux/latest.json",
        platform => return Err(format!("unsupported updater platform: {platform}")),
    };
    let endpoint = url::Url::parse(endpoint)
        .map_err(|error| format!("failed to parse updater endpoint: {error}"))?;
    app.updater_builder()
        .timeout(std::time::Duration::from_secs(30))
        .endpoints(vec![endpoint])
        .map_err(|error| format!("failed to configure updater endpoint: {error}"))?
        .build()
        .map_err(|error| format!("failed to initialize updater: {error}"))
}

fn update_info(update: &Update) -> AppUpdateInfo {
    AppUpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        // Unknown manifest fields are preserved by tauri-plugin-updater in
        // raw_json. Keep notifications enabled for older manifests.
        notify: update
            .raw_json
            .get("notify")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        date: update.date.as_ref().map(|date| date.to_string()),
        body: update.body.clone(),
    }
}

fn ensure_update_is_idle(state: &AppUpdateState) -> Result<(), String> {
    let active = state
        .active
        .lock()
        .map_err(|_| "application update state is unavailable".to_string())?;
    if active.phase == UpdatePhase::Idle {
        Ok(())
    } else {
        Err("an application update is already in progress".to_string())
    }
}

async fn download_requested_update(
    app: &AppHandle,
    prepared_state: &Arc<Mutex<Option<PreparedUpdate>>>,
    version: &str,
) -> Result<(Update, Vec<u8>), String> {
    let update = updater(app)?
        .check()
        .await
        .map_err(|error| format!("failed to check for update: {error}"))?
        .ok_or_else(|| "no application update is available".to_string())?;
    if update.version != version {
        return Err(format!("requested update {version} is no longer available"));
    }

    let prepared = prepare_update_package(app, update, true).await?;
    let bytes = tokio::fs::read(&prepared.package_path)
        .await
        .map_err(|error| format!("failed to read prepared application update: {error}"))?;
    verify_cached_package(app, &prepared.update, &bytes)?;
    *prepared_state
        .lock()
        .map_err(|_| "application update state is unavailable".to_string())? =
        Some(prepared.clone());
    Ok((prepared.update, bytes))
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<Option<AppUpdateInfo>, String> {
    ensure_update_is_idle(state.inner())?;
    let _check_guard = state.check_lock.lock().await;
    ensure_update_is_idle(state.inner())?;

    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("failed to check for update: {error}"))?;
    let Some(update) = update else {
        *state
            .prepared
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())? = None;
        return Ok(None);
    };

    Ok(Some(update_info(&update)))
}

/// Download and verify without installing or restarting the application.
#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    version: String,
    state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())?;
        if !active.phase.start() {
            return Err("an application update is already in progress".to_string());
        }
        active.abort = Some(abort_handle);
    }
    let _guard = ActiveUpdateGuard(state.active.clone());
    let task = async {
        let _check_guard = state.check_lock.lock().await;
        download_requested_update(&app, &state.prepared, &version).await?;
        Ok::<_, String>(())
    };
    Abortable::new(task, abort_registration)
        .await
        .map_err(|_| "application update cancelled".to_string())?
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    version: String,
    state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())?;
        if !active.phase.start() {
            return Err("an application update is already in progress".to_string());
        }
        active.abort = Some(abort_handle);
    }
    let active_guard = ActiveUpdateGuard(state.active.clone());

    let download_app = app.clone();
    let check_lock = state.check_lock.clone();
    let prepared_state = state.prepared.clone();
    let task = async move {
        let (update, bytes) = {
            let _check_guard = check_lock.lock().await;
            let prepared = prepared_state
                .lock()
                .map_err(|_| "application update state is unavailable".to_string())?
                .clone()
                .filter(|prepared| prepared.update.version == version);

            if let Some(prepared) = prepared {
                if let Ok(bytes) = tokio::fs::read(&prepared.package_path).await {
                    if verify_cached_package(&download_app, &prepared.update, &bytes).is_ok() {
                        (prepared.update, bytes)
                    } else {
                        let _ = tokio::fs::remove_file(&prepared.package_path).await;
                        *prepared_state
                            .lock()
                            .map_err(|_| "application update state is unavailable".to_string())? =
                            None;
                        download_requested_update(&download_app, &prepared_state, &version).await?
                    }
                } else {
                    download_requested_update(&download_app, &prepared_state, &version).await?
                }
            } else {
                download_requested_update(&download_app, &prepared_state, &version).await?
            }
        };

        verify_cached_package(&download_app, &update, &bytes)?;

        #[cfg(windows)]
        let document_guard =
            crate::commands::window_shutdown::prepare_for_update(&download_app).await?;
        #[cfg(not(windows))]
        let document_guard = ();
        Ok::<_, String>((update, bytes, document_guard))
    };

    let (update, bytes, document_guard) = Abortable::new(task, abort_registration)
        .await
        .map_err(|_| "application update cancelled".to_string())??;
    {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())?;
        // The cancel command uses this same mutex. A cancellation that won
        // just after the handshake must still prevent runtime teardown.
        if !active.phase.begin_install() {
            return Err("application update cancelled".to_string());
        }
        active.abort = None;
    }
    let _ = app.emit(
        "app-update-progress",
        json!({ "phase": "installing", "downloadedBytes": bytes.len() }),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let _active_guard = active_guard;
        let _document_guard = document_guard;
        // Persist before teardown so a filesystem error leaves runtimes usable.
        write_pending_app_update_result(&update.version)?;
        #[cfg(windows)]
        let _runtime_guard = crate::app::bootstrap::prepare_for_update(&app);
        match update.install(bytes) {
            Ok(()) => Ok(()),
            Err(error) => {
                let message = format!("failed to install update: {error}");
                let _ = write_app_update_result("failed", &message);
                Err(message)
            }
        }
    })
    .await
    .map_err(|error| format!("failed to prepare or install Flowix update: {error}"))?
}

#[tauri::command]
pub fn cancel_app_update(state: State<'_, AppUpdateState>) -> Result<bool, String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "application update state is unavailable".to_string())?;
    if active.phase.cancel() {
        if let Some(handle) = active.abort.as_ref() {
            handle.abort();
        }
        return Ok(true);
    }
    Ok(false)
}
