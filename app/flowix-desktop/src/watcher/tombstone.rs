//! Delay removals so a confirmed rename pair can cancel the old path.
//! A new file with identical content or legacy frontmatter cannot cancel it.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use flowix_core::memo_file::MemoFile;
use tauri::AppHandle;

use crate::watcher::processor::{MemoEventProcessor, NotebookWatchContext};

#[derive(Debug, Clone)]
struct PendingRemove {
    path: PathBuf,
    ctx: NotebookWatchContext,
    deadline: Instant,
}

struct RemoveCoalescerInner {
    pending: Mutex<HashMap<String, PendingRemove>>,
    wake: Condvar,
}

#[derive(Clone)]
pub struct RemoveCoalescer {
    inner: Arc<RemoveCoalescerInner>,
    delay: Duration,
}

impl RemoveCoalescer {
    pub fn new(app: AppHandle, memo_file: Arc<RwLock<MemoFile>>, delay: Duration) -> Self {
        let coalescer = Self::inert(delay);
        spawn_worker(coalescer.inner.clone(), app, memo_file, delay);
        coalescer
    }

    pub(crate) fn cancel_all(&self) {
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.clear();
            self.inner.wake.notify_one();
        }
    }

    pub(crate) fn cancel_notebook(&self, notebook_id: &str) {
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.retain(|_, remove| remove.ctx.notebook_id != notebook_id);
            self.inner.wake.notify_one();
        }
    }

    pub fn schedule(&self, id: String, ctx: NotebookWatchContext, path: &Path) {
        let marker = PendingRemove {
            path: path.to_path_buf(),
            ctx,
            deadline: Instant::now() + self.delay,
        };
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.insert(id, marker);
            self.inner.wake.notify_one();
        }
    }

    pub fn cancel_path(&self, path: &Path) {
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.retain(|_, old| old.path != path);
            self.inner.wake.notify_one();
        }
    }

    fn inert(delay: Duration) -> Self {
        Self {
            inner: Arc::new(RemoveCoalescerInner {
                pending: Mutex::new(HashMap::new()),
                wake: Condvar::new(),
            }),
            delay,
        }
    }

    #[cfg(test)]
    fn insert_for_test(&self, id: String, path: PathBuf, ctx: NotebookWatchContext) {
        let marker = PendingRemove {
            path,
            ctx,
            deadline: Instant::now() + Duration::from_secs(60),
        };
        self.inner.pending.lock().unwrap().insert(id, marker);
    }

    #[cfg(test)]
    fn contains_for_test(&self, id: &str) -> bool {
        self.inner.pending.lock().unwrap().contains_key(id)
    }

    #[cfg(test)]
    fn pending_len_for_test(&self) -> usize {
        self.inner.pending.lock().unwrap().len()
    }
}

fn spawn_worker(
    inner: Arc<RemoveCoalescerInner>,
    app: AppHandle,
    memo_file: Arc<RwLock<MemoFile>>,
    fallback_delay: Duration,
) {
    std::thread::spawn(move || loop {
        let expired = {
            let mut pending = match inner.pending.lock() {
                Ok(pending) => pending,
                Err(_) => return,
            };
            loop {
                if Arc::strong_count(&inner) == 1 && pending.is_empty() {
                    return;
                }

                let now = Instant::now();
                let mut expired = Vec::new();
                pending.retain(|_, remove| {
                    if remove.deadline <= now {
                        expired.push(remove.clone());
                        false
                    } else {
                        true
                    }
                });
                if !expired.is_empty() {
                    break expired;
                }

                let wait_for = pending
                    .values()
                    .map(|remove| remove.deadline.saturating_duration_since(now))
                    .min()
                    .unwrap_or(fallback_delay);

                pending = match inner.wake.wait_timeout(pending, wait_for) {
                    Ok((pending, _)) => pending,
                    Err(_) => return,
                };
            }
        };

        for pending in expired {
            MemoEventProcessor::unregister_and_emit(&app, &memo_file, &pending.ctx, &pending.path);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch_ctx() -> NotebookWatchContext {
        NotebookWatchContext {
            notebook_id: "nb_test".to_string(),
            root: PathBuf::from("."),
        }
    }

    #[test]
    fn explicit_rename_pair_cancels_old_path() {
        let coalescer = RemoveCoalescer::inert(Duration::from_secs(60));
        coalescer.schedule("entry".into(), watch_ctx(), Path::new("Old.md"));
        coalescer.cancel_path(Path::new("Old.md"));
        assert!(!coalescer.contains_for_test("entry"));
    }

    #[test]
    fn schedule_records_pending_remove() {
        let coalescer = RemoveCoalescer::inert(Duration::from_secs(60));
        let id = "memo-1".to_string();
        coalescer.schedule(id.clone(), watch_ctx(), Path::new("Old.md"));

        assert!(coalescer.contains_for_test(&id));
        assert_eq!(coalescer.pending_len_for_test(), 1);
    }

    #[test]
    fn cancel_all_clears_pending_removes() {
        let coalescer = RemoveCoalescer::inert(Duration::from_secs(60));
        coalescer.schedule("memo-1".to_string(), watch_ctx(), Path::new("One.md"));
        coalescer.schedule("memo-2".to_string(), watch_ctx(), Path::new("Two.md"));

        coalescer.cancel_all();

        assert_eq!(coalescer.pending_len_for_test(), 0);
    }

    #[test]
    fn suspending_one_notebook_keeps_other_pending_removes() {
        let coalescer = RemoveCoalescer::inert(Duration::from_secs(60));
        let first = watch_ctx();
        let mut second = watch_ctx();
        second.notebook_id = "nb_other".to_string();
        coalescer.schedule("first".to_string(), first, Path::new("First.md"));
        coalescer.schedule("second".to_string(), second, Path::new("Second.md"));

        coalescer.cancel_notebook("nb_test");

        assert!(!coalescer.contains_for_test("first"));
        assert!(coalescer.contains_for_test("second"));
    }

    #[test]
    fn unrelated_path_cannot_cancel_pending_remove() {
        let coalescer = RemoveCoalescer::inert(Duration::from_secs(60));
        coalescer.schedule("entry".into(), watch_ctx(), Path::new("Old.md"));
        coalescer.cancel_path(Path::new("New.md"));
        assert!(coalescer.contains_for_test("entry"));
    }
}
