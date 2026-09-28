use super::*;
use flowix_core::memo_file::extract_frontmatter_key;
use flowix_core::memo_file::MemoFile;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// 构造一�?���?tempdir �?MemoFile, tempdir 模拟 "default notebook"�?
fn fresh_memo_file() -> (MemoFile, PathBuf) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let tmp = std::env::temp_dir().join(format!(
        "flowix-watcher-processor-test-{}-{}-{}",
        std::process::id(),
        n,
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();
    let app_data = tmp.join("app_data");
    let config_dir = tmp.join("config");
    fs::create_dir_all(&app_data).unwrap();
    fs::create_dir_all(&config_dir).unwrap();

    let memo_file = MemoFile::new(config_dir);
    // 把测�?fixture �?nb_test 写进 SQLite ── 没有这条, register_existing_file
    // �?memo index sync 时撞 `memos.notebook_id` -> `notebooks.id` �?        // FOREIGN KEY 失败 (FOREIGN KEY constraint failed)�?        // 不调 set_current_notebook 的话, get_memo_base 走默认路�?        // (~/Documents/flowix) ── register_existing_file / write_index
    // 会写到那�?���? 我们�?tempdir 测试 fixture 失效�?
    let cfg = flowix_core::memo_file::NotebookConfig {
        id: "nb_test".to_string(),
        name: "Test".to_string(),
        icon: None,
        path: format!("{}/", tmp.display()),
        is_default: true,
        sort: 0,
        created_at: 0,
        updated_at: 0,
    };
    let mut memo_file = memo_file;
    memo_file.write_notebook_configs(&[cfg]).unwrap();
    memo_file.set_current_notebook(Some("nb_test".to_string()));
    (memo_file, tmp)
}

fn watch_ctx(base: &Path) -> NotebookWatchContext {
    NotebookWatchContext {
        notebook_id: "nb_test".to_string(),
        root: base.to_path_buf(),
    }
}

#[test]
fn memo_processing_registers_markdown_in_nested_directories() {
    let (mf, base) = fresh_memo_file();
    let ctx = watch_ctx(&base);
    let nested_document = base.join("docs/guide/Reference.md");
    fs::create_dir_all(nested_document.parent().unwrap()).unwrap();
    fs::write(&nested_document, "# Reference\n").unwrap();

    let outcome = dispatch_modify_event(&mf, &ctx, &nested_document, FsEventKind::Create).unwrap();
    assert!(matches!(outcome, DispatchOutcome::Created { .. }));
    assert_eq!(
        mf.read_all_memos()[0].relative_path,
        "docs/guide/Reference.md"
    );
    let v2_entry = mf
        .read_v2_note_entry_by_path("nb_test", "docs/guide/Reference.md")
        .unwrap()
        .unwrap();
    assert_eq!(v2_entry.title, "Reference");
}

/// 写一�?.md �?notebook 根目�? �?register_existing_file 把它登�?
/// �?memo index。返�?(memo, abs_path)�?
fn seed_registered_md(mf: &MemoFile, base: &PathBuf, title: &str) -> (String, PathBuf) {
    let filename = format!("{title}.md");
    let path = base.join(&filename);
    fs::write(
        &path,
        format!("---\ntitle: {title}\n---\n# {title}\n\ninitial body\n"),
    )
    .unwrap();
    // register_existing_file �?��生成 id, 这里�?���?filename
    let _memo = mf.register_existing_file(&path).expect("register ok");
    (filename, path)
}

#[test]
fn dispatch_modify_event_emits_updated_for_registered_file() {
    // (1) 鍑嗗: 涓存椂 notebook + 涓€涓凡娉ㄥ唽 .md
    let (mf, base) = fresh_memo_file();
    let (filename, path) = seed_registered_md(&mf, &base, "Hello");

    // (2) 模拟"vim �?body": 覆写磁盘
    fs::write(&path, format!("# Hello\n\nexternal edit content\n")).unwrap();

    // (3) �?dispatch_modify_event, 期望 Updated
    let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
        .expect("dispatch ok");
    let event = match outcome {
        DispatchOutcome::Updated(e) => e,
        DispatchOutcome::Created { .. } => panic!("expected Updated, got Created"),
    };

    // (4) 鏂█浜嬩欢瀛楁
    match event {
        MemoEvent::Updated {
            id,
            path: ep,
            memo,
            source,
            ..
        } => {
            assert!(!id.is_empty(), "id should not be empty");
            let expected_path = mf
                .get_memo_base()
                .join(&memo.filename)
                .display()
                .to_string();
            assert_eq!(crate::watcher::path::normalize_for_compare(Path::new(&ep)), crate::watcher::path::normalize_for_compare(Path::new(&expected_path)), "path should equal base+filename");
            assert_eq!(memo.filename, filename);
            // preview 来自�?body 的派�?
            assert!(
                memo.preview.contains("external edit content"),
                "preview should reflect new body, got: {}",
                memo.preview
            );
            assert!(matches!(source, MemoChangeSource::ExternalTool));
        }
        other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
    }
}

#[test]
fn dispatch_modify_event_emits_created_for_unregistered_file() {
    // (1) 准�?: 临时 notebook, **�?*注册任何 .md
    let (mf, base) = fresh_memo_file();
    let filename = "Stranger.md";
    let path = base.join(filename);
    fs::write(&path, "# Stranger\n\nnew file content\n").unwrap();

    // (2) �?dispatch_modify_event, 期望 Created + new_abs_path
    let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Create)
        .expect("dispatch ok");
    let (event, new_abs_path) = match outcome {
        DispatchOutcome::Updated(_) => panic!("expected Created, got Updated"),
        DispatchOutcome::Created {
            event,
            new_abs_path,
        } => (event, new_abs_path),
    };

    match event {
        MemoEvent::Created { memo, source, .. } => {
            assert!(!memo.id.is_empty(), "id should be generated");
            assert_eq!(memo.filename, filename);
            assert!(matches!(source, MemoChangeSource::ExternalTool));
        }
        other => panic!("expected Created, got {:?}", std::mem::discriminant(&other)),
    }
    // register_existing_file_for_notebook_id 璧?generate-new-id + stamp 璺緞,
    // new_abs_path 跟原 path 不一定相�?
    assert!(
        new_abs_path.exists(),
        "registered file should exist on disk"
    );
}

