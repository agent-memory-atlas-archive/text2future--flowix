import { useShallow } from 'zustand/react/shallow';
import { notebooks as notebooksClient } from '@platform/tauri/client';
import {
  useNoteStore,
  type NoteLibraryStore,
  type Notebook,
} from '@features/memo/store/note-store';

/** Memo-list and notebook-selection capabilities required by workspace flows. */
export type WorkspaceMemoState = Pick<
  NoteLibraryStore,
  | 'notebooks'
  | 'selectedNotebook'
  | 'selectedNotebookId'
  | 'selectedNote'
  | 'setNotebooks'
  | 'setSelectedNotebook'
  | 'setSelectedNote'
  | 'setActiveFilter'
  | 'setActivePluginId'
  | 'loadNotes'
  | 'loadNotebooks'
>;

export function getWorkspaceMemoState(): WorkspaceMemoState {
  return useNoteStore.getState();
}

/** Reactive workspace selectors for app-level notebook navigation. */
export function useWorkspaceMemoViewModel() {
  return useNoteStore(useShallow((state) => ({
    selectedNotebook: state.selectedNotebook,
    startupPhase: state.startupPhase,
    setActiveFilter: state.setActiveFilter,
    setActivePluginId: state.setActivePluginId,
    triggerRefresh: state.triggerRefresh,
  })));
}

export function getSelectedWorkspaceNotebookId(): string | null {
  const state = useNoteStore.getState();
  return state.selectedNotebookId ?? state.selectedNotebook?.id ?? null;
}

// The navigation transaction and the main-window synchronization effect can
// observe the same selection change. Keep the last successful native sync so
// the effect does not start a second migration pass for the same notebook.
let lastPersistedWorkspaceNotebookId: string | null | undefined;

export function getLastPersistedWorkspaceNotebookId(): string | null | undefined {
  return lastPersistedWorkspaceNotebookId;
}

/** Persist the notebook selected by a workspace navigation transaction. */
export async function setCurrentWorkspaceNotebook(
  notebook: Pick<Notebook, 'id'> | string | null,
): Promise<void> {
  const notebookId = typeof notebook === 'string' ? notebook : notebook?.id ?? null;
  await notebooksClient.setCurrent(notebookId);
  lastPersistedWorkspaceNotebookId = notebookId;
}

export type { Notebook };
