import { useCallback, useEffect, useState } from 'react';
import { system } from '@platform/tauri/client';
import { createLogger } from '@/lib/logger';

const logger = createLogger('notebook-tree-sections');
export type NotebookTreeSection = 'agents' | 'pinned' | 'views' | 'files' | 'repositories';
const sectionListeners = new Set<(notebookId: string, order: NotebookTreeSection[], hidden: NotebookTreeSection[]) => void>();

const DEFAULT_TREE_SECTION_ORDER: NotebookTreeSection[] = ['agents', 'pinned', 'views', 'files', 'repositories'];
const PREVIOUS_DEFAULT_TREE_SECTION_ORDER: NotebookTreeSection[] = ['agents', 'pinned', 'files', 'views'];
const LEGACY_TREE_SECTION_ORDER: NotebookTreeSection[] = ['agents', 'pinned', 'views', 'files'];

function normalizeTreeSectionOrder(value: unknown): NotebookTreeSection[] {
  if (!Array.isArray(value)) return DEFAULT_TREE_SECTION_ORDER;
  const order = value.filter((item, index, items): item is NotebookTreeSection => (
    DEFAULT_TREE_SECTION_ORDER.includes(item as NotebookTreeSection)
    && items.indexOf(item) === index
  ));
  if (order.length === 5) return order;
  if (order.length === 4) {
    if (order.every((item, index) => item === PREVIOUS_DEFAULT_TREE_SECTION_ORDER[index])) {
      return DEFAULT_TREE_SECTION_ORDER;
    }
    if (order.every((item, index) => item === LEGACY_TREE_SECTION_ORDER[index])) {
      return DEFAULT_TREE_SECTION_ORDER;
    }
    return [...order, 'repositories'];
  }
  const legacyOrder = order.filter((item): item is 'files' | 'views' => item === 'files' || item === 'views');
  if (legacyOrder.length === 2) return ['agents', 'pinned', ...legacyOrder, 'repositories'];
  return [...DEFAULT_TREE_SECTION_ORDER.filter((item) => !order.includes(item)), ...order];
}

export function useNotebookTreeSections(notebookId: string | null, isActive: boolean) {
  const [sectionOrder, setSectionOrder] = useState<NotebookTreeSection[]>(DEFAULT_TREE_SECTION_ORDER);
  const [hiddenSections, setHiddenSections] = useState<NotebookTreeSection[]>([]);
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    let updated = false;
    const receiveSections = (id: string, order: NotebookTreeSection[], hidden: NotebookTreeSection[]) => {
      if (id !== notebookId) return;
      updated = true;
      setSectionOrder(order);
      setHiddenSections(hidden);
    };
    sectionListeners.add(receiveSections);
    setSectionOrder(DEFAULT_TREE_SECTION_ORDER);
    setHiddenSections([]);
    if (!notebookId) return () => { cancelled = true; sectionListeners.delete(receiveSections); };
    void system.getNotebookFileTreePreferences(notebookId).then((preferences) => {
      if (cancelled || updated) return;
      setSectionOrder(normalizeTreeSectionOrder(preferences.sectionOrder));
      setHiddenSections((preferences.hiddenSections ?? []).filter((item): item is NotebookTreeSection => DEFAULT_TREE_SECTION_ORDER.includes(item as NotebookTreeSection)));
    }).catch((error) => {
      logger.warn('failed to load notebook file tree preferences', { error, notebookId });
    });
    return () => { cancelled = true; sectionListeners.delete(receiveSections); };
  }, [isActive, notebookId]);

  const updateSections = useCallback((order: NotebookTreeSection[], hidden: NotebookTreeSection[]) => {
    setSectionOrder(order);
    setHiddenSections(hidden);
    if (!notebookId) return;
    sectionListeners.forEach((listener) => listener(notebookId, order, hidden));
    void system.setNotebookFileTreeSectionOrder(notebookId, order, hidden).catch((error) => {
      logger.warn('failed to save notebook tree preferences', { error, notebookId });
    });
  }, [notebookId]);
  return { sectionOrder, hiddenSections, updateSections };
}