#[test]
fn dispatch_modify_event_with_mark_marks_before_register_write_only() {
    // 验证 mark_self_write 在「会写盘的注册分支」之前被调用、在「只读 reload 分支」不调用。
    // 这是 process 移到 worker 线程后关闭 self-write echo race 的关键: stamp 写盘前
    // mark 必须已落抑制表 (见 manager.rs 模块头注释), 否则 stamp 触发的 self-write
    // notify 事件会先于 mark 到达 -> Created 后跟一个冗余 Updated。
    use std::cell::RefCell;
    let (mf, base) = fresh_memo_file();
    let filename = "Stranger.md";
    let path = base.join(filename);
    fs::write(&path, "# Stranger\n\nno frontmatter key\n").unwrap();

    // (1) 未注册文件 (无 key) -> register 分支会 stamp key 写盘: mark 应被调用一次。
    let marked = RefCell::new(Vec::<PathBuf>::new());
    let outcome = dispatch_modify_event_with_mark(
        &mf,
        &watch_ctx(&base),
        &path,
        FsEventKind::Create,
        |p: &Path| marked.borrow_mut().push(p.to_path_buf()),
    )
    .expect("dispatch ok");
    match &outcome {
        DispatchOutcome::Created { .. } => {}
        other => panic!(
            "expected Created (register), got {:?}",
            std::mem::discriminant(other)
        ),
    }
    assert!(marked.borrow().is_empty(), "registration is read-only");

    marked.borrow_mut().clear();
    let outcome = dispatch_modify_event_with_mark(
        &mf,
        &watch_ctx(&base),
        &path,
        FsEventKind::Modify,
        |p: &Path| marked.borrow_mut().push(p.to_path_buf()),
    )
    .expect("dispatch ok");
    match &outcome {
        DispatchOutcome::Updated(_) => {}
        other => panic!(
            "expected Updated (reload), got {:?}",
            std::mem::discriminant(other)
        ),
    }
    assert!(
        marked.borrow().is_empty(),
        "mark must NOT fire on the read-only reload branch"
    );
}

