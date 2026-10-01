import type { ColorFilterValue } from '@features/memo/store';
import { getNoteQueryKey } from '@features/memo/services/note-query-key';

export function getMemoListQueryKey(
  notebookId: string | undefined,
  filter: string,
  sort: string,
  tagId: string | null,
  colorFilter: ColorFilterValue,
  pluginId?: string | null,
  customFilterId?: string | null,
): string {
  return getNoteQueryKey(notebookId, filter, sort, tagId, colorFilter, pluginId, customFilterId);
}

export function shouldShowMemoListLoading({
  selectedNotebookId,
  isMemoListLoading,
  currentMemoListQueryKey,
  loadedMemoListQueryKey,
}: {
  selectedNotebookId: string | undefined;
  isMemoListLoading: boolean;
  currentMemoListQueryKey: string;
  loadedMemoListQueryKey: string | null;
}): boolean {
  if (!selectedNotebookId) return false;
  return isMemoListLoading || currentMemoListQueryKey !== loadedMemoListQueryKey;
}
