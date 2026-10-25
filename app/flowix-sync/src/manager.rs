//! Notebook synchronization composed with an independently owned account service.
use crate::account::{AccountService, PendingLogout};
use crate::client::CloudClient;
use crate::error::SyncError;
use crate::models::*;
use crate::store::SyncStore;
use crate::v2::{
    V2AccountSyncReport, V2Bootstrap, V2Change, V2EntityType, V2FreezeOperation, V2LocalNote,
    V2LocalNotebook, V2OperationKind, V2PushOperation, V2RemoteApply,
};
use chrono::Utc;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone)]
pub struct SyncManager {
    account: AccountService,
    client: CloudClient,
    store: SyncStore,
    account_sync_lock: Arc<tokio::sync::Mutex<()>>,
}

impl SyncManager {
    pub fn account(&self) -> &AccountService {
        &self.account
    }

    fn from_account(account: AccountService) -> Self {
        Self {
            client: account.client().clone(),
            store: account.store().clone(),
            account,
            account_sync_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}

mod account_api;
mod v2_engine;
