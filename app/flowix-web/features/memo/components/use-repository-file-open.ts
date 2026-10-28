'use client';

import { useCallback } from 'react';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

type RepositoryFileHost = 'main-third' | 'browser-column';

const logger = createLogger('notebook-repositories-open');

/**
 * Repository (资料文件夹) documents default to the Browser column, matching the
 * 对话 section in the file tree; the row menu opens them in Work instead.
 */
export function useRepositoryFileOpen(): {
  openRepositoryFileInBrowser: (path: string, scopePath: string) => void;
  openRepositoryFileInWork: (path: string, scopePath: string) => void;
} {
  const { t } = useI18n();
  const open = useCallback((path: string, scopePath: string, host: RepositoryFileHost) => {
    void openWorkspaceSurface({
      host,
      target: { kind: 'external', path, scopePath, transitionId: null },
    }).catch((error) => {
      logger.warn('failed to open repository file', { error, path, host });
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [t]);
  return {
    openRepositoryFileInBrowser: useCallback((path: string, scopePath: string) => {
      open(path, scopePath, 'browser-column');
    }, [open]),
    openRepositoryFileInWork: useCallback((path: string, scopePath: string) => {
      open(path, scopePath, 'main-third');
    }, [open]),
  };
}
