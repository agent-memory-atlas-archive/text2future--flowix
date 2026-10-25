import { create } from 'zustand';
import type { ContentKind } from '@features/content/public/content-api';

export const EMPTY_SELECTION_CONTENT_KINDS: ReadonlyMap<string, ContentKind> = new Map();

/** Transient projection of the active access-space selection for the work column. */
export const useNotebookTreeSelectionStore = create<{
  owner: symbol | null;
  count: number;
  paths: readonly string[];
  contentKinds: ReadonlyMap<string, ContentKind>;
}>(() => ({ owner: null, count: 0, paths: [], contentKinds: EMPTY_SELECTION_CONTENT_KINDS }));

export function useAccessSpaceSelectionCount() {
  return useNotebookTreeSelectionStore((state) => state.count);
}

export function useAccessSpaceSelectedPaths() {
  return useNotebookTreeSelectionStore((state) => state.paths);
}

export function useAccessSpaceSelectionContentKinds() {
  return useNotebookTreeSelectionStore((state) => state.contentKinds);
}
