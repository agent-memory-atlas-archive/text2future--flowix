//! Serializes manual, automatic and polling sync work, including retries.
use super::*;
use super::local_adapter::*;

static ACCOUNT_SYNC_LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();

fn account_sync_lock() -> Arc<tokio::sync::Mutex<()>> {
    ACCOUNT_SYNC_LOCK
        .get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SyncTarget {
    Notebook(String),
    FullAccount,
}

impl SyncTarget {
    fn notebook_scope(&self) -> Option<&str> {
        match self {
            Self::Notebook(notebook_id) => Some(notebook_id),
            Self::FullAccount => None,
        }
    }

    fn merge(&mut self, other: Self) {
        if *self != other {
            *self = Self::FullAccount;
        }
    }

    fn label(&self) -> &str {
        match self {
            Self::Notebook(notebook_id) => notebook_id,
            Self::FullAccount => "full-account",
        }
    }
}

struct ManualSyncRequest {
    target: SyncTarget,
    responder: oneshot::Sender<Result<CloudSyncResult, String>>,
}

enum SyncCoordinatorRequest {
    Automatic {
        target: SyncTarget,
        generation_changed: bool,
    },
    Retry(SyncTarget),
    Poll,
    Manual(ManualSyncRequest),
}

#[derive(Clone)]
struct SyncCoordinatorHandle {
    sender: mpsc::UnboundedSender<SyncCoordinatorRequest>,
}

#[derive(Default)]
struct PendingSyncBatch {
    target: Option<SyncTarget>,
    responders: Vec<oneshot::Sender<Result<CloudSyncResult, String>>>,
    retry_on_failure: bool,
    debounce_required: bool,
}

impl PendingSyncBatch {
    fn merge_target(&mut self, target: SyncTarget) {
        match &mut self.target {
            Some(current) => current.merge(target),
            None => self.target = Some(target),
        }
    }
}

struct SyncActivity {
    run_id: String,
    started_at: i64,
    notebooks: HashSet<String>,
    result: CloudSyncResult,
}

impl SyncActivity {
    fn new() -> Self {
        Self {
            run_id: uuid::Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp_millis(),
            notebooks: HashSet::new(),
            result: CloudSyncResult {
                notebooks: 0,
                uploaded: 0,
                deleted: 0,
                downloaded: 0,
            },
        }
    }

    fn absorb_report(&mut self, report: &V2AccountSyncReport) {
        self.result.uploaded = self.result.uploaded.saturating_add(report.uploaded);
        self.result.deleted = self.result.deleted.saturating_add(report.deleted);
        self.result.downloaded = self.result.downloaded.saturating_add(report.remote.len());
        self.result.notebooks = self.notebooks.len();
    }
}

const AUTO_SYNC_DEBOUNCE: Duration = Duration::from_millis(1_200);
const AUTO_SYNC_MAX_WAIT: Duration = Duration::from_secs(5);
const CLOUD_POLL_INTERVAL: Duration = Duration::from_secs(30);

static SYNC_COORDINATOR: OnceLock<SyncCoordinatorHandle> = OnceLock::new();
static POLLING_STARTED: AtomicBool = AtomicBool::new(false);

fn sync_coordinator(app: &AppHandle) -> SyncCoordinatorHandle {
    SYNC_COORDINATOR
        .get_or_init(|| {
            let (sender, receiver) = mpsc::unbounded_channel();
            let handle = SyncCoordinatorHandle { sender };
            tauri::async_runtime::spawn(run_sync_coordinator(app.clone(), receiver));
            handle
        })
        .clone()
}

fn send_sync_request(app: &AppHandle, request: SyncCoordinatorRequest) -> Result<(), String> {
    sync_coordinator(app)
        .sender
        .send(request)
        .map_err(|_| "cloud sync coordinator is unavailable".to_string())
}

fn automatic_sync_available(app: &AppHandle, notebook_id: &str) -> bool {
    let state = app.state::<AppState>();
    state
        .cloud_sync
        .state()
        .map(|cloud| cloud.enabled && cloud.authenticated)
        .unwrap_or(false)
        && state
            .cloud_sync
            .v2_notebook(notebook_id)
            .ok()
            .flatten()
            .is_some_and(|notebook| notebook.enabled)
}

fn automatic_sync_target_available(app: &AppHandle, target: &SyncTarget) -> bool {
    match target {
        SyncTarget::Notebook(notebook_id) => automatic_sync_available(app, notebook_id),
        SyncTarget::FullAccount => {
            let state = app.state::<AppState>();
            state
                .cloud_sync
                .state()
                .map(|cloud| cloud.enabled && cloud.authenticated)
                .unwrap_or(false)
                && !state
                    .cloud_sync
                    .v2_enabled_notebooks()
                    .unwrap_or_default()
                    .is_empty()
        }
    }
}

fn enabled_notebooks_for_target(
    state: &AppState,
    target: &SyncTarget,
) -> Result<Vec<V2SyncedNotebook>, String> {
    Ok(state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?
        .into_iter()
        .filter(|notebook| {
            target
                .notebook_scope()
                .is_none_or(|scope| notebook.notebook_id == scope)
        })
        .collect())
}

fn emit_activity_status(
    app: &AppHandle,
    activity: &SyncActivity,
    notebook_ids: impl IntoIterator<Item = String>,
    state: &str,
    phase: &str,
    error: Option<&str>,
) {
    let finished_at = matches!(state, "success" | "error").then(|| Utc::now().timestamp_millis());
    for notebook_id in notebook_ids {
        let mut status = CloudSyncStatus::new(
            &notebook_id,
            &activity.run_id,
            state,
            phase,
            activity.started_at,
        );
        status.uploaded = activity.result.uploaded;
        status.deleted = activity.result.deleted;
        status.downloaded = activity.result.downloaded;
        status.finished_at = finished_at;
        status.last_error = error.map(str::to_owned);
        emit_sync_status(app, &status);
    }
}

async fn sync_v2_account_pass(
    state: &AppState,
    app: &AppHandle,
    target: &SyncTarget,
    enabled: &[V2SyncedNotebook],
    activity: &SyncActivity,
) -> Result<V2AccountSyncReport, String> {
    let generation = state.cloud_sync.session_restore_generation();
    let notebook_scope = target.notebook_scope();
    let full_local_snapshot = should_run_full_local_snapshot(state, notebook_scope)?;
    let sync_lock = account_sync_lock();
    let _guard = sync_lock.lock().await;
    emit_activity_status(
        app,
        activity,
        enabled.iter().map(|notebook| notebook.notebook_id.clone()),
        "checking",
        "snapshot",
        None,
    );
    for notebook in enabled {
        let exists = read_lock(&state.memo_file, "memo_file")
            .get_notebook_config_by_id(&notebook.notebook_id)
            .is_some();
        if exists {
            canonicalize_local_keys(state, app, &notebook.notebook_id)?;
        }
    }
    let (notebooks, notes) = v2_account_snapshot(state, full_local_snapshot, notebook_scope)?;
    emit_activity_status(
        app,
        activity,
        enabled.iter().map(|notebook| notebook.notebook_id.clone()),
        "syncing",
        "transfer",
        None,
    );
    let report_result = state
        .cloud_sync
        .sync_v2_snapshot_at_generation(notebook_scope, notebooks, notes, generation)
        .await;
    persist_rotated_token(state)?;
    let report = report_result.map_err(cloud_error)?;
    emit_activity_status(
        app,
        activity,
        enabled.iter().map(|notebook| notebook.notebook_id.clone()),
        "finalizing",
        "apply",
        None,
    );
    state
        .cloud_sync
        .complete_v2_sync_with_apply(&report, notebook_scope, || {
            apply_v2_report(state, app, &report).map_err(SyncError::InvalidState)
        })
        .map_err(sync_error)?;
    if full_local_snapshot && notebook_scope.is_none() {
        LAST_FULL_LOCAL_SNAPSHOT_AT.store(Utc::now().timestamp_millis(), Ordering::SeqCst);
    }
    Ok(report)
}

fn merge_waiting_request(
    batch: &mut PendingSyncBatch,
    request: SyncCoordinatorRequest,
    poll_due: bool,
) -> bool {
    match request {
        SyncCoordinatorRequest::Automatic {
            target,
            generation_changed,
        } => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required |= generation_changed;
            false
        }
        SyncCoordinatorRequest::Retry(target) => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required = false;
            true
        }
        SyncCoordinatorRequest::Poll if poll_due => {
            batch.merge_target(SyncTarget::FullAccount);
            batch.retry_on_failure = true;
            batch.debounce_required = false;
            true
        }
        SyncCoordinatorRequest::Poll => false,
        SyncCoordinatorRequest::Manual(request) => {
            batch.merge_target(request.target);
            batch.responders.push(request.responder);
            batch.debounce_required = false;
            true
        }
    }
}

