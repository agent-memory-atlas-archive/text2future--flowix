use super::*;
use std::fs;

fn fixture() -> (tempfile::TempDir, MemoFile, NotebookWatchContext) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notes");
    fs::create_dir_all(&root).unwrap();
    let mut memo_file = MemoFile::new(temp.path().join("config"));
    memo_file.write_notebook_configs(&[flowix_core::memo_file::NotebookConfig {
        id: "nb_test".into(),
        name: "Test".into(),
        icon: None,
        path: format!("{}/", root.display()),
        is_default: true,
        sort: 0,
        created_at: 0,
        updated_at: 0,
    }]).unwrap();
    memo_file.set_current_notebook(Some("nb_test".into()));
    let ctx = NotebookWatchContext { notebook_id: "nb_test".into(), root };
    (temp, memo_file, ctx)
}

fn assert_path_indexed(outcome: DispatchOutcome, relative_path: &str) {
    match outcome {
        DispatchOutcome::PathIndexed { relative_path: actual } => assert_eq!(actual, relative_path),
    }
}

#[test]
fn external_markdown_is_indexed_without_a_memo_id() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("docs/guide/Reference.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = "# Reference\n\nExternal body\n";
    fs::write(&path, original).unwrap();

    let outcome = dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Create).unwrap();
    assert_path_indexed(outcome, "docs/guide/Reference.md");
    let entry = memo_file.read_note_entry_by_path("nb_test", "docs/guide/Reference.md")
        .unwrap().expect("path entry");
    assert_eq!(entry.title, "Reference");
    assert!(entry.preview.contains("External body"));
    assert!(memo_file.read_all_memos().is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
}

#[test]
fn external_edit_refreshes_the_same_path_entry() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("Note.md");
    fs::write(&path, "# Note\n\nBefore\n").unwrap();
    assert_path_indexed(
        dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Create).unwrap(),
        "Note.md",
    );

    fs::write(&path, "# Note\n\nAfter\n").unwrap();
    assert_path_indexed(
        dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Modify).unwrap(),
        "Note.md",
    );
    let entry = memo_file.read_note_entry_by_path("nb_test", "Note.md")
        .unwrap().expect("updated path entry");
    assert!(entry.preview.contains("After"));
    assert!(memo_file.read_all_memos().is_empty());
}

#[test]
fn removed_markdown_drops_only_its_path_entry() {
    let (_temp, memo_file, ctx) = fixture();
    let removed = ctx.root.join("Removed.md");
    let kept = ctx.root.join("Kept.md");
    fs::write(&removed, "# Removed\n").unwrap();
    fs::write(&kept, "# Kept\n").unwrap();
    dispatch_modify_event(&memo_file, &ctx, &removed, FsEventKind::Create).unwrap();
    dispatch_modify_event(&memo_file, &ctx, &kept, FsEventKind::Create).unwrap();

    fs::remove_file(&removed).unwrap();
    assert_path_indexed(
        dispatch_modify_event(&memo_file, &ctx, &removed, FsEventKind::Remove).unwrap(),
        "Removed.md",
    );
    assert!(memo_file.read_note_entry_by_path("nb_test", "Removed.md").unwrap().is_none());
    assert!(memo_file.read_note_entry_by_path("nb_test", "Kept.md").unwrap().is_some());
    assert!(memo_file.read_all_memos().is_empty());
}

#[test]
fn external_copy_keeps_authored_yaml_without_using_it_as_identity() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("Copied.md");
    let original = "---\nflowix_key: abc12345\n---\n# Copied\n";
    fs::write(&path, original).unwrap();
    assert_path_indexed(
        dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Create).unwrap(),
        "Copied.md",
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert!(memo_file.read_all_memos().is_empty());
    assert!(memo_file.read_note_entry_by_path("nb_test", "Copied.md").unwrap().is_some());
}
