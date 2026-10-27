'use client';

import { Link2 } from 'lucide-react';

import { WorkColumnTitlebar } from '@features/shell/components/work-column-titlebar';
import { WORK_COLUMN_TITLEBAR_GRADIENT } from '@features/shell/components/work-column-titlebar-shell';
import { WorkColumnTitlebarNavigation } from '@features/shell/components/work-column-titlebar-navigation';
import {
  DOCUMENT_TITLEBAR_ICON_BUTTON_MAC, DOCUMENT_TITLEBAR_ICON_BUTTON_WIN,
  type DocumentTitlebarProps,
} from './document-titlebar-model';
import { ExternalTitlebarBadge, SurfaceHeaderIcon, MediaActions } from './document-titlebar-controls';
import { DocumentTitlebarActions } from './document-titlebar-actions';
import {
  AgentThreadCardFullscreenExitButton, AgentThreadCardFullscreenMoreMenu,
  AgentThreadCardFullscreenIdentity, useAgentThreadCardFullscreenActive,
} from './agent-thread-card-titlebar';

/** Shared behavior and content; platforms only select frame and button styling. */
export function DocumentTitlebar({
  platform,
  webAddressBarVisible = false,
  onToggleWebAddressBar,
  reserveWindowsControls = true,
  surfaceChrome = 'document',
  document: { target },
  sidebar,
  navigation,
  contentCapabilities,
  actions,
  mediaActions,
  folderCollectionViewType,
  showEditorFontSwitcher = false,
  showEditorModeToggle = false,
  editorMode = 'rich',
  onSetEditorMode,
}: DocumentTitlebarProps & { platform: 'mac' | 'windows' }) {
  const isWindows = platform === 'windows';
  const fullscreen = useAgentThreadCardFullscreenActive();
  const isMediaSurface = surfaceChrome === 'media';
  const iconButtonClass = isWindows ? DOCUMENT_TITLEBAR_ICON_BUTTON_WIN : DOCUMENT_TITLEBAR_ICON_BUTTON_MAC;

  return <WorkColumnTitlebar isWindows={isWindows} reserveWindowsControls={reserveWindowsControls}
    showTrafficLightSpacer={sidebar.hidden && !sidebar.noteNavigationVisible}
    className={fullscreen ? 'agent-surface-titlebar' : isMediaSurface ? 'media-surface-titlebar' : ''}
    style={fullscreen || isMediaSurface ? undefined : { backgroundImage: WORK_COLUMN_TITLEBAR_GRADIENT }}>
    <WorkColumnTitlebarNavigation isWindows={isWindows} sidebar={sidebar} navigation={navigation}>
      {!fullscreen && (navigation.title || navigation.icon) &&
        <span className="ml-2 flex min-w-0 max-w-[320px] items-center gap-2 text-sm font-medium text-[var(--foreground)]" title={navigation.title ?? undefined}>
          <SurfaceHeaderIcon icon={navigation.icon} web={Boolean(onToggleWebAddressBar)} />
          {navigation.title && <span className="truncate">{navigation.title}</span>}
        </span>}
    </WorkColumnTitlebarNavigation>
    <AgentThreadCardFullscreenIdentity />
    <div data-tauri-drag-region className={`ml-auto flex shrink-0 items-center pr-3 ${isWindows ? 'gap-2' : 'gap-3'}`}>
      {!fullscreen && onToggleWebAddressBar && <button
        type="button"
        className={iconButtonClass}
        aria-label={webAddressBarVisible ? '隐藏网址条' : '显示网址条'}
        title={webAddressBarVisible ? '隐藏网址条' : '显示网址条'}
        aria-expanded={webAddressBarVisible}
        onClick={onToggleWebAddressBar}
      ><Link2 className="h-4 w-4" /></button>}
      <AgentThreadCardFullscreenExitButton className="agent-thread-card-fullscreen-exit-btn" />
      {!fullscreen && target && <ExternalTitlebarBadge target={target} />}
      {target && !isMediaSurface && <DocumentTitlebarActions
        key={`${target.fileIdentity.displayId}:${target.fileIdentity.path}`}
        target={target}
        visible={!fullscreen}
        iconButtonClass={iconButtonClass}
        capabilities={contentCapabilities}
        actions={actions}
        folderCollectionViewType={folderCollectionViewType}
        showEditorFontSwitcher={showEditorFontSwitcher}
        showEditorModeToggle={showEditorModeToggle}
        editorMode={editorMode}
        onSetEditorMode={onSetEditorMode}
      />}
      {fullscreen && <AgentThreadCardFullscreenMoreMenu iconButtonClass={iconButtonClass} />}
      {!fullscreen && isMediaSurface && mediaActions && <MediaActions iconButtonClass={iconButtonClass} {...mediaActions} />}
    </div>
  </WorkColumnTitlebar>;
}
