use flowix_core::memo_file::{notebook_path_from_relative, MemoFile, NotebookConfig};
use std::{fs, time::Instant};

fn fixture(count: usize) -> (tempfile::TempDir, MemoFile, Vec<NotebookConfig>) {
    let dir = tempfile::tempdir().unwrap();
    let store = MemoFile::new(dir.path().join("config"));
    let notebooks: Vec<_> = (0..count).map(|index| {
        let path = dir.path().join(format!("notebook-{index}"));
        fs::create_dir_all(&path).unwrap();
        NotebookConfig {
            id: format!("nb_{index}"), name: format!("Notebook {index}"),
            icon: None, path: path.to_string_lossy().into_owned(),
            is_default: index == 0, sort: index as i64 * 10,
            created_at: 1, updated_at: 1,
        }
    }).collect();
    store.write_notebook_configs(&notebooks).unwrap();
    for notebook in &notebooks {
        store.read_index_for_notebook_id(Some(&notebook.id)).unwrap();
    }
    (dir, store, notebooks)
}

#[test]
fn scoped_revision_preserves_cas_and_notebook_isolation() {
    let (_dir, store, notebooks) = fixture(2);
    let a = &notebooks[0].id;
    let b = &notebooks[1].id;
    assert!(store.read_memo_content_revision_for_notebook(a, "new-note").unwrap().is_none());
    let first = store.commit_memo_content_revision("new-note", a, "hash-a", "first").unwrap();
    let expected = store.read_memo_content_revision_for_notebook(a, "new-note").unwrap().unwrap();
    assert_eq!(expected, first.state);
    assert!(store.read_memo_content_revision_for_notebook(b, "new-note").unwrap().is_none());
    let next = store.commit_memo_content_revision_if_current("new-note", a, "hash-b", "next", Some(&expected)).unwrap().unwrap();
    assert_eq!(next.state.revision, 2);
    assert!(store.commit_memo_content_revision_if_current("new-note", a, "stale", "late", Some(&expected)).unwrap().is_none());
}

#[test]
fn scoped_revision_does_not_open_an_unrelated_broken_notebook() {
    let (_dir, store, notebooks) = fixture(2);
    let target = &notebooks[1].id;
    let expected = store.commit_memo_content_revision("note", target, "hash", "change").unwrap();
    fs::write(std::path::Path::new(&notebooks[0].path).join(".flowix/notebook.db"), b"broken database").unwrap();
    assert_eq!(store.read_memo_content_revision_for_notebook(target, "note").unwrap(), Some(expected.state));
    assert!(store.read_memo_content_revision_for_notebook(target, "fresh").unwrap().is_none());
}

/// Compare the old Created-event lookups with the optimized path, on isolated
/// notebook databases. This is a component benchmark, not desktop E2E timing.
#[test]
#[ignore = "manual notebook creation lookup benchmark"]
fn benchmark_notebook_creation_event_lookups() {
    let (_dir, store, notebooks) = fixture(8);
    let target = notebooks.last().unwrap();
    let memo = store.create_memo_for_notebook_id(&target.id, "Template note", "body", None).unwrap();
    let mut old = std::time::Duration::ZERO;
    let mut new = std::time::Duration::ZERO;
    for pass in 0..6 {
        for optimized in if pass % 2 == 0 { [false, true] } else { [true, false] } {
            let start = Instant::now();
            for _ in 0..12 {
                let (path, revision) = if optimized {
                    let config = store.get_notebook_config_by_id(&target.id).unwrap();
                    (notebook_path_from_relative(std::path::Path::new(&config.path), &memo.relative_path).unwrap(),
                     store.read_memo_content_revision_for_notebook(&target.id, &memo.id).unwrap())
                } else {
                    let location = store.resolve_memo_location(&memo.id).unwrap().unwrap();
                    (notebook_path_from_relative(std::path::Path::new(&location.notebook.path), &location.memo.relative_path).unwrap(),
                     store.read_memo_content_revision(&memo.id).unwrap())
                };
                assert!(path.is_file());
                assert!(revision.is_none());
            }
            if optimized { new += start.elapsed(); } else { old += start.elapsed(); }
        }
    }
    println!("8 notebooks, 12 Created-event lookups, 6 alternating passes: old_mean_ms={:.1}, new_mean_ms={:.1}, speedup={:.2}x",
        old.as_secs_f64() * 1000.0 / 6.0, new.as_secs_f64() * 1000.0 / 6.0,
        old.as_secs_f64() / new.as_secs_f64());
}
