import { memos } from '@platform/tauri/client';
import { useMemoStore } from '@features/memo/store/memo-store';
import type { NoteReferenceAttrs } from '@features/editor/extensions/note-link/view-note';

export interface MentionNoteItem {
  relativePath: string;
  filename: string;
  title: string;
  updatedAt: number;
  notebookId: string;
  notebookName: string;
  notebookPath: string;
  originalPath: string | null;
}

let cachedItems: MentionNoteItem[] | null = null;
let cachePromise: Promise<MentionNoteItem[]> | null = null;

async function fetchMentionNotes(query: string): Promise<MentionNoteItem[]> {
  const state = useMemoStore.getState();
  if (!state.notebooksInitialized) await state.loadNotebooks();
  const notebooks = useMemoStore.getState().notebooks;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = await Promise.all(notebooks.map(async (notebook) => {
    const notes = await memos.listNotesByPath(notebook.id);
    return notes.filter((note) => !normalizedQuery || note.title.toLocaleLowerCase().includes(normalizedQuery))
      .map((note): MentionNoteItem => ({
        relativePath: note.relativePath,
        filename: note.relativePath.split('/').pop() || note.relativePath,
        title: note.title,
        updatedAt: note.updatedAt,
        notebookId: notebook.id,
        notebookName: notebook.name,
        notebookPath: notebook.path,
        originalPath: null,
      }));
  }));
  return groups.flat().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
}

function loadMentionNotes(): Promise<MentionNoteItem[]> {
  if (cachedItems) return Promise.resolve(cachedItems);
  if (!cachePromise) {
    cachePromise = fetchMentionNotes('')
      .then((items) => {
        cachedItems = items;
        return items;
      })
      .catch((err) => {
        console.warn('[note-mention] load failed:', err);
        cachePromise = null;
        return [];
      });
  }
  return cachePromise;
}

export function invalidateMentionNotes(): void {
  cachedItems = null;
  cachePromise = null;
}

export function queryMentionNotes(query: string): Promise<MentionNoteItem[]> {
  const normalizedQuery = query.trim().toLowerCase();
  return normalizedQuery ? fetchMentionNotes(normalizedQuery) : loadMentionNotes();
}

export function toNoteReferenceAttrs(item: MentionNoteItem): NoteReferenceAttrs {
  return {
    memoId: null,
    notebookId: item.notebookId,
    relativePath: item.relativePath,
    notebookName: item.notebookName,
    title: item.title,
    originalPath: item.originalPath,
    linkStyle: 'flowix',
    linkTarget: null,
    heading: null,
    stale: false,
  };
}