async fn collect_debounced_requests(
    receiver: &mut mpsc::UnboundedReceiver<SyncCoordinatorRequest>,
    batch: &mut PendingSyncBatch,
    poll_due: bool,
) {
    if !batch.debounce_required {
        return;
    }
    let max_deadline = Instant::now() + AUTO_SYNC_MAX_WAIT;
    let mut quiet_deadline = Instant::now() + AUTO_SYNC_DEBOUNCE;
    loop {
        let deadline = quiet_deadline.min(max_deadline);
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            request = receiver.recv() => {
                let Some(request) = request else { break };
                let resets_debounce = matches!(
                    request,
                    SyncCoordinatorRequest::Automatic {
                        generation_changed: true,
                        ..
                    }
                );
                if merge_waiting_request(batch, request, poll_due) {
                    break;
                }
                if resets_debounce {
                    quiet_deadline = (Instant::now() + AUTO_SYNC_DEBOUNCE).min(max_deadline);
                }
            }
        }
    }
    batch.debounce_required = false;
}

fn activity_covers(
    completed_full_account: bool,
    completed_notebooks: &HashSet<String>,
    target: &SyncTarget,
) -> bool {
    completed_full_account
        || matches!(target, SyncTarget::Notebook(notebook_id) if completed_notebooks.contains(notebook_id))
}

