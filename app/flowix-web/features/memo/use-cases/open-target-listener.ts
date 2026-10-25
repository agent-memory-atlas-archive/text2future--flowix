/** Route OS path and notebook events to the main window. */

import { subscribe, type UnlistenFn } from '@platform/tauri/event-bus';

import { openNotebookById, openNoteByDeepLink } from './open-by-target';
import { toast } from '@/lib/toast';
import { subscribePendingOpenTargets } from '@platform/open-target/pending-requests';
import { createLogger } from '@/lib/logger';

const logger = createLogger('openByTarget');

let currentNotebookUnlisten: UnlistenFn | null = null;
let currentPathUnlisten: UnlistenFn | null = null;

/** Preferences windows do not open documents. */
function isMainWindow(): boolean {
  const hash = window.location.hash;
  return !hash.startsWith('#preferences');
}

/** Repeated mounts replace the previous subscriptions. */
export function mountOpenTargetListener(whenReady: Promise<void> = Promise.resolve()): void {
  currentPathUnlisten?.();
  currentPathUnlisten = subscribePendingOpenTargets('path', async ({ target }) => {
    if (!isMainWindow()) return;
    if (target.kind === 'error') { toast.error(target.message); return; }
    if (target.kind !== 'path') return;
    await whenReady;
    try { await openNoteByDeepLink(target.path); }
    catch (error) {
      logger.warn('path open failed', { error });
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });
  currentNotebookUnlisten?.();
  currentNotebookUnlisten = subscribe<string>('flowix:open-notebook', (notebookId) => {
    if (isMainWindow()) void openNotebookById(notebookId).catch((error) => {
      logger.warn('notebook open failed:', error);
    });
  });
}

export function unmountOpenTargetListener(): void {
  currentNotebookUnlisten?.();
  currentNotebookUnlisten = null;
  currentPathUnlisten?.();
  currentPathUnlisten = null;
}
