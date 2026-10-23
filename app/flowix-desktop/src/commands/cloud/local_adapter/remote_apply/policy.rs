use super::*;

/// A deferred entity keeps its old baseline and local bytes. Its notebook is
/// durably marked for another bootstrap in the same transaction as the cursor.
pub(crate) fn apply_v2_report_preserving_local(
    state: &AppState,
    app: &AppHandle,
    report: &mut V2AccountSyncReport,
) -> Result<(), String> {
    if !report.read_only {
        return apply_v2_report(state, app, report).map_err(|error| error.to_string());
    }
    let configs = read_lock(&state.memo_file, "memo_file")
        .read_notebook_configs()
        .map_err(sync_error)?;
    let deleted_notebooks: HashSet<_> = report
        .remote
        .iter()
        .filter_map(|change| match change {
            V2RemoteApply::Notebook {
                notebook_id,
                deleted: true,
                ..
            } => Some(notebook_id.clone()),
            _ => None,
        })
        .collect();
    let mut metadata_changed = HashSet::new();
    let mut locally_changed = HashSet::new();
    for dirty in state
        .cloud_sync
        .store()
        .v2_dirty_entities()
        .map_err(sync_error)?
    {
        if let Some(notebook_id) = dirty.notebook_id {
            locally_changed.insert(notebook_id);
        }
        if dirty.entity_type == flowix_sync::V2EntityType::Notebook {
            locally_changed.insert(dirty.entity_id.clone());
            metadata_changed.insert(dirty.entity_id);
        }
    }
    for notebook in configs {
        let baseline = state
            .cloud_sync
            .store()
            .v2_notebook_state(&notebook.id)
            .map_err(sync_error)?;
        let hash = flowix_sync::v2_notebook_metadata_hash(
            &notebook.name,
            notebook.icon.as_deref(),
            notebook.sort,
        );
        if baseline
            .as_ref()
            .is_none_or(|baseline| baseline.deleted || baseline.metadata_hash != hash)
        {
            locally_changed.insert(notebook.id.clone());
            metadata_changed.insert(notebook.id);
        }
    }
    // Full content scans are only needed before deleting an entire notebook.
    // Ordinary pulls and metadata updates do not scan unrelated notebooks.
    for notebook_id in &deleted_notebooks {
        let (_, notes) = v2_account_snapshot(state, true, Some(notebook_id))?;
        for note in notes {
            let baseline = state
                .cloud_sync
                .v2_note_state(&note.id)
                .map_err(sync_error)?;
            if baseline.as_ref().is_none_or(|baseline| {
                baseline.deleted
                    || baseline.content_hash.as_deref()
                        != Some(v2_content_hash(&note.content).as_str())
                    || baseline.attachments
                        != note
                            .attachments
                            .iter()
                            .map(|item| item.metadata.clone())
                            .collect::<Vec<_>>()
            }) {
                locally_changed.insert(note.notebook_id);
            }
        }
    }
    let moves = state.cloud_sync.v2_pending_moves().map_err(sync_error)?;
    let mut moving_notes = HashSet::new();
    for movement in moves {
        locally_changed.insert(movement.notebook_id);
        moving_notes.insert(movement.from_note_id);
        moving_notes.insert(movement.to_note_id);
    }
    let protected_deletions: HashSet<_> = report
        .remote
        .iter()
        .filter_map(|change| match change {
            V2RemoteApply::Notebook {
                notebook_id,
                deleted: true,
                ..
            } if locally_changed.contains(notebook_id) => Some(notebook_id.clone()),
            _ => None,
        })
        .collect();
    apply_read_only_changes(
        report,
        &metadata_changed,
        &protected_deletions,
        &moving_notes,
        |change| {
            let mut single = V2AccountSyncReport::default();
            single.remote.push(change.clone());
            single.read_only = true;
            RemoteApplyOutcome::from_result(apply_v2_report(state, app, &single))
        },
    )
    .map_err(|error| error.to_string())
}

