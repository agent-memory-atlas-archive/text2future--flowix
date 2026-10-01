'use client';

import { useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties } from 'react';
import { CaretDownIcon, CaretUpIcon, CodeIcon, EyeIcon } from '@phosphor-icons/react';

import { useI18n } from '@/lib/i18n';
import { files } from '@platform/tauri/client';
import { DocumentContainer } from '@features/document/components/document-container';
import { connectLocalHtmlScrollbar } from '@shared/ui/local-html-scrollbar';
import { Tooltip } from '@shared/ui/tooltip';

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
}: {
  filePath: string;
  scopePath: string | null;
  documentProps: DocumentProps;
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

  useEffect(() => {
    const iframe = previewRef.current;
    if (iframe) return connectLocalHtmlScrollbar(iframe);
  }, [src, mode]);

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
                onClick={() => setMode('preview')}
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
            isExternalDocument
            externalScopePath={scopePath}
            readOnly
          />
        </div>
        {mode === 'preview' && (
          <iframe
            key={src}
            ref={previewRef}
            title={filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath}
            src={src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}