fn merge_request_after_pass(
    batch: &mut PendingSyncBatch,
    request: SyncCoordinatorRequest,
    completed_full_account: bool,
    completed_notebooks: &HashSet<String>,
) -> bool {
    match request {
        // An automatic request represents a possibly newer dirty generation,
        // even when the just-finished pass covered the same notebook.
        SyncCoordinatorRequest::Automatic {
            target,
            generation_changed: true,
        } => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required = true;
            false
        }
        // The pass already covers this persisted generation. An identical
        // editor/watcher observation must not create a trailing network pass.
        SyncCoordinatorRequest::Automatic {
            generation_changed: false,
            target,
        } => {
            if activity_covers(completed_full_account, completed_notebooks, &target) {
                false
            } else {
                batch.merge_target(target);
                batch.retry_on_failure = true;
                batch.debounce_required = false;
                true
            }
        }
        SyncCoordinatorRequest::Retry(target) => {
            batch.merge_target(target);
            batch.retry_on_failure = true;
            batch.debounce_required = false;
            true
        }
        // A successful pass makes an overlapping poll redundant. The next
        // periodic tick will be measured from this activity's success.
        SyncCoordinatorRequest::Poll => false,
        SyncCoordinatorRequest::Manual(request) => {
            let covered =
                activity_covers(completed_full_account, completed_notebooks, &request.target);
            if !covered {
                batch.merge_target(request.target);
                batch.debounce_required = false;
            }
            batch.responders.push(request.responder);
            !covered
        }
    }
}

async fn collect_trailing_requests(
    receiver: &mut mpsc::UnboundedReceiver<SyncCoordinatorRequest>,
    batch: &mut PendingSyncBatch,
    completed_full_account: bool,
    completed_notebooks: &HashSet<String>,
) {
    let mut start_immediately = false;
    while let Ok(request) = receiver.try_recv() {
        start_immediately |=
            merge_request_after_pass(batch, request, completed_full_account, completed_notebooks);
    }
    if start_immediately || !batch.debounce_required {
        return;
    }
    let max_deadline = Instant::now() + AUTO_SYNC_MAX_WAIT;
    let mut quiet_deadline = Instant::now() + AUTO_SYNC_DEBOUNCE;
    loop {
        let deadline = quiet_deadline.min(max_deadline);
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            request = receiver.recv() => {
                let Some(request) = request else { break };
                let resets_debounce = matches!(
                    request,
                    SyncCoordinatorRequest::Automatic {
                        generation_changed: true,
                        ..
                    }
                );
                let start_immediately = merge_request_after_pass(
                    batch,
                    request,
                    completed_full_account,
                    completed_notebooks,
                );
                if start_immediately {
                    break;
                }
                if resets_debounce {
                    quiet_deadline = (Instant::now() + AUTO_SYNC_DEBOUNCE).min(max_deadline);
                }
            }
        }
    }
    batch.debounce_required = false;
}

