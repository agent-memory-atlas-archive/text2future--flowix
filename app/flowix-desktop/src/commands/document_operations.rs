use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Operation {
    Pending,
    Complete { result: Value },
    Failed { error: String },
    Missing,
}
fn receipts() -> &'static Mutex<HashMap<String, Operation>> {
    static RECEIPTS: OnceLock<Mutex<HashMap<String, Operation>>> = OnceLock::new();
    RECEIPTS.get_or_init(Mutex::default)
}
fn key(window: &str, operation: &str) -> String {
    format!("{window}:{operation}")
}

pub async fn run<T: Send + Serialize + 'static>(
    name: &'static str,
    operation_id: Option<String>,
    window: String,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let started = std::time::Instant::now();
    let key = operation_id.map(|id| key(&window, &id));
    if let Some(key) = &key {
        let mut receipts = receipts().lock().unwrap_or_else(|e| e.into_inner());
        if receipts.contains_key(key) {
            return Err("DOCUMENT_OPERATION_ALREADY_SUBMITTED".into());
        }
        receipts.insert(key.clone(), Operation::Pending);
    }
    let outcome = crate::document_io::run(name, work)
        .await
        .and_then(|result| result);
    if let Some(key) = key {
        tracing::debug!(operation = name, operation_id = %key, elapsed_ms = started.elapsed().as_millis(), success = outcome.is_ok(), "document operation settled");
        let receipt = match &outcome {
            Ok(result) => match serde_json::to_value(result) {
                Ok(result) => Operation::Complete { result },
                Err(error) => Operation::Failed {
                    error: error.to_string(),
                },
            },
            Err(error) => Operation::Failed {
                error: error.clone(),
            },
        };
        let mut receipts = receipts().lock().unwrap_or_else(|e| e.into_inner());
        if receipts.contains_key(&key) {
            receipts.insert(key, receipt);
        }
    }
    outcome
}

#[tauri::command]
pub fn document_operation_status(window: tauri::WebviewWindow, operation_id: String) -> Operation {
    receipts()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key(window.label(), &operation_id))
        .cloned()
        .unwrap_or(Operation::Missing)
}

#[tauri::command]
pub fn acknowledge_document_operation(window: tauri::WebviewWindow, operation_id: String) {
    let mut receipts = receipts().lock().unwrap_or_else(|e| e.into_inner());
    let key = key(window.label(), &operation_id);
    if !matches!(receipts.get(&key), Some(Operation::Pending)) {
        receipts.remove(&key);
    }
}

pub fn forget_window(label: &str) {
    receipts()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|key, _| !key.starts_with(&format!("{label}:")));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn records_an_outcome_and_never_reexecutes_the_same_operation() {
        let calls = Arc::new(AtomicUsize::new(0));
        let first = calls.clone();
        let result = run(
            "test",
            Some("receipt-1".into()),
            "test-window".into(),
            move || {
                first.fetch_add(1, Ordering::SeqCst);
                Ok("renamed.md".to_owned())
            },
        )
        .await
        .unwrap();
        assert_eq!(result, "renamed.md");
        let second = calls.clone();
        assert!(run(
            "test",
            Some("receipt-1".into()),
            "test-window".into(),
            move || {
                second.fetch_add(1, Ordering::SeqCst);
                Ok("wrong.md".to_owned())
            }
        )
        .await
        .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(matches!(
            receipts().lock().unwrap().get("test-window:receipt-1"),
            Some(Operation::Complete { .. })
        ));
        forget_window("test-window");
        assert!(!receipts()
            .lock()
            .unwrap()
            .contains_key("test-window:receipt-1"));
    }
}