#[test]
fn dispatch_modify_emits_created_when_mcp_already_wrote_the_shared_index() {
    let (mf, base) = fresh_memo_file();
    // MCP/CLI uses a separate MemoFile instance but performs this same
    // file + shared-index write before Desktop observes the fs event.
    let created = mf
        .create_external_memo_for_notebook_id("nb_test", "MCP note", "# MCP note\n", None)
        .expect("mcp-style create");
    let path = base.join(&created.filename);

    // macOS FSEvents reports MemoFile's atomic temp-file rename at the
    // final markdown path as Modify rather than Create.
    let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
        .expect("dispatch ok");

    match outcome {
        DispatchOutcome::Created {
            event: MemoEvent::Created { memo, source, .. },
            ..
        } => {
            assert_eq!(memo.id, created.id);
            assert!(matches!(source, MemoChangeSource::ExternalTool));
        }
        DispatchOutcome::Updated(_) => {
            panic!("MCP-created memo must stay a Created event")
        }
        DispatchOutcome::Created { event, .. } => {
            panic!("expected Created memo event, got {event:?}")
        }
    }
}

#[test]
fn dispatch_modify_event_updated_preserves_id_across_external_edit() {
    // 关键不变�? 外部�?body �? memo index 里这�?entry �?id 不会�?        // (id �?register_existing_file 时生�? 后续 reload �?�� preview/
    // tags/todos/updated_at)銆?
    let (mf, base) = fresh_memo_file();
    let (_, path) = seed_registered_md(&mf, &base, "Note");

    let id1 = mf
        .find_memo_by_filename_for_notebook_id("nb_test", "Note.md")
        .expect("seeded memo")
        .id;

    // 妯℃嫙绗簩娆″閮ㄦ敼
    fs::write(&path, "# Note\n\nsecond edit\n").unwrap();
    let e2 =
        match dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify).unwrap() {
            DispatchOutcome::Updated(e) => e,
            _ => panic!("expected Updated on second dispatch"),
        };
    let id2 = match e2 {
        MemoEvent::Updated { id, .. } => id,
        _ => unreachable!(),
    };

    assert_eq!(id1, id2, "id must be stable across external body edits");
}

#[test]
fn external_create_marker_is_consumed_once_without_reopening_on_quick_edit() {
    let (mf, base) = fresh_memo_file();
    let created = mf
        .create_external_memo_for_notebook_id("nb_test", "MCP note", "# MCP note\n", None)
        .expect("external create");
    let path = base.join(&created.filename);

    let first = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
        .expect("first event");
    assert!(matches!(first, DispatchOutcome::Created { .. }));

    fs::write(&path, "# MCP note\n\nquick external edit\n").unwrap();
    let second = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
        .expect("second event");
    assert!(matches!(second, DispatchOutcome::Updated(_)));
}

/// 回归: 物理删除�? `unregister_and_emit` 必须能从 memo index 查到真实 id
/// 注入�?`MemoEvent::Deleted` 里。物理文件名�?`<title>.md` (id �?    /// 文件名解�?, emit `id=""` 给前�?�?`memos.filter(m => m.id !== "")`
/// 一条都过滤不掉 �?幽灵笔�?。这里直接验证修复后的核心查找逻辑:
/// "�?filename �?memo index entry, 拿到�?id �?register 时生成的 id 一�?�?
#[test]
fn physical_delete_resolves_real_id_from_index() {
    let (mf, base) = fresh_memo_file();
    let (filename, path) = seed_registered_md(&mf, &base, "Ghost");

    // 淇鍓? id=""
    // �??�? id 应�?�?memo index 里这�?entry 的真�?id
    let memo = mf
        .find_memo_by_filename(&filename)
        .expect("seeded entry should be in memo index");
    let real_id = memo.id.clone();

    assert!(
        !real_id.is_empty(),
        "register_existing_file should have generated a non-empty id; got empty"
    );
    // V3 ids come from the memo index rather than the physical filename.
    assert_ne!(real_id, filename, "v3 id must be decoupled from filename");
    // �?��存在 + �?base join 起来等于 expected_abs (unregister_memo_by_path
    // 内部就是这个 invariant guard 通过后才�?entry)
    assert!(
        path.exists(),
        "seeded .md should still be on disk for this test"
    );
    let expected_abs = base.join(&memo.filename);
    assert_eq!(
        expected_abs.canonicalize().ok(),
        path.canonicalize().ok(),
        "abs path should round-trip through base + filename"
    );
}

