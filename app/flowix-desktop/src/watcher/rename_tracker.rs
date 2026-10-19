//! Match split OS rename events using live filesystem identity, never document text.
use super::processor::NotebookWatchContext;
use flowix_core::memo_file::{filesystem_identity, resource_kind_for_path, FileManagementPolicy};
use notify::{
    event::{ModifyKind, RenameMode},
    Event, EventKind,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct RenameTracker {
    roots: HashSet<PathBuf>,
    known: HashMap<PathBuf, (u64, u64)>,
    known_directories: HashSet<PathBuf>,
    pending: HashMap<PathBuf, ((u64, u64), Instant)>,
}
impl RenameTracker {
    fn rebase_known(&mut self, old: &Path, path: &Path) {
        let rebased: Vec<_> = self
            .known
            .iter()
            .filter_map(|(previous, id)| {
                let suffix = previous.strip_prefix(old).ok()?;
                let next = if suffix.as_os_str().is_empty() {
                    path.to_path_buf()
                } else {
                    path.join(suffix)
                };
                Some((previous.clone(), next, *id))
            })
            .collect();
        for (previous, next, id) in rebased {
            self.known.remove(&previous);
            self.known.insert(next.clone(), id);
            if self.known_directories.remove(&previous) {
                self.known_directories.insert(next);
            }
        }
        self.observe(path);
    }

    pub fn seed_root_while(
        root: &NotebookWatchContext,
        keep_running: impl Fn() -> bool,
    ) -> Option<Self> {
        let mut tracker = Self::default();
        tracker
            .add_root_while(root, &keep_running)
            .then_some(tracker)
    }
    pub fn register_root(&mut self, root: &NotebookWatchContext) {
        self.roots.insert(root.root.clone());
    }
    pub fn discard_stale_entries(&mut self) {
        self.known
            .retain(|path, identity| filesystem_identity(path) == Some(*identity));
        self.known_directories.retain(|path| path.is_dir());
    }
    pub fn merge_seed(&mut self, seed: Self) {
        for root in seed.roots {
            if !self.roots.contains(&root) {
                continue;
            }
            for (path, identity) in seed.known.iter().filter(|(path, _)| path.starts_with(&root)) {
                // Keep observations made by live events while the baseline was
                // collected off-thread.
                self.known.entry(path.clone()).or_insert(*identity);
            }
            for path in seed
                .known_directories
                .iter()
                .filter(|path| path.starts_with(&root))
            {
                self.known_directories.insert(path.clone());
            }
        }
    }
    fn add_root_while(&mut self, root: &NotebookWatchContext, keep_running: &impl Fn() -> bool) -> bool {
        self.register_root(root);
        let policy = FileManagementPolicy::from_notebook_root(&root.root);
        for entry in walkdir::WalkDir::new(&root.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry
                    .path()
                    .strip_prefix(&root.root)
                    .is_ok_and(|relative| !policy.is_index_ignored_at(&root.root, relative))
            })
            .filter_map(Result::ok)
        {
            if !keep_running() {
                return false;
            }
            if entry.file_type().is_dir()
                || entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                || resource_kind_for_path(entry.path()).is_some()
            {
                self.observe(entry.path());
            }
        }
        true
    }
    pub fn forget_root(&mut self, root: &Path) {
        self.roots.remove(root);
        let roots = &self.roots;
        let belongs_to_watched_root = |path: &Path| roots.iter().any(|base| path.starts_with(base));
        self.known.retain(|path, _| belongs_to_watched_root(path));
        self.known_directories.retain(|path| belongs_to_watched_root(path));
        self.pending.retain(|path, _| belongs_to_watched_root(path));
    }
    fn observe(&mut self, path: &Path) {
        if let Some(identity) = filesystem_identity(path) {
            self.known.insert(path.to_path_buf(), identity);
            if path.is_dir() {
                self.known_directories.insert(path.to_path_buf());
            }
        }
    }
    pub fn was_directory(&self, path: &Path) -> bool {
        self.known_directories.contains(path)
    }
    pub fn correlate(&mut self, event: Event) -> Event {
        self.pending
            .retain(|_, (_, time)| time.elapsed() < Duration::from_secs(2));
        if matches!(event.kind, EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            && event.paths.len() == 2
        {
            let old = &event.paths[0];
            let new = &event.paths[1];
            if !old.exists() && self.known.get(old).copied() == filesystem_identity(new) {
                self.rebase_known(old, new);
            }
            return event;
        }
        if event.paths.len() != 1 {
            return event;
        }
        let path = &event.paths[0];
        if matches!(
            event.kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::From))
        ) {
            if let Some(identity) = self.known.get(path) {
                self.pending
                    .insert(path.clone(), (*identity, Instant::now()));
            }
            return event;
        }
        if matches!(
            event.kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::To))
        ) {
            if let Some(identity) = filesystem_identity(path) {
                let candidates: Vec<_> = self
                    .pending
                    .iter()
                    .filter(|(old, (id, _))| *id == identity && !old.exists())
                    .map(|(old, _)| old.clone())
                    .collect();
                if candidates.len() == 1 {
                    let old = &candidates[0];
                    self.pending.remove(old);
                    self.rebase_known(old, path);
                    return Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                        .add_path(old.clone())
                        .add_path(path.clone());
                }
            }
        }
        if path.exists() {
            self.observe(path);
        } else if matches!(event.kind, EventKind::Remove(_)) {
            self.known.remove(path);
            self.known_directories.remove(path);
        }
        event
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(mode: RenameMode, path: &Path) -> Event {
        Event::new(EventKind::Modify(ModifyKind::Name(mode))).add_path(path.to_path_buf())
    }
    #[test]
    fn matches_real_split_rename_without_markdown_key() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("Old.md");
        let new = dir.path().join("New.md");
        std::fs::write(&old, "plain Markdown").unwrap();
        let mut tracker = RenameTracker::default();
        tracker.observe(&old);
        std::fs::rename(&old, &new).unwrap();
        tracker.correlate(event(RenameMode::From, &old));
        let paired = tracker.correlate(event(RenameMode::To, &new));
        assert_eq!(paired.paths, vec![old, new]);
        assert_eq!(
            paired.kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::Both))
        );
    }
    #[test]
    fn identical_copied_bytes_do_not_establish_identity() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("Old.md");
        let new = dir.path().join("Copy.md");
        std::fs::write(&old, "same bytes").unwrap();
        std::fs::copy(&old, &new).unwrap();
        let mut tracker = RenameTracker::default();
        tracker.observe(&old);
        std::fs::remove_file(&old).unwrap();
        tracker.correlate(event(RenameMode::From, &old));
        assert_eq!(
            tracker.correlate(event(RenameMode::To, &new)).paths,
            vec![new]
        );
    }

    #[test]
    fn direct_rename_pair_rebases_known_descendants_for_the_next_move() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("drafts");
        let middle = dir.path().join("archive");
        let final_path = dir.path().join("done");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("note.md"), "note").unwrap();
        let mut tracker = RenameTracker::default();
        tracker.observe(&old);
        tracker.observe(&old.join("note.md"));
        std::fs::rename(&old, &middle).unwrap();
        let paired = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(old.clone()).add_path(middle.clone());
        tracker.correlate(paired);
        assert!(tracker.was_directory(&middle));
        assert!(tracker.known.contains_key(&middle.join("note.md")));
        std::fs::rename(&middle, &final_path).unwrap();
        tracker.correlate(event(RenameMode::From, &middle));
        assert_eq!(tracker.correlate(event(RenameMode::To, &final_path)).paths,
            vec![middle, final_path]);
    }
}
