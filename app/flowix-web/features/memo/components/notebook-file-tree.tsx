'use client';

import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { AgentTasksSection } from '@features/agent/public/shell-api';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Loader2,
} from 'lucide-react';
import { SquaresFourIcon } from '@phosphor-icons/react';

import {
  canonicalDirectoryPath,
  canonicalPath,
  joinNotebookMemoPath,
  parentDirectoryPath,
  samePath,
} from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn, displayTitleFromFilename, isMediaLibraryFilename, isTableDocumentFilename, mediaLibraryExtension, tableDocumentExtension } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { FlowixCheckbox } from '@shared/ui/flowix-checkbox';
import { ListSurfaceLoadingState, ListSurfaceViewport } from '@shared/ui/list-surface';
import { Button } from '@shared/ui/button';
import { Popover, PopoverContent } from '@shared/ui/popover';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
import { NotebookCreateContextMenuItems } from '@features/memo/components/notebook-create-context-menu';
import { useNoteStore } from '@features/memo/store/note-store';
import { useCustomFilterStore } from '@features/memo/store/custom-filter-store';
import { NotebookPinnedSection, NotebookViewsSection } from '@features/memo/components/notebook-file-tree-sections';
import { useNotebookPinnedNotes } from '@features/memo/components/use-notebook-pinned-notes';
import { createMediaLibraryFile } from '@features/media-library/model';
import { updateNoteLinksAfterMove } from '@features/memo/services/note-link-rewriter';
import { replaceExternalDocumentPath } from '@features/workspace/use-cases/workspace-navigation';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { renameMarkdownTitle } from '@features/document/public/file-operations-api';
import { renameWorkspaceFile } from '@features/workspace/public/shell-api';
import folderIcon from '@/assets/folder-outline.svg?raw';
import {
  flattenLoadedTree,
  flattenVisibleTree,
  type FolderTreeController,
  type FolderTreeSort,
} from '@features/memo/components/use-folder-tree';
import { NotebookTreeRow } from '@features/memo/components/notebook-tree-row';
import { getWorkspaceAgentRepositories, type WorkspaceAgentRepository } from '@features/agent/public/workspace-api';
import { useAgentWorkspaceStore } from '@features/agent/store/agent-workspace-store';
import {
  files,
  dialogs,
  system,
  type DocTreeItem,
  type MediaLibraryListItem,
  type TableDocumentListItem,
} from '@platform/tauri/client';
import { resourceKindFromPath } from '@features/editor/code-file';
import { useDynamicVirtualList } from '@features/memo/hooks/use-dynamic-virtual-list';
import { useNotebookViewData } from './use-notebook-view-data';
import { AgentRepositoriesSection } from './notebook-repositories-section';
import { TREE_EDGE_GUTTER, INDENT_PER_LEVEL, TREE_ROW_GAP, TREE_ROW_HEIGHT, TREE_ROW_SIZE } from './notebook-tree-layout';
import { useNotebookTreeInteraction } from './use-notebook-tree-interaction';
import { useNotebookTreeDragController } from './use-notebook-tree-drag-controller';
import type { NotebookMoveResult, NotebookMoveSource } from './use-notebook-tree-drag-controller';
export type { NotebookMoveResult, NotebookMoveSource } from './use-notebook-tree-drag-controller';
import { getPopupOriginRect, NotebookTreeSectionMenu } from './notebook-tree-section-menu';
import {
  normalizeNotebookMoveFailure,
  showNotebookMoveFailureToasts,
  type NotebookMoveFailure,
} from './notebook-move-failure-toast';
import { getNotebookFolderImportErrorKey } from './notebook-folder-import';
import { createTableDocumentFile, type TableViewType } from '@features/multidimensional-table/public/create-api';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@shared/ui/context-menu';

const TREE_HEADER_HEIGHT = 30;
const TREE_VIRTUAL_OVERSCAN = 20;
const logger = createLogger('notebook-file-tree');
// Row gutter (6px) + inline padding (6px) + half of the 12px caret.
const FOLDER_CARET_CENTER_OFFSET = 12;

type NotebookTreeSection = 'agents' | 'pinned' | 'views' | 'files' | 'repositories';

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

function tableDocumentTreeItem(table: TableDocumentListItem, fullPath: string): DocTreeItem {
  const name = table.relativePath.split(/[\\/]/).pop() ?? `${table.name}.table.yml`;
  return {
    id: `table-path:${table.relativePath}`,
    fullPath,
    name,
    type: 'document',
    parentId: null,
    children: null,
    sizeBytes: null,
    modifiedMs: table.modifiedMs,
    createdMs: null,
    memoCreatedMs: null,
    resourceKind: 'other',
  };
}

function mediaLibraryTreeItem(library: MediaLibraryListItem, fullPath: string): DocTreeItem {
  const name = library.relativePath.split(/[\\/]/).pop() ?? `${library.name}.lib.yaml`;
  return {
    id: `media-library-path:${library.relativePath}`,
    fullPath,
    name,
    type: 'document',
    parentId: null,
    children: null,
    sizeBytes: null,
    modifiedMs: library.modifiedMs,
    createdMs: null,
    memoCreatedMs: null,
    resourceKind: 'other',
  };
}


function relativeFolderPath(notebookPath: string, folderPath: string): string {
  const root = canonicalDirectoryPath(notebookPath);
  const folder = canonicalPath(folderPath);
  if (folder === root) return '';
  return folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : folder;
}

export interface NotebookFolderCreateRequest {
  id: number;
  parentPath: string;
}

export interface NotebookNoteCreateRequest {
  id: number;
  parentPath: string;
}

interface NotebookFileTreeProps {
  notebookId?: string;
  notebookPath: string;
  notebookName: string;
  activeFilePath?: string | null;
  tree: FolderTreeController;
  isActive?: boolean;
  createFolderRequest?: NotebookFolderCreateRequest | null;
  createNoteRequest?: NotebookNoteCreateRequest | null;
  onCreateFolder?: () => void;
  onNoteSelect: (filePath: string) => void;
  onFolderSelect?: (folderPath: string) => void;
  onNoteOpenInNewTab?: (filePath: string) => void;
  onCreateNote: (parentPath: string, title: string) => Promise<void> | void;
  onMoveNote: (
    sources: NotebookMoveSource[],
    targetDirectoryPath: string,
  ) => Promise<NotebookMoveResult>;
  onDeleteFolder?: (folderPath: string) => Promise<void>;
  onDeleteFile?: (item: DocTreeItem) => Promise<void>;
  defaultCreateFolder?: string | null;
  onSetDefaultCreateFolder?: (folderPath: string) => void;
}

interface NotebookTreeDraftState {
  requestId: number;
  parentPath: string;
  kind: 'note' | 'folder';
  value: string;
}

interface NotebookTreeNodeRenderRow {
  kind: 'node';
  key: string;
  item: DocTreeItem;
  depth: number;
  parentPath: string;
  posInSet?: number;
  setSize?: number;
}

interface NotebookTreeDraftRenderRow {
  kind: 'draft';
  key: string;
  draft: NotebookTreeDraftState;
  depth: number;
  parentPath: string;
}

type NotebookTreeRenderRow = NotebookTreeNodeRenderRow | NotebookTreeDraftRenderRow;

function attachTreeSiblingMetadata(rows: NotebookTreeRenderRow[]): NotebookTreeRenderRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== 'node') continue;
    counts.set(row.parentPath, (counts.get(row.parentPath) ?? 0) + 1);
  }
  const positions = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== 'node') continue;
    const position = (positions.get(row.parentPath) ?? 0) + 1;
    positions.set(row.parentPath, position);
    row.posInSet = position;
    row.setSize = counts.get(row.parentPath);
  }
  return rows;
}

export function buildNotebookTreeRenderRows(
  visibleItems: Array<{ item: DocTreeItem; depth: number }>,
  notebookPath: string,
  draft: NotebookTreeDraftState | null,
): NotebookTreeRenderRow[] {
  const root = canonicalDirectoryPath(notebookPath);
  const rows: NotebookTreeRenderRow[] = visibleItems.map(({ item, depth }) => ({
    kind: 'node',
    key: `node:${canonicalPath(item.fullPath)}`,
    item,
    depth,
    parentPath: parentDirectoryPath(item.fullPath, root),
  }));
  if (!draft) return attachTreeSiblingMetadata(rows);

  const parentPath = canonicalDirectoryPath(draft.parentPath);
  const parentIndex = parentPath === root
    ? -1
    : rows.findIndex((row) => row.kind === 'node' && samePath(row.item.fullPath, parentPath));
  if (parentPath !== root && parentIndex < 0) return attachTreeSiblingMetadata(rows);

  const parentDepth = parentIndex < 0 ? -1 : rows[parentIndex].depth;
  const childDepth = parentDepth + 1;
  const rangeStart = parentIndex + 1;
  let rangeEnd = rows.length;
  for (let index = rangeStart; index < rows.length; index += 1) {
    if (rows[index].depth <= parentDepth) {
      rangeEnd = index;
      break;
    }
  }

  const requestedType = draft.kind === 'folder' ? 'folder' : 'document';
  let insertionIndex = -1;
  for (let index = rangeStart; index < rangeEnd; index += 1) {
    const row = rows[index];
    if (
      row.kind === 'node'
      && row.depth === childDepth
      && samePath(row.parentPath, parentPath)
      && row.item.type === requestedType
    ) {
      insertionIndex = index;
      break;
    }
  }

  if (insertionIndex < 0) {
    if (draft.kind === 'folder') {
      insertionIndex = rangeStart;
    } else {
      insertionIndex = rangeEnd;
    }
  }

  rows.splice(insertionIndex, 0, {
    kind: 'draft',
    key: `draft:${draft.requestId}`,
    draft,
    depth: childDepth,
    parentPath,
  });
  return attachTreeSiblingMetadata(rows);
}


/**
 * Notebook file tree with selection, pointer dragging, and external drops.
 */