/// 边界: 一�?*�?���?*�?.md �?��理删�?(用户�?��了未注册文件, �?    /// 我们�?register 完就删了), `unregister_and_emit` 应当**�?*emit
/// `MemoEvent::Deleted` (id 拿不�?,也不�?memo index�?
#[test]
fn physical_delete_for_unregistered_file_is_noop() {
    let (mf, base) = fresh_memo_file();
    let filename = "Stray.md";
    let path = base.join(filename);
    fs::write(&path, "# Stray\n").unwrap();

    // 模拟 unregister_and_emit �?id 查找前置�? filename 不在 memo index
    let looked_up = mf.find_memo_by_filename(filename);
    assert!(
        looked_up.is_none(),
        "unregistered .md must not resolve to a memo index entry"
    );

    // 模拟 unregister �? 同样 no-op
    let removed = mf.unregister_memo_by_path(&path);
    assert!(!removed, "unregister must return false for unknown file");
}

// A confirmed rename pair updates the old path association without reading
// an identity field from Markdown.
#[test]
fn explicit_rename_pair_updates_path_without_identity_field() {
    let (mf, base) = fresh_memo_file();
    let (filename, old_path) = seed_registered_md(&mf, &base, "Original");

    // 抓原�?entry �?id / timestamps
    let original = mf
        .find_memo_by_filename(&filename)
        .expect("seeded entry should exist");
    let original_id = original.id.clone();
    let original_created = original.created_at;
    let original_updated = original.updated_at;

    // Rename the file without changing its contents.
    let new_filename = "Renamed.md".to_string();
    let new_path = base.join(&new_filename);
    std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

    // The watcher supplies both paths to the rename dispatcher.
    let outcome = dispatch_path_rename(&mf, &watch_ctx(&base), &old_path, &new_path)
        .into_iter()
        .next()
        .expect("rename pair")
        .expect("dispatch ok");
    let event = match outcome {
        DispatchOutcome::Updated(e) => e,
        DispatchOutcome::Created { .. } => {
            panic!("expected Updated for confirmed path rename, got Created")
        }
    };

    match event {
        MemoEvent::Updated {
            id,
            path,
            memo,
            source,
            ..
        } => {
            // 关键不变�?── id �?rename 保留
            assert_eq!(
                id, original_id,
                "id must be preserved across confirmed path rename"
            );
            assert_eq!(
                memo.id, original_id,
                "memo.id must match memo index entry id"
            );
            // filename 改成磁盘实际文件�?
            assert_eq!(
                memo.filename, new_filename,
                "filename must reflect post-rename disk state"
            );
            // path 鏄柊浣嶇疆 (rename 鍚庣殑缁濆璺緞)
            assert_eq!(
                path,
                new_path.display().to_string(),
                "emit path must be the post-rename abs path"
            );
            // created_at 淇濈暀 鈹€鈹€ rename_memo_file 涓嶅姩 created_at
            assert_eq!(
                memo.created_at, original_created,
                "created_at must be preserved (rename_memo_file leaves it alone)"
            );
            // updated_at 刷新 ── rename �?��算一次更�?
            assert!(
                memo.updated_at >= original_updated,
                "updated_at should be refreshed on rename"
            );
            assert!(matches!(source, MemoChangeSource::ExternalTool));
        }
        other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
    }

    // 收尾: memo index �?entry.filename 真的更新�?
    let entry_after = mf
        .find_memo_by_filename(&new_filename)
        .expect("new filename should be in memo index after rename");
    assert_eq!(
        entry_after.id, original_id,
        "memo index entry's id must be preserved"
    );
    // �?filename 应�?已经不在 memo index
    assert!(
        mf.find_memo_by_filename(&filename).is_none(),
        "old filename must be removed from memo index after rename"
    );

    // 娓呯悊
    std::fs::rename(&new_path, &old_path).ok();
}

