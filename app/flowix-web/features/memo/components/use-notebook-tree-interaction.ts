'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';

import { canonicalPath, samePath, uniquePaths } from '@/lib/path';
import { findFileDisplayId } from '@/lib/file-display-registry';
import { TREE_ROW_HEIGHT, TREE_ROW_SIZE } from './notebook-tree-layout';
import type { VisibleTreeNode } from './use-folder-tree';

interface NotebookTreeController {
  expanded: Set<string>;
  toggle: (path: string) => void;
}

interface NotebookTreeNavigationPolicy {
  path: string;
  policy: 'reveal' | 'preserve';
}

interface NotebookTreeNavigationPolicies {
  active: NotebookTreeNavigationPolicy | null;
  pending: NotebookTreeNavigationPolicy | null;
}

function getNavigationPolicyForPath(
  path: string | null,
  policies: NotebookTreeNavigationPolicies,
): NotebookTreeNavigationPolicy | null {
  if (!path) return null;
  if (policies.pending?.path === path) return policies.pending;
  if (policies.active?.path === path) return policies.active;
  return null;
}

interface UseNotebookTreeInteractionOptions {
  activeFilePath: string | null;
  visibleTreeItems: VisibleTreeNode[];
  treeItemPaths: ReadonlySet<string>;
  tree: NotebookTreeController;
  treeRootRef: RefObject<HTMLDivElement | null>;
  treeScrollerRef: RefObject<HTMLDivElement | null>;
  renderRowIndexByPath: ReadonlyMap<string, number>;
  treeContentOffset: number;
  onNoteSelect: (path: string) => void;
}

