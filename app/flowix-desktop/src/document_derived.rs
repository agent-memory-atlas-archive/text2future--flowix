//! One coalescing worker for derived search/version work, outside save receipts.
//! Search reads the latest file; auto-versions use an immutable committed body.
use crate::{app::state::AppState, lock_utils::read_lock};
use flowix_core::MemoService;
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

struct Job {
    app: AppHandle,
    memo_id: String,
    version_content: Option<String>,
}
#[derive(Default)]
struct Pending {
    running: bool,
    jobs: BTreeMap<String, Job>,
}
fn pending() -> &'static Mutex<Pending> {
    static PENDING: OnceLock<Mutex<Pending>> = OnceLock::new();
    PENDING.get_or_init(Mutex::default)
}

pub fn schedule(app: &AppHandle, memo_id: &str, content: Option<&str>) {
    let mut state = pending().lock().unwrap_or_else(|e| e.into_inner());
    let job = state.jobs.entry(memo_id.into()).or_insert_with(|| Job {
        app: app.clone(),
        memo_id: memo_id.into(),
        version_content: None,
    });
    // A rename/index refresh must not erase a queued committed body version.
    if let Some(content) = content {
        job.version_content = Some(content.into());
    }
    if state.running {
        return;
    }
    state.running = true;
    drop(state);
    tauri::async_runtime::spawn(async {
        loop {
            let job = {
                let mut state = pending().lock().unwrap_or_else(|e| e.into_inner());
                match state.jobs.pop_first() {
                    Some((_, job)) => job,
                    None => {
                        state.running = false;
                        break;
                    }
                }
            };
            let result = crate::document_io::run("derive", move || {
                let state = job.app.state::<AppState>();
                // A delayed local snapshot must not overwrite a newer external
                // search update, or resurrect an entry deleted meanwhile.
                crate::app::search_index::try_index_upsert(&state, &job.memo_id);
                if let Some(content) = job.version_content {
                    let memo_file = read_lock(&state.memo_file, "memo_file");
                    MemoService::new(&memo_file)
                        .maybe_create_auto_memo_version(&job.memo_id, &content)?;
                }
                Ok::<(), flowix_core::FlowixError>(())
            })
            .await;
            match result {
                Err(error) => tracing::error!("document derived worker failed: {error}"),
                Ok(Err(error)) => tracing::error!("document auto-version failed: {error}"),
                Ok(Ok(())) => {}
            }
        }
    });
}

pub async fn flush() -> bool {
    for _ in 0..100 {
        if !pending().lock().unwrap_or_else(|e| e.into_inner()).running {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}
