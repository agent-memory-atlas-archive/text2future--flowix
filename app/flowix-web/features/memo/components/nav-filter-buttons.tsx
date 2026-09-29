'use client';

import { Filter, Layers, ListTodo, Menu, MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useState, type MouseEvent } from 'react';

import { cn } from '@/lib/utils';
import { useMemoStore } from '@features/memo/store/memo-store';
import { useI18n } from '@/lib/i18n';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import {
  EMPTY_CUSTOM_FILTERS,
  useCustomFilterStore,
  type CustomFilter,
  type CustomFilterOperator,
  type CustomViewDocumentType,
} from '@features/memo/store/custom-filter-store';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  useContextMenuContext,
} from '@shared/ui/context-menu';
import { logNativeContextMenuError, popupNativeContextMenu } from '@platform/tauri/native-context-menu';

interface NavFilterButtonsProps {
  totalMemoCount: number;
  todoMemoCount: number;
  onSelectItem?: () => void;
}

// 顶部过滤器 (笔记 / 待办) ── 从 NoteNavigationPanel 拆出。
// 两个按钮各自把 selectedTagId 清空并切 activeFilter; counts 由父级
// (经 TagTree 的 loadTags -> onCountsChange 上抛) 传入。
// activeFilter / setSelectedTagId / setActiveFilter 直接订阅 store,
// 不再经 props 透传。
export function NavFilterButtons({
  totalMemoCount,
  todoMemoCount,
  onSelectItem,
}: NavFilterButtonsProps) {
  const { t } = useI18n();
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const setActiveFilter = useMemoStore((s) => s.setActiveFilter);
  // 文件夹浏览是和全部 / 待办 / 标签并列的一个入口。浏览资料时
  // activeFilter 为 all 只是中间列的数据兜底，不能让“全部”也显示选中。
  const isFilterActive = (filter: typeof activeFilter) =>
    activeFilter === filter;

  // 三个按钮都委托 setActiveFilter: 它在内部把 activePluginId /
  // selectedTagId 全部归位, 互斥单选语义集中
  // 在一处。无需在这里手动 setSelectedTagId(null), 也不应影响第三列。
  const handleShowAllTags = () => {
    setActiveFilter('all');
    onSelectItem?.();
  };

  const handleShowTaskMemos = () => {
    setActiveFilter('todos');
    onSelectItem?.();
  };

  return (
    // 过滤器 (笔记/待办) ── 占顶部, 与下方标签组以分隔线分开。
    <div className="space-y-0.5 pt-2">
      <div
        role="button"
        tabIndex={0}
        onClick={handleShowAllTags}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleShowAllTags();
          }
        }}
        className={cn(
          'group relative flex h-7 w-full cursor-pointer select-none items-center gap-0 rounded-lg pr-2 text-left text-sm transition-[color]',
          isFilterActive('all')
            ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
            : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
        )}
        style={{ paddingLeft: 6 }}
        aria-pressed={isFilterActive('all')}
      >
        <span className="mr-2 shrink-0 opacity-90">
          <Layers className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate">{t("memo.navigation.allNotes")}</span>
        <span className={cn('ml-2 shrink-0 tabular-nums text-xs', isFilterActive('all') ? 'text-[var(--primary-foreground)]/75' : 'text-[var(--muted-foreground)]')}>
          {totalMemoCount}
        </span>
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={handleShowTaskMemos}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleShowTaskMemos();
          }
        }}
        className={cn(
          'group relative flex h-7 w-full cursor-pointer select-none items-center gap-0 rounded-lg pr-2 text-left text-sm transition-[color]',
          isFilterActive('todos')
            ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
            : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
        )}
        style={{ paddingLeft: 6 }}
        aria-pressed={isFilterActive('todos')}
      >
        <span className="mr-2 shrink-0 opacity-90">
          <ListTodo className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate">{t("memo.list.filterTasks")}</span>
        <span className={cn('ml-2 shrink-0 tabular-nums text-xs', isFilterActive('todos') ? 'text-[var(--primary-foreground)]/75' : 'text-[var(--muted-foreground)]')}>
          {todoMemoCount}
        </span>
      </div>
    </div>
  );
}

interface CustomFilterRowProps {
  filter: CustomFilter;
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function CustomFilterRow({ filter, active, onSelect, onEdit, onDelete }: CustomFilterRowProps) {
  const { t } = useI18n();
  const { openAt } = useContextMenuContext();

  const openFromButton = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openAt(rect.right - 4, rect.bottom);
  };

