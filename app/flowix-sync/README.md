# Local Cloud modules

## Ownership

- `account/` owns login sessions, credential persistence and recovery, entitlement verification, AI account APIs and billing APIs. `AccountService` can run without `SyncManager`.
- `account/access.rs` projects verified account data into `CloudSyncAccess`: read, upload, deletion capabilities and a restriction reason. This is the only local module that interprets Cloud sync feature flags and storage entitlement rules.
- `manager/` owns notebook synchronization, local changes, frozen operations and protocol execution. It asks `AccountService` for capabilities and session guards. It does not mutate account state.
- `store/` owns SQLite transactions. Account metadata and sync state currently share the database; account code uses account/session persistence, while the synchronization engine owns queues, revisions and cursors.

The existing `SyncManager` account entrypoints are explicit delegates in `manager/account_api.rs` for API compatibility. New integrations call `sync.account()` for account operations. Session-bound sync work must keep its account generation guard through local application and cursor commit.

## Application boundaries

Desktop remote application is in `flowix-desktop/.../cloud/local_adapter/remote_apply/`:

- `remote_apply.rs` applies remote content to the filesystem and notebook configuration.
- `outcome.rs` defines typed failures and `Applied` / `Deferred` results. Error messages are formatted for the command boundary and must not control retry decisions.
- `policy.rs` protects pending local edits and prepares the applied/deferred report. The store commits the cursor and deferred bootstrap markers atomically.

`CloudState.syncAccess` exposes the native capability projection to the web UI. `flowix-web/lib/cloud-account.ts` selects that projection and grants no access while it is missing. UI components do not re-evaluate membership grants. Cloud remains authoritative and checks its own entitlement ledger on every protected endpoint.

## Checks

- `cargo test --manifest-path app/Cargo.toml -p flowix-sync --lib`
- `cargo test --manifest-path app/Cargo.toml -p flowix-desktop --lib commands::cloud::`
- `npx vitest run app/flowix-web/lib/cloud-account.test.ts app/flowix-web/features/preferences/hooks/use-cloud-account-state.test.tsx`

When the local test transport is routed through a development proxy, exclude `127.0.0.1` and `localhost` for Rust HTTP fixtures.
