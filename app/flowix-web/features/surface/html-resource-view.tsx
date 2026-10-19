'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties } from 'react';
import { CaretDownIcon, CaretUpIcon, CodeIcon, EyeIcon } from '@phosphor-icons/react';

import { useI18n } from '@/lib/i18n';
import { files } from '@platform/tauri/client';
import { DocumentContainer } from '@features/document/components/document-container';
import { connectLocalHtmlScrollbar } from '@shared/ui/local-html-scrollbar';
import { Tooltip } from '@shared/ui/tooltip';
import type { SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';
import type { DocumentContentStatus } from '@features/document/components/session/types';

type DocumentProps = ComponentProps<typeof DocumentContainer>;

const iconButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export function HtmlResourceView({
  filePath,
  scopePath,
  documentProps,
  reportPresentation,
}: {
  filePath: string;
  scopePath: string | null;
  documentProps: DocumentProps;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [localToolbarCollapsed, setLocalToolbarCollapsed] = useState(documentProps.toolbarCollapsed ?? false);
  const toolbarCollapsed = documentProps.onToolbarCollapsedChange
    ? documentProps.toolbarCollapsed ?? false
    : localToolbarCollapsed;
  const setToolbarCollapsed = documentProps.onToolbarCollapsedChange ?? setLocalToolbarCollapsed;
  const src = useMemo(() => files.toAssetUrl(filePath), [filePath]);
  const previewRef = useRef<HTMLIFrameElement>(null);
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [previewRetry, setPreviewRetry] = useState(0);
  const retryPreview = useCallback(() => {
    setPreviewState('loading');
    setPreviewRetry((current) => current + 1);
  }, []);
  const onContentStateChange = useCallback((state: DocumentContentStatus) => {
    if (mode !== 'source') return;
    if (state.status === 'loading') {
      reportPresentation?.({ state: {
        status: 'loading', loadingMode: 'blocking', retainContent: state.retainContent,
      } });
    } else if (state.status === 'missing-note') {
      reportPresentation?.({ state: {
        status: 'error', message: { key: 'document.load.missingNoteTitle' }, detailText: state.path,
        actions: [
          { id: 'retry', label: { key: 'error.retry' }, enabled: true, run: state.retry },
          { id: 'preview', label: { key: 'htmlResource.preview' }, enabled: true, run: () => setMode('preview') },
        ],
      } });
    } else if (state.status === 'error') {
      reportPresentation?.({ state: {
        status: 'error', message: { key: 'error.unexpected', fallbackText: state.message },
        actions: [
          { id: 'retry', label: { key: 'error.retry' }, enabled: true, run: state.retry },
          { id: 'preview', label: { key: 'htmlResource.preview' }, enabled: true, run: () => setMode('preview') },
        ],
      } });
    } else {
      reportPresentation?.({ state: { status: 'ready' } });
    }
  }, [mode, reportPresentation, setMode]);

  useEffect(() => {
    if (mode !== 'preview') return;
    reportPresentation?.({ state: previewState === 'loading'
      ? { status: 'loading', loadingMode: 'blocking', retainContent: false }
      : previewState === 'error'
        ? { status: 'error', message: { key: 'document.file.unavailable' },
            actions: [
              { id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryPreview },
              { id: 'source', label: { key: 'htmlResource.source' }, enabled: true, run: () => setMode('source') },
            ] }
        : { status: 'ready' } });
  }, [mode, previewState, reportPresentation, retryPreview, setMode]);

  useEffect(() => {
    const iframe = previewRef.current;
    if (iframe) return connectLocalHtmlScrollbar(iframe);
  }, [src, mode]);

  useEffect(() => {
    if (mode === 'preview') setPreviewState('loading');
  }, [mode, src]);

  return (
    <div className="relative h-full min-h-0 min-w-0">
      <div className="editor-toolbar">
        {toolbarCollapsed ? (
          <Tooltip content={t('editor.toolbar.expandTooltip')}>
            <button
              className="toolbar-expand-handle"
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setToolbarCollapsed(false)}
              aria-label={t('editor.toolbar.expand')}
              aria-expanded={false}
              style={{ width: '2.4rem', height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <CaretUpIcon size={14} weight="bold" />
            </button>
          </Tooltip>
        ) : (
          <div className="toolbar-content">
            <Tooltip content={t('htmlResource.preview')}>
              <button
                type="button"
                aria-pressed={mode === 'preview'}
                aria-label={t('htmlResource.preview')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { setPreviewState('loading'); setMode('preview'); }}
                className={`toolbar-button ${mode === 'preview' ? 'active' : ''}`}
                style={iconButtonStyle}
              >
                <EyeIcon size={16} weight="bold" />
              </button>
            </Tooltip>
            <Tooltip content={t('htmlResource.source')}>
              <button
                type="button"
                aria-pressed={mode === 'source'}
                aria-label={t('htmlResource.source')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setMode('source')}
                className={`toolbar-button ${mode === 'source' ? 'active' : ''}`}
                style={iconButtonStyle}
              >
                <CodeIcon size={16} weight="bold" />
              </button>
            </Tooltip>
            <Tooltip content={t('editor.toolbar.collapseTooltip')}>
              <button
                className="toolbar-button"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setToolbarCollapsed(true)}
                aria-label={t('editor.toolbar.collapse')}
                aria-expanded={true}
                style={iconButtonStyle}
              >
                <CaretDownIcon size={14} weight="bold" />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      <div className="absolute inset-0 min-h-0 min-w-0">
        <div
          aria-hidden={mode !== 'source'}
          inert={mode !== 'source'}
          className={`absolute inset-0 ${mode === 'source' ? 'z-10' : 'invisible pointer-events-none'}`}
        >
          <DocumentContainer
            {...documentProps}
            onContentStateChange={reportPresentation ? onContentStateChange : undefined}
            isExternalDocument
            externalScopePath={scopePath}
            readOnly
          />
        </div>
        {mode === 'preview' && (
          <iframe
            key={`${src}:${previewRetry}`}
            ref={previewRef}
            title={filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath}
            src={src}
            onLoad={() => setPreviewState('ready')}
            onError={() => setPreviewState('error')}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}
