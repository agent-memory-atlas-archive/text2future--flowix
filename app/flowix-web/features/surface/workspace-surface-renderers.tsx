'use client';

import { lazy, useCallback, useEffect } from 'react';

import { useExternalFileContentDetection } from '@features/editor/use-external-file-content-detection';
import { externalFileViewKind } from '@features/editor/public/code-file';
import { workspaceSurfaceAppearance, workspaceSurfaceCapabilities } from '@features/workspace/public/surface-api';

import { LazyAgentConversationDetail } from '@features/agent/components/lazy-agent-conversation-detail';
import { LazyPluginDocumentView, LazyPluginWorkbench } from '@features/plugin/public/surface-api';

import type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-registry';
import { WorkspaceSurfaceStateView } from './workspace-surface-state-view';
import { useWorkspaceSurfaceLifecycleBridge } from './workspace-surface-lifecycle-bridge';
import type { DocumentContentStatus } from '@features/document/components/session/types';
import { openFolderCollection } from '@features/workspace/public/main-window-api';
import { notes } from '@platform/tauri/client';
import { toast } from '@/lib/toast';

const NO_SURFACE_ACTIONS: readonly [] = [];

function publishDocumentContentState(
  reportPresentation: WorkspaceSurfaceRenderContext['reportPresentation'],
  contentState: DocumentContentStatus,
) {
  if (!reportPresentation) return;
  switch (contentState.status) {
    case 'loading':
      reportPresentation({ state: {
        status: 'loading', loadingMode: 'blocking', retainContent: contentState.retainContent,
      } });
      break;
    case 'error':
      reportPresentation({ state: {
        status: 'error', message: { key: 'error.unexpected', fallbackText: contentState.message },
        actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: contentState.retry }],
      } });
      break;
    case 'missing-note':
      reportPresentation({ state: {
        status: 'error', message: { key: 'document.load.missingNoteTitle' }, detailText: contentState.path,
        actions: [
          { id: 'retry', label: { key: 'error.retry' }, enabled: true, run: contentState.retry },
          { id: 'delete', label: { key: 'document.action.delete' }, enabled: true, run: async () => {
            try {
              const outcome = await notes.pruneMissing(contentState.path);
              if (outcome === 'present') {
                await contentState.retry();
                return;
              }
              // The confirmed resource-deleted event owns list, tab and work
              // target cleanup in every window.
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error));
            }
          } },
        ],
      } });
      break;
    case 'ready':
      reportPresentation({ state: { status: 'ready' } });
      break;
  }
}

// Keep the wrapper module lightweight: each content view loads only when selected.
const DocumentContainer = lazy(() => import('@features/document/components/document-container').then((module) => ({ default: module.DocumentContainer })));
const UnavailableFileView = lazy(() => import('@features/document/components/document-container').then((module) => ({ default: module.UnavailableFileView })));
const DocxPreview = lazy(() => import('@features/document/components/docx-preview').then((module) => ({ default: module.DocxPreview })));
const CsvPreview = lazy(() => import('@features/document/components/csv-preview').then((module) => ({ default: module.CsvPreview })));
const TableDocumentView = lazy(() => import('@features/multidimensional-table/public/surface-api').then((module) => ({ default: module.TableDocumentView })));
const MediaLibraryView = lazy(() => import('@features/media-library/media-library-view').then((module) => ({ default: module.MediaLibraryView })));
const MediaResourceView = lazy(() => import('./media-resource-view').then((module) => ({ default: module.MediaResourceView })));
const WorkDocumentsView = lazy(() => import('./work-documents-view').then((module) => ({ default: module.WorkDocumentsView })));
const WorkDocumentsCollectionView = lazy(() => import('./work-documents-collection-view').then((module) => ({ default: module.WorkDocumentsCollectionView })));
const MarkdownDocumentSurface = lazy(() => import('./markdown-document-surface').then((module) => ({ default: module.MarkdownDocumentSurface })));
const HtmlResourceView = lazy(() => import('./html-resource-view').then((module) => ({ default: module.HtmlResourceView })));
const CodeSurfaceFileBrowser = lazy(() => import('./work-file-browser-view').then((module) => ({ default: module.CodeSurfaceFileBrowser })));