fn finish_responders(
    responders: Vec<oneshot::Sender<Result<CloudSyncResult, String>>>,
    result: Result<CloudSyncResult, String>,
) {
    for responder in responders {
        let _ = responder.send(result.clone());
    }
}

async fn run_sync_activity(
    app: &AppHandle,
    receiver: &mut mpsc::UnboundedReceiver<SyncCoordinatorRequest>,
    mut batch: PendingSyncBatch,
) -> Result<CloudSyncResult, String> {
    let mut activity = SyncActivity::new();
    let mut completed_full_account = false;
    let mut completed_notebooks = HashSet::new();

    loop {
        let Some(target) = batch.target.take() else {
            let result = activity.result.clone();
            finish_responders(batch.responders, Ok(result.clone()));
            return Ok(result);
        };
        let state = app.state::<AppState>();
        let enabled = match enabled_notebooks_for_target(state.inner(), &target) {
            Ok(enabled) => enabled,
            Err(error) => {
                let mut error_notebooks = activity.notebooks.clone();
                if let SyncTarget::Notebook(notebook_id) = &target {
                    error_notebooks.insert(notebook_id.clone());
                }
                emit_activity_status(
                    app,
                    &activity,
                    error_notebooks,
                    "error",
                    "failed",
                    Some(&error),
                );
                finish_responders(batch.responders, Err(error.clone()));
                if batch.retry_on_failure {
                    schedule_retry_after_failure(app, target);
                }
                return Err(error);
            }
        };
        activity
            .notebooks
            .extend(enabled.iter().map(|notebook| notebook.notebook_id.clone()));
        activity.result.notebooks = activity.notebooks.len();

        let report =
            match sync_v2_account_pass(state.inner(), app, &target, &enabled, &activity).await {
                Ok(report) => report,
                Err(error) => {
                    let mut error_notebooks = activity.notebooks.clone();
                    if let SyncTarget::Notebook(notebook_id) = &target {
                        error_notebooks.insert(notebook_id.clone());
                    }
                    emit_activity_status(
                        app,
                        &activity,
                        error_notebooks,
                        "error",
                        "failed",
                        Some(&error),
                    );
                    finish_responders(batch.responders, Err(error.clone()));
                    if batch.retry_on_failure {
                        schedule_retry_after_failure(app, target.clone());
                    }
                    return Err(error);
                }
            };
        activity.absorb_report(&report);
        match &target {
            SyncTarget::FullAccount => completed_full_account = true,
            SyncTarget::Notebook(notebook_id) => {
                completed_notebooks.insert(notebook_id.clone());
            }
        }

        collect_trailing_requests(
            receiver,
            &mut batch,
            completed_full_account,
            &completed_notebooks,
        )
        .await;
        if batch.target.is_none() {
            emit_activity_status(
                app,
                &activity,
                activity.notebooks.clone(),
                "success",
                "complete",
                None,
            );
            let result = activity.result.clone();
            finish_responders(batch.responders, Ok(result.clone()));
            return Ok(result);
        }
    }
}

async fn run_sync_coordinator(
    app: AppHandle,
    mut receiver: mpsc::UnboundedReceiver<SyncCoordinatorRequest>,
) {
    let mut last_success_at: Option<Instant> = None;
    while let Some(first_request) = receiver.recv().await {
        let poll_due = last_success_at
            .is_none_or(|last_success| last_success.elapsed() >= CLOUD_POLL_INTERVAL);
        let mut batch = PendingSyncBatch::default();
        merge_waiting_request(&mut batch, first_request, poll_due);
        if batch.target.is_none() {
            continue;
        }
        collect_debounced_requests(&mut receiver, &mut batch, poll_due).await;
        if batch.target.is_none() {
            continue;
        }
        match run_sync_activity(&app, &mut receiver, batch).await {
            Ok(_) => last_success_at = Some(Instant::now()),
            Err(error) => tracing::warn!("cloud sync activity failed: {error}"),
        }
    }
}

