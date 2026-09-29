'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { canonicalDirectoryPath, canonicalPath, parentDirectoryPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { useShowHiddenNotebookFiles } from '@features/preferences/public/runtime-api';
import { useShowNotebookAgentsFile } from '@features/preferences/public/runtime-api';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import {
  NotebookFileTree,
  type NotebookFolderCreateRequest,
  type NotebookNoteCreateRequest,
  type NotebookMoveResult,
  type NotebookMoveSource,
} from '@features/memo/components/notebook-file-tree';
import { useFolderTree } from '@features/memo/components/use-folder-tree';
import { updateNoteLinksAfterMove } from '@features/memo/services/note-link-rewriter';
import { openNotebookNote } from '@features/memo/use-cases/open-notebook-note';
import {
  openBrowserColumnFileBrowser,
  openBrowserColumnMedia,
  openBrowserColumnText,
} from '@features/workspace/use-cases/browser-column-navigation';
import {
  openExternalTarget,
  openMediaTarget,
  openDocumentListTarget,
} from '@features/workspace/use-cases/workspace-navigation';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { createDocumentListTarget, workColumnTargetFilePath } from '@features/workspace/store/work-column-target';
import {
  files,
  mediaResources,
  memos,
  type DocTreeItem,
  type FileBrowserDirectoriesChangedEvent,
} from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { type Notebook } from '@features/memo/store';
import type { SortType } from '@features/memo/services';

const FILE_BROWSER_DIRECTORIES_CHANGED_EVENT = 'file-browser-directories-changed';
const logger = createLogger('notebook-folder-view');

