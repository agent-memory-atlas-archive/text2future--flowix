import { setDocumentProperties } from '@features/document/public/path-properties';
import {
  memos,
  notebooks,
  type FilterType,
  type MemoColorFilter,
  type PathNoteListPage,
  type NotebookSortEntry,
  type SortType,
} from '@platform/tauri/client';
import type { MemoColor } from '@/types/memo-item';
import type { Notebook } from '@features/memo/store/memo-store';

export type { FilterType, SortType } from '@platform/tauri/client';

export const memoRepository = {
  listByPath: (params: {
    notebookId: string;
    filter?: FilterType;
    sort?: SortType;
    tagId?: string;
    color?: MemoColorFilter;
    cursor?: string;
    limit?: number;
  }): Promise<PathNoteListPage> => memos.getPathNotes(params),
  listAllByPath: (notebookId: string) => memos.listNotesByPath(notebookId),
  create: (tag: string | undefined, notebookId: string, parentRelativePath?: string, title?: string) =>
    memos.addPathDocument(notebookId, tag, parentRelativePath, title),
  delete: (path: string) => memos.deleteMemo(path),
  favorite: (path: string, _expectedCacheId?: string) => setDocumentProperties(path, { flowix_favorited: true }),
  unfavorite: (path: string, _expectedCacheId?: string) => setDocumentProperties(path, { flowix_favorited: false }),
  setColors: (path: string, colors: MemoColor[], _expectedCacheId?: string) => setDocumentProperties(path, { flowix_colors: colors }),
};

export const notebookRepository = {
  list: (): Promise<Notebook[]> => notebooks.getAll(),
  getDefaultPath: (name: string) => notebooks.getDefaultPath(name),
  ensureDefaultPath: (name: string) => notebooks.ensureDefaultPath(name),
  create: (name: string, path?: string, icon?: string | null, activate = true) =>
    notebooks.create(name, path, icon, activate),
  createFromCloud: (id: string, name: string, path: string, icon?: string | null) =>
    notebooks.createFromCloud(id, name, path, icon),
  startImport: (notebookId: string) => notebooks.startImport(notebookId),
  getImportStatus: (notebookId: string) => notebooks.getImportStatus(notebookId),
  update: (id: string, name?: string, icon?: string | null) =>
    notebooks.update(id, name, icon),
  /**
   * Reorder notebooks by submitting (id, sort) pairs to the backend.
   * `order` is the desired final sequence (id in the order it should appear);
   * sort values are assigned by the caller (typically `index * 10`).
   * Returns the freshly ordered notebook list.
   */
  reorder: (order: NotebookSortEntry[]) => notebooks.reorder(order),
};
