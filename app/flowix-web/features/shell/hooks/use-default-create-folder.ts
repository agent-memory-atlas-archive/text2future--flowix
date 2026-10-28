import { useCallback, useEffect, useState } from 'react';

import { createLogger } from '@/lib/logger';
import {
  canonicalDirectoryPath,
  notebookRelativeDirectoryPath,
  parentDirectoryPath,
} from '@/lib/path';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { files } from '@platform/tauri/client/desktop';
import { subscribe } from '@platform/tauri/event-bus';
import type { Notebook } from '@features/memo/public/shell-api';

const logger = createLogger('use-default-create-folder');

/**
 * Tracks the "default create folder" preference of the selected notebook for
 * the collection titlebar toggle. Subscribes to preference change events so
 * edits from other surfaces stay in sync.
 */
export function useDefaultCreateFolder(selectedNotebook: Notebook | null) {
  const { t } = useI18n();
  const [defaultCreateFolderState, setDefaultCreateFolderState] = useState<{
    notebookId: string;
    path: string | null;
  } | null>(null);
  const defaultCreateFolder = defaultCreateFolderState !== null
    && selectedNotebook != null
    && defaultCreateFolderState.notebookId === selectedNotebook.id
    ? defaultCreateFolderState.path
    : null;

  useEffect(() => {
    let current = true;
    const refreshDefaultFolder = () => {
      if (!selectedNotebook) return;
      void files.getNotebookViewPreferences(selectedNotebook.path).then((preferences) => {
        if (current) setDefaultCreateFolderState({
          notebookId: selectedNotebook.id,
          path: preferences.defaultCreateFolder ?? null,
        });
      }).catch((error) => {
        logger.warn('load notebook default create folder for titlebar failed', { error, notebookId: selectedNotebook.id });
        if (current) setDefaultCreateFolderState({ notebookId: selectedNotebook.id, path: null });
      });
    };
    if (!selectedNotebook) {
      setDefaultCreateFolderState(null);
      return () => { current = false; };
    }
    refreshDefaultFolder();
    const unsubscribe = subscribe<{ notebookPath: string; defaultCreateFolderChanged: boolean }>(
      'notebook-view-preferences-changed',
      ({ notebookPath, defaultCreateFolderChanged }) => {
        if (defaultCreateFolderChanged
          && canonicalDirectoryPath(notebookPath) === canonicalDirectoryPath(selectedNotebook.path)) {
          refreshDefaultFolder();
        }
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [selectedNotebook?.id, selectedNotebook?.path]);

  const handleToggleDefaultFolder = useCallback(async (target: {
    filePath: string;
    notebookPath: string;
    notebookId: string;
  }) => {
    const folderPath = parentDirectoryPath(target.filePath, target.notebookPath);
    const relativeFolder = notebookRelativeDirectoryPath(target.notebookPath, folderPath);
    if (relativeFolder === null) return;
    try {
      const preferences = await files.getNotebookViewPreferences(target.notebookPath);
      const isDefaultFolder = (preferences.defaultCreateFolder ?? null) === relativeFolder;
      const nextDefaultFolder = isDefaultFolder ? null : relativeFolder;
      await files.setNotebookViewPreferences(target.notebookPath, {
        ...preferences,
        defaultCreateFolder: nextDefaultFolder,
      });
      setDefaultCreateFolderState({ notebookId: target.notebookId, path: nextDefaultFolder });
      toast.success(t(isDefaultFolder
        ? 'memo.fileTree.defaultCreateFolderCleared'
        : 'memo.fileTree.defaultCreateFolderSet'));
    } catch (error) {
      logger.warn('set default create folder from collection titlebar failed', { error, folderPath });
      toast.error(t('memo.fileTree.preferenceSaveFailed'));
    }
  }, [t]);

  return { defaultCreateFolderState, defaultCreateFolder, handleToggleDefaultFolder };
}
