//! Native startup coordination.
//!
//! Startup migrations must not run inside Tauri's setup callback: doing so
//! delays WebView initialization and leaves Windows showing an apparently
//! frozen application. This coordinator gives the WebView a small, explicit
//! state machine to observe while the blocking migration work runs on a
//! dedicated thread.

use serde::Serialize;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StartupPhase {
    Pending,
    Running,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    pub phase: StartupPhase,
    pub step: String,
    pub error: Option<String>,
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
                    step: "initializing".to_string(),
                    error: None,
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

    pub fn elapsed_ms(&self) -> u128 {
        self.started_at.elapsed().as_millis()
    }

    pub fn mark_running(&self, step: impl Into<String>) {
        self.update(StartupStatus {
            phase: StartupPhase::Running,
            step: step.into(),
            error: None,
        });
    }

    pub fn mark_ready(&self) {
        self.update(StartupStatus {
            phase: StartupPhase::Ready,
            step: "ready".to_string(),
            error: None,
        });
    }

    pub fn mark_failed(&self, error: impl Into<String>) {
        self.update(StartupStatus {
            phase: StartupPhase::Failed,
            step: "failed".to_string(),
            error: Some(error.into()),
        });
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
        state.status = status;
        self.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::{StartupCoordinator, StartupPhase};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn waiters_are_released_when_startup_is_ready() {
        let coordinator = Arc::new(StartupCoordinator::new());
        let waiter = coordinator.clone();
        let handle = thread::spawn(move || waiter.wait_until_ready());

        coordinator.mark_running("migrating");
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
    fn maintenance_waits_for_the_first_interactive_workspace() {
        let coordinator = Arc::new(StartupCoordinator::new());
        let waiter = coordinator.clone();
        let handle = thread::spawn(move || waiter.wait_until_interactive(Duration::from_secs(1)));
        coordinator.mark_ready();
        coordinator.mark_interactive();
        assert!(handle.join().unwrap());
    }
}
