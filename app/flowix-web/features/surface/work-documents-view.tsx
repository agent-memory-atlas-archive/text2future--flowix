'use client';

import { useEffect, useMemo, useState } from 'react';
import { DocumentListView } from './document-list-view';
import type { WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';
import { useI18n } from '@/lib/i18n';

export function WorkDocumentsView({ notebookId, notebookPath, context }: {
  notebookId: string;
  notebookPath: string;
  context: WorkspaceSurfaceRenderContext;
}) {
  const { t } = useI18n();
  const [listLoading, setListLoading] = useState(true);
  const listContext = useMemo(() => ({
    displayId: `work-documents:${notebookId}`,
    folderPath: notebookPath,
    notebookPath,
    notebookId,
    filters: {},
    // Legacy folder view intentionally lists every notebook work document.
    workDocumentsFilter: { path_scope: 'all' as const },
  }), [notebookId, notebookPath]);

  useEffect(() => {
    context.reportPresentation?.({ title: t('memo.create.workDocuments'), state: listLoading
      ? { status: 'loading', loadingMode: 'blocking', retainContent: true }
      : { status: 'ready' } });
  }, [context.reportPresentation, listLoading, t]);

  return <DocumentListView
    listContext={listContext}
    workDocuments
    workspaceHost={context.host}
    onLoadingChange={setListLoading}
  />;
}
