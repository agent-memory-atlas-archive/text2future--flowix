import { ChevronsRight, ChevronLeft, ChevronRight, Ellipsis, FilePlus2, MessageCirclePlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { BrowserColumnEntry } from '@features/workspace/public/browser-column-api';
import { navigateBrowserColumnHistory, useBrowserColumnViewModel, canOpenBrowserColumnTargetInWorkColumn } from '@features/workspace/public/browser-column-api';
import { AgentConversationIdentity, AgentConversationMoreMenu, useBrowserColumnAgentHeaderModel, useNewConversationAgentSelection } from '@features/agent/public/shell-api';
import { AgentThreadCardFullscreenExitButton, AgentThreadCardFullscreenIdentity, AgentThreadCardFullscreenMoreMenu, useDocumentCommands, useFullscreenAgentThreadCardInfo } from '@features/document/public/shell-api';
import type { BrowserColumnSurfaceChrome } from '@features/surface/public/shell-api';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { useNotebookNoteIcon } from '@features/memo/public/shell-api';
import { classifyFileContent, isHtmlFilePath } from '@features/content/public/content-api';
import { requireFileDisplayIdentity } from '@/lib/file-display-registry';
import { documentIdentityFromFile, ExternalDocumentActions, MediaActions, readLatestDocumentContent, useDocumentEditorMode, setDocumentEditorMode, type DocumentTitlebarProps } from '@features/document/public/shell-api';
import { toast } from '@/lib/toast';
import { product } from '@platform/tauri/client';
import { BrowserContentIcon } from './browser-content-icon';
import { WORK_COLUMN_TITLEBAR_GRADIENT } from './work-column-titlebar-shell';
import { WorkspaceColumnContextMenu } from './workspace-column-context-menu';
import { DOCUMENT_TITLEBAR_ICON_BUTTON_MAC, DOCUMENT_TITLEBAR_ICON_BUTTON_WIN, NoteColorPicker, useDocumentTitlebarColors, type DocumentTitlebarTarget } from '@features/document/public/shell-api';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@shared/ui/dropdown-menu';

function BrowserColumnNoteColorButton({
  path,
  notebookId,
  scopePath,
  iconButtonClass,
}: {
  path: string;
  notebookId: string;
  scopePath: string;
  iconButtonClass: string;
}) {
  const fileIdentity = useMemo(() => requireFileDisplayIdentity(path), [path]);
  const relativePath = useMemo(() => notebookRelativeDirectoryPath(scopePath, path), [path, scopePath]);
  const target = useMemo<DocumentTitlebarTarget>(() => ({
    fileIdentity,
    scopePath,
    notebookId,
    relativePath,
    indexable: relativePath !== null,
    isOutsideCurrentNotebook: relativePath === null,
  }), [fileIdentity, notebookId, relativePath, scopePath]);
  const { colors, changeColors } = useDocumentTitlebarColors(target);
  if (relativePath === null) return null;
  return <NoteColorPicker colors={colors} iconButtonClass={iconButtonClass} onChange={changeColors} />;
}

function BrowserColumnDocumentMoreActions({
  path,
  scopePath,
  notebookId,
  surfaceCapabilities,
  surfaceId,
  onToggleMemoEditorMode,
  iconButtonClass,
}: {
  path: string;
  scopePath: string | null;
  notebookId: string | null;
  surfaceCapabilities: readonly string[];
  surfaceId: string;
  onToggleMemoEditorMode: (surfaceId: string) => void | Promise<void>;
  iconButtonClass: string;
}) {
  const fileIdentity = useMemo(() => requireFileDisplayIdentity(path), [path]);
  const documentIdentity = useMemo(() => documentIdentityFromFile(fileIdentity), [fileIdentity]);
  const relativePath = useMemo(() => scopePath ? notebookRelativeDirectoryPath(scopePath, path) : null, [path, scopePath]);
  const isNote = classifyFileContent(path) === 'note';
  const target = useMemo<DocumentTitlebarTarget>(() => ({
    fileIdentity,
    scopePath,
    notebookId,
    relativePath,
    indexable: isNote && Boolean(notebookId) && relativePath !== null,
    isOutsideCurrentNotebook: relativePath === null,
  }), [fileIdentity, isNote, notebookId, relativePath, scopePath]);
  const editorMode = useDocumentEditorMode('browser-column', documentIdentity);
  const getContent = () => readLatestDocumentContent(documentIdentity, 'browser-column');
  const commands = useDocumentCommands({
    currentDocumentPath: path,
    getCurrentDocumentContent: getContent,
    getCurrentDocumentEditor: () => null,
    pdfHost: 'browser-column',
  });
  const capabilities: DocumentTitlebarProps['contentCapabilities'] = {
    copyFullText: surfaceCapabilities.includes('copy-content'),
    memoColors: target.indexable,
    exportContent: surfaceCapabilities.includes('export-content'),
    saveAsTemplate: surfaceCapabilities.includes('save-template'),
    versionHistory: target.indexable,
  };
  const actions: DocumentTitlebarProps['actions'] = {
    onCopyLink: commands.handleCopyLink,
    onCopyFullText: commands.handleCopyFullText,
    onExportMarkdown: commands.handleExportMarkdown,
    onSaveAsTemplate: commands.handleSaveAsTemplate,
    onExportWord: commands.handleExportWord,
    onExportPdf: commands.handleExportPdf,
    onDeleteExternalFile: () => {
      window.dispatchEvent(new CustomEvent('flowix:request-delete-external-file', {
        detail: { filePath: path, notebookPath: scopePath },
      }));
    },
  };
  return <ExternalDocumentActions
    target={target}
    iconButtonClass={iconButtonClass}
    capabilities={capabilities}
    actions={actions}
    showColorPicker={false}
    showEditorFontSwitcher={isNote && surfaceCapabilities.includes('edit')}
    showEditorModeToggle={isNote || isHtmlFilePath(path)}
    editorMode={editorMode}
    onSetEditorMode={(mode) => {
      if (mode === editorMode) return;
      if (isHtmlFilePath(path)) setDocumentEditorMode('browser-column', documentIdentity, mode);
      else void onToggleMemoEditorMode(surfaceId);
    }}
  />;
}

function BrowserColumnMediaMoreActions({
  filePath,
  notebookPath,
  iconButtonClass,
}: {
  filePath: string;
  notebookPath: string | null;
  iconButtonClass: string;
}) {
  const { t } = useI18n();
  return <MediaActions
    iconButtonClass={iconButtonClass}
    onCopyLink={async () => {
      try {
        await navigator.clipboard.writeText(filePath);
        toast.success(t('document.command.copySuccess'));
      } catch {
        toast.error(t('document.command.copyFailed'));
      }
    }}
    onRevealInFileManager={() => {
      void product.revealInFileManager(filePath).catch(() => toast.error(t('memo.fileTree.openFailed')));
    }}
    onRequestDelete={notebookPath ? () => window.dispatchEvent(new CustomEvent('flowix:request-delete-media', {
      detail: { filePath, notebookPath },
    })) : undefined}
  />;
}
export interface BrowserColumnHeaderProps {
  current: BrowserColumnEntry | null;
  activeSurfaceChrome: BrowserColumnSurfaceChrome;
  surfaceCapabilities?: readonly string[];
  onToggleMemoEditorMode: (surfaceId: string) => void | Promise<void>;
  onOpenInWorkColumn: (surfaceId: string) => void | Promise<void>;
  onCloseColumn?: () => void;
  isFocused: boolean;
  canCreate: boolean;
  onCreateNote: (templateId?: string) => void;
  onCreateAgentConversation: (typeKey: AgentTypeKey) => void;
}

export function BrowserColumnHeader(props: BrowserColumnHeaderProps) {
  const { t } = useI18n();
  const { canNavigateBack, canNavigateForward } = useBrowserColumnViewModel();
  const fullscreen = useFullscreenAgentThreadCardInfo('browser-column');
  const { conversationInstances } = useBrowserColumnAgentHeaderModel();
  const selection = useNewConversationAgentSelection();
  const [renameRequest, setRenameRequest] = useState(0);
  const { current } = props;
  const noteIcon = useNotebookNoteIcon(current?.target.kind === 'file-browser' && current.target.activeFilePath && classifyFileContent(current.target.activeFilePath) === 'note'
    ? current.target.activeFilePath : null);
  const conversation = current?.target.kind === 'agent_conversation' ? conversationInstances[current.target.instanceId] : null;
  const mediaTarget = current?.target.kind === 'media'
    ? { filePath: current.target.filePath, notebookPath: current.target.notebookPath }
    : current?.target.kind === 'file-browser' && current.target.activeFilePath && props.activeSurfaceChrome === 'media'
      ? { filePath: current.target.activeFilePath, notebookPath: current.target.scopePath }
      : null;
  const title = fullscreen?.title || conversation?.title || current?.title || '';
  const special = props.activeSurfaceChrome === 'agent' || fullscreen ? 'agent-surface-titlebar' : props.activeSurfaceChrome === 'media' ? 'media-surface-titlebar' : '';
  const windows = typeof navigator !== 'undefined' && /Windows|Win32/.test(navigator.userAgent + navigator.platform);
  const buttonClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-35 [-webkit-app-region:no-drag]';
  const actionButtonClass = `${windows ? DOCUMENT_TITLEBAR_ICON_BUTTON_WIN : DOCUMENT_TITLEBAR_ICON_BUTTON_MAC} [-webkit-app-region:no-drag]`;
  const navigate = async (direction: 'back' | 'forward') => {
    try { if (await navigateBrowserColumnHistory(direction) === null) toast.error(t('tabWindow.switchFailed')); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('tabWindow.switchFailed')); }
  };
  return <WorkspaceColumnContextMenu onCreateNote={props.onCreateNote} onCreateAgentConversation={props.onCreateAgentConversation}><header data-browser-column-header data-tauri-drag-region
    data-thread-card-fullscreen={fullscreen ? '' : undefined}
    className={`relative flex shrink-0 items-center gap-1 pl-1 pr-2 ${windows ? 'h-9 min-h-9 pr-[126px]' : 'h-12 min-h-12'} ${special}`}
    style={special ? undefined : { backgroundImage: WORK_COLUMN_TITLEBAR_GRADIENT }}>
    <button type="button" className={buttonClass} aria-label={t('tabWindow.closeColumn')} onClick={props.onCloseColumn}><ChevronsRight className="h-4 w-4" /></button>
    <button type="button" className={buttonClass} aria-label={t('document.titlebar.back')} disabled={!canNavigateBack} onClick={() => void navigate('back')}><ChevronLeft className="h-4 w-4" /></button>
    <button type="button" className={buttonClass} aria-label={t('document.titlebar.forward')} disabled={!canNavigateForward} onClick={() => void navigate('forward')}><ChevronRight className="h-4 w-4" /></button>
    <div className="flex min-w-0 flex-1 items-center gap-2" data-tauri-drag-region>
      {current && !conversation && !fullscreen && <span className="shrink-0"><BrowserContentIcon entry={current} noteIcon={noteIcon} /></span>}
      {fullscreen ? <AgentThreadCardFullscreenIdentity host="browser-column" /> : conversation ? (
        <AgentConversationIdentity
          instanceId={conversation.instanceId}
          title={title}
          typeKey={conversation.agentType}
          threadId={conversation.threadId}
          sessionId={conversation.providerSessionId}
          renameRequest={renameRequest}
          className="min-w-0 flex-1"
        />
      ) : <span className="truncate text-sm" title={title} data-tauri-drag-region>{title}</span>}
    </div>
    <AgentThreadCardFullscreenExitButton host="browser-column" className="agent-thread-card-fullscreen-exit-btn" />
    {current?.target.kind === 'file-browser'
      && current.target.activeFilePath
      && classifyFileContent(current.target.activeFilePath) === 'note'
      && current.target.notebookId
      && current.target.scopePath
      && <BrowserColumnNoteColorButton
        path={current.target.activeFilePath}
        notebookId={current.target.notebookId}
        scopePath={current.target.scopePath}
        iconButtonClass={actionButtonClass}
      />}
    {fullscreen ? <AgentThreadCardFullscreenMoreMenu host="browser-column" iconButtonClass={actionButtonClass} />
      : conversation ? <AgentConversationMoreMenu instance={conversation} iconButtonClass={actionButtonClass} onRename={() => setRenameRequest((request) => request + 1)} />
        : mediaTarget ? <BrowserColumnMediaMoreActions filePath={mediaTarget.filePath} notebookPath={mediaTarget.notebookPath} iconButtonClass={actionButtonClass} />
          : current?.target.kind === 'file-browser' && current.target.activeFilePath ? <BrowserColumnDocumentMoreActions
            key={`${current.id}:${current.target.activeFilePath}`}
            path={current.target.activeFilePath}
            scopePath={current.target.scopePath}
            notebookId={current.target.notebookId}
            surfaceCapabilities={props.surfaceCapabilities ?? []}
            surfaceId={current.id}
            onToggleMemoEditorMode={props.onToggleMemoEditorMode}
            iconButtonClass={actionButtonClass}
          />
            : <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={actionButtonClass} aria-label={t('document.titlebar.moreTooltip')} title={t('document.titlebar.moreTooltip')}><Ellipsis className="h-4 w-4" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[210px] rounded-xl p-1">
                {current && <DropdownMenuItem disabled={!canOpenBrowserColumnTargetInWorkColumn(current.target)} onClick={() => void props.onOpenInWorkColumn(current.id)}>{t('tabWindow.context.openInWorkColumn')}</DropdownMenuItem>}
                <DropdownMenuItem disabled={!props.canCreate} onClick={() => props.onCreateNote()}><FilePlus2 className="mr-2 h-4 w-4" />{t('tabWindow.context.newNote')}</DropdownMenuItem>
                {selection.options.map((type) => <DropdownMenuItem key={type.id} disabled={!props.canCreate} onClick={() => props.onCreateAgentConversation(type.id)}><MessageCirclePlus className="mr-2 h-4 w-4" />{type.nameKey ? t(type.nameKey as Parameters<typeof t>[0]) : type.name}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>}
  </header></WorkspaceColumnContextMenu>;
}