/** Owns the file tree's selection, keyboard focus, and active-row navigation. */
export function useNotebookTreeInteraction({
  activeFilePath,
  visibleTreeItems,
  treeItemPaths,
  tree,
  treeRootRef,
  treeScrollerRef,
  renderRowIndexByPath,
  treeContentOffset,
  onNoteSelect,
}: UseNotebookTreeInteractionOptions) {
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [focusedTreePath, setFocusedTreePath] = useState<string | null>(null);
  const selectedFilePathsRef = useRef<string[]>([]);
  const selectionAnchorPathRef = useRef<string | null>(null);
  const activePath = activeFilePath ? canonicalPath(activeFilePath) : null;
  const activeDisplayId = activeFilePath ? findFileDisplayId(activeFilePath) : null;
  const previousActiveFileRef = useRef({ path: activePath, displayId: activeDisplayId });
  const pendingActiveFileScrollPathRef = useRef(activeFilePath ? canonicalPath(activeFilePath) : null);
  const [navigationPolicies, setNavigationPolicies] = useState<NotebookTreeNavigationPolicies>({
    active: null,
    pending: null,
  });
  const navigationPolicyForActivePath = getNavigationPolicyForPath(activePath, navigationPolicies);
  const activeFileShouldReveal = !activeFilePath
    || navigationPolicyForActivePath?.policy !== 'preserve';

  const selectedFilePathSet = useMemo(
    () => new Set(selectedFilePaths.map((path) => canonicalPath(path))),
    [selectedFilePaths],
  );
  const visibleDocumentPaths = useMemo(
    () => visibleTreeItems
      .filter(({ item }) => item.type === 'document')
      .map(({ item }) => item.fullPath),
    [visibleTreeItems],
  );

  const updateSelection = useCallback((paths: string[], anchorPath: string | null) => {
    const nextPaths = uniquePaths(paths);
    selectedFilePathsRef.current = nextPaths;
    selectionAnchorPathRef.current = anchorPath;
    setSelectedFilePaths(nextPaths);
  }, []);
  const getSelectionAnchorPath = useCallback(() => selectionAnchorPathRef.current, []);

  const setNavigationPolicy = useCallback((path: string, policy: 'reveal' | 'preserve') => {
    const intent = { path: canonicalPath(path), policy };
    const currentActivePath = activeFilePath ? canonicalPath(activeFilePath) : null;
    setNavigationPolicies((current) => intent.path === currentActivePath
      ? { active: intent, pending: null }
      // Keep the current file's policy until the requested path becomes active.
      : { ...current, pending: intent });
  }, [activeFilePath]);

  const navigateToNote = useCallback((path: string, policy: 'reveal' | 'preserve') => {
    setNavigationPolicy(path, policy);
    onNoteSelect(path);
  }, [onNoteSelect, setNavigationPolicy]);

  useLayoutEffect(() => {
    const nextActivePath = activePath;
    const { path: previousPath, displayId: previousDisplayId } = previousActiveFileRef.current;
    if (previousPath === nextActivePath) {
      // The registry can move before activeFilePath's store projection. Keep
      // the previous ID through that temporary old-path lookup miss.
      if (activeDisplayId) previousActiveFileRef.current = { path: nextActivePath, displayId: activeDisplayId };
      return;
    }
    const sameDisplay = activeDisplayId !== null && previousDisplayId === activeDisplayId;
    previousActiveFileRef.current = { path: nextActivePath, displayId: activeDisplayId };
    if (sameDisplay && previousPath && nextActivePath) {
      // A rename keeps the same surface. Carry selection/focus to its new
      // locator even if the tree's asynchronous directory read is still stale.
      const rebase = (path: string) => samePath(path, previousPath) ? nextActivePath : path;
      const anchor = selectionAnchorPathRef.current;
      updateSelection(selectedFilePathsRef.current.map(rebase), anchor ? rebase(anchor) : null);
      setFocusedTreePath(current => current ? rebase(current) : null);
      setNavigationPolicies(current => ({
        active: current.active ? { ...current.active, path: rebase(current.active.path) } : null,
        pending: current.pending ? { ...current.pending, path: rebase(current.pending.path) } : null,
      }));
      return;
    }
    const requestedPolicy = nextActivePath
      && navigationPolicies.pending?.path === nextActivePath
      ? navigationPolicies.pending
      : null;
    setNavigationPolicies({ active: requestedPolicy, pending: null });
    if (selectedFilePathsRef.current.length === 0 && selectionAnchorPathRef.current === null) return;
    updateSelection([], null);
  }, [activePath, activeDisplayId, navigationPolicies.pending, updateSelection]);

  useEffect(() => {
    const currentPaths = selectedFilePathsRef.current;
    const nextPaths = currentPaths.filter((path) => treeItemPaths.has(canonicalPath(path))
      || Boolean(activeFilePath && samePath(path, activeFilePath)));
    if (nextPaths.length === currentPaths.length) return;
    const anchorPath = selectionAnchorPathRef.current;
    updateSelection(
      nextPaths,
      anchorPath && nextPaths.some((path) => samePath(path, anchorPath))
        ? anchorPath
        : nextPaths[nextPaths.length - 1] ?? null,
    );
  }, [treeItemPaths, activeFilePath, updateSelection]);

  const focusTreeItem = useCallback((path: string) => {
    setFocusedTreePath(path);
    const focusMountedRow = () => {
      const row = Array.from(
        treeRootRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
      ).find((candidate) => samePath(candidate.dataset.notebookTreePath ?? '', path));
      row?.focus();
      return Boolean(row);
    };
    if (focusMountedRow()) return;

    const index = renderRowIndexByPath.get(canonicalPath(path));
    const scroller = treeScrollerRef.current;
    if (index === undefined || !scroller) return;
    const rowTop = treeContentOffset + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
    window.requestAnimationFrame(() => { focusMountedRow(); });
  }, [renderRowIndexByPath, treeContentOffset, treeRootRef, treeScrollerRef]);

  const handleTreeItemKeyDown = useCallback((path: string, event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = visibleTreeItems.findIndex(({ item }) => samePath(item.fullPath, path));
    if (currentIndex < 0) return;
    const current = visibleTreeItems[currentIndex];
    const nextVisibleItem = (step: number) => visibleTreeItems[currentIndex + step];

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const target = nextVisibleItem(event.key === 'ArrowDown' ? 1 : -1);
      if (!target) return;
      event.preventDefault();
      focusTreeItem(target.item.fullPath);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      const target = event.key === 'Home'
        ? visibleTreeItems[0]
        : visibleTreeItems[visibleTreeItems.length - 1];
      if (!target) return;
      event.preventDefault();
      focusTreeItem(target.item.fullPath);
      return;
    }

    if (event.key === 'ArrowRight' && current.item.type === 'folder') {
      const expanded = tree.expanded.has(canonicalPath(current.item.fullPath));
      if (!expanded) {
        event.preventDefault();
        tree.toggle(current.item.fullPath);
        return;
      }
      const child = nextVisibleItem(1);
      if (child && child.depth > current.depth) {
        event.preventDefault();
        focusTreeItem(child.item.fullPath);
      }
      return;
    }

    if (event.key === 'ArrowLeft') {
      if (current.item.type === 'folder'
        && tree.expanded.has(canonicalPath(current.item.fullPath))) {
        event.preventDefault();
        tree.toggle(current.item.fullPath);
        return;
      }
      const parent = visibleTreeItems
        .slice(0, currentIndex)
        .reverse()
        .find(({ item, depth }) => item.type === 'folder' && depth < current.depth);
      if (parent) {
        event.preventDefault();
        focusTreeItem(parent.item.fullPath);
      }
    }
  }, [focusTreeItem, tree, visibleTreeItems]);

  useEffect(() => {
    const fallback = activeFileShouldReveal && activeFilePath && visibleTreeItems.some(({ item }) => samePath(item.fullPath, activeFilePath))
      ? activeFilePath
      : visibleTreeItems[0]?.item.fullPath ?? null;
    setFocusedTreePath(current => {
      // Read the state after the rename layout effect, rather than replacing
      // its rebased focus with a fallback computed from the stale tree.
      if (current && (visibleTreeItems.some(({ item }) => samePath(item.fullPath, current))
        || (activeFilePath && samePath(current, activeFilePath)))) return current;
      return fallback;
    });
  }, [activeFileShouldReveal, activeFilePath, focusedTreePath, visibleTreeItems]);

  useEffect(() => {
    const activePath = activeFilePath ? canonicalPath(activeFilePath) : null;
    pendingActiveFileScrollPathRef.current = activeFileShouldReveal ? activePath : null;
  }, [activeFileShouldReveal, activeFilePath]);

  useEffect(() => {
    if (!activeFilePath || !activeFileShouldReveal) return;
    const activePath = canonicalPath(activeFilePath);
    if (pendingActiveFileScrollPathRef.current !== activePath) return;
    const index = renderRowIndexByPath.get(activePath);
    const scroller = treeScrollerRef.current;
    if (index === undefined || !scroller) return;
    const rowTop = treeContentOffset + index * TREE_ROW_SIZE;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
    }
    pendingActiveFileScrollPathRef.current = null;
  }, [activeFileShouldReveal, activeFilePath, renderRowIndexByPath, treeContentOffset, treeScrollerRef]);

  const selectNote = useCallback((filePath: string, event?: MouseEvent<HTMLDivElement>) => {
    const currentPaths = selectedFilePathsRef.current;
    const isToggle = Boolean(event?.ctrlKey || event?.metaKey);
    const anchorPath = selectionAnchorPathRef.current;
    const targetIndex = visibleDocumentPaths.findIndex((path) => samePath(path, filePath));
    const anchorIndex = anchorPath
      ? visibleDocumentPaths.findIndex((path) => samePath(path, anchorPath))
      : -1;

    if (event?.shiftKey && anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const range = visibleDocumentPaths.slice(start, end + 1);
      updateSelection(isToggle ? [...currentPaths, ...range] : range, filePath);
    } else if (isToggle) {
      const nextPaths = currentPaths.some((path) => samePath(path, filePath))
        ? currentPaths.filter((path) => !samePath(path, filePath))
        : [...currentPaths, filePath];
      updateSelection(nextPaths, filePath);
    } else {
      updateSelection([filePath], filePath);
      navigateToNote(filePath, 'reveal');
    }
  }, [navigateToNote, updateSelection, visibleDocumentPaths]);

  const treeFocusPath = focusedTreePath
    ?? (activeFileShouldReveal && activeFilePath && visibleTreeItems.some(({ item }) => samePath(item.fullPath, activeFilePath))
      ? activeFilePath
      : visibleTreeItems[0]?.item.fullPath ?? null);

  return {
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
  };
}