function isInsideHiddenDirectory(item: DocTreeItem, notebookPath: string): boolean {
  const root = canonicalDirectoryPath(notebookPath);
  const itemPath = canonicalPath(item.fullPath);
  const prefix = root === '/' ? '/' : `${root}/`;
  if (!itemPath.startsWith(prefix)) return false;
  const relativeParts = itemPath.slice(prefix.length).split('/').filter(Boolean);
  const directoryParts = item.type === 'folder' ? relativeParts : relativeParts.slice(0, -1);
  return directoryParts.some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

export function isNotebookTreeItemVisible(
  item: DocTreeItem,
  notebookPath?: string,
  showHiddenNotebookFiles = false,
  showAgentsFile = false,
): boolean {
  if (item.name === 'AGENTS.md' && !showAgentsFile) return false;
  if (!showHiddenNotebookFiles && notebookPath && isInsideHiddenDirectory(item, notebookPath)) {
    return false;
  }
  if (item.type === 'folder') {
    return !['attachment', 'attachments'].includes(item.name.toLowerCase());
  }
  // The file tree is a filesystem view: show every file, including source
  // code and formats that Flowix cannot preview. Markdown remains the only
  // document type treated as a note by the open handler below.
  return true;
}

export function sortNotebookTreeItems(items: DocTreeItem[], sort: SortType): DocTreeItem[] {
  const timestamp = (item: DocTreeItem) => (
    sort === 'updatedAt'
      ? item.modifiedMs
      : item.memoCreatedMs ?? item.createdMs
  ) ?? 0;
  return [...items].sort((left, right) => {
    if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
    if (left.type === 'folder') return left.name.localeCompare(right.name);
    if (sort === 'filenameAsc' || sort === 'filenameDesc') {
      const filenameOrder = left.name.toLowerCase().localeCompare(right.name.toLowerCase())
        || left.name.localeCompare(right.name);
      return sort === 'filenameDesc' ? -filenameOrder : filenameOrder;
    }
    return timestamp(right) - timestamp(left) || left.name.localeCompare(right.name);
  });
}

export function NotebookFolderView({
  notebook,
  createFolderRequest,
  createNoteRequest,
  onCreateFolder,
  sort,
  onCreateNote,
  hiddenListFolders = [],
  onToggleListFolderVisibility,
  onSetDefaultCreateFolder,
  isActive = true,
}: {
  notebook: Notebook;
  createFolderRequest?: NotebookFolderCreateRequest | null;
  createNoteRequest?: NotebookNoteCreateRequest | null;
  onCreateFolder?: () => void;
  sort: SortType;
  onCreateNote?: (parentPath: string, title: string) => Promise<void> | void;
  hiddenListFolders?: string[];
  onToggleListFolderVisibility?: (folderPath: string) => void;
  onSetDefaultCreateFolder?: (folderPath: string) => void;
  isActive?: boolean;
}) {
  const { t } = useI18n();
  const showHiddenNotebookFiles = useShowHiddenNotebookFiles();
  const showAgentsFile = useShowNotebookAgentsFile();
  const tree = useFolderTree(notebook.path, {
    includeHiddenDirectories: showHiddenNotebookFiles,
    showAgentsFile,
  });
  const noteTree = useMemo(() => {
    if (!isActive) return tree;
    return {
      ...tree,
      rootChildren: sortNotebookTreeItems(
        tree.rootChildren.filter((item) => isNotebookTreeItemVisible(
          item,
          notebook.path,
          showHiddenNotebookFiles,
          showAgentsFile,
        )),
        sort,
      ),
      nodes: new Map([...tree.nodes].map(([path, item]) => [
        path,
        item.children
          ? {
              ...item,
              children: sortNotebookTreeItems(
                item.children.filter((child) => isNotebookTreeItemVisible(
                  child,
                  notebook.path,
                  showHiddenNotebookFiles,
                  showAgentsFile,
                )),
                sort,
              ),
            }
          : item,
      ])),
    };
  }, [
    isActive,
    notebook.path,
    showHiddenNotebookFiles,
    showAgentsFile,
    sort,
    tree.rootChildren,
    tree.nodes,
    tree.expanded,
    tree.loading,
    tree.error,
    tree.toggle,
    tree.expandTo,
    tree.collapseAll,
    tree.refresh,
    tree.refreshDirectories,
    tree.reload,
  ]);
  const activeFilePath = useWorkColumnStore((state) => (
    workColumnTargetFilePath(state.navigation.target)
  ));
  const refreshDirectoriesRef = useRef(tree.refreshDirectories);
  refreshDirectoriesRef.current = tree.refreshDirectories;

  useEffect(() => {
    if (!isActive) return;
    let disposed = false;
    let leaseId: string | null = null;
    const rootPath = canonicalDirectoryPath(notebook.path);
    const unlisten = subscribe<FileBrowserDirectoriesChangedEvent>(
      FILE_BROWSER_DIRECTORIES_CHANGED_EVENT,
      (payload) => {
        if (disposed || canonicalDirectoryPath(payload.rootPath) !== rootPath) return;
        if (leaseId && payload.leaseId !== leaseId) return;
        void refreshDirectoriesRef.current(payload.directories);
      },
    );

    void files.watchRoot(notebook.path, {
      ignoreHidden: !showHiddenNotebookFiles,
      ignoreAgents: !showAgentsFile,
    })
      .then((nextLeaseId) => {
        if (disposed) {
          void files.unwatchRoot(nextLeaseId).catch(() => undefined);
          return;
        }
        leaseId = nextLeaseId;
      })
      .catch((error) => {
        if (!disposed) logger.warn('registering notebook tree watcher failed', { error });
      });

    return () => {
      disposed = true;
      unlisten();
      if (leaseId) void files.unwatchRoot(leaseId).catch(() => undefined);
    };
  }, [isActive, notebook.path, showHiddenNotebookFiles, showAgentsFile]);

  const openFile = useCallback(async (filePath: string) => {
    const startedAt = performance.now();
    try {
      if (resourceKindFromPath(filePath) !== 'note') {
        const resourceKind = resourceKindFromPath(filePath);
        if (resourceKind === 'image' || resourceKind === 'video') {
          await openMediaTarget({
            filePath,
            notebookId: notebook.id,
            notebookPath: notebook.path,
            resourceKind,
          });
        } else {
          await openExternalTarget(filePath, {
            scopePath: notebook.path,
            destination: 'main-third',
          });
        }
        return;
      }
      await openNotebookNote(filePath, notebook, {
        destination: 'main-third',
      });
      console.info('[perf:file-tree-open] path opened', { elapsedMs: performance.now() - startedAt });
    } catch (error) {
      logger.warn('opening notebook tree file failed', { error, filePath });
      toast.error(t('memo.fileTree.openFailed'));
    }
  }, [notebook, t, tree.nodes]);

  const openFileInNewTab = useCallback(async (filePath: string) => {
    try {
      if (resourceKindFromPath(filePath) !== 'note') {
        const resourceKind = resourceKindFromPath(filePath);
        if (resourceKind === 'image' || resourceKind === 'video') {
          await openBrowserColumnMedia(filePath, notebook.id, notebook.path, resourceKind);
        } else {
          await openBrowserColumnFileBrowser(notebook.path, filePath);
        }
        return;
      }
      await openBrowserColumnText(filePath, notebook.path);
    } catch (error) {
      logger.warn('opening notebook tree file in new tab failed', { error, filePath });
      toast.error(t('memo.fileTree.openFailed'));
    }
  }, [notebook.id, notebook.path, t]);

  const moveItem = useCallback(async (sources: NotebookMoveSource[], targetDirectoryPath: string): Promise<NotebookMoveResult> => {
    const sourcePaths = sources.map((source) => source.path);
    const root = canonicalDirectoryPath(notebook.path);
    const target = canonicalDirectoryPath(targetDirectoryPath);
    if (target !== root && !target.startsWith(`${root}/`)) {
      return { movedPaths: [], failedPaths: sourcePaths };
    }
    const parentRelativePath = target === root ? '' : target.slice(root.length + 1);
    const movedPaths: string[] = [];
    const failedPaths: string[] = [];
    for (const source of sources) {
      const sourcePath = source.path;
      try {
        const canonicalSourcePath = canonicalPath(sourcePath);
        const sourceInNotebook = canonicalSourcePath === root
          || canonicalSourcePath.startsWith(`${root}/`);
        if (!sourceInNotebook) {
          const importedPath = await files.importFile(sourcePath, target, notebook.path);
          movedPaths.push(importedPath);
          continue;
        }
        if (source.isFolder) {
          const movedPath = await files.moveFolder(sourcePath, target, notebook.path);
          movedPaths.push(movedPath);
          updateNoteLinksAfterMove(sourcePath, movedPath, true);
          continue;
        }
        const isMarkdownNote = source.resourceKind === 'note'
          || /\.(md|markdown)$/i.test(sourcePath);
        if (isMarkdownNote) {
          const moved = await memos.moveMemoToDirectory(
            sourcePath,
            notebook.id,
            parentRelativePath,
          );
          movedPaths.push(moved.path);
          if (moved.path !== sourcePath) updateNoteLinksAfterMove(sourcePath, moved.path);
        } else {
          const movedPath = await files.move(sourcePath, target, notebook.path);
          movedPaths.push(movedPath);
        }
      } catch (error) {
        logger.warn('moving notebook tree item failed', { error, sourcePath, targetDirectoryPath });
        failedPaths.push(sourcePath);
      }
    }
    return { movedPaths, failedPaths };
  }, [notebook.id, notebook.path]);

  const deleteFolder = useCallback(async (folderPath: string) => {
    const ok = await files.deleteFolder(folderPath, notebook.path);
    if (!ok) {
      toast.error(t('memo.fileTree.deleteFailed'));
      return;
    }
    const parent = folderPath.slice(0, folderPath.replace(/[\\/]+$/, '').lastIndexOf('/')) || notebook.path;
    await tree.refresh(parent);
    toast.success(t('memo.fileTree.deleted', { name: folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folderPath }));
  }, [notebook.path, t, tree.refresh]);

  const deleteResource = useCallback(async (item: DocTreeItem) => {
    const kind = item.resourceKind ?? resourceKindFromPath(item.name);
    if (kind !== 'image' && kind !== 'video') return;
    const ok = await mediaResources.delete(item.fullPath, notebook.path);
    if (!ok) {
      toast.error(t('media.fileTree.deleteFailed'));
      return;
    }
    const parent = parentDirectoryPath(item.fullPath, notebook.path);
    await tree.refresh(parent);
    toast.success(t('media.fileTree.deleted', { name: item.name }));
  }, [notebook.path, t, tree.refresh]);

  // MemoList remains mounted while the middle column shows conversations.
  // Avoid retaining a large hidden tree in the DOM while it is inactive.
  if (!isActive) return null;

  return (
    <NotebookFileTree
      notebookId={notebook.id}
      notebookName={notebook.name}
      notebookPath={notebook.path}
      activeFilePath={activeFilePath}
      tree={noteTree}
      hiddenListFolders={hiddenListFolders}
      onToggleListFolderVisibility={onToggleListFolderVisibility}
      onSetDefaultCreateFolder={onSetDefaultCreateFolder}
      createFolderRequest={createFolderRequest}
      createNoteRequest={createNoteRequest}
      onCreateFolder={onCreateFolder}
      onNoteSelect={(filePath) => { void openFile(filePath); }}
      onFolderSelect={(folderPath) => {
        const target = createDocumentListTarget(
          { kind: 'folder', path: folderPath, notebookPath: notebook.path, notebookId: notebook.id },
          {},
        );
        openDocumentListTarget(target);
      }}
      onNoteOpenInNewTab={(filePath) => { void openFileInNewTab(filePath); }}
      onCreateNote={(parentPath, title) => onCreateNote?.(parentPath, title)}
      onMoveNote={moveItem}
      onDeleteFolder={deleteFolder}
      onDeleteResource={deleteResource}
    />
  );
}
