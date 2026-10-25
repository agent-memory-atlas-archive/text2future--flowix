use super::*;

impl SyncManager {
    async fn bootstrap_v2_snapshot(
        &self,
        access_token: &str,
        enabled_notebooks: &[crate::v2::V2SyncedNotebook],
        cursor: i64,
        generation: u64,
        started_at: i64,
        uploaded: usize,
        deleted: usize,
    ) -> Result<V2AccountSyncReport, SyncError> {
        let bootstrap = self.client.v2_bootstrap_page(access_token, None).await?;
        let enabled_ids: HashSet<_> = enabled_notebooks
            .iter()
            .map(|notebook| notebook.notebook_id.as_str())
            .collect();
        let remote = self
            .remote_from_bootstrap(access_token, &enabled_ids, &bootstrap)
            .await?;
        let complete = bootstrap.next_page_token.is_none();
        let bootstrapped_notebooks = if complete {
            enabled_notebooks
                .iter()
                .map(|notebook| notebook.notebook_id.clone())
                .collect()
        } else {
            Vec::new()
        };

        Ok(V2AccountSyncReport {
            auth_generation: Some(generation),
            started_at,
            cursor: if complete { bootstrap.cursor } else { cursor },
            head_cursor: bootstrap.cursor,
            uploaded,
            deleted,
            remote,
            bootstrapped_notebooks,
            bootstrap_next_page_token: bootstrap.next_page_token,
            read_only: false,
            deferred_notebooks: Vec::new(),
        })
    }

    pub(super) async fn sync_v2_account_once(
        &self,
        access_token: &str,
        notebooks: &[V2LocalNotebook],
        notes: &[V2LocalNote],
        notebook_scope: Option<&str>,
        generation: u64,
    ) -> Result<V2AccountSyncReport, SyncError> {
        let started_at = Utc::now().timestamp_millis();
        let access = self.account.require_sync_access()?;
        let allow_writes = access.can_upload;
        let enabled_notebooks: Vec<_> = self
            .store
            .v2_notebooks(true)?
            .into_iter()
            .filter(|notebook| notebook_scope.is_none_or(|scope| notebook.notebook_id == scope))
            .collect();
        if let Some(scope) = notebook_scope {
            if enabled_notebooks.is_empty() {
                return Err(SyncError::InvalidState(format!(
                    "notebook {scope} is not enabled for cloud sync"
                )));
            }
        }
        let enabled_ids: HashSet<&str> = enabled_notebooks
            .iter()
            .map(|notebook| notebook.notebook_id.as_str())
            .collect();
        let mut self_sync_seqs = if allow_writes {
            self.push_v2_pending_moves(access_token, notebook_scope, generation)
                .await?
        } else {
            HashSet::new()
        };
        // Observe local changes before any pull, including passes without upload capacity.
        {
            let _generation = self.account.require_auth_generation(generation)?;
            self.reconcile_v2_snapshot(&enabled_ids, notebooks, notes)?;
        }
        self.freeze_new_v2_operations(
            access_token,
            notebooks,
            notes,
            notebook_scope,
            generation,
            access,
        )
        .await?;
        let mut due = match notebook_scope {
            Some(scope) => self
                .store
                .v2_inflight_due_for_notebook(Utc::now().timestamp_millis(), scope)?,
            None => self.store.v2_inflight_due(Utc::now().timestamp_millis())?,
        };
        due.retain(|operation| match operation.operation_kind {
            V2OperationKind::Put => access.can_upload,
            V2OperationKind::Delete => access.can_delete,
        });
        let (uploaded, deleted, pushed_seqs) = self
            .push_v2_inflight(access_token, &due, generation)
            .await?;
        self_sync_seqs.extend(pushed_seqs);
        if deleted > 0 && !allow_writes {
            self.account.request_entitlement_refresh();
        }

        let bootstrap_required = enabled_notebooks
            .iter()
            .any(|notebook| notebook.bootstrap_required);
        let cursor = match notebook_scope {
            Some(scope) => self.store.v2_notebook_cursor(scope)?,
            None => self.store.v2_cursor()?,
        };
        let mut report = if bootstrap_required {
            self.bootstrap_v2_snapshot(
                access_token,
                &enabled_notebooks,
                cursor,
                generation,
                started_at,
                uploaded,
                deleted,
            )
            .await?
        } else {
            match self
                .pull_v2_changes(
                    access_token,
                    cursor,
                    &enabled_ids,
                    notebook_scope,
                    &self_sync_seqs,
                )
                .await
            {
                Ok((remote, next_cursor, head_cursor)) => V2AccountSyncReport {
                    auth_generation: Some(generation),
                    started_at,
                    cursor: next_cursor,
                    head_cursor,
                    uploaded,
                    deleted,
                    remote,
                    bootstrapped_notebooks: Vec::new(),
                    bootstrap_next_page_token: None,
                    read_only: false,
                    deferred_notebooks: Vec::new(),
                },
                Err(SyncError::Api {
                    status: 410, code, ..
                }) if code == "CURSOR_EXPIRED" => {
                    self.bootstrap_v2_snapshot(
                        access_token,
                        &enabled_notebooks,
                        cursor,
                        generation,
                        started_at,
                        uploaded,
                        deleted,
                    )
                    .await?
                }
                Err(error) => return Err(error),
            }
        };

        report.read_only = !allow_writes;
        let _generation = self.account.require_auth_generation(generation)?;
        Ok(report)
    }
}