#[test]
fn dispatch_modify_event_rekeys_pasted_duplicate_when_original_still_exists() {
    let (mf, base) = fresh_memo_file();
    let (original_filename, original_path) = seed_registered_md(&mf, &base, "Original");
    let original = mf
        .find_memo_by_filename(&original_filename)
        .expect("seeded entry should exist");
    let original_id = original.id.clone();

    let pasted_filename = "Original Copy.md".to_string();
    let pasted_path = base.join(&pasted_filename);
    std::fs::copy(&original_path, &pasted_path).expect("copy should succeed");

    let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &pasted_path, FsEventKind::Create)
        .expect("dispatch ok");
    let memo = match outcome {
        DispatchOutcome::Created {
            event: MemoEvent::Created { memo, .. },
            ..
        } => memo,
        DispatchOutcome::Updated(_) => panic!("pasted duplicate must emit Created"),
        DispatchOutcome::Created { event, .. } => {
            panic!("expected Created memo event, got {event:?}")
        }
    };

    assert_ne!(memo.id, original_id, "pasted copy must get a fresh id");
    assert_eq!(memo.filename, pasted_filename);
    assert_eq!(
        mf.read_current_memo(&original_id).unwrap().filename,
        original_filename,
        "original memo entry must not be moved"
    );
    let pasted_content = std::fs::read_to_string(&pasted_path).unwrap();
    assert_eq!(
        pasted_content,
        std::fs::read_to_string(&original_path).unwrap()
    );
}

// A pasted file may retain an old `flowix_key` in its authored content.
// Registering its path creates a fresh internal cache ID and leaves the file
// unchanged; the old YAML field is not used as the new identity.
#[test]
fn dispatch_modify_event_registers_orphan_with_new_cache_id() {
    let (mf, base) = fresh_memo_file();

    // 直接造一�?.md �?frontmatter key �?memo index 里没记录�?孤儿"
    let orphan_filename = "Orphan.md".to_string();
    let orphan_path = base.join(&orphan_filename);
    let orphan_id = "abc123";
    std::fs::write(
        &orphan_path,
        format!("---\nflowix_key: {orphan_id}\n---\n# Orphan\n\nbody content\n"),
    )
    .unwrap();

    // 模拟 read_memo 返回 None 的状�?── memo index 干净
    assert!(mf.read_current_memo(orphan_id).is_none());

    // dispatch: 搴斿垱寤烘柊 memo, 涓嶆部鐢ㄧ鐩樻棫 key
    let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &orphan_path, FsEventKind::Create)
        .expect("dispatch ok");
    let memo = match outcome {
        DispatchOutcome::Created {
            event: MemoEvent::Created { memo, .. },
            ..
        } => memo,
        other => panic!("expected Created via (c) path, got {other:?}"),
    };

    assert_ne!(memo.id, orphan_id, "pasted file must get a fresh id");
    assert_eq!(memo.filename, orphan_filename);

    // 收尾: memo index 真的有这�?entry
    assert!(
        mf.read_current_memo(orphan_id).is_none(),
        "old disk key must not be registered in this notebook"
    );
    let entry = mf
        .read_current_memo(&memo.id)
        .expect("fresh id should now be in memo index");
    assert_eq!(entry.id, memo.id);
    let stamped = std::fs::read_to_string(&orphan_path).unwrap();
    assert_eq!(
        extract_frontmatter_key(&stamped),
        Some(orphan_id.to_string())
    );
}

