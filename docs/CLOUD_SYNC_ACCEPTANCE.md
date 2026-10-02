# Cloud sync acceptance

This checklist applies to `flowix-main` and `flowix-cloud` protocol epoch 2. File identity is the notebook ID plus notebook-relative path; local memo IDs are not sync keys.

## Automated gates

| Scenario | Test or command | Result |
|---|---|---|
| Concurrent child edit vs notebook deletion | Cloud `NOTEBOOK_TREE_CONFLICT` actor test | Pass |
| Fixed bootstrap pages while heads change | Cloud frozen snapshot actor test | Pass |
| A/B offline edits, stale push, upload interruption and retry | Cloud HTTP end-to-end test | Pass |
| Nonoverlapping Markdown edits, including adjacent lines | `flowix-sync` merge tests using `diffy` patches | Pass |
| Overlap and same-position insertion | `flowix-sync` conflict tests | Pass |
| Deleted note and attachment restoration | Cloud HTTP end-to-end tests | Pass |
| Move lineage in history | Cloud actor test | Pass |
| Move back to a path whose stable ID is a tombstone | Cloud actor test and `flowix-sync` store test | Pass |
| Rejected move queue cleanup and forced bootstrap | `flowix-sync` store test | Pass |
| Local remote-delete protection | Desktop cloud deletion tests | Pass |
| Remote edit versus pending local move | Native two-instance release gate | Pending |
| Remote edit versus local delete | Native two-instance release gate | Pending |
| Conflict resolution after the common-base blob expires | Native two-instance release gate | Pending |
| Desktop Rust and frontend compilation | `cargo check -p flowix-desktop`, `vite build` | Pass |

Cloud: `npm run check` from `flowix-cloud`. Rust: `CARGO_INCREMENTAL=0 cargo test -p flowix-sync --lib` and `CARGO_INCREMENTAL=0 cargo test -p flowix-desktop --lib commands::cloud::deletion::tests` from `flowix-main/app`.

## Native two-instance release gate

This requires two signed-in desktop instances using the same test account and separate local notebook directories. It has not been executed in this workspace: only one Flowix instance is available, and computer-use permission is unavailable. Do not use the user's active notebook as a test fixture. Validate before general availability:

1. Sync the same nested Markdown file and attachment to A and B, then disconnect both.
2. Edit different Markdown lines on A and B. Reconnect A, then B. Both edits must appear on both clients with no conflict copy.
3. Repeat with overlapping edits. The original must match the accepted remote head; B's work must appear in a named conflict copy and in Cloud preferences. Resolve each choice and confirm both devices converge.
4. Edit an attachment on both clients. Confirm the binary conflict copy, archive, and selected resolution.
5. Move a file on A while B edits its old path offline. Confirm the merged or preserved result at the new path and no silent overwrite.
6. Move A→B→A and confirm the earlier path tombstone is reused with an intact history lineage.
7. Delete a file on A while B edits offline. Confirm B's older revision is preserved as a conflict copy, the remote edit returns at the original path, and both devices converge. Restore a historical revision through Cloud preferences.
8. Interrupt blob upload after reservation and retry. Confirm the same immutable operation can complete without duplicate revisions or lost local bytes.
9. Edit a child on A while B deletes its notebook from an older tree cursor. Confirm `NOTEBOOK_TREE_CONFLICT` and no child loss.
10. Interrupt bootstrap between pages while A changes a head. Confirm all pages share one cursor and the next sync catches the later change.
11. Keep B offline beyond the revision retention period, then create a conflicting edit on A. Confirm B preserves a conflict copy when its common-base blob is no longer available and then converges to A's head.
