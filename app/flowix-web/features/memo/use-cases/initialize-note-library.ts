import { notebookRepository } from '@features/memo/services';
import { getNoteQueryKey } from '@features/memo/services/note-query-key';
import { useNoteStore } from '@features/memo/store/note-store';
import { useTagStore } from '@features/memo/store/tag-store';

/**
 * Owns the main-window critical path: resolve the authoritative notebook and
 * load the first Note query before the UI enters its interactive state.
 *
 * Components may mount before this promise completes, but they must not start
 * their own bootstrap request. This makes startup deterministic while leaving
 * later filtering and notebook switching to their existing flows.
 */
let initializationPromise: Promise<void> | null = null;
let notebookContextPromise: Promise<void> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function performInitialization(startupNotebookId?: string | null): Promise<void> {
  const store = useNoteStore.getState();
  store.setStartupPhase('loading');

  try {
    const notebooks = await notebookRepository.list();
    const latestStore = useNoteStore.getState();
    const persistedNotebookId = startupNotebookId
      ?? latestStore.selectedNotebookId
      ?? latestStore.selectedNotebook?.id
      ?? null;

    latestStore.setNotebooks(notebooks);

    if (notebooks.length === 0) {
      latestStore.setSelectedNotebook(null);
      latestStore.setStartupReady('');
      return;
    }

    const selectedNotebook = notebooks.find(
      (notebook) => notebook.id === persistedNotebookId,
    ) ?? notebooks[0];

    latestStore.setSelectedNotebook(selectedNotebook);

    const current = useNoteStore.getState();
    const selectedTagId = useTagStore.getState().selectedTagId;
    const filter = current.activeFilter;
    const sort = current.activeSort;
    const tagId = filter === 'tagged' ? selectedTagId ?? undefined : undefined;
    const queryKey = getNoteQueryKey(
      selectedNotebook.id,
      filter,
      sort,
      tagId ?? null,
      current.colorFilter,
      current.activePluginId,
      current.activeCustomFilterId,
    );

    const noteLoadApplied = await current.loadNotes({
      notebookId: selectedNotebook.id,
      filter,
      sort,
      tagId,
    });

    if (!noteLoadApplied) {
      // A newer interactive load or memo mutation superseded the startup
      // request. Let the list effect own the current query instead of marking
      // an unverified snapshot as the initial result.
      useNoteStore.getState().setStartupReady('');
      return;
    }

    // A user action should be able to supersede startup. Do not publish a
    // response for a notebook that is no longer selected.
    const afterLoad = useNoteStore.getState();
    const afterLoadQueryKey = getNoteQueryKey(
      afterLoad.selectedNotebook?.id,
      afterLoad.activeFilter,
      afterLoad.activeSort,
      afterLoad.activeFilter === 'tagged'
        ? useTagStore.getState().selectedTagId
        : null,
      afterLoad.colorFilter,
      afterLoad.activePluginId,
      afterLoad.activeCustomFilterId,
    );
    if (
      afterLoad.selectedNotebook?.id !== selectedNotebook.id
      || afterLoadQueryKey !== queryKey
    ) {
      // A notebook navigation transaction won the race while startup was in
      // flight. Let the normal interactive query effect load the latest query.
      afterLoad.setStartupReady('');
      return;
    }

    afterLoad.setStartupReady(queryKey);
  } catch (error) {
    useNoteStore.getState().setStartupPhase('error', errorMessage(error));
    throw error;
  }
}

/** Resolve notebook identity without making the cards query a startup gate. */
async function performNotebookContextInitialization(startupNotebookId?: string | null): Promise<void> {
  const store = useNoteStore.getState();
  store.setStartupPhase('loading');

  try {
    const notebooks = await notebookRepository.list();
    const latestStore = useNoteStore.getState();
    const persistedNotebookId = startupNotebookId
      ?? latestStore.selectedNotebookId
      ?? latestStore.selectedNotebook?.id
      ?? null;

    latestStore.setNotebooks(notebooks);
    if (notebooks.length === 0) {
      latestStore.setSelectedNotebook(null);
      latestStore.setStartupReady('');
      return;
    }

    const selectedNotebook = notebooks.find(
      (notebook) => notebook.id === persistedNotebookId,
    ) ?? notebooks[0];
    latestStore.setSelectedNotebook(selectedNotebook);
    useNoteStore.getState().setStartupReady('');
  } catch (error) {
    useNoteStore.getState().setStartupPhase('error', errorMessage(error));
    throw error;
  }
}

/** Main-window bootstrap shared by cards, folders, and conversations. */
export function initializeNotebookContext(startupNotebookId?: string | null): Promise<void> {
  if (notebookContextPromise) return notebookContextPromise;

  notebookContextPromise = performNotebookContextInitialization(startupNotebookId).finally(() => {
    notebookContextPromise = null;
  });
  return notebookContextPromise;
}

export function initializeNoteLibrary(startupNotebookId?: string | null): Promise<void> {
  if (initializationPromise) return initializationPromise;

  initializationPromise = performInitialization(startupNotebookId).finally(() => {
    initializationPromise = null;
  });
  return initializationPromise;
}
