import { useCallback, useMemo } from 'react';
import { files, type DocTreeItem } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { displayTitleFromFilename, tableDocumentExtension } from '@/lib/utils';
import { canonicalPath } from '@/lib/path';
import { renameWorkspaceFile } from '@features/workspace/public/shell-api';
import { fileTreeRenameFailureKey } from './file-tree-failure';

const logger = createLogger('notebook-view-actions');
const MESSAGES = {
  table: {
    membershipFailed: 'multidimensionalTable.viewMembership.saveFailed',
    identitySuccess: 'multidimensionalTable.identityRegenerated',
    identityFailed: 'multidimensionalTable.identityRegenerateFailed',
  },
  'media-library': {
    membershipFailed: 'mediaLibrary.viewMembership.saveFailed',
    identitySuccess: 'mediaLibrary.identityRegenerated',
    identityFailed: 'mediaLibrary.identityRegenerateFailed',
  },
} as const;

interface ViewDocument {
  collectionId: string;
  relativePath: string;
  inViews: boolean;
  identityConflict?: boolean;
}

/** Shared catalog mutations; filesystem rows and Views keep their own rendering. */
export function useNotebookViewActions({ kind, notebookId, notebookPath, itemsByPath, refresh, updateIdentity, onDeleteFile }: {
  kind: keyof typeof MESSAGES;
  notebookId: string | null;
  notebookPath: string;
  itemsByPath: ReadonlyMap<string, ViewDocument>;
  refresh: () => Promise<void>;
  updateIdentity: (relativePath: string, collectionId: string) => void;
  onDeleteFile?: (item: DocTreeItem, options?: { silent?: boolean }) => Promise<boolean | void>;
}) {
  const { t } = useI18n();
  const messages = MESSAGES[kind];
  const deleteItem = useCallback(async (item: DocTreeItem) => {
    try {
      if (onDeleteFile) {
        if (await onDeleteFile(item) === false) return;
      } else {
        if (!await files.delete(item.fullPath, notebookPath)) {
          toast.error(t('memo.fileTree.deleteFailed'));
          return;
        }
        toast.success(t('status.deleteCompleted'));
      }
      if (notebookId) await refresh();
    } catch {
      toast.error(t('memo.fileTree.deleteFailed'));
    }
  }, [notebookId, notebookPath, onDeleteFile, refresh, t]);

  const setInViews = useCallback(async (collectionId: string, inViews: boolean) => {
    if (!notebookId) return;
    try {
      const setMembership = kind === 'table' ? files.setTableDocumentInViews : files.setMediaLibraryInViews;
      await setMembership(notebookId, collectionId, inViews);
      await refresh();
    } catch (error) {
      logger.warn('failed to update view membership', { error, notebookId, collectionId, kind });
      toast.error(t(messages.membershipFailed));
    }
  }, [kind, notebookId, refresh, messages, t]);

  const makeIdentityUnique = useCallback(async (relativePath: string) => {
    if (!notebookId) return;
    try {
      const collectionId = await files.makeViewDocumentIdentityUnique(notebookId, relativePath);
      updateIdentity(relativePath, collectionId);
      try {
        await refresh();
      } catch (error) {
        // Identity was saved successfully; a catalog refresh failure must not report mutation failure.
        logger.warn('failed to reload catalog after assigning identity', { error, notebookId, relativePath, kind });
      }
      toast.success(t(messages.identitySuccess));
    } catch (error) {
      logger.warn('failed to regenerate copied view identity', { error, notebookId, relativePath, kind });
      toast.error(t(messages.identityFailed));
    }
  }, [kind, notebookId, refresh, updateIdentity, messages, t]);

  const visibilityByPath = useMemo(() => new Map([...itemsByPath].map(([path, item]) => [path, {
    collectionId: item.collectionId,
    inViews: item.inViews,
    identityConflict: item.identityConflict ?? false,
    onChange: (inViews: boolean) => { void setInViews(item.collectionId, inViews); },
    onMakeIdentityUnique: () => { void makeIdentityUnique(item.relativePath); },
  }] as const)), [itemsByPath, setInViews, makeIdentityUnique]);

  // Views exposes inline table renaming; ordinary file rows use the tree rename transaction.
  const renameTable = useCallback(async (item: DocTreeItem, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === displayTitleFromFilename(item.name)) return true;
    try {
      await renameWorkspaceFile({
        path: item.fullPath,
        name: `${trimmed}${tableDocumentExtension(item.name)}`,
        scopePath: notebookPath,
        notebookId: notebookId ?? undefined,
        collectionId: itemsByPath.get(canonicalPath(item.fullPath))?.collectionId,
      });
      if (notebookId) await refresh();
      toast.success(t('memo.fileTree.renamed', { name: trimmed }));
      return true;
    } catch (error) {
      toast.error(t(fileTreeRenameFailureKey(error)));
      return false;
    }
  }, [itemsByPath, notebookId, notebookPath, refresh, t]);

  return { deleteItem, renameTable, visibilityByPath };
}
