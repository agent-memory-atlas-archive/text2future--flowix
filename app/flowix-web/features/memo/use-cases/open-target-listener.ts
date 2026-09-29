/** Route OS path and notebook events to the main window. */

import { subscribe, type UnlistenFn } from '@platform/tauri/event-bus';

import { openNotebookById, openNoteByDeepLink } from './open-by-target';

let currentNotebookUnlisten: UnlistenFn | null = null;
let currentPathUnlisten: UnlistenFn | null = null;

/** Preferences windows do not open documents. */
function isMainWindow(): boolean {
  const hash = window.location.hash;
  return !hash.startsWith('#preferences');
}

/** Repeated mounts replace the previous subscriptions. */
export function mountOpenTargetListener(): void {
  currentPathUnlisten?.();
  currentPathUnlisten = subscribe<string>('flowix:open-path', (path) => {
    if (isMainWindow()) void openNoteByDeepLink(path).catch((error) => {
      console.warn('[openByTarget] path open failed:', error);
    });
  });
  currentNotebookUnlisten?.();
  currentNotebookUnlisten = subscribe<string>('flowix:open-notebook', (notebookId) => {
    if (isMainWindow()) void openNotebookById(notebookId).catch((error) => {
      console.warn('[openByTarget] notebook open failed:', error);
    });
  });
}

export function unmountOpenTargetListener(): void {
  currentNotebookUnlisten?.();
  currentNotebookUnlisten = null;
  currentPathUnlisten?.();
  currentPathUnlisten = null;
}