fn apply_read_only_changes(
    report: &mut V2AccountSyncReport,
    metadata_changed: &HashSet<String>,
    protected_deletions: &HashSet<String>,
    moving_notes: &HashSet<String>,
    mut apply: impl FnMut(&V2RemoteApply) -> Result<RemoteApplyOutcome, RemoteApplyError>,
) -> Result<(), RemoteApplyError> {
    let mut applied = Vec::new();
    let mut changes: Vec<_> = report.remote.iter().collect();
    // Apply note deletions before removing their notebook configuration.
    changes.sort_by_key(|change| matches!(change, V2RemoteApply::Notebook { .. }));
    for change in changes {
        let (notebook_id, protected) = match change {
            V2RemoteApply::Notebook {
                notebook_id,
                deleted,
                ..
            } => (
                notebook_id,
                metadata_changed.contains(notebook_id)
                    || (*deleted && report.deferred_notebooks.contains(notebook_id)),
            ),
            V2RemoteApply::Note {
                notebook_id,
                note_id,
                ..
            } => (notebook_id, moving_notes.contains(note_id)),
        };
        let deferred = if protected || protected_deletions.contains(notebook_id) {
            true
        } else {
            matches!(apply(change)?, RemoteApplyOutcome::Deferred(_))
        };
        if deferred {
            report.deferred_notebooks.push(notebook_id.clone());
        } else {
            applied.push(change.clone());
        }
    }
    report.remote = applied;
    report.deferred_notebooks.sort();
    report.deferred_notebooks.dedup();
    Ok(())
}

#[cfg(test)]
mod read_only_tests {
    use super::*;

    fn note(id: &str) -> V2RemoteApply {
        V2RemoteApply::Note {
            note_id: id.into(),
            notebook_id: "nb".into(),
            filename: format!("{id}.md"),
            content_hash: None,
            content: None,
            revision: "remote".into(),
            sync_seq: 10,
            deleted: false,
            attachments: Vec::new(),
        }
    }
    fn notebook(deleted: bool) -> V2RemoteApply {
        V2RemoteApply::Notebook {
            notebook_id: "nb".into(),
            name: Some("Old cloud name".into()),
            icon: None,
            sort_order: Some(0),
            revision: "remote".into(),
            sync_seq: 10,
            deleted,
        }
    }

    #[test]
    fn local_notebook_rename_is_preserved_while_other_content_is_applied() {
        let mut report = V2AccountSyncReport::default();
        report.remote = vec![notebook(false), note("clean")];
        let mut applied_notes = 0;
        apply_read_only_changes(
            &mut report,
            &HashSet::from(["nb".into()]),
            &HashSet::new(),
            &HashSet::new(),
            |change| {
                assert!(matches!(change, V2RemoteApply::Note { .. }));
                applied_notes += 1;
                Ok(RemoteApplyOutcome::Applied)
            },
        )
        .unwrap();
        assert_eq!(applied_notes, 1);
        assert_eq!(report.remote.len(), 1);
        assert_eq!(report.deferred_notebooks, ["nb"]);
    }

    #[test]
    fn a_conflicting_note_does_not_block_clean_notes_or_advance_its_baseline() {
        let mut report = V2AccountSyncReport::default();
        report.cursor = 10;
        report.remote = vec![note("edited"), note("clean")];
        apply_read_only_changes(
            &mut report,
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
            |change| {
                if matches!(change, V2RemoteApply::Note { note_id, .. } if note_id == "edited") {
                    Ok(RemoteApplyOutcome::Deferred(RemoteConflict::LocalEdit))
                } else {
                    Ok(RemoteApplyOutcome::Applied)
                }
            },
        )
        .unwrap();
        assert_eq!(report.cursor, 10);
        assert_eq!(report.deferred_notebooks, ["nb"]);
        assert!(
            matches!(&report.remote[..], [V2RemoteApply::Note { note_id, .. }] if note_id == "clean")
        );
    }

    #[test]
    fn notebook_deletion_waits_when_one_of_its_notes_conflicts() {
        let mut report = V2AccountSyncReport::default();
        report.remote = vec![notebook(true), note("edited")];
        apply_read_only_changes(
            &mut report,
            &HashSet::new(),
            &HashSet::new(),
            &HashSet::new(),
            |change| {
                assert!(matches!(change, V2RemoteApply::Note { .. }));
                Ok(RemoteApplyOutcome::Deferred(RemoteConflict::NoteDelete))
            },
        )
        .unwrap();
        assert!(report.remote.is_empty());
        assert_eq!(report.deferred_notebooks, ["nb"]);
    }
}