type SurfaceOfKind<K extends WorkspaceSurfaceRendererData['kind']> = Extract<WorkspaceSurfaceRendererData, { kind: K }>;
type RendererProps<K extends WorkspaceSurfaceRendererData['kind']> = {
  surface: SurfaceOfKind<K>;
  context: WorkspaceSurfaceRenderContext;
};

export function MarkdownRenderer({ surface, context }: RendererProps<'file-markdown'>) {
  const onContentStateChange = useCallback((state: DocumentContentStatus) => {
    publishDocumentContentState(context.reportPresentation, state);
  }, [context.reportPresentation]);
  return <MarkdownDocumentSurface
    fileIdentity={surface.fileIdentity}
    documentProps={{ ...surface.documentProps, workspaceHost: context.host,
      initialFocus: context.initialFocus ?? surface.documentProps.initialFocus,
      onContentStateChange: context.reportPresentation ? onContentStateChange : undefined }}
    navigationViewId={context.host === 'browser-column' ? context.viewId : undefined}
    reportPresentation={context.reportPresentation}
    registerLifecycle={context.registerLifecycle}
  />;
}

export function CodeRenderer({ surface, context }: RendererProps<'file-code'>) {
  const onContentStateChange = useCallback((state: DocumentContentStatus) => {
    publishDocumentContentState(context.reportPresentation, state);
  }, [context.reportPresentation]);
  const documentProps = useWorkspaceSurfaceLifecycleBridge({
    ...surface.documentProps,
    workspaceHost: context.host,
    initialFocus: context.initialFocus ?? surface.documentProps.initialFocus,
    onContentStateChange: context.reportPresentation ? onContentStateChange : undefined,
  }, context.registerLifecycle);
  if (context.host === 'main-third') {
    const workSurface = {
      kind: 'code' as const,
      instanceKey: surface.instanceKey,
      fileIdentity: surface.fileIdentity,
      props: documentProps,
    };
    return <CodeSurfaceFileBrowser surface={workSurface} />;
  }
  const content = <DocumentContainer
    {...documentProps}
    fileIdentity={surface.fileIdentity}
    navigationViewId={context.viewId}
    externalScopePath={surface.scopePath}
  />;
  return context.wrapInFileBrowser?.(content) ?? content;
}

export function CsvRenderer({ surface, context }: RendererProps<'file-csv'>) {
  const props = useWorkspaceSurfaceLifecycleBridge({
    filePath: surface.fileIdentity.path, scopePath: surface.scopePath,
  }, context.registerLifecycle);
  return <CsvPreview {...props} reportPresentation={context.reportPresentation} />;
}

export function ImageRenderer({ surface, context }: RendererProps<'file-image'>) {
  return <MediaResourceView filePath={surface.fileIdentity.path} notebookPath={surface.scopePath} resourceKind="image"
    reportPresentation={context.reportPresentation} />;
}

export function VideoRenderer({ surface, context }: RendererProps<'file-video'>) {
  return <MediaResourceView filePath={surface.fileIdentity.path} notebookPath={surface.scopePath} resourceKind="video"
    reportPresentation={context.reportPresentation} />;
}

export function TableRenderer({ surface, context }: RendererProps<'file-table'>) {
  const props = useWorkspaceSurfaceLifecycleBridge(surface.props, context.registerLifecycle);
  return <TableDocumentView {...props} fileIdentity={surface.fileIdentity} reportPresentation={context.reportPresentation} />;
}

