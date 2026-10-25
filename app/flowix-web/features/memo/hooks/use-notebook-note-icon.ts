import { useNoteMetadata } from './use-note-metadata';

/** The current document shares metadata and recovery with sidebar rows. */
export function useNotebookNoteIcon(filePath: string | null): string | null {
  return useNoteMetadata(filePath ?? '', null, Boolean(filePath))?.icon?.trim() || null;
}