/// Debounce editor/watcher bursts and run synchronization off the write path.
pub(crate) fn schedule_notebook_sync(app: AppHandle, notebook_id: String) {
    schedule_notebook_sync_observation(app, notebook_id, true);
}

pub(crate) fn schedule_notebook_sync_observation(
    app: AppHandle,
    notebook_id: String,
    generation_changed: bool,
) {
    if !automatic_sync_available(&app, &notebook_id) {
        return;
    }
    if let Err(error) = send_sync_request(
        &app,
        SyncCoordinatorRequest::Automatic {
            target: SyncTarget::Notebook(notebook_id.clone()),
            generation_changed,
        },
    ) {
        tracing::warn!("failed to schedule cloud sync for {notebook_id}: {error}");
    }
}

fn schedule_retry_after_failure(app: &AppHandle, target: SyncTarget) {
    let state = app.state::<AppState>();
    match state
        .cloud_sync
        .v2_retry_delay(chrono::Utc::now().timestamp_millis())
    {
        Ok(Some(delay_ms)) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay_ms.max(1) as u64)).await;
                if !automatic_sync_target_available(&app, &target) {
                    return;
                }
                let state = app.state::<AppState>();
                if state
                    .cloud_sync
                    .v2_retry_delay(Utc::now().timestamp_millis())
                    .ok()
                    .flatten()
                    .is_none()
                {
                    return;
                }
                if let Err(error) =
                    send_sync_request(&app, SyncCoordinatorRequest::Retry(target.clone()))
                {
                    tracing::warn!(
                        "failed to schedule cloud retry for {}: {error}",
                        target.label()
                    );
                }
            });
        }
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(
                "failed to calculate cloud retry for {}: {error}",
                target.label()
            );
        }
    }
}

pub(crate) fn start_cloud_sync_polling(app: AppHandle) {
    if POLLING_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CLOUD_POLL_INTERVAL).await;
            let should_poll = {
                let state = app.state::<AppState>();
                let cloud_state = state.cloud_sync.state().ok();
                matches!(
                    cloud_state,
                    Some(CloudState {
                        enabled: true,
                        authenticated: true,
                        ..
                    })
                ) && !state
                    .cloud_sync
                    .v2_enabled_notebooks()
                    .unwrap_or_default()
                    .is_empty()
            };
            if should_poll {
                if let Err(error) = send_sync_request(&app, SyncCoordinatorRequest::Poll) {
                    tracing::warn!("failed to request periodic cloud sync: {error}");
                }
            }
        }
    });
}