export function MediaLibraryRenderer({ surface, context }: RendererProps<'file-media-library'>) {
  const lifecycleProps = useWorkspaceSurfaceLifecycleBridge({}, context.registerLifecycle);
  return <MediaLibraryView
    {...lifecycleProps}
    filePath={surface.fileIdentity.path}
    fileIdentity={surface.fileIdentity}
    expectedCollectionId={surface.expectedCollectionId}
    notebookPath={surface.notebookPath}
    notebookId={surface.notebookId}
    workspaceHost={context.host}
    reportPresentation={context.reportPresentation}
  />;
}

export function WorkDocumentsCollectionRenderer({ surface, context }: RendererProps<'file-work-documents'>) {
  const lifecycleProps = useWorkspaceSurfaceLifecycleBridge({}, context.registerLifecycle);
  return <WorkDocumentsCollectionView
    {...lifecycleProps}
    filePath={surface.fileIdentity.path}
    fileIdentity={surface.fileIdentity}
    notebookPath={surface.notebookPath}
    notebookId={surface.notebookId}
    expectedCollectionId={surface.expectedCollectionId}
    workspaceHost={context.host}
    reportPresentation={context.reportPresentation}
  />;
}

export function HtmlRenderer({ surface, context }: RendererProps<'file-html'>) {
  const documentProps = useWorkspaceSurfaceLifecycleBridge({
    ...surface.documentProps,
    fileIdentity: surface.fileIdentity,
    workspaceHost: context.host,
    initialFocus: context.initialFocus ?? surface.documentProps.initialFocus,
  }, context.registerLifecycle);
  return <HtmlResourceView
    filePath={surface.fileIdentity.path}
    scopePath={surface.scopePath}
    documentProps={documentProps}
    reportPresentation={context.reportPresentation}
  />;
}

export function DocxRenderer({ surface, context }: RendererProps<'file-docx'>) {
  const preview = <DocxPreview filePath={surface.fileIdentity.path} scopePath={surface.scopePath} reportPresentation={context.reportPresentation} />;
  return context.host === 'browser-column' ? context.wrapInFileBrowser?.(preview) ?? preview : preview;
}

export function UnavailableRenderer({ surface, context }: RendererProps<'file-unavailable'>) {
  const onContentStateChange = useCallback((state: DocumentContentStatus) => {
    publishDocumentContentState(context.reportPresentation, state);
  }, [context.reportPresentation]);
  const filePath = surface.fileIdentity.path;
  const documentProps = useWorkspaceSurfaceLifecycleBridge({
    ...surface.documentProps,
    workspaceHost: context.host,
    initialFocus: context.initialFocus ?? surface.documentProps?.initialFocus,
    onContentStateChange: context.reportPresentation ? onContentStateChange : undefined,
  }, context.registerLifecycle);
  const baseFileKind = externalFileViewKind(filePath);
  const { isTextContent, loading: contentDetectionLoading } = useExternalFileContentDetection(filePath, surface.scopePath, baseFileKind === 'unavailable');
  const resolvedFileKind = externalFileViewKind(filePath, null, isTextContent);
  const hasDocumentProps = Boolean(surface.documentProps);
  useEffect(() => {
    if (baseFileKind === 'docx' || baseFileKind === 'csv') return;
    if (contentDetectionLoading) {
      context.reportPresentation?.({ state: {
        status: 'loading', loadingMode: 'blocking', retainContent: false,
      } });
    } else if (resolvedFileKind === 'code' && hasDocumentProps) {
      context.reportPresentation?.({ appearance: workspaceSurfaceAppearance('file-code'),
        capabilities: workspaceSurfaceCapabilities('file-code'), actions: NO_SURFACE_ACTIONS });
    }
  }, [baseFileKind, context.reportPresentation, hasDocumentProps, contentDetectionLoading, resolvedFileKind]);
  if (baseFileKind === 'docx') {
    const preview = <DocxPreview filePath={filePath} scopePath={surface.scopePath} reportPresentation={context.reportPresentation} />;
    return context.host === 'browser-column' ? context.wrapInFileBrowser?.(preview) ?? preview : preview;
  }
  if (baseFileKind === 'csv') return <CsvPreview filePath={filePath} scopePath={surface.scopePath}
    onSurfaceLifecycleReady={documentProps.onSurfaceLifecycleReady} reportPresentation={context.reportPresentation} />;
  if (contentDetectionLoading) return context.reportPresentation ? null : <WorkspaceSurfaceStateView
    appearance={workspaceSurfaceAppearance('file-unavailable')}
    state={{ status: 'loading', loadingMode: 'blocking', retainContent: false }}
  />;
  if (resolvedFileKind === 'code' && surface.documentProps) {
    const content = <DocumentContainer
      {...documentProps}
      initialFocus={context.initialFocus ?? surface.documentProps.initialFocus}
      fileIdentity={surface.fileIdentity}
      navigationViewId={context.host === 'browser-column' ? context.viewId : undefined}
      externalScopePath={surface.scopePath}
    />;
    return context.host === 'browser-column' ? context.wrapInFileBrowser?.(content) ?? content : content;
  }
  return <UnavailableFileView filePath={filePath} openContainingFolder scopePath={surface.scopePath} reportPresentation={context.reportPresentation} />;
}

