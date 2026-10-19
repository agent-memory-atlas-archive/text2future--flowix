//! Native startup coordination.
//!
//! Startup migrations must not run inside Tauri's setup callback: doing so
//! delays WebView initialization and leaves Windows showing an apparently
//! frozen application. This coordinator gives the WebView a small, explicit
//! state machine to observe while the blocking migration work runs on a
//! dedicated thread.

use serde::{Deserialize, Serialize};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StartupPhase {
    Pending,
    Running,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StartupStage {
    Initialization,
    WorkspacePreparation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupProgress {
    pub percent: u8,
    pub completed: usize,
    pub total: usize,
    pub task: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    pub phase: StartupPhase,
    pub stage: StartupStage,
    pub step: String,
    pub error: Option<String>,
    pub progress: Option<StartupProgress>,
}

struct StartupState {
    status: StartupStatus,
    interactive: bool,
}

/// Process-local startup barrier shared by native commands and the WebView.
pub struct StartupCoordinator {
    started_at: Instant,
    state: Mutex<StartupState>,
    changed: Condvar,
}

impl Default for StartupCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl StartupCoordinator {
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
            state: Mutex::new(StartupState {
                status: StartupStatus {
                    phase: StartupPhase::Pending,
                    stage: StartupStage::Initialization,
                    step: "initialization".to_string(),
                    error: None,
                    progress: None,
                },
                interactive: false,
            }),
            changed: Condvar::new(),
        }
    }

    pub fn status(&self) -> StartupStatus {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .status
            .clone()
    }

    /// Wait until the startup snapshot changes or the bounded wait expires.
    /// The caller passes its last snapshot so updates between the snapshot IPC
    /// and this wait cannot be missed.
    pub fn wait_for_status_change(
        &self,
        previous: &StartupStatus,
        timeout: Duration,
    ) -> StartupStatus {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while state.status == *previous {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            state = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        state.status.clone()
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.started_at.elapsed().as_millis()
    }

    pub fn mark_running(&self, stage: StartupStage, step: impl Into<String>) {
        self.update(StartupStatus {
            phase: StartupPhase::Running,
            stage,
            step: step.into(),
            error: None,
            progress: None,
        });
    }

    pub fn set_progress(
        &self,
        percent: u8,
        completed: usize,
        total: usize,
        task: impl Into<String>,
    ) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.status.stage != StartupStage::Initialization
            || state.status.phase != StartupPhase::Running
        {
            return;
        }
        state.status.progress = Some(StartupProgress {
            percent: percent.min(100),
            completed,
            total,
            task: task.into(),
        });
        self.changed.notify_all();
    }

    pub fn mark_ready(&self) {
        self.update(StartupStatus {
            phase: StartupPhase::Ready,
            stage: StartupStage::WorkspacePreparation,
            step: "ready".to_string(),
            error: None,
            progress: None,
        });
    }

    pub fn mark_failed(&self, error: impl Into<String>) {
        // Preserve the stage and task that failed for retry UI and diagnostics.
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.status.phase = StartupPhase::Failed;
        state.status.error = Some(error.into());
        state.status.progress = None;
        self.changed.notify_all();
    }

    /// Only a failed attempt may be retried; the existing worker owns all attempts.
    pub fn request_retry(&self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.status.phase != StartupPhase::Failed {
            return Err("startup is not failed".into());
        }
        state.status = StartupStatus {
            phase: StartupPhase::Pending,
            stage: state.status.stage,
            step: match state.status.stage {
                StartupStage::Initialization => "initialization",
                StartupStage::WorkspacePreparation => "preparingData",
            }
            .into(),
            error: None,
            progress: None,
        };
        self.changed.notify_all();
        Ok(())
    }

    pub fn wait_for_retry(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        while state.status.phase == StartupPhase::Failed {
            state = self.changed.wait(state).unwrap_or_else(|p| p.into_inner());
        }
    }

    pub fn wait_until_ready(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            match state.status.phase {
                StartupPhase::Ready => return Ok(()),
                StartupPhase::Failed => {
                    return Err(state
                        .status
                        .error
                        .clone()
                        .unwrap_or_else(|| "startup migration failed".to_string()));
                }
                StartupPhase::Pending | StartupPhase::Running => {
                    state = self
                        .changed
                        .wait(state)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
            }
        }
    }

    pub fn mark_interactive(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.interactive = true;
        self.changed.notify_all();
    }

    pub fn wait_until_interactive(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !state.interactive {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            state = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        true
    }

    fn update(&self, status: StartupStatus) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Once stage 2 starts, neither retries nor later maintenance may reopen
        // version initialization. Keep this invariant at the status boundary.
        if state.status.stage == StartupStage::WorkspacePreparation
            && status.stage == StartupStage::Initialization
        {
            tracing::warn!(step = %status.step, "ignored startup transition back to initialization");
            return;
        }
        state.status = status;
        self.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::{StartupCoordinator, StartupPhase, StartupStage};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn retry_only_reopens_failed_startup() {
        let coordinator = StartupCoordinator::new();
        assert!(coordinator.request_retry().is_err());
        coordinator.mark_failed("interrupted");
        coordinator.request_retry().unwrap();
        coordinator.wait_for_retry();
        assert_eq!(coordinator.status().phase, StartupPhase::Pending);
        assert!(coordinator.status().error.is_none());
        assert!(coordinator.request_retry().is_err());
        coordinator.mark_ready();
        assert!(coordinator.request_retry().is_err());
    }

    #[test]
    fn waiters_are_released_when_startup_is_ready() {
        let coordinator = Arc::new(StartupCoordinator::new());
        let waiter = coordinator.clone();
        let handle = thread::spawn(move || waiter.wait_until_ready());

        coordinator.mark_running(StartupStage::Initialization, "migrating");
        coordinator.mark_ready();

        assert_eq!(handle.join().unwrap(), Ok(()));
        assert_eq!(coordinator.status().phase, StartupPhase::Ready);
    }

    #[test]
    fn failed_startup_is_returned_to_waiters() {
        let coordinator = StartupCoordinator::new();
        coordinator.mark_failed("disk unavailable");

        assert_eq!(
            coordinator.wait_until_ready(),
            Err("disk unavailable".to_string())
        );
    }

    #[test]
    fn status_wait_returns_on_progress_and_does_not_miss_an_earlier_update() {
        let coordinator = StartupCoordinator::new();
        let previous = coordinator.status();
        coordinator.mark_running(StartupStage::Initialization, "indexing");
        let changed = coordinator.wait_for_status_change(&previous, Duration::from_millis(1));
        assert_eq!(changed.phase, StartupPhase::Running);
        assert_eq!(changed.step, "indexing");
    }

    #[test]
    fn failure_retains_the_stage_and_task() {
        let coordinator = StartupCoordinator::new();
        coordinator.mark_running(StartupStage::WorkspacePreparation, "load-current-notebook");
        coordinator.mark_failed("disk unavailable");
        let status = coordinator.status();
        assert_eq!(status.stage, StartupStage::WorkspacePreparation);
        assert_eq!(status.step, "load-current-notebook");
        coordinator.request_retry().unwrap();
        assert_eq!(
            coordinator.status().stage,
            StartupStage::WorkspacePreparation
        );
    }

    #[test]
    fn workspace_preparation_cannot_return_to_initialization_or_publish_its_progress() {
        let coordinator = StartupCoordinator::new();
        coordinator.mark_running(StartupStage::Initialization, "migrating");
        coordinator.set_progress(50, 1, 2, "migration");
        assert!(coordinator.status().progress.is_some());
        coordinator.mark_running(StartupStage::WorkspacePreparation, "preparingData");

        for _ in 0..2 {
            coordinator.mark_running(StartupStage::Initialization, "versionInitialization");
            coordinator.set_progress(30, 0, 2, "prepareNotebookRegistry");
            let status = coordinator.status();
            assert_eq!(status.stage, StartupStage::WorkspacePreparation);
            assert!(status.progress.is_none());
            coordinator.mark_failed("database unavailable");
            coordinator.request_retry().unwrap();
            assert_eq!(
                coordinator.status().stage,
                StartupStage::WorkspacePreparation
            );
            coordinator.mark_running(StartupStage::WorkspacePreparation, "preparingData");
        }
    }

    #[test]
    fn maintenance_waits_for_the_first_interactive_workspace() {
        let coordinator = Arc::new(StartupCoordinator::new());
        let waiter = coordinator.clone();
        let handle = thread::spawn(move || waiter.wait_until_interactive(Duration::from_secs(1)));
        coordinator.mark_ready();
        coordinator.mark_interactive();
        assert!(handle.join().unwrap());
    }
}
