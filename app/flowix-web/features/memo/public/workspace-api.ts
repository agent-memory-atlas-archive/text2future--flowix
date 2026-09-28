import { useShallow } from 'zustand/react/shallow';
import { notebooks as notebooksClient } from '@platform/tauri/client';
import {
  useMemoStore,
  type MemoStore,
  type Notebook,
} from '@features/memo/store/memo-store';
import type { MemoItem } from '@/types/memo-item';

/** Memo-list and notebook-selection capabilities required by workspace flows. */
export type WorkspaceMemoState = Pick<
  MemoStore,
  | 'memos'
  | 'notebooks'
  | 'selectedMemo'
  | 'selectedNotebook'
  | 'selectedNotebookId'
  | 'setMemos'
  | 'setNotebooks'
  | 'setSelectedMemo'
  | 'setSelectedNotebook'
  | 'setActiveFilter'
  | 'setActivePluginId'
  | 'upsertMemo'
  | 'loadMemos'
  | 'loadPathNotes'
  | 'loadNotebooks'
>;

export function getWorkspaceMemoState(): WorkspaceMemoState {
  return useMemoStore.getState();
}

/** Reactive workspace selectors for app-level notebook navigation. */
export function useWorkspaceMemoViewModel() {
  return useMemoStore(useShallow((state) => ({
    selectedNotebook: state.selectedNotebook,
    startupPhase: state.startupPhase,
    setActiveFilter: state.setActiveFilter,
    setActivePluginId: state.setActivePluginId,
    triggerRefresh: state.triggerRefresh,
  })));
}

export function getSelectedWorkspaceNotebookId(): string | null {
  const state = useMemoStore.getState();
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

export type { MemoItem, Notebook };
