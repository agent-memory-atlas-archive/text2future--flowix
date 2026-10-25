import { useCallback, useSyncExternalStore } from 'react';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { useNoteStore } from '../store/note-store';
import { noteMetadata, observeNoteMetadata } from '../services/note-metadata-service';
import type { NoteMetadata } from '../model/note-metadata';

/** Query snapshots seed the projection at their boundary, never during render. */
export function useNoteMetadata(path: string, fallback: NoteMetadata | null | undefined, enabled = true) {
  const notebooks = useNoteStore((state) => state.notebooks);
  const key = canonicalPath(path);
  const notebook = enabled ? notebooks.filter((item) => {
    const root = canonicalDirectoryPath(item.path);
    return key.startsWith(root === '/' ? '/' : `${root}/`);
  }).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
  const notebookId = notebook?.id;
  const notebookPath = notebook?.path;
  const subscribe = useCallback((listener: () => void) => !enabled ? () => {} : notebookId && notebookPath
    ? observeNoteMetadata({ notebookId, notebookPath }, path, listener)
    : noteMetadata.subscribe(path, listener), [path, notebookId, notebookPath, enabled]);
  const getSnapshot = useCallback(() => noteMetadata.get(path), [path]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return snapshot.status === 'deleted' ? null : snapshot.value ?? fallback ?? null;
}
