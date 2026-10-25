import { publishNotebookQueryInvalidated } from '@platform/tauri/notebook-change-events';
import { notebooks, type NotebookBackgroundStatus, type NotebookMediaMaintenanceStatus } from '@platform/tauri/client/memos';
import { subscribe } from '@platform/tauri/event-bus';
import { useNotebookBackgroundStore } from '../store/notebook-background-store';
import { useNotebookMediaMaintenanceStore } from '../store/notebook-media-maintenance-store';
import { useNoteStore } from '../store/note-store';

import { createLogger } from '@/lib/logger';
const logger = createLogger('memo/services/notebook-background-service');
/** Subscribe before taking the snapshot; revisions reject late snapshot/event results. */
export function mountNotebookBackgroundUpdates(): () => void {
  let disposed = false;
  const apply = (status: NotebookBackgroundStatus) => {
    if (disposed || !useNotebookBackgroundStore.getState().apply(status)) return;
    useNoteStore.setState((state) => {
      const patch = { ...(status.memoCount === undefined ? {} : { memoCount: status.memoCount }),
        ...(status.missing === undefined ? {} : { missing: status.missing }) };
      return {
        notebooks: state.notebooks.map((notebook) => notebook.id === status.notebookId ? { ...notebook, ...patch } : notebook),
        selectedNotebook: state.selectedNotebook?.id === status.notebookId
          ? { ...state.selectedNotebook, ...patch } : state.selectedNotebook,
      };
    });
    if (status.state === 'ready') publishNotebookQueryInvalidated(status.notebookId);
  };
  const reconcile = () => {
    void notebooks.getBackgroundStatus().then((statuses) => statuses.forEach(apply))
      .catch((error) => logger.warn('Notebook maintenance status unavailable:', error));
  };
  const stop = subscribe<NotebookBackgroundStatus>('flowix:notebook-maintenance', apply, { onListenerReady: reconcile });
  reconcile();
  const applyMedia = (status: NotebookMediaMaintenanceStatus) => {
    if (!disposed) useNotebookMediaMaintenanceStore.getState().apply(status);
  };
  const reconcileMedia = () => {
    void notebooks.getMediaMaintenanceStatus().then((statuses) => statuses.forEach(applyMedia))
      .catch((error) => logger.warn('Media maintenance status unavailable:', error));
  };
  const stopMedia = subscribe<NotebookMediaMaintenanceStatus>(
    'flowix:media-maintenance', applyMedia, { onListenerReady: reconcileMedia },
  );
  reconcileMedia();
  return () => { disposed = true; stop(); stopMedia(); };
}