export function NotebookFileTree({
  notebookId: notebookIdProp,
  notebookPath,
  notebookName,
  activeFilePath = null,
  tree,
  isActive = true,
  createFolderRequest,
  createNoteRequest,
  onCreateFolder,
  onNoteSelect,
  onFolderSelect,
  onNoteOpenInNewTab,
  onCreateNote,
  onMoveNote,
  onDeleteFolder,
  onDeleteFile,
  defaultCreateFolder,
  onSetDefaultCreateFolder,
}: NotebookFileTreeProps) {
  const { t } = useI18n();
  const selectedFolderPath = useWorkColumnStore((state) => {
    const target = state.navigation.target;
    if ((target.kind === 'collection' || target.kind === 'table' || target.kind === 'media-library') && canonicalPath(target.filePath).endsWith('/.index.yaml')) {
      return parentDirectoryPath(target.filePath, target.notebookPath ?? '');
    }
    return null;
  });
  const refreshTrigger = useNoteStore((state) => state.refreshTrigger);
  const notebookIdFromStore = useNoteStore((state) => (
    state.notebooks.find((notebook) => samePath(notebook.path, notebookPath))?.id ?? null
  ));
  const notebookId = notebookIdProp ?? notebookIdFromStore;
  const loadNotebookFilters = useCustomFilterStore((state) => state.loadNotebookFilters);
  const agentWorkspaceNotebook = useAgentWorkspaceStore((state) =>
    notebookId ? state.workspace.byNotebookId[notebookId] : undefined,
  );
  const agentRepositories = useMemo(
    () => getWorkspaceAgentRepositories(notebookId),
    [agentWorkspaceNotebook, notebookId],
  );
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  const {
    pinnedItems,
    hasPrevious: pinnedHasPrevious,
    hasMore: pinnedHasMore,
    loadingMore: pinnedLoadingMore,
    loadingInitial: pinnedLoadingInitial,
    loadPrevious: loadPreviousPinned,
    loadMore: loadMorePinned,
    removePinnedItem,
  } = useNotebookPinnedNotes({
    notebookId,
    notebookPath,
    isActive,
    refreshTrigger,
  });
  const {
    tableDocuments,
    mediaLibraries,
    refreshTables,
    refreshMediaLibraries,
    updateTableIdentity,
    updateMediaLibraryIdentity,
  } = useNotebookViewData({
    notebookId,
    notebookPath,
    isActive,
    refreshTrigger,
    ignoreCollectionPathEvents: tree.ignoreCollectionPathEvents,
  });
  const [newTableDialogOpen, setNewTableDialogOpen] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [newTableViewType, setNewTableViewType] = useState<TableViewType>('table');
  const [newTableInViews, setNewTableInViews] = useState(false);
  const [newTableParentFolder, setNewTableParentFolder] = useState<string | null>(null);
  const [isCreatingTable, setIsCreatingTable] = useState(false);
  const [newLibraryDialogOpen, setNewLibraryDialogOpen] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  const [newLibraryInViews, setNewLibraryInViews] = useState(false);
  const [newLibraryParentFolder, setNewLibraryParentFolder] = useState<string | null>(null);
  const [isCreatingLibrary, setIsCreatingLibrary] = useState(false);
  const viewTableDocuments = useMemo(() => tableDocuments.filter((table) => table.inViews), [tableDocuments]);
  const viewMediaLibraries = useMemo(() => mediaLibraries.filter((library) => library.inViews), [mediaLibraries]);
  const tableDocumentByPath = useMemo(() => {
    const byPath = new Map<string, TableDocumentListItem>();
    for (const table of tableDocuments) {
      const fullPath = joinNotebookMemoPath(notebookPath, table.relativePath);
      if (fullPath) byPath.set(canonicalPath(fullPath), table);
    }
    return byPath;
  }, [notebookPath, tableDocuments]);
  const mediaLibraryByPath = useMemo(() => {
    const byPath = new Map<string, MediaLibraryListItem>();
    for (const library of mediaLibraries) {
      const fullPath = joinNotebookMemoPath(notebookPath, library.relativePath);
      if (fullPath) byPath.set(canonicalPath(fullPath), library);
    }
    return byPath;
  }, [mediaLibraries, notebookPath]);
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [viewsCollapsed, setViewsCollapsed] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [fileTreeSort, setFileTreeSort] = useState<FolderTreeSort>('createdAt');
  const [repositorySectionHeight, setRepositorySectionHeight] = useState(0);
  const [sectionOrder, setSectionOrder] = useState<NotebookTreeSection[]>(DEFAULT_TREE_SECTION_ORDER);
  const [hiddenSections, setHiddenSections] = useState<NotebookTreeSection[]>([]);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [customizeAnchorRect, setCustomizeAnchorRect] = useState<DOMRect | null>(null);
  const [customizeOrder, setCustomizeOrder] = useState<NotebookTreeSection[]>(DEFAULT_TREE_SECTION_ORDER);
  const [customizeHidden, setCustomizeHidden] = useState<NotebookTreeSection[]>([]);
  const openCustomizeDisplay = useCallback((anchorRect: DOMRect) => {
    setCustomizeAnchorRect(anchorRect);
    setCustomizeOrder([...sectionOrder]);
    setCustomizeHidden([...hiddenSections]);
    setCustomizeOpen(true);
  }, [hiddenSections, sectionOrder]);
  const updateCustomizeSectionVisibility = useCallback((section: NotebookTreeSection, visible: boolean) => {
    const nextHiddenSections = visible
      ? customizeHidden.filter((item) => item !== section)
      : [...customizeHidden, section];
    setCustomizeHidden(nextHiddenSections);
    setHiddenSections(nextHiddenSections);
    if (notebookId) {
      void system.setNotebookFileTreeSectionOrder(notebookId, sectionOrder, nextHiddenSections).catch((error) => {
        logger.warn('failed to save notebook file tree section visibility', { error, notebookId, section });
      });
    }
  }, [customizeHidden, notebookId, sectionOrder]);
  const updateCustomizeSectionOrder = useCallback((nextOrder: NotebookTreeSection[]) => {
    setCustomizeOrder(nextOrder);
    setSectionOrder(nextOrder);
    if (notebookId) {
      void system.setNotebookFileTreeSectionOrder(notebookId, nextOrder, hiddenSections).catch((error) => {
        logger.warn('failed to save notebook file tree section order', { error, notebookId });
      });
    }
  }, [hiddenSections, notebookId]);
  const draggedSection = useRef<NotebookTreeSection | null>(null);
  const sectionDragPointerId = useRef<number | null>(null);
  const sectionDropTargetRef = useRef<{ section: NotebookTreeSection; after: boolean } | null>(null);
  const [sectionDropTarget, setSectionDropTarget] = useState<{ section: NotebookTreeSection; after: boolean } | null>(null);
  const [agentSectionHeight, setAgentSectionHeight] = useState(0);
  const [draft, setDraft] = useState<NotebookTreeDraftState | null>(null);
  const treeScrollerRef = useRef<HTMLDivElement | null>(null);
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  const externalDropSurfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isActive) return;
    if (notebookId) void loadNotebookFilters(notebookId);
  }, [isActive, loadNotebookFilters, notebookId]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    setSectionOrder(DEFAULT_TREE_SECTION_ORDER);
    setHiddenSections([]);
    if (!notebookId) return () => { cancelled = true; };
    void system.getNotebookFileTreePreferences(notebookId).then((preferences) => {
      if (cancelled) return;
      setSectionOrder(normalizeTreeSectionOrder(preferences.sectionOrder));
      setHiddenSections((preferences.hiddenSections ?? []).filter((item): item is NotebookTreeSection => DEFAULT_TREE_SECTION_ORDER.includes(item as NotebookTreeSection)));
    }).catch((error) => {
      logger.warn('failed to load notebook file tree preferences', { error, notebookId });
    });
    return () => { cancelled = true; };
  }, [isActive, notebookId]);

  const visibleSectionOrder = useMemo(() => sectionOrder.filter((section) => (
    !hiddenSections.includes(section) && (section === 'files'
    || section === 'repositories'
    || (section === 'agents' && Boolean(notebookId) && agentSectionHeight > 0)
    || (section === 'pinned' && (pinnedItems.length > 0 || pinnedHasPrevious || pinnedHasMore))
    || section === 'views')
  )), [agentSectionHeight, hiddenSections, notebookId, pinnedHasMore, pinnedHasPrevious, pinnedItems.length, sectionOrder]);

  const moveTreeSection = useCallback((section: NotebookTreeSection, direction: -1 | 1) => {
    if (!notebookId) return;
    const visibleIndex = visibleSectionOrder.indexOf(section);
    const targetSection = visibleSectionOrder[visibleIndex + direction];
    if (visibleIndex < 0 || !targetSection) return;
    const index = sectionOrder.indexOf(section);
    const targetIndex = sectionOrder.indexOf(targetSection);
    const next = [...sectionOrder];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    setSectionOrder(next);
    void system.setNotebookFileTreeSectionOrder(notebookId, next).catch((error) => {
      logger.warn('failed to save notebook file tree section order', { error, notebookId });
    });
  }, [notebookId, sectionOrder, visibleSectionOrder]);
  const hideTreeSection = useCallback((section: NotebookTreeSection) => {
    if (!notebookId || hiddenSections.includes(section)) return;
    const nextHiddenSections = [...hiddenSections, section];
    setHiddenSections(nextHiddenSections);
    void system.setNotebookFileTreeSectionOrder(notebookId, sectionOrder, nextHiddenSections).catch((error) => {
      logger.warn('failed to save hidden notebook file tree section', { error, notebookId, section });
    });
  }, [hiddenSections, notebookId, sectionOrder]);
  const treeHeaderRef = useRef<HTMLDivElement | null>(null);
  const handledFolderRequestIdRef = useRef<number | null>(null);
  const handledNoteRequestIdRef = useRef<number | null>(null);
  const cancelledDraftRequestIdRef = useRef<number | null>(null);
  const submittingDraftRef = useRef(false);
  const [keptAlivePaths, setKeptAlivePaths] = useState<Set<string>>(() => new Set());
  const loadedTreeItems = useMemo(() => flattenLoadedTree(tree), [tree]);
  const visibleTreeItems = useMemo(() => flattenVisibleTree(tree, fileTreeSort), [fileTreeSort, tree]);
  const renderRows = useMemo(
    () => buildNotebookTreeRenderRows(visibleTreeItems, notebookPath, draft),
    [draft, notebookPath, visibleTreeItems],
  );
  const pinnedSectionHeight = pinnedItems.length > 0 || pinnedHasPrevious || pinnedHasMore
    ? TREE_HEADER_HEIGHT + (pinnedCollapsed ? 0 : pinnedItems.length * TREE_ROW_SIZE + (pinnedHasPrevious || pinnedHasMore ? TREE_ROW_SIZE : 0)) + 12
    : 0;
  const viewsSectionHeight = TREE_HEADER_HEIGHT + (viewsCollapsed ? 0 : (viewTableDocuments.length + viewMediaLibraries.length) * TREE_ROW_SIZE) + 12;
  const sectionHeights: Record<NotebookTreeSection, number> = {
    agents: notebookId ? agentSectionHeight : 0,
    pinned: pinnedSectionHeight,
    views: viewsSectionHeight,
    files: TREE_HEADER_HEIGHT,
    repositories: repositorySectionHeight,
  };
  const treeContentOffset = TREE_HEADER_HEIGHT + sectionOrder
    .slice(0, sectionOrder.indexOf('files'))
    .reduce((height, section) => height + (hiddenSections.includes(section) ? 0 : sectionHeights[section]), 0);
  const handleAgentSectionHeightChange = useCallback((height: number) => {
    setAgentSectionHeight((current) => current === height ? current : height);
  }, []);
  const handleShowAllAgentConversations = useCallback(() => {
    useNoteStore.getState().setMiddleColumnView('conversations');
  }, []);
  const handleRepositorySectionHeightChange = useCallback((height: number) => {
    setRepositorySectionHeight((current) => current === height ? current : height);
  }, []);
  const handleRepositoryExpand = useCallback((repositoryElement: HTMLElement) => {
    const scroller = treeScrollerRef.current;
    if (!scroller) return;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const repositoryTop = repositoryElement.getBoundingClientRect().top;
    scroller.scrollTop += repositoryTop - scrollerTop - 36;
  }, []);
  const renderRowIndexByPath = useMemo(() => new Map(
    renderRows.flatMap((row, index) => row.kind === 'node'
      ? [[canonicalPath(row.item.fullPath), index] as const]
      : []),
  ), [renderRows]);
  const treeItemByPath = useMemo(
    () => new Map(loadedTreeItems.map((item) => [canonicalPath(item.fullPath), item] as const)),
    [loadedTreeItems],
  );
  const treeItemPaths = useMemo(() => new Set(treeItemByPath.keys()), [treeItemByPath]);
  const {
    focusedTreePath,
    setFocusedTreePath,
    selectedFilePaths,
    selectedFilePathSet,
    updateSelection,
    getSelectionAnchorPath,
    setNavigationPolicy,
    navigateToNote,
    activeFileShouldReveal,
    treeFocusPath,
    handleTreeItemKeyDown,
    selectNote,
  } = useNotebookTreeInteraction({
    activeFilePath,
    visibleTreeItems,
    treeItemPaths,
    tree,
    treeRootRef,
    treeScrollerRef,
    renderRowIndexByPath,
    treeContentOffset,
    onNoteSelect,
  });
  const {
    dragOverFolderPath,
    dragPreview,
    dragPreviewRef,
    dragPreviewPositionRef,
    moveFeedback,
    startItemDrag: handlePointerDownItem,
    handlePointerMove: handleTreePointerMove,
    handlePointerUp: handleTreePointerUp,
    handlePointerCancel: handleTreePointerCancel,
    shouldSuppressOpen: shouldSuppressOpenPath,
  } = useNotebookTreeDragController({
    notebookId,
    notebookPath,
    tree,
    treeItemsByPath: treeItemByPath,
    selectedFilePaths,
    getSelectionAnchorPath,
    updateSelection,
    onMoveNote,
    treeRootRef,
    treeHeaderRef,
    treeScrollerRef,
    externalDropSurfaceRef,
    t,
  });
  const getRenderRowKey = useCallback((row: NotebookTreeRenderRow) => row.key, []);
  const estimateRenderRowSize = useCallback(() => TREE_ROW_SIZE, []);
  const keepAliveKeys = useMemo(() => {
    const keys = [...keptAlivePaths].map((path) => 'node:' + canonicalPath(path));
    if (focusedTreePath) keys.push('node:' + canonicalPath(focusedTreePath));
    if (draft) keys.push('draft:' + draft.requestId);
    return keys;
  }, [draft, focusedTreePath, keptAlivePaths]);
  const {
    totalSize: virtualTreeSize,
    virtualItems: virtualTreeRows,
  } = useDynamicVirtualList({
    items: renderRows,
    getKey: getRenderRowKey,
    estimateSize: estimateRenderRowSize,
    scrollerRef: treeScrollerRef,
    enabled: !filesCollapsed,
    resetKey: notebookPath,
    overscan: TREE_VIRTUAL_OVERSCAN,
    keepAliveKeys,
    scrollMargin: treeContentOffset,
  });
  useEffect(() => {
    if (!draft) return;
    const index = renderRows.findIndex((row) => row.key === 'draft:' + draft.requestId);
    const scroller = treeScrollerRef.current;
    if (index < 0 || !scroller) return;
    const rowTop = treeContentOffset + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
  }, [draft, renderRows, treeContentOffset]);
  const handleRowKeepAliveChange = useCallback((path: string, active: boolean) => {
    const key = canonicalPath(path);
    setKeptAlivePaths((previous) => {
      const alreadyKept = previous.has(key);
      if (alreadyKept === active) return previous;
      const next = new Set(previous);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const hasVisibleItems = tree.rootChildren.length > 0;
  const isRootDropTarget = dragOverFolderPath !== null
    && canonicalDirectoryPath(dragOverFolderPath) === canonicalDirectoryPath(notebookPath);
  const expandToRef = useRef(tree.expandTo);
  expandToRef.current = tree.expandTo;

  useEffect(() => {
    if (!isActive || !activeFilePath || !activeFileShouldReveal || tree.loading) return;
    void expandToRef.current(activeFilePath);
  }, [activeFileShouldReveal, activeFilePath, isActive, tree.loading]);

  useEffect(() => {
    if (!createFolderRequest || handledFolderRequestIdRef.current === createFolderRequest.id) return;
    handledFolderRequestIdRef.current = createFolderRequest.id;
    void tree.expandTo(`${createFolderRequest.parentPath}/__new-folder__`);
    setDraft({
      requestId: createFolderRequest.id,
      parentPath: createFolderRequest.parentPath,
      kind: 'folder',
      value: '',
    });
  }, [createFolderRequest, tree.expandTo]);

  useEffect(() => {
    if (!createNoteRequest || handledNoteRequestIdRef.current === createNoteRequest.id) return;
    handledNoteRequestIdRef.current = createNoteRequest.id;
    void tree.expandTo(`${createNoteRequest.parentPath}/__new-note__`);
    setDraft({
      requestId: createNoteRequest.id,
      parentPath: createNoteRequest.parentPath,
      kind: 'note',
      value: '',
    });
  }, [createNoteRequest, tree.expandTo]);

  const submitDraft = useCallback(async () => {
    if (!draft) return;
    if (cancelledDraftRequestIdRef.current === draft.requestId) {
      cancelledDraftRequestIdRef.current = null;
      return;
    }
    if (submittingDraftRef.current) return;
    submittingDraftRef.current = true;
    const { parentPath, kind, value } = draft;
    const name = value.trim();
    if (!name) {
      setDraft(null);
      submittingDraftRef.current = false;
      return;
    }
    try {
      if (kind === 'note') {
        await onCreateNote(parentPath, name);
        await tree.refresh(parentPath);
        setDraft(null);
        return;
      }
      const created = await files.createFolder(parentPath, name);
      if (!created) {
        toast.error(t('memo.fileTree.createFailed'));
        return;
      }
      await tree.refresh(parentPath);
      setDraft(null);
    } catch (error) {
      toast.error(t(
        String(error).includes('FILE_EXISTS')
          ? 'memo.fileTree.nameConflict'
          : 'memo.fileTree.createFailed',
      ));
    } finally {
      submittingDraftRef.current = false;
    }
  }, [draft, onCreateNote, t, tree.refresh]);

  const cancelDraft = useCallback(() => {
    if (!draft) return;
    cancelledDraftRequestIdRef.current = draft.requestId;
    setDraft(null);
  }, [draft]);

  const requestCreateDraft = useCallback((parentPath: string, kind: 'note' | 'folder') => {
    void tree.expandTo(`${parentPath}/__new-${kind}__`);
    setDraft({ requestId: Date.now(), parentPath, kind, value: '' });
  }, [tree.expandTo]);

  const handleRename = useCallback(async (item: DocTreeItem, nextName: string) => {
    const trimmed = nextName.trim();
    const isNote = item.type === 'document'
      && (item.resourceKind ?? resourceKindFromPath(item.name)) === 'note';
    const isTableDocument = item.type === 'document' && isTableDocumentFilename(item.name);
    const isMediaLibrary = item.type === 'document' && isMediaLibraryFilename(item.name);
    const currentName = item.type === 'folder'
      ? item.name
      : isNote || isTableDocument || isMediaLibrary ? displayTitleFromFilename(item.name) : item.name;
    if (!trimmed || trimmed === currentName) return true;

    try {
      if (item.type === 'folder') {
        const renamedPath = await tree.renameFolder(item.fullPath, trimmed, notebookPath);
        const oldFolderPath = canonicalDirectoryPath(item.fullPath);
        const newFolderPath = canonicalDirectoryPath(renamedPath);
        const expandedPathsToRefresh = [...tree.expanded]
          .filter((path) => (path === oldFolderPath || path.startsWith(`${oldFolderPath}/`))
            && (tree.loadingDirectories.has(path) || !tree.nodes.get(path)?.children?.length))
          .map((path) => `${newFolderPath}${path.slice(oldFolderPath.length)}`);
        updateNoteLinksAfterMove(item.fullPath, renamedPath, true);
        await Promise.all(expandedPathsToRefresh.map((path) => tree.refresh(path)));
      } else {
        if (isNote) {
          const fileIdentity = ensureFileDisplayIdentity(item.fullPath);
          const result = await renameMarkdownTitle({
            path: item.fullPath,
            title: trimmed,
            scopePath: notebookPath,
            notebook: notebookId ? { id: notebookId, path: notebookPath } : null,
            displayId: fileIdentity.displayId,
            onPathChanged: (oldPath, newPath) => replaceExternalDocumentPath(fileIdentity.displayId, oldPath, newPath),
          });
          if (!result) return false;
          if (!result.changed) return true;
        } else {
          const extension = isTableDocument
            ? tableDocumentExtension(item.name)
            : isMediaLibrary ? mediaLibraryExtension(item.name)
              : isNote ? item.name.match(/\.(md|markdown)$/i)?.[0] ?? '' : '';
          await renameWorkspaceFile({
            path: item.fullPath,
            name: `${trimmed}${extension}`,
            scopePath: notebookPath,
            notebookId: notebookId ?? undefined,
            collectionId: tableDocumentByPath.get(canonicalPath(item.fullPath))?.collectionId ?? mediaLibraryByPath.get(canonicalPath(item.fullPath))?.collectionId,
          });
        }
      }

      const normalizedPath = canonicalPath(item.fullPath);
      const parent = normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
      if (item.type !== 'folder' && !isTableDocument && !isMediaLibrary) await tree.refresh(parent || notebookPath);
      toast.success(t('memo.fileTree.renamed', { name: trimmed }));
      return true;
    } catch (error) {
      toast.error(t(String(error).includes('FILE_EXISTS')
        ? 'memo.fileTree.nameConflict'
        : 'memo.fileTree.renameFailed'));
      return false;
    }
  }, [notebookPath, notebookId, tableDocumentByPath, mediaLibraryByPath, t, tree]);

  const handleRenameTableDocument = useCallback(async (item: DocTreeItem, nextName: string) => {
    const trimmed = nextName.trim();
    const currentName = displayTitleFromFilename(item.name);
    if (!trimmed || trimmed === currentName) return true;
    try {
      await renameWorkspaceFile({
        path: item.fullPath,
        name: `${trimmed}${tableDocumentExtension(item.name)}`,
        scopePath: notebookPath,
        notebookId: notebookId ?? undefined,
        collectionId: tableDocumentByPath.get(canonicalPath(item.fullPath))?.collectionId,
      });
      if (notebookId) await refreshTables();
      toast.success(t('memo.fileTree.renamed', { name: trimmed }));
      return true;
    } catch (error) {
      toast.error(t(String(error).includes('FILE_EXISTS')
        ? 'memo.fileTree.nameConflict'
        : 'memo.fileTree.renameFailed'));
      return false;
    }
  }, [notebookId, notebookPath, t, refreshTables]);

  const handleDeleteTableDocument = useCallback(async (item: DocTreeItem) => {
    try {
      if (onDeleteFile) {
        await onDeleteFile(item);
      } else {
        const deleted = await files.delete(item.fullPath, notebookPath);
        if (!deleted) {
          toast.error(t('memo.fileTree.deleteFailed'));
          return;
        }
        toast.success(t('memo.fileTree.deleted', { name: displayTitleFromFilename(item.name) }));
      }
      if (notebookId) await refreshTables();
    } catch {
      toast.error(t('memo.fileTree.deleteFailed'));
    }
  }, [notebookId, notebookPath, onDeleteFile, t, refreshTables]);
  const handleDeleteMediaLibrary = useCallback(async (item: DocTreeItem) => {
    try {
      if (onDeleteFile) {
        await onDeleteFile(item);
      } else {
        const deleted = await files.delete(item.fullPath, notebookPath);
        if (!deleted) {
          toast.error(t('memo.fileTree.deleteFailed'));
          return;
        }
        toast.success(t('memo.fileTree.deleted', { name: displayTitleFromFilename(item.name) }));
      }
      if (notebookId) await refreshMediaLibraries();
    } catch {
      toast.error(t('memo.fileTree.deleteFailed'));
    }
  }, [notebookId, notebookPath, onDeleteFile, t, refreshMediaLibraries]);

  const handleTogglePath = useCallback((path: string) => {
    if (shouldSuppressOpenPath(path)) return;
    tree.toggle(path);
  }, [shouldSuppressOpenPath, tree.toggle]);
  const openMediaLibraryPath = useCallback((
    path: string,
    host: 'main-third' | 'browser-column',
    navigationPolicy: 'reveal' | 'preserve' = 'reveal',
  ) => {
    const mediaLibrary = mediaLibraryByPath.get(canonicalPath(path));
    if (!mediaLibrary || !notebookId) return false;
    if (host === 'main-third') setNavigationPolicy(path, navigationPolicy);
    void openWorkspaceSurface({
      ...(host === 'browser-column'
        ? { host, options: { browserDisposition: 'open-in-column' as const } }
        : { host }),
      target: {
        kind: 'collection-reference',
        notebookId,
        collectionId: mediaLibrary.collectionId,
        collectionKind: 'media_library',
        relativePathHint: mediaLibrary.relativePath,
      },
    }).catch((error) => {
      logger.warn('failed to open media library', { error, path, host });
      toast.error(t('memo.fileTree.openFailed'));
    });
    return true;
  }, [mediaLibraryByPath, notebookId, setNavigationPolicy, t]);
  const handleOpenPath = useCallback((path: string, event?: ReactMouseEvent<HTMLDivElement>) => {
    if (shouldSuppressOpenPath(path)) return;
    if (openMediaLibraryPath(path, 'main-third', 'reveal')) return;
    selectNote(path, event);
  }, [openMediaLibraryPath, selectNote, shouldSuppressOpenPath]);
  const handleOpenPinnedPath = useCallback((path: string) => {
    if (shouldSuppressOpenPath(path)) return;
    updateSelection([], null);
    navigateToNote(path, 'preserve');
  }, [navigateToNote, shouldSuppressOpenPath, updateSelection]);
  const handleOpenRepositoryFile = useCallback((path: string, scopePath: string) => {
    void openWorkspaceSurface({
      host: 'main-third',
      target: { kind: 'external', path, scopePath, transitionId: null },
    }).catch((error) => {
      logger.warn('failed to open repository file', { error, path });
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [t]);
  const handleOpenTableDocument = useCallback((relativePath: string) => {
    const path = joinNotebookMemoPath(notebookPath, relativePath);
    if (!path) return;
    setNavigationPolicy(path, 'preserve');
    void openWorkspaceSurface({
      host: 'main-third',
      target: { kind: 'external', path, scopePath: notebookPath, transitionId: null },
      options: { notebookId },
    }).catch((error) => {
      logger.warn('failed to open table document', { error, path });
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [notebookId, notebookPath, setNavigationPolicy, t]);
  const handleOpenMediaLibraryFromViews = useCallback((path: string) => {
    if (openMediaLibraryPath(path, 'main-third', 'preserve')) return;
    selectNote(path);
  }, [openMediaLibraryPath, selectNote]);
  const openNewTableDialog = useCallback((inViews = false, parentFolderPath?: string, viewType: TableViewType = 'table') => {
    setNewTableInViews(inViews);
    setNewTableParentFolder(parentFolderPath ?? null);
    setNewTableViewType(viewType);
    setNewTableName(viewType === 'gallery'
      ? t('memo.create.galleryDefaultName')
      : viewType === 'kanban'
        ? t('memo.create.kanbanDefaultName')
        : viewType === 'calendar'
          ? t('memo.create.calendarDefaultName')
          : t('memo.create.tableDefaultName'));
    setNewTableDialogOpen(true);
  }, [t]);
  const handleSetTableDocumentInViews = useCallback(async (collectionId: string, inViews: boolean) => {
    if (!notebookId) return;
    try {
      await files.setTableDocumentInViews(notebookId, collectionId, inViews);
      await refreshTables();
    } catch (error) {
      logger.warn('failed to update table view-group visibility', { error, notebookId, collectionId });
      toast.error(t('multidimensionalTable.viewMembership.saveFailed'));
    }
  }, [notebookId, t, refreshTables]);
  const handleSetMediaLibraryInViews = useCallback(async (collectionId: string, inViews: boolean) => {
    if (!notebookId) return;
    try {
      await files.setMediaLibraryInViews(notebookId, collectionId, inViews);
      await refreshMediaLibraries();
    } catch (error) {
      logger.warn('failed to update media library view-group visibility', { error, notebookId, collectionId });
      toast.error(t('mediaLibrary.viewMembership.saveFailed'));
    }
  }, [notebookId, t, refreshMediaLibraries]);
  const handleRetryDirectory = useCallback((path: string) => {
    void tree.retryDirectory?.(path);
  }, [tree.retryDirectory]);
  const handleCreateViewAtPath = useCallback((parentPath: string, viewType?: TableViewType) => {
    openNewTableDialog(false, parentPath, viewType);
  }, [openNewTableDialog]);
  const handleMakeTableIdentityUnique = useCallback(async (relativePath: string) => {
    if (!notebookId) return;
    try {
      const collectionId = await files.makeViewDocumentIdentityUnique(notebookId, relativePath);
      updateTableIdentity(relativePath, collectionId);
      try {
        await refreshTables();
      } catch (error) {
        logger.warn('failed to reload table catalog after assigning identity', { error, notebookId, relativePath });
      }
      toast.success(t('multidimensionalTable.identityRegenerated'));
    } catch (error) {
      logger.warn('failed to regenerate copied table identity', { error, notebookId, relativePath });
      toast.error(t('multidimensionalTable.identityRegenerateFailed'));
    }
  }, [notebookId, t, refreshTables, updateTableIdentity]);
  const handleMakeMediaLibraryIdentityUnique = useCallback(async (relativePath: string) => {
    if (!notebookId) return;
    try {
      const collectionId = await files.makeViewDocumentIdentityUnique(notebookId, relativePath);
      updateMediaLibraryIdentity(relativePath, collectionId);
      try {
        await refreshMediaLibraries();
      } catch (error) {
        logger.warn('failed to reload media library catalog after assigning identity', { error, notebookId, relativePath });
      }
      toast.success(t('mediaLibrary.identityRegenerated'));
    } catch (error) {
      logger.warn('failed to regenerate copied media library identity', { error, notebookId, relativePath });
      toast.error(t('mediaLibrary.identityRegenerateFailed'));
    }
  }, [notebookId, t, refreshMediaLibraries, updateMediaLibraryIdentity]);
  const tableViewVisibilityByPath = useMemo(() => new Map(
    [...tableDocumentByPath].map(([path, tableDocument]) => [path, {
      collectionId: tableDocument.collectionId,
      inViews: tableDocument.inViews,
      identityConflict: tableDocument.identityConflict ?? false,
      onChange: (inViews: boolean) => {
        void handleSetTableDocumentInViews(tableDocument.collectionId, inViews);
      },
      onMakeIdentityUnique: () => {
        void handleMakeTableIdentityUnique(tableDocument.relativePath);
      },
    }] as const),
  ), [handleMakeTableIdentityUnique, handleSetTableDocumentInViews, tableDocumentByPath]);
  const mediaLibraryViewVisibilityByPath = useMemo(() => new Map(
    [...mediaLibraryByPath].map(([path, mediaLibrary]) => [path, {
      inViews: mediaLibrary.inViews,
      identityConflict: mediaLibrary.identityConflict ?? false,
      onChange: (inViews: boolean) => {
        void handleSetMediaLibraryInViews(mediaLibrary.collectionId, inViews);
      },
      onMakeIdentityUnique: () => {
        void handleMakeMediaLibraryIdentityUnique(mediaLibrary.relativePath);
      },
    }] as const),
  ), [handleMakeMediaLibraryIdentityUnique, handleSetMediaLibraryInViews, mediaLibraryByPath]);
  const handleCreateTableDocument = useCallback(async () => {
    if (!notebookId || isCreatingTable) return;
    setIsCreatingTable(true);
    try {
      // A folder context menu targets that folder. Other entry points use the
      // notebook default; creating from Views additionally marks membership.
      const relativeFolder = newTableInViews || newTableParentFolder === null
        ? defaultCreateFolder
        : relativeFolderPath(notebookPath, newTableParentFolder);
      const { filePath, table } = await createTableDocumentFile(notebookPath, relativeFolder, newTableName, newTableViewType);
      if (newTableInViews) {
        await files.setTableDocumentInViews(notebookId, table.collection.id, true);
      }
      setNewTableDialogOpen(false);
      setNewTableName('');
      setNewTableViewType('table');
      setNewTableInViews(false);
      setNewTableParentFolder(null);
      await refreshTables();
      await openWorkspaceSurface({
        host: 'main-third',
        target: { kind: 'external', path: filePath, scopePath: notebookPath, transitionId: null },
        options: { notebookId },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建多维表格失败');
    } finally {
      setIsCreatingTable(false);
    }
  }, [defaultCreateFolder, isCreatingTable, newTableInViews, newTableName, newTableParentFolder, newTableViewType, notebookId, notebookPath, refreshTables]);

  const openNewMediaLibraryDialog = useCallback((inViews = false, parentFolderPath?: string) => {
    setNewLibraryInViews(inViews);
    setNewLibraryParentFolder(parentFolderPath ?? null);
    setNewLibraryName(t('memo.create.mediaLibraryDefaultName'));
    setNewLibraryDialogOpen(true);
  }, [t]);
  const handleCreateMediaLibraryAtPath = useCallback((parentPath: string) => {
    openNewMediaLibraryDialog(false, parentPath);
  }, [openNewMediaLibraryDialog]);
  const handleCreateMediaLibrary = useCallback(async () => {
    if (!notebookId || isCreatingLibrary) return;
    setIsCreatingLibrary(true);
    try {
      const relativeFolder = newLibraryParentFolder !== null
        ? relativeFolderPath(notebookPath, newLibraryParentFolder)
        : defaultCreateFolder;
      const { filePath, document } = await createMediaLibraryFile(notebookPath, relativeFolder, newLibraryName);
      if (newLibraryInViews) {
        await files.setMediaLibraryInViews(notebookId, document.collection.id, true);
      }
      setNewLibraryDialogOpen(false);
      setNewLibraryName('');
      setNewLibraryInViews(false);
      setNewLibraryParentFolder(null);
      await refreshMediaLibraries();
      await openWorkspaceSurface({
        host: 'main-third',
        target: { kind: 'external', path: filePath, scopePath: notebookPath, transitionId: null },
        options: { notebookId },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建媒体库失败');
    } finally {
      setIsCreatingLibrary(false);
    }
  }, [defaultCreateFolder, isCreatingLibrary, newLibraryInViews, newLibraryName, newLibraryParentFolder, notebookId, notebookPath, refreshMediaLibraries]);
  const handleAddRepository = useCallback(async () => {
    if (!notebookId) return;
    const result = await useAgentWorkspaceStore.getState().workspaceActions.addFolderFromPicker(notebookId);
    if (!result.ok) {
      if (result.code === 'already-tracked') toast.error(t('agent.access.alreadyTracked'));
      else if (result.code === 'save-failed') toast.error(t('agent.access.saveFailed'));
      return;
    }


  }, [notebookId, t]);
  const handleRemoveRepository = useCallback(async (repository: WorkspaceAgentRepository) => {
    if (!notebookId) return;
    const access = useAgentWorkspaceStore.getState().workspaceActions;
    const saved = await access.detachFolderFromNotebook(notebookId, repository.path);
    if (saved === false) {
      toast.error(t('agent.access.saveFailed'));
      return;
    }
    if (saved === 'not-attached') return;
    toast.success(t('agent.access.folderDeleted', { name: repository.name }));
  }, [notebookId, t]);
  const handleOpenPathInNewTab = useCallback((path: string) => {
    if (openMediaLibraryPath(path, 'browser-column')) return;
    onNoteOpenInNewTab?.(path);
  }, [onNoteOpenInNewTab, openMediaLibraryPath]);
  const handleCreateNoteAtPath = useCallback((parentPath: string) => {
    requestCreateDraft(parentPath, 'note');
  }, [requestCreateDraft]);
  const handleCreateFolderAtPath = useCallback((parentPath: string) => {
    requestCreateDraft(parentPath, 'folder');
  }, [requestCreateDraft]);
  const handleFocusPath = useCallback((path: string) => setFocusedTreePath(path), []);
  const handleDeleteFolderPath = useCallback(async (path: string) => {
    await onDeleteFolder?.(path);
  }, [onDeleteFolder]);
  const renderDraft = (draftState: NotebookTreeDraftState, depth: number) => (
    <NotebookTreeDraft
      draft={draftState}
      depth={depth}
      data-notebook-tree-depth={depth}
      onChange={(value) => setDraft({ ...draftState, value })}
      onSubmit={() => void submitDraft()}
      onCancel={cancelDraft}
    />
  );

  const handleImportFiles = useCallback(async (targetDirectoryPath: string) => {
    const selectedPaths = await dialogs.selectFiles({ multiple: true });
    if (!selectedPaths?.length) return;
    const failures: NotebookMoveFailure[] = [];
    for (const sourcePath of selectedPaths) {
      try {
        await files.importFile(sourcePath, targetDirectoryPath, notebookPath);
      } catch (error) {
        logger.warn('importing file into notebook tree failed', { error, sourcePath, targetDirectoryPath });
        failures.push(normalizeNotebookMoveFailure(error));
      }
    }
    await tree.refresh(targetDirectoryPath);
    if (failures.length > 0) {
      showNotebookMoveFailureToasts(
        t,
        selectedPaths.length - failures.length,
        failures.length,
        failures,
      );
    }
  }, [notebookPath, t, tree.refresh]);

  const handleImportFolder = useCallback(async (targetDirectoryPath: string) => {
    let sourceDirectoryPath: string | null | undefined;
    let progressToastId: string | number | undefined;
    try {
      sourceDirectoryPath = await dialogs.selectImportDirectory();
      if (!sourceDirectoryPath) return;
      progressToastId = toast.info(t('memo.fileTree.importFolderInProgress'), { duration: Number.POSITIVE_INFINITY });
      await files.importFolder(sourceDirectoryPath, targetDirectoryPath, notebookPath);
      await tree.refresh(targetDirectoryPath);
      toast.dismiss(progressToastId);
      progressToastId = undefined;
      toast.success(t('memo.fileTree.importFolderSuccess'));
    } catch (error) {
      logger.warn('importing folder into notebook tree failed', { error, sourceDirectoryPath, targetDirectoryPath });
      if (sourceDirectoryPath) {
        try {
          await tree.refresh(targetDirectoryPath);
        } catch (refreshError) {
          logger.warn('refreshing notebook tree after folder import failed', { refreshError, targetDirectoryPath });
        }
      }
      toast.error(t(getNotebookFolderImportErrorKey(error)));
    } finally {
      if (progressToastId !== undefined) toast.dismiss(progressToastId);
    }
  }, [notebookPath, t, tree.refresh]);

  const renderTreeItem = (
    item: DocTreeItem,
    depth: number,
    logicalParentPath: string,
    posInSet?: number,
    setSize?: number,
  ) => {
    const itemPath = canonicalPath(item.fullPath);
    const tableViewVisibility = tableViewVisibilityByPath.get(itemPath);
    const mediaLibraryViewVisibility = mediaLibraryViewVisibilityByPath.get(itemPath);
    const expanded = item.type === 'folder' && tree.expanded.has(canonicalPath(item.fullPath));
    const isDropTarget = item.type === 'folder'
      && dragOverFolderPath !== null
      && canonicalDirectoryPath(item.fullPath) === canonicalDirectoryPath(dragOverFolderPath);
    const isMovingTarget = item.type === 'folder'
      && moveFeedback !== null
      && samePath(item.fullPath, moveFeedback.targetDirectoryPath);
    const isMovingSource = moveFeedback !== null
      && moveFeedback.paths.some((path) => samePath(path, item.fullPath));
    const moveStatus = isMovingTarget || isMovingSource ? moveFeedback?.status : undefined;

    return (
      <div
        className={cn(
          item.type === 'folder' && 'folder-file-tree__group notebook-file-tree__folder-group relative',
        )}
        data-notebook-tree-row="true"
        data-notebook-tree-depth={depth}
        data-drag-over={isDropTarget ? 'true' : 'false'}
        data-notebook-drop-path={item.type === 'folder' ? item.fullPath : undefined}
        data-notebook-parent-path={logicalParentPath}
        style={{
          '--folder-file-tree-drop-left': `${TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL}px`,
          '--folder-file-tree-drop-right': `${TREE_EDGE_GUTTER}px`,
        } as CSSProperties}
      >
        {depth > 0 && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {Array.from({ length: depth }, (_, level) => (
              <span
                key={level}
                className="absolute inset-y-0 w-px"
                style={{
                  left: TREE_EDGE_GUTTER + level * INDENT_PER_LEVEL + FOLDER_CARET_CENTER_OFFSET,
                  backgroundColor: 'color-mix(in srgb, var(--border) 72%, transparent)',
                }}
              />
            ))}
          </div>
        )}
        <NotebookTreeRow
          item={item}
          notebookPath={notebookPath}
          parentPath={logicalParentPath}
          posInSet={posInSet}
          setSize={setSize}
          depth={depth}
          expanded={expanded}
          isLoadingChildren={tree.loadingDirectories?.has(canonicalDirectoryPath(item.fullPath)) ?? false}
          childrenError={tree.directoryErrors?.has(canonicalDirectoryPath(item.fullPath)) ?? false}
          onRetryChildren={handleRetryDirectory}
          active={item.type === 'folder'
            ? Boolean(selectedFolderPath) && canonicalPath(item.fullPath) === canonicalPath(selectedFolderPath!)
            : !selectedFolderPath && Boolean(activeFilePath) && canonicalPath(item.fullPath) === canonicalPath(activeFilePath!)}
          selected={item.type === 'document' && selectedFilePathSet.has(canonicalPath(item.fullPath))}
          moveStatus={moveStatus}
          onToggle={handleTogglePath}
          onSelectFolder={onFolderSelect}
          onOpen={handleOpenPath}
          onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
          onCreateNote={handleCreateNoteAtPath}
          onCreateFolder={handleCreateFolderAtPath}
          onImportFiles={handleImportFiles}
          onImportFolder={handleImportFolder}
          onCreateView={handleCreateViewAtPath}
          onCreateMediaLibrary={handleCreateMediaLibraryAtPath}
          tableViewVisibility={tableViewVisibility}
          mediaLibraryViewVisibility={mediaLibraryViewVisibility}
          onRename={handleRename}
          tabIndex={treeFocusPath && samePath(treeFocusPath, item.fullPath) ? 0 : -1}
          onFocus={handleFocusPath}
          onKeyDown={handleTreeItemKeyDown}
          onDeleteFolder={item.type === 'folder' && onDeleteFolder
            ? handleDeleteFolderPath
            : undefined}
          onDeleteFile={item.type === 'document' && onDeleteFile
            ? onDeleteFile
            : undefined}
          onSetDefaultFolder={item.type === 'folder' ? onSetDefaultCreateFolder : undefined}
          isDefaultFolder={item.type === 'folder' && defaultCreateFolder === relativeFolderPath(notebookPath, item.fullPath)}
          onKeepAliveChange={handleRowKeepAliveChange}
          onPointerDown={handlePointerDownItem}
        />
      </div>
    );
  };

  const renderTreeRow = (row: NotebookTreeRenderRow) => row.kind === 'draft'
    ? renderDraft(row.draft, row.depth)
    : renderTreeItem(row.item, row.depth, row.parentPath, row.posInSet, row.setSize);

  const folderDropHighlight = useMemo(() => {
    if (!dragOverFolderPath || samePath(dragOverFolderPath, notebookPath)) return null;
    const targetIndex = renderRows.findIndex((row) => (
      row.kind === 'node'
      && row.item.type === 'folder'
      && samePath(row.item.fullPath, dragOverFolderPath)
    ));
    if (targetIndex < 0) return null;
    const targetDepth = renderRows[targetIndex].depth;
    let endIndex = targetIndex + 1;
    while (endIndex < renderRows.length && renderRows[endIndex].depth > targetDepth) {
      endIndex += 1;
    }
    return {
      top: targetIndex * TREE_ROW_SIZE,
      height: Math.max(TREE_ROW_HEIGHT, (endIndex - targetIndex) * TREE_ROW_SIZE - TREE_ROW_GAP),
      left: TREE_EDGE_GUTTER + targetDepth * INDENT_PER_LEVEL,
    };
  }, [dragOverFolderPath, notebookPath, renderRows]);

  return (
    <div
      ref={externalDropSurfaceRef}
      data-notebook-external-drop-target="true"
      className={cn(
        'relative flex h-full min-h-0 flex-col select-none bg-[var(--list-bg)] text-[var(--foreground)]',
        dragPreview && 'notebook-file-tree--dragging',
      )}
    >
      <ListSurfaceViewport>
        <OverlayScrollbar
          className="h-full"
          scrollerClassName="h-full overflow-y-auto pt-1 pb-1"
          scrollerRef={treeScrollerRef}
          onScroll={(event) => {
            setShowScrollTopHint(event.currentTarget.scrollTop > 0);
          }}
        >
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex min-h-full flex-col">
          {notebookId && !hiddenSections.includes('agents') && (
            <AgentTasksSection
              notebookId={notebookId}
              edgeGutter={TREE_EDGE_GUTTER}
              order={sectionOrder.indexOf('agents') + 1}
              onHeightChange={handleAgentSectionHeightChange}
              onShowAllConversations={handleShowAllAgentConversations}
              sectionActions={(
                <NotebookTreeSectionMenu
                  onHideSection={() => hideTreeSection('agents')}
                  canMoveUp={visibleSectionOrder.indexOf('agents') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('agents') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('agents', -1)}
                  onMoveDown={() => moveTreeSection('agents', 1)}
                  onCustomizeDisplay={openCustomizeDisplay}
                />
              )}
            />
          )}
          {(pinnedItems.length > 0 || pinnedHasPrevious || pinnedHasMore) && !hiddenSections.includes('pinned') && (
            <NotebookPinnedSection
              order={sectionOrder.indexOf('pinned') + 1}
              items={pinnedItems}
              hasPreviousPage={pinnedHasPrevious}
              hasMoreItems={pinnedHasMore}
              loadingMore={pinnedLoadingMore || pinnedLoadingInitial}
              onLoadPrevious={loadPreviousPinned}
              onLoadMore={() => { void loadMorePinned(); }}
              collapsed={pinnedCollapsed}
              onToggleCollapsed={() => setPinnedCollapsed((collapsed) => !collapsed)}
              sectionActions={(
                <NotebookTreeSectionMenu
                  onHideSection={() => hideTreeSection('pinned')}
                  canMoveUp={visibleSectionOrder.indexOf('pinned') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('pinned') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('pinned', -1)}
                  onMoveDown={() => moveTreeSection('pinned', 1)}
                  onCustomizeDisplay={openCustomizeDisplay}
                />
              )}
              renderItem={(item) => (
                <NotebookTreeRow
                  key={item.fullPath}
                  item={item}
                  notebookPath={notebookPath}
                  parentPath={parentDirectoryPath(item.fullPath, notebookPath)}
                  depth={0}
                  expanded={false}
                  active={!selectedFolderPath && Boolean(activeFilePath) && samePath(item.fullPath, activeFilePath!)}
                  selected={selectedFilePathSet.has(canonicalPath(item.fullPath))}
                  onToggle={handleTogglePath}
                  onOpen={handleOpenPinnedPath}
                  onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
                  onCreateNote={handleCreateNoteAtPath}
                  onCreateFolder={handleCreateFolderAtPath}
                  onImportFiles={(path) => { void handleImportFiles(path); }}
                  onImportFolder={(path) => { void handleImportFolder(path); }}
                  onCreateView={(parentPath, viewType) => openNewTableDialog(false, parentPath, viewType)}
                  onCreateMediaLibrary={(parentPath) => openNewMediaLibraryDialog(false, parentPath)}
                  onRename={handleRename}
                  onDeleteFile={onDeleteFile}
                  onPointerDown={() => {}}
                  onKeepAliveChange={handleRowKeepAliveChange}
                  favoritePath={item.fullPath}
                  onFavoriteChanged={(itemId, favorited) => {
                    if (!favorited) removePinnedItem(itemId);
                  }}
                  tabIndex={0}
                />
              )}
            />
          )}
          {!hiddenSections.includes('views') && (
            <NotebookViewsSection
              order={sectionOrder.indexOf('views') + 1}
              tables={viewTableDocuments}
              mediaLibraries={viewMediaLibraries}
              collapsed={viewsCollapsed}
              onToggleCollapsed={() => setViewsCollapsed((collapsed) => !collapsed)}
              sectionActions={(
                <NotebookTreeSectionMenu
                  onHideSection={() => hideTreeSection('views')}
                  canMoveUp={visibleSectionOrder.indexOf('views') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('views') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('views', -1)}
                  onMoveDown={() => moveTreeSection('views', 1)}
                  onCreateTable={(viewType) => openNewTableDialog(true, undefined, viewType)}
                  onCreateMediaLibrary={() => openNewMediaLibraryDialog(true)}
                  onCustomizeDisplay={openCustomizeDisplay}
                />
              )}
              renderTable={(table) => {
                const tablePath = joinNotebookMemoPath(notebookPath, table.relativePath);
                if (!tablePath) return null;
                const active = Boolean(!selectedFolderPath && activeFilePath && samePath(activeFilePath, tablePath));
                const tableItem = tableDocumentTreeItem(table, tablePath);
                return (
                  <NotebookTreeRow
                    key={table.relativePath}
                    item={tableItem}
                    notebookPath={notebookPath}
                    parentPath={parentDirectoryPath(tablePath, notebookPath)}
                    depth={0}
                    expanded={false}
                    active={active}
                    selected={active}
                    onToggle={() => {}}
                    onOpen={() => handleOpenTableDocument(table.relativePath)}
                    onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
                    onCreateNote={handleCreateNoteAtPath}
                    onCreateFolder={handleCreateFolderAtPath}
                    onCreateView={(parentPath, viewType) => openNewTableDialog(true, parentPath, viewType)}
                    onCreateMediaLibrary={(parentPath) => openNewMediaLibraryDialog(true, parentPath)}
                    tableViewVisibility={{
                      collectionId: table.collectionId,
                      inViews: table.inViews,
                      identityConflict: table.identityConflict ?? false,
                      onChange: (inViews) => { void handleSetTableDocumentInViews(table.collectionId, inViews); },
                      onMakeIdentityUnique: () => { void handleMakeTableIdentityUnique(table.relativePath); },
                    }}
                    onRename={handleRenameTableDocument}
                    onDeleteFile={handleDeleteTableDocument}
                    onPointerDown={() => {}}
                    onFocus={handleFocusPath}
                    tabIndex={0}
                  />
                );
              }}
              renderMediaLibrary={(library) => {
                const libraryPath = joinNotebookMemoPath(notebookPath, library.relativePath);
                if (!libraryPath) return null;
                const active = Boolean(!selectedFolderPath && activeFilePath && samePath(activeFilePath, libraryPath));
                const libraryItem = mediaLibraryTreeItem(library, libraryPath);
                return (
                  <NotebookTreeRow
                    key={library.relativePath}
                    item={libraryItem}
                    notebookPath={notebookPath}
                    parentPath={parentDirectoryPath(libraryPath, notebookPath)}
                    depth={0}
                    expanded={false}
                    active={active}
                    selected={active}
                    onToggle={() => {}}
                    onOpen={() => handleOpenMediaLibraryFromViews(libraryPath)}
                    onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
                    onCreateNote={handleCreateNoteAtPath}
                    onCreateFolder={handleCreateFolderAtPath}
                    onCreateView={(parentPath, viewType) => openNewTableDialog(true, parentPath, viewType)}
                    onCreateMediaLibrary={(parentPath) => openNewMediaLibraryDialog(true, parentPath)}
                    mediaLibraryViewVisibility={{
                      inViews: library.inViews,
                      identityConflict: library.identityConflict ?? false,
                      onChange: (inViews) => { void handleSetMediaLibraryInViews(library.collectionId, inViews); },
                      onMakeIdentityUnique: () => { void handleMakeMediaLibraryIdentityUnique(library.relativePath); },
                    }}
                    onRename={handleRename}
                    onDeleteFile={handleDeleteMediaLibrary}
                    onPointerDown={() => {}}
                    onFocus={handleFocusPath}
                    tabIndex={0}
                  />
                );
              }}
            />
          )}
          {!hiddenSections.includes('files') && <section
            className="flex min-h-0 flex-col pb-3"
            aria-label={t('memo.fileTree.sectionTitle')}
            data-notebook-files-section="true"
            style={{
              order: sectionOrder.indexOf('files') + 1,
              flexGrow: visibleSectionOrder[visibleSectionOrder.length - 1] === 'files' ? 1 : 0,
            }}
          >
          <div
            ref={treeHeaderRef}
            className={cn(
              'notebook-file-tree__section-header group mb-0.5 flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 transition-colors duration-150 hover:bg-[var(--muted)]',
              isRootDropTarget && 'bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]',
            )}
            style={{
              marginLeft: TREE_EDGE_GUTTER,
              width: `calc(100% - ${TREE_EDGE_GUTTER * 2}px)`,
            }}
          >
            <button
              type="button"
              className="flex h-full items-center gap-0.5 text-[0.82rem] font-medium text-[var(--muted-foreground)] opacity-90 hover:text-[var(--foreground)] focus-visible:outline-none"
              aria-label={t(filesCollapsed ? 'memo.fileTree.expandFiles' : 'memo.fileTree.collapseFiles')}
              title={t(filesCollapsed ? 'memo.fileTree.expandFiles' : 'memo.fileTree.collapseFiles')}
              onClick={() => setFilesCollapsed((collapsed) => !collapsed)}
            >
              <span>{t('memo.fileTree.sectionTitle')}</span>
              <ChevronRight className={cn('h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-within:opacity-100', filesCollapsed && 'opacity-100', !filesCollapsed && 'rotate-90')} />
            </button>
            <div className="ml-auto flex items-center">
              <NotebookTreeSectionMenu
                onHideSection={() => hideTreeSection('files')}
                canMoveUp={visibleSectionOrder.indexOf('files') > 0}
                canMoveDown={visibleSectionOrder.indexOf('files') < visibleSectionOrder.length - 1}
                onMoveUp={() => moveTreeSection('files', -1)}
                onMoveDown={() => moveTreeSection('files', 1)}
                onCreateFolder={onCreateFolder}
                onCreateNote={() => handleCreateNoteAtPath(notebookPath)}
                onCreateTable={(viewType) => openNewTableDialog(false, undefined, viewType)}
                onCreateMediaLibrary={() => openNewMediaLibraryDialog()}
                onImportFiles={() => { void handleImportFiles(notebookPath); }}
                onImportFolder={() => { void handleImportFolder(notebookPath); }}
                sort={fileTreeSort}
                onSort={setFileTreeSort}
                onCustomizeDisplay={openCustomizeDisplay}
              />
            </div>
          </div>
              {!filesCollapsed && <div
            ref={treeRootRef}
            role="tree"
            aria-multiselectable="true"
            aria-label={notebookName}
            data-notebook-tree-root="true"
            style={{ minHeight: virtualTreeSize || TREE_ROW_HEIGHT }}
            className={cn(
              'relative min-h-0 flex-1 rounded-lg transition-colors duration-150',
              isRootDropTarget && 'bg-[color-mix(in_oklch,var(--brand)_10%,transparent)]',
            )}
            onPointerMove={handleTreePointerMove}
            onPointerUp={handleTreePointerUp}
            onPointerCancel={handleTreePointerCancel}
          >
            {tree.error && (
              <div className="flex items-center justify-center gap-2 px-4 py-4 text-center text-xs text-[var(--muted-foreground)]" role="alert">
                <span>{t('memo.fileTree.unreadableHint')}</span>
                <Button type="button" size="xs" variant="ghost" className="rounded-lg" onClick={() => void tree.reload()}>
                  {t('error.retry')}
                </Button>
              </div>
            )}
            {!hasVisibleItems && !tree.loading && !tree.error && !draft && (
              <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
                {t('memo.fileTree.empty')}
              </div>
            )}
            <div
              className="notebook-file-tree__virtual-items relative min-h-full"
              data-notebook-tree-virtualized="true"
              style={{ height: virtualTreeSize }}
            >
              {folderDropHighlight && (
                <div
                  aria-hidden="true"
                  className="notebook-file-tree__drop-range pointer-events-none absolute right-[6px] z-[1] rounded-lg bg-[color-mix(in_oklch,var(--brand)_15%,transparent)]"
                  style={folderDropHighlight}
                />
              )}
              {virtualTreeRows.map(({ key, item: row, start, size }) => (
                <div
                  key={key}
                  className="absolute inset-x-0 top-0 z-[2]"
                  data-notebook-virtual-row={key}
                  data-notebook-tree-row="true"
                  data-notebook-drop-path={row.kind === 'node' && row.item.type === 'folder'
                    ? row.item.fullPath
                    : undefined}
                  data-notebook-parent-path={row.parentPath}
                  style={{ height: size, transform: `translateY(${start}px)` }}
                >
                  {renderTreeRow(row)}
                </div>
              ))}
            </div>
          </div>}
          </section>}
          {!hiddenSections.includes('repositories') && (
            <AgentRepositoriesSection
              repositories={agentRepositories}
              order={sectionOrder.indexOf('repositories') + 1}
              onHeightChange={handleRepositorySectionHeightChange}
              sectionActions={(
                <NotebookTreeSectionMenu
                  onHideSection={() => hideTreeSection('repositories')}
                  canMoveUp={visibleSectionOrder.indexOf('repositories') > 0}
                  canMoveDown={visibleSectionOrder.indexOf('repositories') < visibleSectionOrder.length - 1}
                  onMoveUp={() => moveTreeSection('repositories', -1)}
                  onMoveDown={() => moveTreeSection('repositories', 1)}
                  onCustomizeDisplay={openCustomizeDisplay}
                />
              )}
              onAddRepository={() => { void handleAddRepository(); }}
              onRemoveRepository={(repository) => { void handleRemoveRepository(repository); }}
              onExpandRepository={handleRepositoryExpand}
              canAddRepository={Boolean(notebookId)}
              onOpenFile={handleOpenRepositoryFile}
              onOpenInNewTab={onNoteOpenInNewTab ? handleOpenPathInNewTab : undefined}
            />
          )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              <NotebookCreateContextMenuItems
                onCreateNote={() => handleCreateNoteAtPath(notebookPath)}
                onCreateFolder={() => handleCreateFolderAtPath(notebookPath)}
                onCreateTable={(viewType) => openNewTableDialog(false, notebookPath, viewType)}
                onCreateMediaLibrary={() => openNewMediaLibraryDialog(false, notebookPath)}
                onImportFiles={() => { void handleImportFiles(notebookPath); }}
                onImportFolder={() => { void handleImportFolder(notebookPath); }}
              />
              <ContextMenuItem keepOpenOnClick
                onClick={(event) => openCustomizeDisplay(getPopupOriginRect(event.currentTarget))}
                className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left transition-colors hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <SquaresFourIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('memo.fileTree.customizeDisplay')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </OverlayScrollbar>
        {!hasVisibleItems && tree.loading && (
          <ListSurfaceLoadingState
            ariaLabel={t('memo.fileTree.loading')}
            className="absolute inset-0 z-[2] bg-[var(--list-bg)]"
          />
        )}
        {dragPreview && (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-[100] flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg border border-[var(--border-popup)] bg-[color-mix(in_oklch,var(--card)_88%,transparent)] px-2 text-sm text-[var(--foreground)] opacity-90 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.35)] backdrop-blur-sm will-change-transform"
            ref={(node) => {
              dragPreviewRef.current = node;
              if (node) {
                const { x, y } = dragPreviewPositionRef.current;
                node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
              }
            }}
          >
            <NotebookTreeFileIcon className="notebook-file-tree__default-file-icon h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            <span className="truncate">
              {dragPreview.count > 1 ? t('memo.fileTree.draggingNotes', { count: dragPreview.count }) : dragPreview.name}
            </span>
          </div>
        )}
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-[3] h-10 bg-gradient-to-b from-[var(--list-bg)] to-transparent transition-opacity',
            showScrollTopHint ? 'opacity-100' : 'opacity-0',
          )}
        />
      </ListSurfaceViewport>
      <Dialog open={newTableDialogOpen} onOpenChange={setNewTableDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{newTableViewType === 'gallery'
              ? t('memo.create.galleryDialogTitle')
              : newTableViewType === 'kanban'
                ? t('memo.create.kanbanDialogTitle')
                : newTableViewType === 'calendar'
                  ? t('memo.create.calendarDialogTitle')
                  : t('memo.create.tableDialogTitle')}</DialogTitle>
            <DialogDescription>{t('memo.create.tableDescription')}</DialogDescription>
          </DialogHeader>
          <form className="mt-2 space-y-4" onSubmit={(event) => { event.preventDefault(); void handleCreateTableDocument(); }}>
            <input
              autoFocus
              value={newTableName}
              onChange={(event) => setNewTableName(event.target.value)}
              placeholder={newTableViewType === 'gallery'
                ? t('memo.create.galleryDefaultName')
                : newTableViewType === 'kanban'
                  ? t('memo.create.kanbanDefaultName')
                  : newTableViewType === 'calendar'
                    ? t('memo.create.calendarDefaultName')
                    : t('memo.create.tableDefaultName')}
              className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg text-sm" onClick={() => setNewTableDialogOpen(false)}>{t('dialog.cancel')}</Button>
              <Button type="submit" size="sm" className="h-8 rounded-lg text-sm" disabled={!newTableName.trim() || isCreatingTable}>
                {isCreatingTable ? <Loader2 className="mr-1.5 h-4 w-4 flowix-spin" aria-hidden="true" /> : null}
                {isCreatingTable ? t('memo.create.creating') : t('memo.create.confirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={newLibraryDialogOpen} onOpenChange={setNewLibraryDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('memo.create.mediaLibraryTitle')}</DialogTitle>
            <DialogDescription>{t('memo.create.mediaLibraryDescription')}</DialogDescription>
          </DialogHeader>
          <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void handleCreateMediaLibrary(); }}>
            <input autoFocus value={newLibraryName} onChange={(event) => setNewLibraryName(event.target.value)} placeholder={t('memo.create.mediaLibraryDefaultName')} className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setNewLibraryDialogOpen(false)}>{t('dialog.cancel')}</Button>
              <Button type="submit" size="sm" className="rounded-lg" disabled={!newLibraryName.trim() || isCreatingLibrary}>
                {isCreatingLibrary ? <Loader2 className="mr-1.5 h-4 w-4 flowix-spin" aria-hidden="true" /> : null}
                {isCreatingLibrary ? t('memo.create.creating') : t('memo.create.confirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Popover open={customizeOpen} onOpenChange={setCustomizeOpen} anchorRect={customizeAnchorRect}>
        <PopoverContent side="bottom" align="start" sideOffset={0} alignToAnchorOrigin keepParentMenuOpen className="w-[190px] max-w-[calc(100vw-16px)] rounded-2xl p-[5px] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader className="mb-0 flex min-h-8 flex-row items-center justify-between px-1">
            <button type="button" aria-label="返回上一级菜单" title="返回上一级菜单" onClick={() => setCustomizeOpen(false)} className="inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded px-0 text-xs leading-[1.2] text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="min-w-0 truncate text-xs leading-[1.2]">{t('memo.fileTree.customizeDisplay')}</span>
            </button>
            <DialogTitle className="sr-only">{t('memo.fileTree.customizeDisplay')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-0.5" aria-label="文件树分区展示与顺序">
            {customizeOrder.map((section) => {
              const labels: Record<NotebookTreeSection, string> = {
                agents: t('memo.fileTree.agentsSectionTitle'),
                pinned: t('memo.fileTree.pinnedSectionTitle'),
                views: t('memo.fileTree.viewsSectionTitle'),
                files: t('memo.fileTree.sectionTitle'),
                repositories: t('memo.fileTree.repositoriesTitle'),
              };
              const selected = !customizeHidden.includes(section);
              return <div key={section} data-customize-section={section} className={cn('group relative flex h-8 items-center gap-2 rounded-lg px-2 transition-colors hover:bg-[var(--muted)]', draggedSection.current === section && 'opacity-50')}>
                {sectionDropTarget?.section === section && draggedSection.current !== section && <span aria-hidden="true" className={cn('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-[var(--primary)]', sectionDropTarget.after ? '-bottom-0.5' : '-top-0.5')} />}
                <button type="button" onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  draggedSection.current = section;
                  sectionDragPointerId.current = event.pointerId;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  event.preventDefault();
                }} onPointerMove={(event) => {
                  if (sectionDragPointerId.current !== event.pointerId) return;
                  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-customize-section]');
                  const target = row?.dataset.customizeSection as NotebookTreeSection | undefined;
                  if (!row || !target || target === draggedSection.current) {
                    sectionDropTargetRef.current = null;
                    setSectionDropTarget(null);
                    return;
                  }
                  const bounds = row.getBoundingClientRect();
                  const next = { section: target, after: event.clientY >= bounds.top + bounds.height / 2 };
                  sectionDropTargetRef.current = next;
                  setSectionDropTarget(next);
                }} onPointerUp={(event) => {
                  if (sectionDragPointerId.current !== event.pointerId) return;
                  const source = draggedSection.current;
                  const target = sectionDropTargetRef.current;
                  if (source && target) {
                    const next = customizeOrder.filter((item) => item !== source);
                    next.splice(next.indexOf(target.section) + (target.after ? 1 : 0), 0, source);
                    updateCustomizeSectionOrder(next);
                  }
                  draggedSection.current = null;
                  sectionDragPointerId.current = null;
                  sectionDropTargetRef.current = null;
                  setSectionDropTarget(null);
                }} onPointerCancel={() => {
                  draggedSection.current = null;
                  sectionDragPointerId.current = null;
                  sectionDropTargetRef.current = null;
                  setSectionDropTarget(null);
                }} onKeyDown={(event) => {
                  const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                  if (!direction) return;
                  event.preventDefault();
                  const index = customizeOrder.indexOf(section);
                  const target = index + direction;
                  if (target < 0 || target >= customizeOrder.length) return;
                  const next = [...customizeOrder];
                  [next[index], next[target]] = [next[target], next[index]];
                  updateCustomizeSectionOrder(next);
                }} aria-label={`排序${labels[section]}，使用上下方向键调整`} className="flex h-7 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:cursor-grabbing">
                  <GripVertical className="h-4 w-4" aria-hidden="true" />
                </button>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--foreground)]">{labels[section]}</span>
                <FlowixCheckbox
                  checked={selected}
                  aria-label={`展示${labels[section]}`}
                  onCheckedChange={(checked) => updateCustomizeSectionVisibility(section, checked)}
                />
              </div>;
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function NotebookTreeDraft({
  draft,
  depth,
  onChange,
  onSubmit,
  onCancel,
  style,
  'data-notebook-tree-depth': dataDepth,
}: {
  draft: { requestId: number; kind: 'note' | 'folder'; value: string };
  depth: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  style?: CSSProperties;
  'data-notebook-tree-depth'?: number;
}) {
  const { t } = useI18n();
  const draftInput = useComposingValue(draft.value, onChange);
  return (
    <div
      data-notebook-tree-depth={dataDepth}
      className="flex h-8 items-center px-1.5"
      style={{
        marginLeft: TREE_EDGE_GUTTER
          + depth * INDENT_PER_LEVEL,
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        data-notebook-tree-draft-icon={draft.kind}
        className={cn(
          'relative flex h-[18px] w-[18px] shrink-0 items-center justify-center',
          draft.kind === 'folder'
            ? 'text-[var(--brand)]'
            : 'text-[color-mix(in_oklch,var(--foreground)_90%,white_10%)]',
        )}
      >
        {draft.kind === 'folder' ? (
          <span
            className="absolute inset-0 flex items-center justify-center"
            dangerouslySetInnerHTML={{ __html: folderIcon }}
          />
        ) : (
          <NotebookTreeFileIcon className="notebook-file-tree__default-file-icon h-[18px] w-[18px]" />
        )}
      </span>
      <input
        key={draft.requestId}
        autoFocus
        value={draftInput.value}
        placeholder={draft.kind === 'folder' ? t('memo.fileTree.newFolder') : t('memo.fileTree.newNote')}
        onChange={draftInput.onChange}
        onCompositionStart={draftInput.onCompositionStart}
        onCompositionEnd={draftInput.onCompositionEnd}
        onBlur={onSubmit}
        onKeyDown={(event) => {
          if (draftInput.isComposingKeyboardEvent(event.nativeEvent)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            onSubmit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="ml-1.5 h-5 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm outline-none"
      />
    </div>
  );
}
