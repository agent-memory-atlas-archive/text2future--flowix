import { useTitleEditCaret } from '@shared/hooks/use-title-edit-caret';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, Folder, Inbox, LoaderCircle, Play } from 'lucide-react';
import { DotsThreeIcon, FunnelIcon, PlusIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { files, mediaResources, type DocumentPageItem, type NotebookFolderOption } from '@platform/tauri/client';
import { externalFileViewKind, fileExtension, isCodeTextFilePath, resourceKindFromPath } from '@features/editor/public/code-file';
import { toast } from '@/lib/toast';
import { canonicalPath } from '@/lib/path';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { useI18n } from '@/lib/i18n';
import { matchesMediaCollectionFilter, normalizeMediaLibraryFileCondition, type MediaLibraryFileCondition, type MediaLibraryRecord } from '@features/media-library/model';
import { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
import { NotebookTreeResourceIcon } from '@features/memo/components/file-type-icon';
import type { DocumentListViewContext } from './document-list-view-model';
import { useDocumentListData } from './use-document-list-data';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { requestMediaPreview } from './media-preview-tasks';
import { openPath } from '@platform/tauri/opener';
import { MediaLibraryFilterPanel } from '@features/media-library/media-library-filter-panel';
import { normalizeWorkDocumentsCondition, WORK_DOCUMENT_KINDS, type WorkDocumentsFilterCondition } from '@features/work-documents/model';
import documentCardPlaceholder from '@/assets/placeholder-document-card.jpg';
import imageCardPlaceholder from '@/assets/placeholder-image-card.jpg';
import videoCardPlaceholder from '@/assets/placeholder-video-card.jpg';
import codeCardPlaceholder from '@/assets/placeholder-code-card.jpg';
import pdfCardPlaceholder from '@/assets/placeholder-pdf-card.jpg';
import pptCardPlaceholder from '@/assets/placeholder-ppt-card.jpg';
import excelCardPlaceholder from '@/assets/placeholder-excel-card.jpg';
import otherCardPlaceholder from '@/assets/placeholder-other-card.jpg';
import folderCardPlaceholder from '@/assets/placeholder-folder-card.png';
import { WorkDocumentsLoadingSkeleton } from '@shared/ui/work-documents-loading-skeleton';

// Keep the loading effect stable when ordinary folders omit media records.
const EMPTY_MEDIA_LIBRARY_RECORDS: MediaLibraryRecord[] = [];
const MEDIA_CARD_MIN_WIDTH = 160;
const MEDIA_COLUMN_GAP = 2;
const MEDIA_CARD_ESTIMATED_HEIGHT = 320;

const VirtualizedMediaColumn = memo(function VirtualizedMediaColumn({
  items,
  scrollerRef,
  scrollMargin,
  renderCard,
}: {
  items: readonly DocumentPageItem[];
  scrollerRef: RefObject<HTMLDivElement | null>;
  scrollMargin: number;
  renderCard: (item: DocumentPageItem) => ReactNode;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    initialRect: { width: MEDIA_CARD_MIN_WIDTH, height: 600 },
    estimateSize: () => MEDIA_CARD_ESTIMATED_HEIGHT,
    getItemKey: (index) => items[index]?.fullPath ?? index,
    measureElement: (element) => {
      const measured = element.getBoundingClientRect().height;
      return measured > 0 ? measured : MEDIA_CARD_ESTIMATED_HEIGHT;
    },
    scrollMargin,
    gap: MEDIA_COLUMN_GAP,
    overscan: 4,
  });

  return (
    <div className="relative min-w-0 flex-1" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const item = items[virtualItem.index];
        if (!item) return null;
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full min-w-0 py-px"
            style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
          >
            {renderCard(item)}
          </div>
        );
      })}
    </div>
  );
});

