/** Read-only access to the notebook the user currently has selected. */
import { useNoteStore, type Notebook } from '@features/memo/store/note-store';

export type { Notebook };

export function getSelectedNotebookSnapshot(): Notebook | null {
  return useNoteStore.getState().selectedNotebook;
}

function sameNotebookIdentity(left: Notebook | null, right: Notebook | null): boolean {
  return left?.id === right?.id
    && left?.name === right?.name
    && left?.path === right?.path
    && left?.missing === right?.missing;
}

/**
 * Observe changes to the selected notebook identity. Only fires when a field
 * that affects notebook-scoped resources changes, not on every store write.
 */
export function subscribeSelectedNotebook(
  listener: (notebook: Notebook | null, previous: Notebook | null) => void,
): () => void {
  return useNoteStore.subscribe((state, previous) => {
    if (!sameNotebookIdentity(state.selectedNotebook, previous.selectedNotebook)) {
      listener(state.selectedNotebook, previous.selectedNotebook);
    }
  });
}
