import { useCallback, useEffect } from 'react';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { files } from '@platform/tauri/client/desktop';
import {
  clearBrowserColumnExternalPath,
  clearWorkspaceTargetForDeletedFile,
  deleteMainExternalDocument,
} from '@features/workspace/public/shell-api';

const logger = createLogger('use-external-file-deletion');

/**
 * Deletes an external (multi-dimensional table / media) document from the
 * main layout, guarding against unsaved content and cleaning up workspace
 * display state afterwards. Also listens for window-level delete requests
 * dispatched by non-React surfaces.
 */
export function useExternalFileDeletion() {
  const { t } = useI18n();

  const handleDeleteExternalFile = useCallback(async (expectedFilePath: string, notebookPath: string | null) => {
    try {
      const outcome = await deleteMainExternalDocument(expectedFilePath);
      if (outcome === 'unsaved') {
        toast.error(t('document.external.deleteFileUnsaved'));
        return;
      }
      if (outcome !== 'deleted') {
        if (!notebookPath) {
          toast.error('无法确定多维表格所属的笔记本，无法删除。');
          return;
        }
        const deleted = await files.delete(expectedFilePath, notebookPath);
        if (!deleted) throw new Error('删除多维表格失败');
        try {
          clearBrowserColumnExternalPath(expectedFilePath);
          await clearWorkspaceTargetForDeletedFile(expectedFilePath);
        } catch (cleanupError) {
          logger.warn('[MainLayout] File deleted, but workspace display cleanup failed:', {
            error: cleanupError,
            filePath: expectedFilePath,
          });
          toast.error(t('document.external.deleteFileViewCleanupFailed'));
        }
      }
      toast.success(t('status.deleteCompleted'));
    } catch (error) {
      logger.warn('[MainLayout] Failed to delete external file:', { error: error });
      toast.error(t('document.external.deleteFileFailed'));
    }
  }, [t]);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: unknown; notebookPath?: unknown }>).detail;
      if (typeof detail?.filePath === 'string' && detail.filePath) {
        void handleDeleteExternalFile(detail.filePath, typeof detail.notebookPath === 'string' ? detail.notebookPath : null);
      }
    };
    window.addEventListener('flowix:request-delete-external-file', handleRequest);
    return () => window.removeEventListener('flowix:request-delete-external-file', handleRequest);
  }, [handleDeleteExternalFile]);

  return { handleDeleteExternalFile };
}
