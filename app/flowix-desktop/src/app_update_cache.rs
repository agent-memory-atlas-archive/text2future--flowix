use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fmt::Write as _,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::Update;

#[derive(Clone)]
pub(super) struct PreparedUpdate {
    pub(super) update: Update,
    pub(super) package_path: PathBuf,
}

fn update_cache_location(app: &AppHandle, update: &Update) -> Result<PathBuf, String> {
    let mut hasher = Sha256::new();
    for value in [
        update.target.as_str(),
        update.version.as_str(),
        update.download_url.as_str(),
        update.signature.as_str(),
    ] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    let mut package_key = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(package_key, "{byte:02x}");
    }

    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("failed to locate application cache directory: {error}"))?
        .join("app-updates");
    Ok(directory.join(format!("update-{package_key}.bundle")))
}

pub(super) fn verify_cached_package(
    app: &AppHandle,
    update: &Update,
    bytes: &[u8],
) -> Result<(), String> {
    use base64::Engine as _;

    let encoded_key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            "updater public key is missing from application configuration".to_string()
        })?;
    let key_text = base64::engine::general_purpose::STANDARD
        .decode(encoded_key)
        .map_err(|error| format!("failed to decode updater public key: {error}"))?;
    let key_text = std::str::from_utf8(&key_text)
        .map_err(|error| format!("updater public key is not valid UTF-8: {error}"))?;
    let public_key = minisign_verify::PublicKey::decode(key_text)
        .map_err(|error| format!("failed to parse updater public key: {error}"))?;

    let signature_text = base64::engine::general_purpose::STANDARD
        .decode(&update.signature)
        .map_err(|error| format!("failed to decode update signature: {error}"))?;
    let signature_text = std::str::from_utf8(&signature_text)
        .map_err(|error| format!("update signature is not valid UTF-8: {error}"))?;
    let signature = minisign_verify::Signature::decode(signature_text)
        .map_err(|error| format!("failed to parse update signature: {error}"))?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|error| format!("cached update signature verification failed: {error}"))
}

async fn remove_old_update_packages(directory: &std::path::Path, keep: &std::path::Path) {
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path != keep {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

pub(super) async fn prepare_update_package(
    app: &AppHandle,
    mut update: Update,
    report_progress: bool,
) -> Result<PreparedUpdate, String> {
    // Package downloads need a larger budget than the manifest request, but
    // must still release the check/install lock if the server stops responding.
    update.timeout = Some(std::time::Duration::from_secs(10 * 60));
    let package_path = update_cache_location(app, &update)?;
    let directory = package_path
        .parent()
        .ok_or_else(|| "application update cache path has no parent directory".to_string())?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("failed to create application update cache: {error}"))?;

    match tokio::fs::read(&package_path).await {
        Ok(bytes) if verify_cached_package(app, &update, &bytes).is_ok() => {
            remove_old_update_packages(directory, &package_path).await;
            return Ok(PreparedUpdate {
                update,
                package_path,
            });
        }
        Ok(_) => {
            let _ = tokio::fs::remove_file(&package_path).await;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("failed to read cached application update: {error}"));
        }
    }

    let partial_path = package_path.with_extension("part");
    let _ = tokio::fs::remove_file(&partial_path).await;
    let downloaded_bytes = Arc::new(AtomicU64::new(0));
    let started = Arc::new(AtomicBool::new(false));
    let progress_app = report_progress.then(|| app.clone());
    let chunk_app = progress_app.clone();
    let chunk_bytes = downloaded_bytes.clone();
    let chunk_started = started.clone();
    let finish_bytes = downloaded_bytes.clone();
    let bytes = update
        .download(
            move |chunk_length, content_length| {
                let Some(progress_app) = chunk_app.as_ref() else {
                    return;
                };
                if !chunk_started.swap(true, Ordering::Relaxed) {
                    let _ = progress_app.emit(
                        "app-update-progress",
                        json!({ "phase": "started", "contentLength": content_length }),
                    );
                }
                let downloaded = chunk_bytes.fetch_add(chunk_length as u64, Ordering::Relaxed)
                    + chunk_length as u64;
                let _ = progress_app.emit(
                    "app-update-progress",
                    json!({
                        "phase": "progress",
                        "downloadedBytes": downloaded,
                        "contentLength": content_length,
                    }),
                );
            },
            move || {
                if let Some(progress_app) = progress_app.as_ref() {
                    let _ = progress_app.emit(
                        "app-update-progress",
                        json!({
                            "phase": "finished",
                            "downloadedBytes": finish_bytes.load(Ordering::Relaxed),
                        }),
                    );
                }
            },
        )
        .await
        .map_err(|error| format!("failed to download update: {error}"))?;

    // `Update::download` verifies the signature. Verify here as well so the
    // same rule applies to freshly downloaded and previously cached bytes.
    verify_cached_package(app, &update, &bytes)?;
    tokio::fs::write(&partial_path, &bytes)
        .await
        .map_err(|error| format!("failed to write cached application update: {error}"))?;
    if let Err(error) = tokio::fs::rename(&partial_path, &package_path).await {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return Err(format!(
            "failed to publish cached application update: {error}"
        ));
    }
    remove_old_update_packages(directory, &package_path).await;

    Ok(PreparedUpdate {
        update,
        package_path,
    })
}
