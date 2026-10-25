import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { reviseCollection } from '@features/collection/model';
import type { MultidimensionalTableDocument, TableView } from './model';
import type { useTableSession } from './use-table-session';
import { removeTableView, resolveTableView } from './view-selection';

interface Options {
  session: Pick<ReturnType<typeof useTableSession>, 'document' | 'saving' | 'loadSequenceRef' | 'isCurrentSession'>;
  save: ReturnType<typeof useTableSession>['save'];
  editable: boolean;
  canDeleteViews: boolean;
  activeViewId: string | null;
  activateView: (id: string) => void;
}

export function useTableViewManagement({ session, save, editable, canDeleteViews, activeViewId, activateView }: Options) {
  const { t } = useI18n();
  const { document, saving, loadSequenceRef, isCurrentSession } = session;
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [editingViewName, setEditingViewName] = useState('');
  const [editingViewWidth, setEditingViewWidth] = useState(48);
  const [managingViewId, setManagingViewId] = useState<string | null>(null);
  const [managingViewName, setManagingViewName] = useState('');
  const [viewPendingDelete, setViewPendingDelete] = useState<TableView | null>(null);
  const editingViewInputRef = useRef<HTMLInputElement | null>(null);
  const editingViewMeasureRef = useRef<HTMLSpanElement | null>(null);
  const managingViewRef = useRef<TableView | null>(null);
  const deletingViewRef = useRef(false);
  useLayoutEffect(() => {
    if (!editingViewId) return;
    const input = editingViewInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editingViewId]);

  useLayoutEffect(() => {
    if (!editingViewId) return;
    const measuredWidth = editingViewMeasureRef.current?.getBoundingClientRect().width;
    if (measuredWidth) setEditingViewWidth(Math.max(40, Math.ceil(measuredWidth + 2)));
  }, [editingViewId, editingViewName, activeViewId]);

  const beginRenameView = useCallback((view: TableView) => {
    setEditingViewName(view.name);
    setEditingViewId(view.id);
  }, []);

  const renameView = useCallback(async (view: TableView, rawName: string) => {
    setEditingViewId(null);
    if (!document || saving) return;
    const trimmedName = rawName.trim();
    if (!trimmedName) {
      toast.error(t('multidimensionalTable.view.nameRequired'));
      return;
    }
    if (trimmedName === view.name) return;
    if (document.views.items.some((item) => item.id !== view.id && item.name === trimmedName)) {
      toast.error(t('multidimensionalTable.view.nameExists'));
      return;
    }
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: document.views.items.map((item) => item.id === view.id ? { ...item, name: trimmedName } : item) },
    };
    await save(next, false, loadSequenceRef.current);
  }, [document, loadSequenceRef, save, saving, t]);

  const manageViewRenameInputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (!managingViewId) return;
    manageViewRenameInputRef.current?.focus();
    manageViewRenameInputRef.current?.select();
  }, [managingViewId]);

  const beginManageViewRename = useCallback((view: TableView) => {
    managingViewRef.current = view;
    setManagingViewName(view.name);
    setManagingViewId(view.id);
  }, []);

  const cancelManageViewRename = useCallback(() => {
    managingViewRef.current = null;
    setManagingViewId(null);
    setManagingViewName('');
  }, []);

  const finishManageViewRename = useCallback((view: TableView, rawName: string) => {
    // Consume the edit before awaiting a save so a subsequent blur cannot submit it again.
    if (managingViewRef.current?.id !== view.id) return;
    cancelManageViewRename();
    return renameView(view, rawName);
  }, [cancelManageViewRename, renameView]);

  const closeViewManagement = useCallback(() => {
    const view = managingViewRef.current;
    if (view) return finishManageViewRename(view, manageViewRenameInputRef.current?.value ?? managingViewName);
    cancelManageViewRename();
  }, [cancelManageViewRename, finishManageViewRename, managingViewName]);

  const deleteView = useCallback(async (view: TableView) => {
    if (!editable || !canDeleteViews || !document || saving || document.views.items.length <= 1 || deletingViewRef.current) return;
    deletingViewRef.current = true;
    try {
      const sequence = loadSequenceRef.current;
      const next = removeTableView(document, view.id);
      if (next === document) return;
      if (await save(next, false, sequence) && isCurrentSession(sequence) && activeViewId === view.id) {
        const fallback = resolveTableView(next);
        if (fallback) activateView(fallback.id);
      }
    } finally {
      deletingViewRef.current = false;
    }
  }, [activeViewId, activateView, canDeleteViews, document, editable, isCurrentSession, loadSequenceRef, save, saving]);

  const requestDeleteView = useCallback((view: TableView) => {
    if (!editable || !canDeleteViews || !document || saving || document.views.items.length <= 1 || deletingViewRef.current) return;
    setViewPendingDelete(view);
  }, [canDeleteViews, document, editable, saving]);

  const cancelDeleteView = useCallback(() => setViewPendingDelete(null), []);

  const confirmDeleteView = useCallback(() => {
    if (!viewPendingDelete || deletingViewRef.current) return;
    const view = viewPendingDelete;
    setViewPendingDelete(null);
    void deleteView(view);
  }, [deleteView, viewPendingDelete]);

  return {
    editingViewId, editingViewName, setEditingViewName, editingViewWidth,
    editingViewInputRef, editingViewMeasureRef, managingViewId, cancelManageViewRename,
    managingViewName, setManagingViewName, manageViewRenameInputRef, closeViewManagement,
    viewPendingDelete, cancelDeleteView, beginRenameView, renameView,
    beginManageViewRename, finishManageViewRename, requestDeleteView, confirmDeleteView,
  };
}
