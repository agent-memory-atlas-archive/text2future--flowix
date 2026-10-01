import { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, Grid2X2, Inbox } from 'lucide-react';
import { files, type DocumentPageItem, type FileBrowserDirectoriesChangedEvent } from '@platform/tauri/client';
import { externalFileViewKind, fileExtension, isCodeTextFilePath, resourceKindFromPath } from '@features/editor/public/code-file';
import { toast } from '@/lib/toast';
import { canonicalPath } from '@/lib/path';
import { useCustomFilterStore } from '@features/memo/store/custom-filter-store';
import { subscribe } from '@platform/tauri/event-bus';
import { createLogger } from '@/lib/logger';
import { setDocumentProperties } from '@features/document/public/path-properties';
import { Dialog, DialogContent, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import { useI18n } from '@/lib/i18n';
import { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
import type { DocumentListSurface } from './types';
import documentCardPlaceholder from '@/assets/placeholder-document-card.jpg';
import imageCardPlaceholder from '@/assets/placeholder-image-card.jpg';
import videoCardPlaceholder from '@/assets/placeholder-video-card.jpg';
import codeCardPlaceholder from '@/assets/placeholder-code-card.jpg';
import pdfCardPlaceholder from '@/assets/placeholder-pdf-card.jpg';
import pptCardPlaceholder from '@/assets/placeholder-ppt-card.jpg';
import excelCardPlaceholder from '@/assets/placeholder-excel-card.jpg';
import otherCardPlaceholder from '@/assets/placeholder-other-card.jpg';
import folderCardPlaceholder from '@/assets/placeholder-folder-card.png';

const logger = createLogger('document-list-view');
function cardPlaceholder(item: DocumentPageItem): string {
  if (item.resourceKind === 'folder') return folderCardPlaceholder;
  const extension = fileExtension(item.name);
  if (item.resourceKind === 'note' || extension === 'md' || extension === 'markdown') return documentCardPlaceholder;
  if (item.resourceKind === 'image') return imageCardPlaceholder;
  if (item.resourceKind === 'video') return videoCardPlaceholder;
  if (extension === 'pdf') return pdfCardPlaceholder;
  if (['ppt', 'pptx', 'pps', 'ppsx', 'odp'].includes(extension)) return pptCardPlaceholder;
  if (['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods'].includes(extension)) return excelCardPlaceholder;
  if (isCodeTextFilePath(item.fullPath)) return codeCardPlaceholder;
  return otherCardPlaceholder;
}

function formatUpdatedAgo(timestamp: number | null): string {
  if (!timestamp) return '更新时间未知';
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return '更新 刚刚';
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `更新 ${elapsedMinutes}分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `更新 ${elapsedHours}小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `更新 ${elapsedDays}天前`;
  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `更新 ${elapsedMonths}个月前`;
  return `更新 ${Math.floor(elapsedMonths / 12)}年前`;
}

function DocumentCard({ item, notebookPath, onOpen }: { item: DocumentPageItem; notebookPath: string; onOpen: () => Promise<void> }) {
  const kind = item.resourceKind === 'folder' ? 'other' : externalFileViewKind(item.fullPath);
  const placeholder = cardPlaceholder(item);
  const [preview, setPreview] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    const request = kind === 'image'
      ? files.readImage(item.fullPath, notebookPath)
      : Promise.resolve(null);
    void request.then((value) => { if (!cancelled) setPreview(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [item.fullPath, kind, notebookPath]);
  const image = <img
    src={kind === 'image' && preview ? preview : placeholder}
    alt=""
    loading="lazy"
    className={`h-full w-full object-cover ${kind === 'image' && preview ? '' : 'opacity-50'}`}
  />;
  return <button type="button" disabled={opening} aria-busy={opening} onClick={() => {
    setOpening(true);
    void onOpen().finally(() => setOpening(false));
  }} className="group flex h-[210px] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left transition-[background-color,border-color] hover:border-[color-mix(in_oklch,var(--border)_94%,var(--foreground)_6%)] hover:bg-[color-mix(in_oklch,var(--card)_98%,var(--foreground)_2%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-wait disabled:opacity-70">
    <span className="flex h-[148px] w-full shrink-0 items-center justify-center overflow-hidden border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_97%,var(--foreground)_3%)]">
      {image}
    </span>
    <span className="flex min-w-0 flex-1 items-start gap-1 px-3 py-2.5">
      {item.resourceKind === 'folder'
        ? <Folder className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
        : <NotebookTreeFileIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-5 text-[var(--foreground)]">{item.resourceKind === 'folder' ? item.name : item.name.replace(/\.[^.]+$/, '')}</span>
        <span className="mt-0.5 block truncate text-[11px] leading-4 text-[var(--muted-foreground)]">{formatUpdatedAgo(item.modifiedMs)}</span>
      </span>
    </span>
  </button>;
}

export function DocumentListView({ surface }: { surface: DocumentListSurface }) {
  const { t } = useI18n();
  const resourceKindsKey = (surface.filters.resourceKinds ?? []).join('\u0000');
  const loadNotebookFilters = useCustomFilterStore((state) => state.loadNotebookFilters);
  const customFilter = useCustomFilterStore((state) => (
    surface.notebookId ? state.filtersByNotebook[surface.notebookId]?.find((filter) => filter.id === surface.filters.customFilterId) ?? null : null
  ));
  const [items, setItems] = useState<DocumentPageItem[]>([]);
  const [folders, setFolders] = useState<DocumentPageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 600 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const refreshDirectoriesRef = useRef<string[]>([]);
  const loadingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const requestGenerationRef = useRef(0);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setViewport((current) => ({
      ...current,
      top: Math.max(0, element.scrollTop - (headerRef.current?.offsetHeight ?? 0) - 8),
      height: element.clientHeight,
      width: element.clientWidth - 40,
    }));
    update();
    const resize = new ResizeObserver(update);
    resize.observe(element);
    if (headerRef.current) resize.observe(headerRef.current);
    element.addEventListener('scroll', update, { passive: true });
    return () => { resize.disconnect(); element.removeEventListener('scroll', update); };
  }, []);
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [surface.displayId]);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribe<{ notebookId: string }>('file-management-changed', ({ notebookId }) => {
    if (notebookId === surface.notebookId) setRevision((value) => value + 1);
  }), [surface.notebookId]);
  useEffect(() => subscribe<{ notebookId: string }>('media-properties-changed', ({ notebookId }) => {
    if (notebookId === surface.notebookId) setRevision((value) => value + 1);
  }), [surface.notebookId]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const editFilter = (anchorElement: HTMLButtonElement) => {
    if (!surface.notebookId || !surface.filters.customFilterId) return;
    window.dispatchEvent(new CustomEvent('flowix:open-custom-filter-edit', {
      detail: { filterId: surface.filters.customFilterId, notebookId: surface.notebookId, anchorElement },
    }));
  };
  useEffect(() => {
    if (surface.notebookId) void loadNotebookFilters(surface.notebookId);
  }, [loadNotebookFilters, surface.notebookId]);
  useEffect(() => subscribe<FileBrowserDirectoriesChangedEvent>(
    'file-browser-directories-changed',
    (event) => {
      if (canonicalPath(event.rootPath) !== canonicalPath(surface.notebookPath)) return;
      const root = canonicalPath(surface.notebookPath).replace(/\/$/, '');
      const directories = event.directories.filter((directory) => {
        const path = canonicalPath(directory);
        if (path === root) return true;
        return path.startsWith(`${root}/`);
      });
      if (directories.length === 0) return;
      refreshDirectoriesRef.current.push(...directories);
      if (loadingRef.current) {
        pendingRefreshRef.current = true;
        return;
      }
      setRevision((value) => value + 1);
    },
  ), [surface.notebookPath]);
  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    let cancelled = false;
    if (!surface.notebookId) {
      loadingRef.current = false;
      setItems([]);
      setError(true);
      setLoading(false);
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setLoadingMore(false);
    setMoreError(false);
    setError(false);
    setItems([]);
    setFolders([]);
    setHasMore(false);
    setNextCursor(null);
    const refreshDirectories = refreshDirectoriesRef.current.splice(0);
    void files.listDocumentPage({
      notebookId: surface.notebookId,
      folderPath: surface.folderPath,
      resourceKinds: surface.filters.resourceKinds,
      customFilter,
      refreshDirectories,
    }).then((page) => {
      if (cancelled || generation !== requestGenerationRef.current) return;
      setItems(page.items);
      setFolders(page.folders);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    }).catch((error) => {
      logger.warn('loading document page failed', { error });
      if (!cancelled && generation === requestGenerationRef.current) setError(true);
    }).finally(() => {
      if (!cancelled && generation === requestGenerationRef.current) {
        loadingRef.current = false;
        setLoading(false);
        if (pendingRefreshRef.current) {
          pendingRefreshRef.current = false;
          setRevision((value) => value + 1);
        }
      }
    });
    return () => { cancelled = true; requestGenerationRef.current += 1; };
  }, [customFilter, revision, surface.folderPath, surface.notebookId, surface.notebookPath, resourceKindsKey]);
  const loadMore = useCallback(() => {
    if (!surface.notebookId || !nextCursor || loading || loadingMore || !hasMore) return;
    const generation = requestGenerationRef.current;
    setLoadingMore(true);
    setMoreError(false);
    void files.listDocumentPage({
      notebookId: surface.notebookId,
      folderPath: surface.folderPath,
      resourceKinds: surface.filters.resourceKinds,
      customFilter,
      cursor: nextCursor,
    }).then((page) => {
      if (generation !== requestGenerationRef.current) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    }).catch((error) => {
      logger.warn('loading next document page failed', { error });
      if (generation === requestGenerationRef.current) setMoreError(true);
    }).finally(() => {
      if (generation === requestGenerationRef.current) setLoadingMore(false);
    });
  }, [customFilter, hasMore, loading, loadingMore, nextCursor, resourceKindsKey, surface.folderPath, surface.notebookId]);
  useEffect(() => {
    if (!hasMore || moreError || !endRef.current || !scrollRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { root: scrollRef.current, rootMargin: '500px' });
    observer.observe(endRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore, moreError]);
  const visibleItems = [...folders, ...items];
  const columnCount = Math.max(1, Math.floor((viewport.width + 14) / 214));
  const rowHeight = 224;
  const rowCount = Math.ceil(visibleItems.length / columnCount);
  const firstRow = Math.min(Math.max(0, rowCount - 1), Math.max(0, Math.floor(viewport.top / rowHeight) - 2));
  const lastRow = Math.min(rowCount, Math.ceil((viewport.top + viewport.height) / rowHeight) + 2);
  const visibleCards = visibleItems.slice(firstRow * columnCount, lastRow * columnCount);
  const createNote = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || creating || !surface.notebookId) return;
    setCreating(true);
    try {
      let customFilterForCreation = customFilter;
      if (surface.notebookId && surface.filters.customFilterId && !customFilterForCreation) {
        await loadNotebookFilters(surface.notebookId);
        customFilterForCreation = useCustomFilterStore.getState().filtersByNotebook[surface.notebookId]
          ?.find((filter) => filter.id === surface.filters.customFilterId) ?? null;
      }
      let path: string;
      const { noteRepository } = await import('@features/memo/services/note-repository');
      const root = canonicalPath(surface.notebookPath).replace(/\/$/, '');
      const folder = canonicalPath(surface.folderPath).replace(/\/$/, '');
      const relative = folder === root ? '' : folder.slice(root.length + 1);
      const created = await noteRepository.create(undefined, surface.notebookId, relative, title);
      path = created.path;
      if (customFilterForCreation?.documentType === 'note') {
        const saved = await setDocumentProperties(path, {
          [customFilterForCreation.key]: customFilterForCreation.value,
        });
        if (!saved) throw new Error('Failed to apply the active custom view to the new note');
      }
      setCreateOpen(false);
      setNewTitle('');
      setRevision((value) => value + 1);
      const { openExternalTarget } = await import('@features/workspace/use-cases/workspace-navigation');
      await openExternalTarget(path, { destination: 'main-third', scopePath: surface.notebookPath });
    } catch {
      toast.error('新建笔记失败');
    } finally {
      setCreating(false);
    }
  }, [creating, customFilter, loadNotebookFilters, newTitle, surface.filters.customFilterId, surface.folderPath, surface.notebookId, surface.notebookPath]);
  const openItem = useCallback(async (item: DocumentPageItem) => {
    try {
      if (item.resourceKind === 'folder') {
        const [{ openDocumentListTarget }, { createDocumentListTarget }] = await Promise.all([
          import('@features/workspace/use-cases/workspace-navigation'),
          import('@features/workspace/store/work-column-target'),
        ]);
        openDocumentListTarget(createDocumentListTarget({
          kind: 'folder', path: item.fullPath, notebookPath: surface.notebookPath, notebookId: surface.notebookId,
        }, {}));
        return;
      }
      const { openExternalTarget, openMediaTarget } = await import('@features/workspace/use-cases/workspace-navigation');
      const kind = item.resourceKind ?? resourceKindFromPath(item.fullPath);
      if (kind === 'image' || kind === 'video') {
        await openMediaTarget({ filePath: item.fullPath, notebookId: surface.notebookId, notebookPath: surface.notebookPath, resourceKind: kind });
      } else {
        await openExternalTarget(item.fullPath, { destination: 'main-third', scopePath: surface.notebookPath });
      }
    } catch {
      toast.error('打开文件失败');
    }
  }, [surface.notebookId, surface.notebookPath]);
  return <section className="flex h-full min-h-0 flex-col bg-transparent text-[var(--foreground)]">
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-5 pb-4">
    <div ref={headerRef} className="-mx-5 flex flex-wrap items-center justify-between gap-2 px-5 pt-3">
      <div className="flex items-center" role="group" aria-label={t('memo.documentList.viewType')}>
        <button
          type="button"
          aria-pressed="true"
          className="inline-flex h-8 items-center justify-start gap-1.5 rounded-lg px-0 text-sm font-medium text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        ><Grid2X2 className="h-3.5 w-3.5" aria-hidden="true" />{t('memo.documentList.gallery')}</button>
      </div>
      <div className="flex items-center gap-2">
        {surface.notebookId && surface.filters.customFilterId && <Button type="button" variant="outline" className="px-3" onClick={(event) => editFilter(event.currentTarget)}>{t('memo.customFilter.edit')}</Button>}
        <Button type="button" className="px-3" onClick={() => setCreateOpen(true)} disabled={!surface.notebookId}>{t('memo.documentList.new')}</Button>
      </div>
    </div>
      {error ? <div className="flex h-full min-h-[160px] items-center justify-center text-center text-sm text-[var(--muted-foreground)]">不支持读取隐藏/系统文件夹</div>
        : loading && visibleItems.length === 0
        ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">正在整理文件列表…</div>
        : !loading && visibleItems.length === 0
        ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">
              <div className="flex flex-col items-center text-center">
                <Inbox className="mb-3 h-10 w-10 opacity-50" strokeWidth={1.25} aria-hidden="true" />
                <span>列表内容为空</span>
              </div>
            </div>
          : <div style={{ paddingTop: firstRow * rowHeight, paddingBottom: Math.max(0, rowCount - lastRow) * rowHeight }}><div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-stretch gap-3.5 pt-3">{visibleCards.map((item) => <DocumentCard key={item.fullPath} item={item} notebookPath={surface.notebookPath} onOpen={() => openItem(item)} />)}</div></div>}
      {moreError && <button type="button" className="mt-4 text-sm text-[var(--brand)]" onClick={loadMore}>加载失败，点击重试</button>}
      {hasMore && !moreError && <div ref={endRef} className="h-1" aria-hidden="true" />}
    </div>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-w-sm"><DialogTitle>新建笔记</DialogTitle><form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void createNote(); }}><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="笔记标题" className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" /><div className="flex justify-end gap-2"><Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" size="sm" className="rounded-lg" disabled={!newTitle.trim() || creating}>创建</Button></div></form></DialogContent></Dialog>
  </section>;
}
