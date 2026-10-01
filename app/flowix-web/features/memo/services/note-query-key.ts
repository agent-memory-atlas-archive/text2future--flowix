import type { ColorFilterValue } from '@features/memo/store';

export function getNoteQueryKey(
  notebookId: string | undefined,
  filter: string,
  sort: string,
  tagId: string | null,
  colorFilter: ColorFilterValue,
  pluginId?: string | null,
  customFilterId?: string | null,
): string {
  const parts = [
    notebookId ?? '',
    filter,
    sort,
    filter === 'tagged' ? tagId ?? '' : '',
    filter === 'color' ? colorFilter : '',
    pluginId ?? '',
  ];
  if (filter === 'custom') parts.push(customFilterId ?? '');
  return parts.join(':');
}