// Simulate a title rename: the old and new paths pass the event filter, then
// the confirmed rename pair updates the existing index association. The
// cache ID and creation time stay with the note without a Markdown ID field.
#[test]
fn gui_title_edit_full_pipeline_preserves_id_and_timestamps() {
    use crate::watcher::filter::{run_pipeline, PathFilter};
    use crate::watcher::whitelist::WhitelistConfig;

    let (mf, base) = fresh_memo_file();
    let (filename, old_path) = seed_registered_md(&mf, &base, "Original");

    // 抓原�?entry �?id / created_at / updated_at
    let original = mf
        .find_memo_by_filename(&filename)
        .expect("seeded entry should exist");
    let original_id = original.id.clone();
    let original_created = original.created_at;
    let original_updated = original.updated_at;

    // ====== Step 1: fs::rename(OLD �?NEW) ── 物理重命�?======
    let new_filename = "Renamed.md".to_string();
    let new_path = base.join(&new_filename);
    std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

    // ====== Step 2a: 妯℃嫙 notify From(OLD) 浜嬩欢杩涘叆 filter pipeline ======
    let whitelist = std::sync::Arc::new(std::sync::RwLock::new(WhitelistConfig::load_or_default()));
    let path_filter = PathFilter {
        whitelist: whitelist.clone(),
    };
    let from_event = RawFsEvent::new(FsEventKind::Remove, old_path.clone());
    let from_decision = run_pipeline(&from_event, &path_filter);
    assert!(
        matches!(from_decision, crate::watcher::event::FilterDecision::Pass),
        "a marker for the old file content must not suppress its removal"
    );

    // ====== Step 2b: 妯℃嫙 notify To(NEW) 浜嬩欢杩涘叆 filter pipeline ======
    let to_event = RawFsEvent::new(FsEventKind::Create, new_path.clone());
    let to_decision = run_pipeline(&to_event, &path_filter);
    assert!(
        matches!(to_decision, crate::watcher::event::FilterDecision::Pass),
        "To(NEW) must pass through filter pipeline (NEW was not marked)"
    );

    // Apply the confirmed old-path/new-path pair.
    let outcome = dispatch_path_rename(&mf, &watch_ctx(&base), &old_path, &new_path)
        .into_iter()
        .next()
        .expect("rename pair")
        .expect("dispatch ok");
    let event = match outcome {
        DispatchOutcome::Updated(e) => e,
        DispatchOutcome::Created { .. } => {
            panic!("GUI rename must emit Updated for confirmed path rename")
        }
    };

    match event {
        MemoEvent::Updated {
            id,
            path,
            memo,
            source: _,
            ..
        } => {
            assert_eq!(id, original_id, "id must be preserved across GUI rename");
            assert_eq!(memo.id, original_id);
            assert_eq!(
                memo.filename, new_filename,
                "filename must reflect post-rename disk state"
            );
            assert_eq!(
                path,
                new_path.display().to_string(),
                "emit path must be the post-rename abs path"
            );
            assert_eq!(
                memo.created_at, original_created,
                "created_at must be preserved (rename_memo_file leaves it alone)"
            );
            assert!(
                memo.updated_at >= original_updated,
                "updated_at should be refreshed on rename"
            );
        }
        other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
    }

    // ====== 鏀跺熬锛歮emo index entry 鐘舵€?======
    let entry_after = mf
        .find_memo_by_filename(&new_filename)
        .expect("new filename should be in memo index after rename");
    assert_eq!(entry_after.id, original_id);
    assert!(
        mf.find_memo_by_filename(&filename).is_none(),
        "old filename must be removed from memo index after rename"
    );

    // 娓呯悊: 鎶婃枃浠舵尓鍥炲幓閬垮厤姹℃煋鍏朵粬娴嬭瘯
    std::fs::rename(&new_path, &old_path).ok();
}

#[test]
fn dispatch_modify_event_emits_updated_when_index_already_renamed() {
    let (mf, base) = fresh_memo_file();
    let (filename, old_path) = seed_registered_md(&mf, &base, "Original");
    let original = mf
        .find_memo_by_filename(&filename)
        .expect("seeded entry should exist");
    let original_id = original.id.clone();
    let original_created = original.created_at;

    let new_filename = "Renamed Already Indexed.md".to_string();
    let new_path = base.join(&new_filename);
    std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

    // Simulate the internal save path winning the race and updating the index
    // before the watcher processes the new-path event.
    let synced = mf
        .sync_memo_filename_from_disk_key(&original_id, &new_path)
        .expect("pre-sync should succeed");
    assert_eq!(synced.filename, new_filename);

    let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &new_path, FsEventKind::Create)
        .expect("dispatch ok");
    let event = match outcome {
        DispatchOutcome::Updated(event) => event,
        DispatchOutcome::Created { .. } => {
            panic!("already-indexed rename must still emit Updated")
        }
    };

    match event {
        MemoEvent::Updated { id, path, memo, .. } => {
            assert_eq!(id, original_id);
            assert_eq!(memo.id, original_id);
            assert_eq!(memo.filename, new_filename);
            assert_eq!(memo.created_at, original_created);
            assert_eq!(
                crate::watcher::path::normalize_for_compare(std::path::Path::new(&path)),
                crate::watcher::path::normalize_for_compare(&new_path)
            );
        }
        other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
    }
}