  return (
    <ContextMenuTrigger asChild>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onContextMenu={(event) => {
          void popupNativeContextMenu(event, [
            { text: t('memo.customFilter.edit'), action: onEdit },
            { text: t('memo.customFilter.delete'), action: onDelete },
          ]).catch((error) => logNativeContextMenuError('custom filter', error));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          'group relative flex h-7 w-full cursor-pointer select-none items-center gap-0 rounded-lg pr-1.5 text-left text-sm transition-[color,background-color]',
          active
            ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
            : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
        )}
        style={{ paddingLeft: 6 }}
        aria-pressed={active}
        title={`${filter.key} ${filter.operator === 'contains' ? t('memo.customFilter.contains') : t('memo.customFilter.equals')} ${filter.value}`}
      >
        <span className="mr-2 shrink-0 opacity-90">
          <Menu className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate">{filter.name}</span>
        <button
          type="button"
          aria-label={t('memo.customFilter.actions')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={openFromButton}
          className={cn(
            'ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none',
            'group-hover:opacity-100',
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </div>
    </ContextMenuTrigger>
  );
}

export function CustomFilterList({ onSelectItem }: { onSelectItem?: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [editingFilter, setEditingFilter] = useState<CustomFilter | null>(null);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [operator, setOperator] = useState<CustomFilterOperator>('contains');
  const [value, setValue] = useState('');
  const [documentType, setDocumentType] = useState<CustomViewDocumentType>('note');
  const [dialogNotebookId, setDialogNotebookId] = useState<string | null>(null);
  const selectedNotebook = useMemoStore((s) => s.selectedNotebook);
  const notebookId = selectedNotebook?.id ?? null;
  const filters = useCustomFilterStore((s) => notebookId ? s.filtersByNotebook[notebookId] ?? EMPTY_CUSTOM_FILTERS : EMPTY_CUSTOM_FILTERS);
  const loadNotebookFilters = useCustomFilterStore((s) => s.loadNotebookFilters);
  const addFilter = useCustomFilterStore((s) => s.addFilter);
  const updateFilter = useCustomFilterStore((s) => s.updateFilter);
  const removeFilter = useCustomFilterStore((s) => s.removeFilter);
  const activeCustomFilterId = useMemoStore((s) => s.activeCustomFilterId);
  const setActiveCustomFilter = useMemoStore((s) => s.setActiveCustomFilter);
  const setActiveFilter = useMemoStore((s) => s.setActiveFilter);
  const triggerRefresh = useMemoStore((s) => s.triggerRefresh);

  useEffect(() => {
    if (notebookId) void loadNotebookFilters(notebookId);
  }, [loadNotebookFilters, notebookId]);

  const reset = useCallback(() => {
    setEditingFilter(null);
    setName('');
    setKey('');
    setOperator('contains');
    setValue('');
    setDocumentType('note');
  }, []);

  useEffect(() => {
    const handleCreateRequest = (event: Event) => {
      const targetNotebookId = (event as CustomEvent<{ notebookId?: string }>).detail?.notebookId ?? notebookId;
      if (!targetNotebookId) return;
      void loadNotebookFilters(targetNotebookId).then(() => {
        reset();
        setDialogNotebookId(targetNotebookId);
        setOpen(true);
      });
    };
    window.addEventListener('flowix:open-custom-filter-create', handleCreateRequest);
    return () => window.removeEventListener('flowix:open-custom-filter-create', handleCreateRequest);
  }, [loadNotebookFilters, notebookId, reset]);

  const openEditDialog = useCallback((filter: CustomFilter, targetNotebookId = notebookId) => {
    setEditingFilter(filter);
    setDialogNotebookId(targetNotebookId);
    setName(filter.name);
    setKey(filter.key);
    setOperator(filter.operator);
    setValue(filter.value);
    setDocumentType(filter.documentType ?? 'note');
    setOpen(true);
  }, [notebookId]);

  useEffect(() => {
    const handleEditRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ filterId?: string; notebookId?: string }>).detail;
      const targetNotebookId = detail?.notebookId ?? notebookId;
      if (!targetNotebookId) return;
      void loadNotebookFilters(targetNotebookId).then(() => {
        const filter = useCustomFilterStore.getState().filtersByNotebook[targetNotebookId]
          ?.find((item) => item.id === detail?.filterId);
        if (filter) openEditDialog(filter, targetNotebookId);
      });
    };
    window.addEventListener('flowix:open-custom-filter-edit', handleEditRequest);
    return () => window.removeEventListener('flowix:open-custom-filter-edit', handleEditRequest);
  }, [loadNotebookFilters, notebookId, openEditDialog]);

  const handleSubmit = () => {
    const nextName = name.trim();
    const nextKey = key.trim();
    const nextValue = value.trim();
    const targetNotebookId = dialogNotebookId ?? notebookId;
    if (!nextName || (documentType === 'note' && (!nextKey || !nextValue)) || !targetNotebookId) return;
    const nextFilter = { name: nextName, documentType, key: documentType === 'note' ? nextKey : '', operator, value: documentType === 'note' ? nextValue : '' };
    if (editingFilter) {
      updateFilter(targetNotebookId, editingFilter.id, nextFilter);
      if (notebookId === targetNotebookId && activeCustomFilterId === editingFilter.id) triggerRefresh();
    } else {
      const id = addFilter(targetNotebookId, nextFilter);
      if (notebookId === targetNotebookId) setActiveCustomFilter(id);
    }
    setOpen(false);
    reset();
  };

  const handleDelete = (filter: CustomFilter) => {
    if (activeCustomFilterId === filter.id) setActiveFilter('all');
    if (notebookId) removeFilter(notebookId, filter.id);
  };

  return (
    <>
      {filters.length > 0 && (
        <div className="mt-1 pt-1">
          <div className="px-1 pb-1 pt-1 text-xs font-medium text-[var(--muted-foreground)]">
            {t('memo.customFilter.section')}
          </div>
          <div className="space-y-0.5">
            {filters.map((filter) => (
          <ContextMenu key={filter.id}>
            <CustomFilterRow
              filter={filter}
              active={activeCustomFilterId === filter.id}
              onSelect={() => {
                setActiveCustomFilter(filter.id);
                onSelectItem?.();
              }}
              onEdit={() => openEditDialog(filter)}
              onDelete={() => handleDelete(filter)}
            />
            <ContextMenuContent className="w-[160px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              <ContextMenuItem
                onClick={() => openEditDialog(filter)}
                className="h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                {t('memo.customFilter.edit')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleDelete(filter)}
                className="h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-transparent hover:text-[var(--destructive)]"
              >
                {t('memo.customFilter.delete')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
            ))}
          </div>
        </div>
      )}
      <Dialog open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen) reset(); }}>
        <DialogContent rightSide>
          <DialogHeader>
            <DialogTitle>{t(editingFilter ? 'memo.customFilter.editTitle' : 'memo.customFilter.title')}</DialogTitle>
            <DialogDescription>{t('memo.customFilter.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1 text-sm">
              <span className="text-sm font-semibold text-[var(--foreground)]">{t('memo.customFilter.name')}</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('memo.customFilter.namePlaceholder')} autoFocus />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="text-sm font-semibold text-[var(--foreground)]">{t('memo.customFilter.documentType')}</span>
              <select value={documentType} onChange={(event) => setDocumentType(event.target.value as CustomViewDocumentType)} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus:border-[var(--primary)]">
                <option value="note">{t('memo.customFilter.typeNote')}</option>
                <option value="image">{t('memo.customFilter.typeImage')}</option>
                <option value="video">{t('memo.customFilter.typeVideo')}</option>
              </select>
            </label>
            {documentType === 'note' && <>
              <label className="block space-y-1 text-sm">
                <span className="text-sm font-semibold text-[var(--foreground)]">{t('memo.customFilter.key')}</span>
                <Input value={key} onChange={(event) => setKey(event.target.value)} placeholder={t('memo.customFilter.keyPlaceholder')} />
              </label>
              <div className="grid grid-cols-[1fr_1.4fr] gap-2">
                <label className="space-y-1 text-sm">
                  <span className="text-sm font-semibold text-[var(--foreground)]">{t('memo.customFilter.condition')}</span>
                  <select value={operator} onChange={(event) => setOperator(event.target.value as CustomFilterOperator)} className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus:border-[var(--primary)]">
                    <option value="contains">{t('memo.customFilter.contains')}</option>
                    <option value="equals">{t('memo.customFilter.equals')}</option>
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-sm font-semibold text-[var(--foreground)]">{t('memo.customFilter.value')}</span>
                  <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder={t('memo.customFilter.valuePlaceholder')} />
                </label>
              </div>
            </>}
            <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('memo.customFilter.cancel')}</Button>
              <Button type="button" onClick={handleSubmit} disabled={!name.trim() || (documentType === 'note' && (!key.trim() || !value.trim()))}>{t(editingFilter ? 'memo.customFilter.save' : 'memo.customFilter.create')}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CustomFilterFooter() {
  const { t } = useI18n();

  return (
    <div className="mt-auto shrink-0 border-t border-[var(--border)] px-2 py-2">
      <Button
        type="button"
        variant="outline"
        className="w-full justify-center gap-2 bg-white px-3 text-sm hover:bg-white [[data-theme='dark']_&]:bg-[var(--card)] [[data-theme='dark']_&]:hover:bg-[var(--hover-bg)]"
        onClick={() => window.dispatchEvent(new CustomEvent('flowix:open-custom-filter-create'))}
      >
        <Filter className="size-3.5" />
        <span>{t('memo.customFilter.button')}</span>
      </Button>
    </div>
  );
}
