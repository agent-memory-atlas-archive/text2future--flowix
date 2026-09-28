import { joinNotebookMemoPath } from '@/lib/path';
import { useDocumentStore } from '@features/document/store/document-store';
import { useMemoStore, type Notebook } from '@features/memo/store/memo-store';
import type { MemoItem } from '@/types/memo-item';
import type { PathNoteListItem } from '@/types/memo-item';
import { memos as memosClient } from '@platform/tauri/client';
import { createLogger } from '@/lib/logger';
import {
  openArtifactTarget,
  openExternalTarget,
  openMemoTarget,
} from '@features/workspace/use-cases/workspace-navigation';
import type { WorkspaceContentLocation } from '@features/workspace/use-cases/workspace-content-activation';
import { getPluginNoteInfo } from '@features/plugin/plugin-note';

const logger = createLogger('memo-session');

export interface OpenMemoSessionOptions {
  initialFocus?: 'title' | 'body';
  initialContent?: string;
}

export function resolveMemoSessionPath(memo: MemoItem, notebook: Notebook | null): string | null {
  const relativePath = memo.relativePath || memo.filename;
  return notebook?.path ? joinNotebookMemoPath(notebook.path, relativePath) : relativePath ?? null;
}

/** Open a main-list note by its notebook-relative path, without resolving a
 * memo ID or creating an ID-backed workspace target. */
export async function openPathNoteSession(
  note: PathNoteListItem,
  notebook: Notebook | null,
): Promise<WorkspaceContentLocation | null> {
  if (!notebook?.path || notebook.id !== note.notebookId) return null;
  const fullPath = joinNotebookMemoPath(notebook.path, note.relativePath);
  if (!fullPath) return null;
  const identity = { notebookId: note.notebookId, relativePath: note.relativePath };
  const previousSelection = useMemoStore.getState().selectedPathNote;
  useMemoStore.getState().setSelectedPathNote(identity);
  try {
    return await openExternalTarget(fullPath, { scopePath: notebook.path });
  } catch (error) {
    const selected = useMemoStore.getState().selectedPathNote;
    if (selected?.notebookId === identity.notebookId && selected.relativePath === identity.relativePath) {
      useMemoStore.getState().setSelectedPathNote(previousSelection);
    }
    logger.error('open path note failed', { error, path: fullPath });
    return null;
  }
}

export async function openMemoSession(
  memo: MemoItem,
  notebook: Notebook | null,
  options?: OpenMemoSessionOptions,
): Promise<WorkspaceContentLocation | null> {
  try {
    const pluginNote = getPluginNoteInfo(memo);
    if (pluginNote) {
      return await openArtifactTarget({
        pointerMemoId: memo.id,
        notebook,
        pluginId: pluginNote.pluginId,
        renderer: pluginNote.renderer,
        memo,
      });
    }

    const fullPath = resolveMemoSessionPath(memo, notebook);
    return await openMemoTarget({
      memoId: memo.id,
      path: fullPath,
      notebookId: notebook?.id ?? null,
      notebookPath: notebook?.path ?? null,
      memo,
      notebook,
      initialFocus: options?.initialFocus,
      initialContent: options?.initialContent,
    });
  } catch (error) {
    logger.error('open document failed', { error, memoId: memo.id });
    return null;
  }
}

let restoringMemoId: string | null = null;
let restoringPathNoteKey: string | null = null;

/**
 * Restore the memo persisted by the workspace store exactly once at main
 * window startup. Keeping this orchestration outside MemoList prevents a
 * hover/secondary list instance from reopening a document and avoids a
 * mount-only React effect with captured state.
 */
export async function restorePersistedMemoSession(requestedMemoId?: string | null): Promise<void> {
  const memoState = useMemoStore.getState();
  const pathNote = !requestedMemoId ? memoState.selectedPathNote : null;
  if (pathNote) {
    const pathNoteKey = `${pathNote.notebookId}\u0000${pathNote.relativePath}`;
    if (restoringPathNoteKey === pathNoteKey) return;
    const documentState = useDocumentStore.getState();
    if (documentState.currentDocumentSource === 'external') return;
    const notebook = memoState.selectedNotebook?.id === pathNote.notebookId
      ? memoState.selectedNotebook
      : memoState.notebooks.find((item) => item.id === pathNote.notebookId) ?? null;
    if (!notebook) return;
    const path = joinNotebookMemoPath(notebook.path, pathNote.relativePath);
    if (!path) return;
    restoringPathNoteKey = pathNoteKey;
    try {
      await openExternalTarget(path, { history: 'skip', scopePath: notebook.path });
    } finally {
      if (restoringPathNoteKey === pathNoteKey) restoringPathNoteKey = null;
    }
    return;
  }
  const memoId = requestedMemoId ?? memoState.selectedMemoId ?? memoState.selectedMemo?.id ?? null;
  if (!memoId || restoringMemoId === memoId) return;

  const documentState = useDocumentStore.getState();
  if (documentState.currentDocumentSource === 'external') return;
  if (documentState.activeMemoSession?.memoId === memoId) return;

  restoringMemoId = memoId;
  try {
    // The persisted store contains only the identity. Resolve the current
    // backend entity so filename/properties/plugin metadata are authoritative.
    const memo = memoState.selectedMemo?.id === memoId
      ? memoState.selectedMemo
      : await memosClient.readMemo(memoId);
    if (!memo) {
      useMemoStore.getState().setSelectedMemo(null);
      return;
    }
    useMemoStore.getState().setSelectedMemo(memo);
    await openMemoSession(memo, memoState.selectedNotebook);
  } finally {
    if (restoringMemoId === memoId) restoringMemoId = null;
  }
}