export function MediaResourceRenderer({ surface, context }: RendererProps<'media'>) {
  return <MediaResourceView
    filePath={surface.fileIdentity.path}
    notebookPath={surface.notebookPath}
    resourceKind={surface.resourceKind}
    reportPresentation={context.reportPresentation}
  />;
}

export function AgentConversationRenderer({ surface, context }: RendererProps<'agent-conversation'>) {
  return <LazyAgentConversationDetail instanceId={surface.instanceId} reportPresentation={context.reportPresentation} />;
}

export function PluginDocumentRenderer({ surface, context }: RendererProps<'mindmap' | 'plugin-artifact'>) {
  return <LazyPluginDocumentView {...surface.props} reportPresentation={context.reportPresentation} />;
}

export function PluginWorkbenchRenderer({ surface, context }: RendererProps<'plugin-workbench'>) {
  return <LazyPluginWorkbench {...surface.props} reportPresentation={context.reportPresentation} />;
}

export function CollectionRenderer({ surface, context }: RendererProps<'collection'>) {
  useEffect(() => {
    if (surface.viewMode === 'work-documents') return;
    context.reportPresentation?.({ state: { status: 'ready' } });
  }, [context.reportPresentation, surface.viewMode]);

  if (surface.viewMode === 'work-documents') {
    return <WorkDocumentsView notebookId={surface.notebookId} notebookPath={surface.notebookPath} context={context} />;
  }

  const choose = async (initialType: 'notes' | 'media') => {
    try {
      await openFolderCollection(surface.notebookId, surface.folderPath, {
        initialType,
        destination: context.host,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法打开文件夹集合');
    }
  };

  return <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
    <section className="w-full max-w-xl">
      <h1 className="mb-5 text-xl font-semibold text-[var(--foreground)]">如何显示当前文件夹？</h1>
      <div className="mb-2 grid grid-cols-1 gap-3">
        <button type="button" onClick={() => { void choose('notes'); }}
          className="flex flex-col items-start justify-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-left transition-colors hover:bg-[var(--muted)]">
          <span className="text-sm font-medium">显示笔记</span>
          <span className="text-sm text-[var(--muted-foreground)]">支持表格 / 日历 / 看板 / 画廊</span>
        </button>
        <button type="button" onClick={() => { void choose('media'); }}
          className="flex flex-col items-start justify-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-left transition-colors hover:bg-[var(--muted)]">
          <span className="text-sm font-medium">显示图/视频</span>
          <span className="text-sm text-[var(--muted-foreground)]">支持图片墙 / 瀑布流</span>
        </button>
      </div>
    </section>
  </div>;
}