pub(super) async fn sync_now(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<CloudSyncResult, String> {
    let target = match notebook_id {
        Some(notebook_id) => SyncTarget::Notebook(notebook_id),
        None => SyncTarget::FullAccount,
    };
    let (responder, response) = oneshot::channel();
    send_sync_request(
        &app,
        SyncCoordinatorRequest::Manual(ManualSyncRequest { target, responder }),
    )?;
    response
        .await
        .map_err(|_| "cloud sync coordinator stopped before completing the request".to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_target_merge_keeps_one_scope_and_promotes_distinct_notebooks() {
        let mut target = SyncTarget::Notebook("nb_1".into());
        target.merge(SyncTarget::Notebook("nb_1".into()));
        assert_eq!(target, SyncTarget::Notebook("nb_1".into()));

        target.merge(SyncTarget::Notebook("nb_2".into()));
        assert_eq!(target, SyncTarget::FullAccount);

        target.merge(SyncTarget::Notebook("nb_3".into()));
        assert_eq!(target, SyncTarget::FullAccount);
    }

    #[test]
    fn automatic_requests_debounce_and_manual_requests_start_immediately() {
        let mut batch = PendingSyncBatch::default();
        assert!(!merge_waiting_request(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_1".into()),
                generation_changed: true,
            },
            true,
        ));
        assert!(batch.debounce_required);

        let (responder, _response) = oneshot::channel();
        assert!(merge_waiting_request(
            &mut batch,
            SyncCoordinatorRequest::Manual(ManualSyncRequest {
                target: SyncTarget::Notebook("nb_1".into()),
                responder,
            }),
            true,
        ));
        assert!(!batch.debounce_required);
        assert_eq!(batch.responders.len(), 1);
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_1".into())));
    }

    #[test]
    fn new_dirty_generation_after_pass_requests_one_trailing_pass() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        assert!(!merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_1".into()),
                generation_changed: true,
            },
            false,
            &completed,
        ));
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_1".into())));
        assert!(batch.debounce_required);
    }

    #[test]
    fn repeated_generation_does_not_request_a_trailing_pass() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        assert!(!merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_1".into()),
                generation_changed: false,
            },
            false,
            &completed,
        ));
        assert!(batch.target.is_none());
        assert!(!batch.debounce_required);
    }

    #[test]
    fn persisted_generation_for_an_uncovered_notebook_still_wakes_the_worker() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        assert!(merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Automatic {
                target: SyncTarget::Notebook("nb_2".into()),
                generation_changed: false,
            },
            false,
            &completed,
        ));
        assert_eq!(batch.target, Some(SyncTarget::Notebook("nb_2".into())));
    }

    #[test]
    fn covered_manual_request_joins_current_activity_without_another_pass() {
        let mut batch = PendingSyncBatch::default();
        let completed = HashSet::from(["nb_1".to_string()]);
        let (responder, _response) = oneshot::channel();
        assert!(!merge_request_after_pass(
            &mut batch,
            SyncCoordinatorRequest::Manual(ManualSyncRequest {
                target: SyncTarget::Notebook("nb_1".into()),
                responder,
            }),
            false,
            &completed,
        ));
        assert!(batch.target.is_none());
        assert_eq!(batch.responders.len(), 1);
    }

    #[test]
    fn full_account_pass_covers_later_notebook_manual_request() {
        assert!(activity_covers(
            true,
            &HashSet::new(),
            &SyncTarget::Notebook("nb_1".into()),
        ));
    }

    #[test]
    fn cloud_sync_status_uses_camel_case_wire_format() {
        let mut status =
            CloudSyncStatus::new("nb_1", "run_1", "error", "failed", 1_700_000_000_000);
        status.finished_at = Some(1_700_000_000_100);
        status.last_error = Some("network unavailable".to_string());

        let value = serde_json::to_value(status).expect("serialize cloud sync status");
        assert_eq!(value["notebookId"], "nb_1");
        assert_eq!(value["runId"], "run_1");
        assert_eq!(value["startedAt"], 1_700_000_000_000_i64);
        assert_eq!(value["finishedAt"], 1_700_000_000_100_i64);
        assert_eq!(value["lastError"], "network unavailable");
    }

    #[test]
    fn cloud_error_preserves_actionable_membership_code() {
        let message = cloud_error(SyncError::Api {
            status: 402,
            code: "MEMBERSHIP_REQUIRED".to_string(),
            message: "membership required".to_string(),
            details: Some(serde_json::json!({
                "usedBytes": 128,
                "quotaBytes": 0,
                "membershipExpiresAt": null,
            })),
        });

        assert!(message.starts_with("MEMBERSHIP_REQUIRED:"));
        let details: serde_json::Value = serde_json::from_str(
            message
                .strip_prefix("MEMBERSHIP_REQUIRED:")
                .expect("membership error prefix"),
        )
        .expect("membership error details");
        assert_eq!(details["usedBytes"], 128);
        assert_eq!(details["quotaBytes"], 0);
    }

    #[test]
    fn cloud_error_preserves_quota_details_for_the_ui() {
        let message = cloud_error(SyncError::Api {
            status: 402,
            code: "STORAGE_QUOTA_EXCEEDED".to_string(),
            message: "quota exceeded".to_string(),
            details: Some(serde_json::json!({
                "usedBytes": 52_428_800,
                "quotaBytes": 52_428_800,
                "requestedDeltaBytes": 1_024,
            })),
        });

        assert!(message.starts_with("STORAGE_QUOTA_EXCEEDED:"));
        let details: serde_json::Value = serde_json::from_str(
            message
                .strip_prefix("STORAGE_QUOTA_EXCEEDED:")
                .expect("quota error prefix"),
        )
        .expect("quota error details");
        assert_eq!(details["usedBytes"], 52_428_800);
        assert_eq!(details["quotaBytes"], 52_428_800);
        assert_eq!(details["requestedDeltaBytes"], 1_024);
    }
}
