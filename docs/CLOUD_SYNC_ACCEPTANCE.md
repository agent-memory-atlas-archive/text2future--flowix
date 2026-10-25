# Cloud sync acceptance

This checklist applies to Cloud protocol epoch 3. A file is identified by the notebook ID and its notebook-relative path. Markdown and attachment files each have an independent index head and blob.

## Release checks

The epoch 3 implementation has not been run through automated or two-device verification in this workspace. Mark these checks complete only after running them against the matching `flowix-main` and `flowix-cloud` builds.

| Scenario | Expected result | Status |
|---|---|---|
| Fresh actor schema | Exactly five application tables: `notes`, `notebooks`, `state`, `operations`, `uploads` | Pending |
| Existing epoch 2 actor | Sync index resets; account and local notebook files remain; legacy objects on the active R2 backend enter delayed cleanup | Pending |
| Bootstrap while files change | Pages use one starting cursor; the follow-up changes request catches concurrent updates and deletions | Pending |
| Compact changes | Each entity returns its latest head after the requested cursor; tombstones remain available | Pending |
| Upload interruption | An incomplete upload cannot become a note head; expired orphan objects are eventually collected | Pending |
| Blob ownership and quota | Each file has its own blob ID; replacing, moving, and deleting files keep usage and ownership correct | Pending |
| Membership note count | Counts live Markdown files and excludes `attachments/` rows | Pending |
| Offline edit conflict | A stale revision is rejected; the entire local version is preserved in a named conflict copy before the current cloud head is applied. Cloud does not have a common base for automatic three-way merging, including for non-overlapping edits. | Pending |
| Notebook deletion race | A child change after `baseTreeSeq` rejects the notebook deletion | Pending |
| Local path archive | Local archived versions remain restorable without a Cloud history endpoint | Pending |

## Two-device release check

Use two signed-in desktop instances with separate local notebook directories. This was not executed in this workspace.

1. Sync a nested Markdown file and an attachment from A to B; verify each has its own cloud index row.
2. Disconnect both devices, edit different Markdown lines, reconnect A and then B, and confirm A's accepted head is applied while B's entire rejected local version is preserved in a named conflict copy. Non-overlapping edits are not automatically merged because Cloud retains only the current head.
3. Repeat with overlapping edits and confirm rejected local bytes remain in a named conflict copy.
4. Edit the same attachment on both devices and confirm the conflict copy and selected resolution are preserved.
5. Move a file on A while B edits its old path offline; confirm the current bytes appear at the moved path without silent loss.
6. Move A→B→A and confirm the path tombstone is reused correctly.
7. Delete a file on A while B edits offline; confirm B's edits are preserved and the current cloud state converges on both devices.
8. Interrupt an upload after reservation, retry, and confirm the pending object is cleaned up without losing local bytes.
9. Edit a child on A while B deletes its notebook from an older tree cursor; confirm `NOTEBOOK_TREE_CONFLICT` and no child loss.
10. Interrupt bootstrap between pages while A changes a file; confirm the next pull catches the change.

The backend reset and matching desktop release must ship together because epoch 3 is incompatible with epoch 2.