function cardPlaceholder(item: DocumentPageItem): string {
  if (item.resourceKind === 'folder') return folderCardPlaceholder;
  const extension = fileExtension(item.name);
  if (item.resourceKind === 'note' || ['md', 'markdown', 'doc', 'docx', 'odt', 'pages', 'wps', 'html', 'htm'].includes(extension)) return documentCardPlaceholder;
  if (item.resourceKind === 'image') return imageCardPlaceholder;
  if (item.resourceKind === 'video') return videoCardPlaceholder;
  if (extension === 'pdf') return pdfCardPlaceholder;
  if (['ppt', 'pptx', 'pps', 'ppsx', 'odp', 'key'].includes(extension)) return pptCardPlaceholder;
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

function mediaItemRelativePath(filePath: string, notebookPath: string): string {
  const path = canonicalPath(filePath).replace(/\/+$/, '');
  const root = canonicalPath(notebookPath).replace(/\/+$/, '');
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.split('/').pop() ?? '';
}

function mediaItemRelativeDirectory(filePath: string, notebookPath: string): string {
  return mediaItemRelativePath(filePath, notebookPath).split('/').slice(0, -1).join('/') || '.';
}

function matchesMediaRuleFilter(item: DocumentPageItem, notebookPath: string, filter?: Record<string, unknown> | null): boolean {
  if (item.resourceKind !== 'image' && item.resourceKind !== 'video') return false;
  return matchesMediaCollectionFilter(mediaItemRelativePath(item.fullPath, notebookPath), item.resourceKind, filter);
}

const DocumentCard = memo(function DocumentCard({ item, notebookPath, openItem, mediaLibrary = false, observeMediaCard, onRequestDelete, deleteLabel, deleteDisabled = false }: { item: DocumentPageItem; notebookPath: string; openItem: (item: DocumentPageItem) => Promise<void>; mediaLibrary?: boolean; observeMediaCard?: (node: Element, onNear: () => void) => () => void; onRequestDelete?: (item: DocumentPageItem) => void; deleteLabel?: string; deleteDisabled?: boolean }) {
  const kind = mediaLibrary && (item.resourceKind === 'image' || item.resourceKind === 'video')
    ? item.resourceKind
    : item.resourceKind === 'folder' ? 'other' : externalFileViewKind(item.fullPath);
  const placeholder = cardPlaceholder(item);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [nearViewport, setNearViewport] = useState(false);
  const [cardHovered, setCardHovered] = useState(false);
  const cardRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mediaLibrary || !cardRef.current || !observeMediaCard) {
      setNearViewport(true);
      return;
    }
    return observeMediaCard(cardRef.current, () => setNearViewport(true));
  }, [mediaLibrary, observeMediaCard]);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    if (mediaLibrary && !nearViewport) {
      setPreviewLoading(false);
      return () => { cancelled = true; };
    }
    if (mediaLibrary && (kind === 'image' || kind === 'video')) {
      setPreviewLoading(true);
      const task = requestMediaPreview(item.fullPath, notebookPath, kind, item.modifiedMs ?? 0);
      void task.promise.then((value) => {
        if (cancelled) return;
        setPreview(value);
        if (!value) setPreviewLoading(false);
      });
      return () => { cancelled = true; task.cancel(); };
    }
    setPreviewLoading(false);
    if (kind === 'image') {
      void files.readImage(item.fullPath, notebookPath)
        .then((value) => { if (!cancelled) setPreview(value); })
        .catch(() => undefined);
    } else if (kind === 'video') {
      void mediaResources.get(item.fullPath, notebookPath)
        .then(() => files.readVideoPreview(item.fullPath, notebookPath))
        .then((value) => { if (!cancelled) setPreview(value); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [item.fullPath, item.modifiedMs, kind, mediaLibrary, nearViewport, notebookPath]);
  const image = <img
    src={preview || placeholder}
    alt=""
    onLoad={() => { if (mediaLibrary && preview) setPreviewLoading(false); }}
    onError={() => {
      if (!mediaLibrary || !preview) return;
      setPreview(null);
      setPreviewLoading(false);
    }}
    loading={mediaLibrary ? 'eager' : 'lazy'}
    className={`${mediaLibrary ? kind === 'video' ? 'block h-[360px] w-full object-cover' : 'block max-h-[360px] w-full object-contain' : 'h-full w-full object-cover'} ${preview ? '' : 'opacity-50'}`}
  />;
  if (mediaLibrary) return <div className="group relative w-full break-inside-avoid" onMouseEnter={() => setCardHovered(true)} onMouseLeave={() => setCardHovered(false)}>
    <button type="button" disabled={opening} aria-busy={opening || previewLoading} onClick={() => {
    setOpening(true);
    void openItem(item).finally(() => setOpening(false));
  }} ref={cardRef} className="group flex w-full flex-col overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--card)] text-left transition-colors hover:border-[color-mix(in_oklch,var(--border)_90%,var(--foreground)_10%)] disabled:cursor-wait disabled:opacity-70">
    <span className="relative block w-full overflow-hidden bg-[color-mix(in_srgb,var(--card)_94%,var(--foreground)_6%)]">
      {image}
      {previewLoading && <span aria-hidden="true" className="pointer-events-none absolute inset-0 animate-pulse bg-[var(--muted)]" />}
      {kind === 'video' && <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-white shadow-lg backdrop-blur-sm"><Play className="ml-0.5 h-5 w-5 fill-current stroke-current" strokeWidth={1.5} /></span></span>}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/40 via-black/25 to-transparent px-2.5 pb-2 pt-8 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        <span className="truncate text-[11px] leading-4 text-white/75" title={mediaItemRelativeDirectory(item.fullPath, notebookPath)}>{mediaItemRelativeDirectory(item.fullPath, notebookPath)}</span>
        <span className="truncate text-[13px] font-medium leading-5" title={item.name}>{item.name}</span>
      </span>
    </span>
    </button>
    {item.resourceKind === 'image' && onRequestDelete && <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={deleteLabel}
      title={deleteLabel}
      disabled={deleteDisabled}
      onClick={() => onRequestDelete(item)}
      style={{ backgroundColor: 'color-mix(in srgb, var(--hover-bg) 36%, transparent)' }}
      className={`absolute right-2 top-2 z-10 h-7 w-7 rounded-lg p-0 text-[var(--foreground)] shadow-sm transition-[opacity,color] hover:text-[var(--destructive)] ${cardHovered ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100'}`}
    ><TrashSimpleIcon size={14} weight="bold" aria-hidden="true" /></Button>}
  </div>;
  return <button type="button" disabled={opening} aria-busy={opening} onClick={() => {
    setOpening(true);
    void openItem(item).finally(() => setOpening(false));
  }} className={`group relative flex h-[210px] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left transition-[background-color,border-color] hover:border-[color-mix(in_oklch,var(--border)_94%,var(--foreground)_6%)] hover:bg-[color-mix(in_oklch,var(--card)_98%,var(--foreground)_2%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-wait disabled:opacity-70 ${kind === 'image' || kind === 'video' ? 'block' : ''}`}>
    {kind === 'image' || kind === 'video' ? <>
      <span className="absolute inset-0 block overflow-hidden bg-[color-mix(in_srgb,var(--card)_97%,var(--foreground)_3%)]">
        {image}
      </span>
      {kind === 'video' && <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/40 text-white shadow-lg backdrop-blur-sm">
          <Play className="ml-0.5 h-6 w-6 fill-current stroke-current" strokeWidth={1.5} />
        </span>
      </span>}
      <span className="absolute inset-x-0 bottom-0 flex h-12 items-center justify-between gap-3 bg-gradient-to-t from-black/30 via-black/15 to-transparent px-3 text-white">
        <span className="min-w-0 truncate text-[13px] font-medium leading-5" title={item.name}>{item.name}</span>
        <span className="shrink-0 text-[11px] leading-4 text-white/75">{formatUpdatedAgo(item.modifiedMs)}</span>
      </span>
    </> : <>
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
    </>}
  </button>;
});

export function DocumentListView({ listContext, mediaLibrary = false, workDocuments = false, libraryName = '媒体库', libraryFilePath, mediaLibraryFolderPath, mediaLibraryFilter = {}, workDocumentsFilter = {}, mediaLibraryRecords = EMPTY_MEDIA_LIBRARY_RECORDS, mediaLibraryExcludedPaths = [], mediaLibraryDatasetFilter, mediaLibraryViewFilter, onMediaLibraryFilterChange, onWorkDocumentsFilterChange, onLoadingChange, onRenameLibrary, onAddMedia, onDeleteMedia, onSwitchToTable, libraryActionsDisabled = false, refreshPaused = false, workspaceHost = 'main-third' }: {
  listContext: DocumentListViewContext;
  mediaLibrary?: boolean;
  workDocuments?: boolean;
  libraryName?: string;
  libraryFilePath?: string;
  mediaLibraryFolderPath?: string;
  mediaLibraryFilter?: MediaLibraryFileCondition;
  workDocumentsFilter?: WorkDocumentsFilterCondition;
  mediaLibraryRecords?: MediaLibraryRecord[];
  mediaLibraryExcludedPaths?: string[];
  mediaLibraryDatasetFilter?: Record<string, unknown> | null;
  mediaLibraryViewFilter?: Record<string, unknown> | null;
  onAddMedia?: () => Promise<boolean>;
  onDeleteMedia?: (item: DocumentPageItem) => Promise<boolean>;
  onMediaLibraryFilterChange?: (condition: MediaLibraryFileCondition) => Promise<boolean>;
  onWorkDocumentsFilterChange?: (condition: WorkDocumentsFilterCondition) => Promise<boolean>;
  onLoadingChange?: (loading: boolean) => void;
  onRenameLibrary?: (title: string) => Promise<void>;
  onSwitchToTable?: () => void;
  libraryActionsDisabled?: boolean;
  refreshPaused?: boolean;
  workspaceHost?: 'main-third' | 'browser-column';
}) {
  const { t } = useI18n();
  const resourceKindsKey = (listContext.filters.resourceKinds ?? []).join('\u0000');
  const {
    items, linkedItems, folders, hasMediaDataset, hasLinkedMedia, loading, loadingLinkedItems,
    moreError, hasMore, error, loadMore, refresh,
  } = useDocumentListData({ listContext, mediaLibrary, workDocuments, mediaLibraryRecords, refreshPaused });
  useEffect(() => {
    if (workDocuments) onLoadingChange?.(loading);
  }, [loading, onLoadingChange, workDocuments]);
  const [addingMedia, setAddingMedia] = useState(false);
  const [mediaToDelete, setMediaToDelete] = useState<DocumentPageItem | null>(null);
  const [deletingMedia, setDeletingMedia] = useState(false);
  const [editingLibraryTitle, setEditingLibraryTitle] = useState(false);
  const [libraryTitleDraft, setLibraryTitleDraft] = useState(libraryName);
  const [renamingLibraryTitle, setRenamingLibraryTitle] = useState(false);
  const [mediaNameQuery, setMediaNameQuery] = useState('');
  const [mediaPathQuery, setMediaPathQuery] = useState('');
  const [mediaPathIsAllQuery, setMediaPathIsAllQuery] = useState(false);
  const [mediaTypeQuery, setMediaTypeQuery] = useState<string>('any');
  const [mediaFiltersOpen, setMediaFiltersOpen] = useState(false);
  const [mediaDataFiltersOpen, setMediaDataFiltersOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderOptions, setFolderOptions] = useState<NotebookFolderOption[]>([]);
  const [folderOptionsLoading, setFolderOptionsLoading] = useState(false);
  const activeFileCondition = workDocuments ? workDocumentsFilter : mediaLibraryFilter;
  const workDocumentKindOptions = [
    { value: 'any', label: t('workDocuments.kind.any') },
    { value: WORK_DOCUMENT_KINDS[0], label: t('workDocuments.kind.document') },
    { value: WORK_DOCUMENT_KINDS[1], label: t('workDocuments.kind.spreadsheet') },
    { value: WORK_DOCUMENT_KINDS[2], label: t('workDocuments.kind.presentation') },
    { value: WORK_DOCUMENT_KINDS[3], label: t('workDocuments.kind.web') },
    { value: WORK_DOCUMENT_KINDS[4], label: t('workDocuments.kind.archive') },
    { value: WORK_DOCUMENT_KINDS[5], label: t('workDocuments.kind.database') },
  ];
  const { inputRef: libraryTitleInputRef, captureCaret: captureLibraryTitleCaret } = useTitleEditCaret(editingLibraryTitle);
  useEffect(() => {
    if (!editingLibraryTitle) setLibraryTitleDraft(libraryName);
  }, [editingLibraryTitle, libraryName]);
  const commitLibraryTitle = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim();
    setEditingLibraryTitle(false);
    if (renamingLibraryTitle) return;
    if (!onRenameLibrary || !title || title === libraryName) {
      setEditingLibraryTitle(false);
      return;
    }
    setRenamingLibraryTitle(true);
    try {
      await onRenameLibrary(title);
    } finally {
      setRenamingLibraryTitle(false);
      setEditingLibraryTitle(false);
    }
  }, [libraryName, onRenameLibrary, renamingLibraryTitle]);
  const beginLibraryTitleEdit = useCallback(() => {
    if (!onRenameLibrary || renamingLibraryTitle) return;
    setLibraryTitleDraft(libraryName);
    setEditingLibraryTitle(true);
  }, [libraryName, onRenameLibrary, renamingLibraryTitle]);
  useEffect(() => {
    if (!editingLibraryTitle) return;
    const blurOnOutsidePointer = (event: PointerEvent) => {
      const input = libraryTitleInputRef.current;
      if (input && !event.composedPath().includes(input)) input.blur();
    };
    document.addEventListener('pointerdown', blurOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', blurOnOutsidePointer, true);
  }, [editingLibraryTitle]);
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 600 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const mediaGridRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [mediaGridScrollMargin, setMediaGridScrollMargin] = useState(0);
  const previewObserverRef = useRef<IntersectionObserver | null>(null);
  const previewCallbacksRef = useRef(new Map<Element, () => void>());
  const observeMediaCard = useCallback((node: Element, onNear: () => void) => {
    let observer = previewObserverRef.current;
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          previewCallbacksRef.current.get(entry.target)?.();
          previewCallbacksRef.current.delete(entry.target);
          previewObserverRef.current?.unobserve(entry.target);
        }
      }, { root: scrollRef.current, rootMargin: '600px' });
      previewObserverRef.current = observer;
    }
    previewCallbacksRef.current.set(node, onNear);
    observer.observe(node);
    return () => {
      previewCallbacksRef.current.delete(node);
      previewObserverRef.current?.unobserve(node);
    };
  }, []);
  useEffect(() => () => {
    previewObserverRef.current?.disconnect();
    previewObserverRef.current = null;
    previewCallbacksRef.current.clear();
  }, []);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // Scroll fires far more often than the viewport actually changes. Coalesce
    // to one measurement per frame and bail out when the numbers are identical,
    // otherwise every scroll event re-rendered the whole card grid.
    const measure = () => setViewport((current) => {
      const top = Math.max(0, element.scrollTop - (headerRef.current?.offsetHeight ?? 0) - 8);
      const height = element.clientHeight;
      const width = element.clientWidth - 40;
      return current.top === top && current.height === height && current.width === width
        ? current
        : { top, height, width };
    });
    const measureMediaGridOffset = () => {
      const grid = mediaGridRef.current;
      if (!grid) return;
      const gridTop = grid.getBoundingClientRect().top;
      const scrollTop = element.getBoundingClientRect().top;
      const next = Math.max(0, gridTop - scrollTop + element.scrollTop);
      setMediaGridScrollMargin((current) => current === next ? current : next);
    };
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
        measureMediaGridOffset();
      });
    };
    measure();
    measureMediaGridOffset();
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    if (headerRef.current) resize.observe(headerRef.current);
    if (mediaGridRef.current) resize.observe(mediaGridRef.current);
    if (!mediaLibrary) element.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      resize.disconnect();
      element.removeEventListener('scroll', schedule);
    };
  }, [mediaLibrary]);
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [listContext.displayId]);
  useEffect(() => {
    if (!mediaLibrary && !workDocuments) return;
    scrollRef.current?.scrollTo(0, 0);
  }, [mediaLibrary, workDocuments, activeFileCondition.file_name_contains, activeFileCondition.file_type, activeFileCondition.path_contains, activeFileCondition.path_scope, resourceKindsKey]);
  useEffect(() => {
    if (!folderPickerOpen || !listContext.notebookPath) return;
    let active = true;
    setFolderOptionsLoading(true);
    void files.getNotebookFolderOptions(listContext.notebookPath).then((options) => {
      if (active) setFolderOptions(options);
    }).catch(() => {
      if (active) setFolderOptions([]);
    }).finally(() => {
      if (active) setFolderOptionsLoading(false);
    });
    return () => { active = false; };
  }, [folderPickerOpen, listContext.notebookPath]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const addMedia = () => {
    if (addingMedia || !onAddMedia) return;
    setAddingMedia(true);
    void onAddMedia().then((changed) => { if (changed) refresh(); }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t('mediaLibrary.addMediaFailed'));
    }).finally(() => setAddingMedia(false));
  };
  useEffect(() => {
    if (!hasMore || moreError || !endRef.current || !scrollRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { root: scrollRef.current, rootMargin: '500px' });
    observer.observe(endRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore, moreError]);
  const appliedMediaNameQuery = (activeFileCondition.file_name_contains ?? '').trim().toLocaleLowerCase();
  const appliedMediaPathQuery = (activeFileCondition.path_contains ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
  const excludedMediaPathSet = useMemo(
    () => new Set(mediaLibraryExcludedPaths.map((path) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase())),
    [mediaLibraryExcludedPaths],
  );
  // Derived once per data/filter change. Previously this ran on every render,
  // including each scroll frame, so the whole list was re-filtered and de-duped
  // dozens of times per second while scrolling.
  const visibleItems = useMemo(() => (mediaLibrary
    ? [...new Map([
      ...linkedItems.filter((item) => !excludedMediaPathSet.has(mediaItemRelativePath(item.fullPath, listContext.notebookPath).toLocaleLowerCase())
        && matchesMediaRuleFilter(item, listContext.notebookPath, mediaLibraryViewFilter)),
      ...(hasMediaDataset ? items.filter((item) => (
        (item.resourceKind === 'image' || item.resourceKind === 'video')
        && !excludedMediaPathSet.has(mediaItemRelativePath(item.fullPath, listContext.notebookPath).toLocaleLowerCase())
        && matchesMediaRuleFilter(item, listContext.notebookPath, mediaLibraryDatasetFilter)
        && matchesMediaRuleFilter(item, listContext.notebookPath, mediaLibraryViewFilter)
      )) : []),
    ].map((item) => [canonicalPath(item.fullPath), item])).values()]
    : [...folders, ...items]), [
    mediaLibrary,
    linkedItems,
    items,
    folders,
    hasMediaDataset,
    mediaLibraryViewFilter,
    mediaLibraryDatasetFilter,
    excludedMediaPathSet,
    listContext.notebookPath,
  ]);
  useEffect(() => {
    if (!mediaLibrary) return;
    const element = scrollRef.current;
    const grid = mediaGridRef.current;
    if (!element || !grid) return;
    const next = Math.max(
      0,
      grid.getBoundingClientRect().top
        - element.getBoundingClientRect().top
        + element.scrollTop,
    );
    setMediaGridScrollMargin((current) => current === next ? current : next);
  }, [mediaLibrary, visibleItems.length]);
  const mediaFilterCount = (appliedMediaNameQuery ? 1 : 0)
    + (appliedMediaPathQuery ? 1 : 0)
    + (activeFileCondition.file_type ? 1 : 0)
    + (activeFileCondition.path_scope === 'all' ? 1 : 0);
  const saveMediaFilters = useCallback(async (pathOverride?: string | null) => {
    if (workDocuments ? !onWorkDocumentsFilterChange : !onMediaLibraryFilterChange) return false;
    const pathIsAll = pathOverride === null || (pathOverride === undefined && mediaPathIsAllQuery);
    const rawCondition = {
      file_name_contains: mediaNameQuery.trim(),
      file_type: mediaTypeQuery === 'any' ? undefined : mediaTypeQuery,
      path_contains: pathIsAll ? undefined : (pathOverride ?? mediaPathQuery).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      path_scope: pathIsAll ? 'all' : undefined,
    };
    const condition = workDocuments
      ? normalizeWorkDocumentsCondition(rawCondition as WorkDocumentsFilterCondition)
      : normalizeMediaLibraryFileCondition(rawCondition as MediaLibraryFileCondition);
    const currentPath = (activeFileCondition.path_contains ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (pathOverride === undefined && condition.file_name_contains === (activeFileCondition.file_name_contains?.trim() || undefined)
      && condition.file_type === activeFileCondition.file_type
      && condition.path_contains === (currentPath || undefined)
      && condition.path_scope === activeFileCondition.path_scope) return true;
    return workDocuments
      ? onWorkDocumentsFilterChange!(condition as WorkDocumentsFilterCondition)
      : onMediaLibraryFilterChange!(condition as MediaLibraryFileCondition);
  }, [activeFileCondition.file_name_contains, activeFileCondition.file_type, activeFileCondition.path_contains, activeFileCondition.path_scope, mediaNameQuery, mediaPathIsAllQuery, mediaPathQuery, mediaTypeQuery, onMediaLibraryFilterChange, onWorkDocumentsFilterChange, workDocuments]);
  const applyMediaFilters = useCallback(async () => {
    if (await saveMediaFilters()) setMediaFiltersOpen(false);
  }, [saveMediaFilters]);
  const openMediaDatasetMenu = () => {
    setMediaNameQuery(activeFileCondition.file_name_contains ?? '');
    setMediaTypeQuery(activeFileCondition.file_type ?? 'any');
    setMediaPathQuery(activeFileCondition.path_contains ?? '');
    setMediaPathIsAllQuery(activeFileCondition.path_scope === 'all');
    setMediaDataFiltersOpen(false);
    setMediaFiltersOpen(true);
  };
  const renderMediaFilterPanel = (locationOnly: boolean) => (
    <MediaLibraryFilterPanel
      fileName={mediaNameQuery}
      fileType={mediaTypeQuery}
      path={mediaPathQuery}
      pathIsAll={mediaPathIsAllQuery}
      fixedFolderPath={mediaLibraryFolderPath}
      folderPickerOpen={folderPickerOpen}
      folderOptions={folderOptions}
      folderOptionsLoading={folderOptionsLoading}
      notebookAvailable={Boolean(listContext.notebookPath)}
      autoFocus={!locationOnly}
      locationOnly={locationOnly}
      showLocationMenu={false}
      busy={libraryActionsDisabled}
      kindOptions={workDocuments ? workDocumentKindOptions : undefined}
      onFileNameChange={setMediaNameQuery}
      onFileTypeChange={setMediaTypeQuery}
      onPathChange={setMediaPathQuery}
      onPathSelected={async (selectedPath) => {
        const saved = await saveMediaFilters(selectedPath);
        if (saved) {
          setMediaPathQuery(selectedPath ?? '');
          setMediaPathIsAllQuery(selectedPath === null);
        }
        return saved;
      }}
      onFolderPickerOpenChange={setFolderPickerOpen}
      onReset={() => { setMediaNameQuery(''); setMediaTypeQuery('any'); }}
      onApply={() => { void applyMediaFilters(); }}
    />
  );
  const confirmDeleteMedia = useCallback(async () => {
    if (!mediaToDelete || !onDeleteMedia || deletingMedia) return;
    setDeletingMedia(true);
    try {
      if (await onDeleteMedia(mediaToDelete)) {
        setMediaToDelete(null);
        refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('media.fileTree.deleteFailed'));
    } finally {
      setDeletingMedia(false);
    }
  }, [deletingMedia, mediaToDelete, onDeleteMedia, t]);
  const columnCount = Math.max(1, Math.floor((viewport.width + 14) / 214));
  const mediaColumnCount = Math.min(
    Math.max(1, Math.floor((viewport.width + MEDIA_COLUMN_GAP) / (MEDIA_CARD_MIN_WIDTH + MEDIA_COLUMN_GAP))),
    Math.max(1, visibleItems.length),
  );
  const mediaColumns = useMemo(() => {
    const columns: DocumentPageItem[][] = Array.from({ length: mediaColumnCount }, () => []);
    // Appending a page keeps existing cards in their columns while the column count is unchanged.
    visibleItems.forEach((item, index) => columns[index % mediaColumnCount].push(item));
    return columns;
  }, [visibleItems, mediaColumnCount]);
  const rowHeight = 224;
  const rowCount = Math.ceil(visibleItems.length / columnCount);
  const firstRow = Math.min(Math.max(0, rowCount - 1), Math.max(0, Math.floor(viewport.top / rowHeight) - 2));
  const lastRow = Math.min(rowCount, Math.ceil((viewport.top + viewport.height) / rowHeight) + 2);
  const visibleCards = visibleItems.slice(firstRow * columnCount, lastRow * columnCount);
  const folderTitle = listContext.folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || listContext.folderPath;
  const createNote = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || creating || !listContext.notebookId) return;
    setCreating(true);
    try {
      let path: string;
      const { noteRepository } = await import('@features/memo/services/note-repository');
      const root = canonicalPath(listContext.notebookPath).replace(/\/$/, '');
      const folder = canonicalPath(listContext.folderPath).replace(/\/$/, '');
      const relative = folder === root ? '' : folder.slice(root.length + 1);
      const created = await noteRepository.create(undefined, listContext.notebookId, relative, title);
      path = created.path;
      setCreateOpen(false);
      setNewTitle('');
      refresh();
      const { openWorkspaceSurface } = await import('@features/workspace/public/open-surface-api');
      await openWorkspaceSurface({
        host: 'main-third',
        target: { kind: 'external', path, scopePath: listContext.notebookPath, transitionId: null },
      });
    } catch {
      toast.error('新建笔记失败');
    } finally {
      setCreating(false);
    }
  }, [creating, newTitle, listContext.folderPath, listContext.notebookId, listContext.notebookPath]);
  const openItem = useCallback(async (item: DocumentPageItem) => {
    try {
      if (workDocuments) {
        await openPath(item.fullPath);
        return;
      }
      if (item.resourceKind === 'folder') {
        if (!listContext.notebookId) throw new Error('无法确定文件夹所属笔记本');
        const { openFolderCollectionFromFolder } = await import('@features/workspace/public/main-window-api');
        await openFolderCollectionFromFolder(listContext.notebookId, item.fullPath, workspaceHost);
        return;
      }
      if (item.isDirectory) {
        await openPath(item.fullPath);
        return;
      }
      const { openWorkspaceSurface } = await import('@features/workspace/public/open-surface-api');
      const kind = item.resourceKind ?? resourceKindFromPath(item.fullPath);
      if (kind === 'image' || kind === 'video') {
        await openWorkspaceSurface({ host: 'browser-column', target: {
          kind: 'media', filePath: item.fullPath, notebookId: listContext.notebookId,
          notebookPath: listContext.notebookPath, resourceKind: kind,
        }, options: { browserDisposition: 'focus-existing' } });
      } else {
        const target = { kind: 'external' as const, path: item.fullPath, scopePath: listContext.notebookPath, transitionId: null };
        if (workspaceHost === 'browser-column') {
          await openWorkspaceSurface({ host: workspaceHost, target, options: { browserDisposition: 'focus-existing' } });
        } else {
          await openWorkspaceSurface({ host: workspaceHost, target });
        }
      }
    } catch {
      toast.error('打开文件失败');
    }
  }, [listContext.notebookId, listContext.notebookPath, workDocuments, workspaceHost]);
  return <section className="flex h-full min-h-0 flex-col bg-transparent text-[var(--foreground)]">
    <OverlayScrollbar
      className="flex h-full min-h-0 min-w-0 flex-1"
      scrollerClassName="h-full min-h-0 min-w-0 w-full flex-1 overflow-auto px-5 pb-4"
      scrollerRef={scrollRef}
    >
    <div ref={headerRef} className={mediaLibrary || workDocuments ? 'multidimensional-table__view-nav -mx-5 flex min-w-0 shrink-0 items-center justify-between gap-1 px-4' : '-mx-5 flex flex-wrap items-center justify-between gap-2 px-5 pt-3'}>
      {mediaLibrary ? <>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          <div className="flex h-7 min-w-0 max-w-full flex-[0_1_auto] -translate-x-[2px] items-center gap-1.5" title={libraryName}>
            <NotebookTreeResourceIcon path={libraryFilePath ?? 'media-library.lib.yaml'} collectionType="media_library" className="h-5 w-5 shrink-0" />
            {editingLibraryTitle ? <input
              ref={libraryTitleInputRef}
              aria-label={t('mediaLibrary.titleLabel')}
              value={libraryTitleDraft}
              disabled={renamingLibraryTitle}
              onChange={(event) => setLibraryTitleDraft(event.currentTarget.value)}
              onBlur={(event) => { void commitLibraryTitle(event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setLibraryTitleDraft(libraryName);
                  setEditingLibraryTitle(false);
                }
              }}
              className="box-border h-[22px] min-w-[2em] max-w-full flex-[0_1_auto] rounded px-0.5 py-1 [field-sizing:content] border-0 bg-[var(--muted)] text-sm font-medium leading-none text-[var(--foreground)] outline-none"
            /> : <button
              type="button"
              onDoubleClick={(event) => { if (!onRenameLibrary || renamingLibraryTitle) return; event.preventDefault(); captureLibraryTitleCaret(event.currentTarget, event.clientX, event.clientY); beginLibraryTitleEdit(); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'F2') {
                  event.preventDefault();
                  beginLibraryTitleEdit();
                }
              }}
              aria-label={`重命名媒体库：${libraryName}`}
              title={onRenameLibrary ? `双击重命名：${libraryName}` : libraryName}
              disabled={!onRenameLibrary || renamingLibraryTitle}
              className="inline-flex min-w-[2em] flex-[0_1_auto] items-center truncate rounded border-0 bg-transparent px-0.5 py-1 text-left text-sm font-medium leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-100"
            >{libraryName}</button>}
            {renamingLibraryTitle && <span role="status" aria-label={t('memo.fileTree.renaming')} className="inline-flex shrink-0 items-center text-[var(--muted-foreground)]">
              <LoaderCircle className="h-3.5 w-3.5 flowix-spin" aria-hidden="true" />
            </span>}
          </div>
          {onSwitchToTable && <>
            <span aria-hidden="true" className="h-[1em] w-px shrink-0 bg-[var(--border)]" />
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="sm" aria-label="更多" title="更多"
                  className="h-7 w-7 shrink-0 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]">
                  <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" side="bottom" sideOffset={5} fitViewport className="w-[160px] rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <button type="button" disabled={libraryActionsDisabled} onClick={onSwitchToTable}
                  className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                  多维表格
                </button>
              </PopoverContent>
            </Popover>
          </>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">{t('mediaLibrary.itemCount', { count: visibleItems.length, more: hasMore ? '+' : '' })}</span>
          <span aria-hidden="true" className="h-[1em] w-px shrink-0 bg-[var(--border)]" />
          <div className="flex shrink-0 items-center gap-0">
            <Popover open={mediaFiltersOpen} onOpenChange={(open) => {
              setMediaFiltersOpen(open);
              if (open) {
                openMediaDatasetMenu();
              } else {
                setMediaDataFiltersOpen(false);
                setFolderPickerOpen(false);
                void saveMediaFilters();
              }
            }}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('mediaLibrary.filterLabel')}
                  title={t('mediaLibrary.filterLabel')}
                  className={`h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)] ${mediaFiltersOpen || mediaFilterCount > 0 ? 'bg-[var(--muted)] text-[var(--foreground)]' : ''}`}
                ><FunnelIcon size={14} weight="bold" aria-hidden="true" /></Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="bottom" sideOffset={0} fitViewport style={{ zIndex: 150 }} ignorePopoverOutside={folderPickerOpen || mediaDataFiltersOpen} className="w-[220px] max-w-[calc(100vw-16px)] rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <div className="space-y-0.5">
                  {renderMediaFilterPanel(true)}
                  <Popover open={mediaDataFiltersOpen} onOpenChange={setMediaDataFiltersOpen}>
                    <div className={`rounded-lg transition-colors ${mediaDataFiltersOpen ? 'bg-[var(--hover-bg)]' : 'hover:bg-[var(--hover-bg)]'}`}>
                      <PopoverTrigger asChild>
                        <button type="button" className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm">
                          <span>数据条件</span>
                          <span className="flex items-center gap-1 text-sm text-[var(--muted-foreground)]">
                            {mediaNameQuery.trim() || mediaTypeQuery !== 'any' ? '已设置' : '未设置'}
                            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                        </button>
                      </PopoverTrigger>
                    </div>
                    <PopoverContent side="left" align="start" sideOffset={0} fitViewport style={{ zIndex: 160 }} ignorePopoverOutside={folderPickerOpen} className="max-h-[min(70vh,420px)] w-[320px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                      {renderMediaFilterPanel(false)}
                    </PopoverContent>
                  </Popover>
                </div>
              </PopoverContent>
            </Popover>
            {onAddMedia && <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('mediaLibrary.addMedia')}
              title={t('mediaLibrary.addMedia')}
              disabled={addingMedia || libraryActionsDisabled}
              onClick={addMedia}
              className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            ><PlusIcon size={14} weight="bold" aria-hidden="true" /></Button>}
          </div>
        </div>
      </> : workDocuments ? <>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          <div className="flex h-7 min-w-0 max-w-full flex-[0_1_auto] items-center gap-1.5" title={libraryName}>
            <NotebookTreeResourceIcon path={libraryFilePath ?? 'work-documents.index.yaml'} collectionType="work_documents" className="h-5 w-5 shrink-0" />
            {editingLibraryTitle ? <input
              ref={libraryTitleInputRef}
              aria-label={t('workDocuments.titleLabel')}
              value={libraryTitleDraft}
              disabled={renamingLibraryTitle}
              onChange={(event) => setLibraryTitleDraft(event.currentTarget.value)}
              onBlur={(event) => { void commitLibraryTitle(event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                else if (event.key === 'Escape') { event.preventDefault(); setLibraryTitleDraft(libraryName); setEditingLibraryTitle(false); }
              }}
              className="box-border h-[22px] min-w-[2em] max-w-full flex-[0_1_auto] rounded border-0 bg-[var(--muted)] px-0.5 py-1 text-sm font-medium leading-none text-[var(--foreground)] outline-none"
            /> : <button
              type="button"
              onDoubleClick={(event) => { if (!onRenameLibrary || renamingLibraryTitle) return; event.preventDefault(); captureLibraryTitleCaret(event.currentTarget, event.clientX, event.clientY); beginLibraryTitleEdit(); }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); beginLibraryTitleEdit(); } }}
              aria-label={`${t('workDocuments.renameLabel')}: ${libraryName}`}
              title={onRenameLibrary ? `${t('workDocuments.renameHint')}: ${libraryName}` : libraryName}
              disabled={!onRenameLibrary || renamingLibraryTitle}
              className="inline-flex min-w-[2em] max-w-full flex-[0_1_auto] items-center truncate rounded border-0 bg-transparent px-0.5 py-1 text-left text-sm font-medium leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-100"
            >{libraryName}</button>}
            {renamingLibraryTitle && <span role="status" aria-label={t('memo.fileTree.renaming')} className="inline-flex shrink-0 items-center text-[var(--muted-foreground)]"><LoaderCircle className="h-3.5 w-3.5 flowix-spin" aria-hidden="true" /></span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">{t('memo.documentList.workDocumentsCount', { count: visibleItems.length, more: hasMore ? '+' : '' })}</span>
          <span aria-hidden="true" className="h-[1em] w-px shrink-0 bg-[var(--border)]" />
          <Popover open={mediaFiltersOpen} onOpenChange={(open) => {
            setMediaFiltersOpen(open);
            if (open) openMediaDatasetMenu();
            else { setMediaDataFiltersOpen(false); setFolderPickerOpen(false); void saveMediaFilters(); }
          }}>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="sm" aria-label={t('workDocuments.filterLabel')} title={t('workDocuments.filterLabel')}
                disabled={libraryActionsDisabled || !onWorkDocumentsFilterChange}
                className={`h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)] ${mediaFiltersOpen || mediaFilterCount > 0 ? 'bg-[var(--muted)] text-[var(--foreground)]' : ''}`}>
                <FunnelIcon size={14} weight="bold" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" side="bottom" sideOffset={0} fitViewport style={{ zIndex: 150 }} ignorePopoverOutside={folderPickerOpen || mediaDataFiltersOpen} className="w-[220px] max-w-[calc(100vw-16px)] rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              <div className="space-y-0.5">
                {renderMediaFilterPanel(true)}
                <Popover open={mediaDataFiltersOpen} onOpenChange={setMediaDataFiltersOpen}>
                  <div className={`rounded-lg transition-colors ${mediaDataFiltersOpen ? 'bg-[var(--hover-bg)]' : 'hover:bg-[var(--hover-bg)]'}`}>
                    <PopoverTrigger asChild>
                      <button type="button" className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm">
                        <span>{t('mediaLibrary.dataConditions')}</span>
                        <span className="flex items-center gap-1 text-sm text-[var(--muted-foreground)]">
                          {mediaNameQuery.trim() || mediaTypeQuery !== 'any' ? t('mediaLibrary.conditionsSet') : t('mediaLibrary.conditionsEmpty')}
                          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                      </button>
                    </PopoverTrigger>
                  </div>
                  <PopoverContent side="left" align="start" sideOffset={0} fitViewport style={{ zIndex: 160 }} ignorePopoverOutside={folderPickerOpen} className="max-h-[min(70vh,420px)] w-[320px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                    {renderMediaFilterPanel(false)}
                  </PopoverContent>
                </Popover>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </> : <>
      <div className="flex items-center" role="group" aria-label={t('memo.documentList.viewType')}>
        <button
          type="button"
          aria-pressed="true"
          className="inline-flex h-8 items-center justify-start gap-1.5 rounded-lg px-0 text-sm font-medium text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        ><Folder className="h-3.5 w-3.5" aria-hidden="true" /><span className="max-w-[500px] truncate">{folderTitle}</span></button>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" className="px-3" onClick={() => setCreateOpen(true)} disabled={!listContext.notebookId}>{t('memo.documentList.new')}</Button>
      </div>
      </>}
    </div>
      {error ? <div className="flex h-full min-h-[160px] items-center justify-center text-center text-sm text-[var(--muted-foreground)]">
        {workDocuments ? <div className="flex items-center gap-3">
          <span>{t('memo.documentList.workDocumentsLoadFailed')}</span>
          <Button type="button" variant="ghost" size="sm" onClick={refresh}>{t('error.retry')}</Button>
        </div> : '不支持读取隐藏/系统文件夹'}
      </div>
        : (loading || (mediaLibrary && loadingLinkedItems)) && visibleItems.length === 0
        ? workDocuments ? <WorkDocumentsLoadingSkeleton showHeader={false} />
          : <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">正在整理文件列表…</div>
        : !loading && visibleItems.length === 0 && !(mediaLibrary && hasMore)
        ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">
              <div className="flex flex-col items-center text-center">
                {!mediaLibrary && <Inbox className="mb-3 h-10 w-10 opacity-50" strokeWidth={1.25} aria-hidden="true" />}
                {mediaLibrary && !hasMediaDataset && !hasLinkedMedia ? <div className="flex items-center gap-1">
                  <span>未添加图片或视频，</span>
                  <button type="button" disabled={libraryActionsDisabled || !onMediaLibraryFilterChange} onClick={openMediaDatasetMenu} className="inline-flex items-center gap-0.5 text-[var(--foreground)] hover:text-[var(--brand)] disabled:opacity-50">
                    选择数据<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  {onAddMedia && <button type="button" disabled={libraryActionsDisabled || addingMedia} onClick={addMedia} className="inline-flex items-center gap-0.5 text-[var(--foreground)] hover:text-[var(--brand)] disabled:opacity-50">
                    添加<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>}
                </div> : mediaLibrary && mediaLibraryFolderPath !== undefined ? <div className="flex items-center gap-1">
                  <span>未添加图片或视频，</span>
                  {onAddMedia && <button type="button" disabled={libraryActionsDisabled || addingMedia} onClick={addMedia} className="inline-flex items-center gap-0.5 text-[var(--foreground)] hover:text-[var(--brand)] disabled:opacity-50">
                    添加<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>}
                </div> : workDocuments && mediaFilterCount === 0 ? <div className="flex items-center gap-1">
                  <span>{t('workDocuments.noDataSelected')}</span>
                  <button type="button" disabled={libraryActionsDisabled || !onWorkDocumentsFilterChange} onClick={openMediaDatasetMenu} className="inline-flex items-center gap-0.5 text-[var(--foreground)] hover:text-[var(--brand)] disabled:opacity-50">
                    {t('workDocuments.selectData')}<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div> : workDocuments ? <span>{t('memo.documentList.workDocumentsEmpty')}</span> : <span>列表内容为空</span>}
              </div>
            </div>
          : mediaLibrary && visibleItems.length === 0 && hasMore
            ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">{t('mediaLibrary.searchingMore')}</div>
          : mediaLibrary
            ? <div ref={mediaGridRef} className="flex w-full items-start pt-0" style={{ gap: MEDIA_COLUMN_GAP }}>{mediaColumns.map((column, columnIndex) => (
              <VirtualizedMediaColumn
                key={columnIndex}
                items={column}
                scrollerRef={scrollRef}
                scrollMargin={mediaGridScrollMargin}
                renderCard={(item) => (
                  <DocumentCard
                    item={item}
                    notebookPath={listContext.notebookPath}
                    openItem={openItem}
                    mediaLibrary
                    observeMediaCard={observeMediaCard}
                    onRequestDelete={onDeleteMedia ? setMediaToDelete : undefined}
                    deleteLabel={t('media.fileTree.delete')}
                    deleteDisabled={libraryActionsDisabled || deletingMedia}
                  />
                )}
              />
            ))}</div>
            : <div style={{ paddingTop: firstRow * rowHeight, paddingBottom: Math.max(0, rowCount - lastRow) * rowHeight }}><div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-stretch gap-3.5 pt-3">{visibleCards.map((item) => <DocumentCard key={item.fullPath} item={item} notebookPath={listContext.notebookPath} openItem={openItem} />)}</div></div>}
      {moreError && <button type="button" className="mt-4 rounded-lg px-2 py-1 text-sm text-[var(--brand)] hover:bg-[var(--muted)]" onClick={loadMore}>加载失败，点击重试</button>}
      {hasMore && !moreError && <div ref={endRef} className="h-1" aria-hidden="true" />}
    </OverlayScrollbar>
    {mediaLibrary && <Dialog open={!!mediaToDelete} onOpenChange={(open) => { if (!open && !deletingMedia) setMediaToDelete(null); }}>
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('mediaLibrary.deleteImageTitle')}</DialogTitle>
          <DialogDescription>{t('mediaLibrary.deleteImageDescription', { name: mediaToDelete?.name ?? '' })}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" className="rounded-lg" disabled={deletingMedia} onClick={() => setMediaToDelete(null)}>{t('dialog.cancel')}</Button>
          <Button type="button" variant="outline" size="sm" disabled={deletingMedia} onClick={() => void confirmDeleteMedia()} className="rounded-lg hover:border-[var(--destructive)] hover:bg-transparent hover:text-[var(--destructive)]">{t('dialog.delete')}</Button>
        </div>
      </DialogContent>
    </Dialog>}
    {!mediaLibrary && <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-w-sm"><DialogTitle>新建笔记</DialogTitle><form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void createNote(); }}><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="笔记标题" className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" /><div className="flex justify-end gap-2"><Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" size="sm" className="rounded-lg" disabled={!newTitle.trim() || creating}>创建</Button></div></form></DialogContent></Dialog>}
  </section>;
}
