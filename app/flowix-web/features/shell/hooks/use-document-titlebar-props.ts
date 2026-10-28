import { useState } from 'react';

import { canonicalPath, notebookRelativeDirectoryPath, parentDirectoryPath } from '@/lib/path';
import {
  resolveDocumentTitlebarTarget,
  type DocumentEditorMode,
  type DocumentTitlebarProps,
} from '@features/document/public/shell-api';
import {
  resolveWorkColumnRuntimePresentation,
  useWorkspaceSurfacePresentation,
  type WorkColumnPresentation,
} from '@features/surface/public/shell-api';
import type { Notebook } from '@features/memo/public/shell-api';
import type {
  useShellDocumentViewModel,
} from '@features/document/public/shell-api';
import type {
  useShellWorkspaceViewModel,
} from '@features/workspace/public/shell-api';

type WorkspaceNavigation = ReturnType<typeof useShellWorkspaceViewModel>['navigation'];
type ActiveExternalSession = ReturnType<typeof useShellDocumentViewModel>['activeExternalSession'];
type RuntimePresentation = ReturnType<typeof useWorkspaceSurfacePresentation>;
type WorkCapabilities = ReturnType<typeof resolveWorkColumnRuntimePresentation>['capabilities'];
type WorkHeaderStyle = ReturnType<typeof resolveWorkColumnRuntimePresentation>['chrome'];

export interface UseDocumentTitlebarPropsInput {
  workColumnPresentation: WorkColumnPresentation;
  workRuntimePresentation: RuntimePresentation;
  workCapabilities: WorkCapabilities;
  workHeaderStyle: WorkHeaderStyle;
  navigationState: WorkspaceNavigation;
  browserColumnVisible: boolean;
  mainEditorMode: DocumentEditorMode;
  handleSetMainEditorMode: (mode: DocumentEditorMode) => void;
  isMemoListHidden: boolean;
  noteNavigationVisible: boolean;
  handleToggleMemoList: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  handleNavigateBack: () => void;
  handleNavigateForward: () => void;
  handleCopyLink: () => void;
  handleCopyFullText: () => void;
  handleExportMarkdown: () => void;
  handleSaveAsTemplate: () => void;
  handleExportWord: () => void;
  handleExportPdf: () => void;
  handleDeleteExternalFile: (expectedFilePath: string, notebookPath: string | null) => Promise<void>;
  mediaActions: DocumentTitlebarProps['mediaActions'];
  defaultCreateFolderState: { notebookId: string; path: string | null } | null;
  defaultCreateFolder: string | null;
  handleToggleDefaultFolder: (target: {
    filePath: string;
    notebookPath: string;
    notebookId: string;
  }) => Promise<void>;
  handleSwitchFolderCollectionType: (target: {
    filePath: string;
    notebookPath: string;
    notebookId: string;
  }, type: 'table' | 'media_library') => Promise<void>;
  activeExternalSession: ActiveExternalSession;
  selectedNotebook: Notebook | null;
}

/**
 * Assembles the `DocumentTitlebarProps` object shared by the Windows and Mac
 * document titlebars, including the web address bar state and the collection
 * view type switcher for `.index.yaml` collections.
 */
export function useDocumentTitlebarProps(input: UseDocumentTitlebarPropsInput): DocumentTitlebarProps {
  const {
    workColumnPresentation,
    workRuntimePresentation,
    workCapabilities,
    workHeaderStyle,
    navigationState,
    browserColumnVisible,
    mainEditorMode,
    handleSetMainEditorMode,
    isMemoListHidden,
    noteNavigationVisible,
    handleToggleMemoList,
    canNavigateBack,
    canNavigateForward,
    handleNavigateBack,
    handleNavigateForward,
    handleCopyLink,
    handleCopyFullText,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
    handleExportPdf,
    handleDeleteExternalFile,
    mediaActions,
    defaultCreateFolderState,
    defaultCreateFolder,
    handleToggleDefaultFolder,
    handleSwitchFolderCollectionType,
    activeExternalSession,
    selectedNotebook,
  } = input;
  const [addressBarWorkSurfaceId, setAddressBarWorkSurfaceId] = useState<string | null>(null);
  const workWebSurfaceId = workColumnPresentation.content.status === 'surface'
    && workColumnPresentation.content.surface.kind === 'web'
    ? workColumnPresentation.content.surface.instanceKey : null;
  const workWebAddressBarVisible = workWebSurfaceId !== null && addressBarWorkSurfaceId === workWebSurfaceId;

  return {
    webAddressBarVisible: workWebAddressBarVisible,
    onToggleWebAddressBar: workWebSurfaceId === null ? undefined : () => {
      setAddressBarWorkSurfaceId(workWebAddressBarVisible ? null : workWebSurfaceId);
    },
    reserveWindowsControls: !browserColumnVisible,
    surfaceChrome: workHeaderStyle === 'media' ? 'media' as const : 'document' as const,
    showEditorFontSwitcher: workColumnPresentation.content.status === 'surface'
      && workCapabilities.includes('edit')
      && workColumnPresentation.content.surface.kind === 'md',
    showEditorModeToggle: workColumnPresentation.content.status === 'surface'
      && (workColumnPresentation.content.surface.kind === 'md' || workColumnPresentation.content.surface.kind === 'html-file'),
    editorMode: mainEditorMode,
    onSetEditorMode: handleSetMainEditorMode,
    document: {
      target: workColumnPresentation.header.kind === 'document'
        && workColumnPresentation.header.document.externalFilePath
        && workColumnPresentation.content.status === 'surface'
        && 'fileIdentity' in workColumnPresentation.content.surface
        ? resolveDocumentTitlebarTarget(
            workColumnPresentation.content.surface.fileIdentity,
            activeExternalSession,
            selectedNotebook?.path ?? null,
          )
        : null,
    },
    sidebar: {
      hidden: isMemoListHidden,
      noteNavigationVisible,
      onToggle: handleToggleMemoList,
    },
    navigation: {
      canNavigateBack,
      canNavigateForward,
      onNavigateBack: handleNavigateBack,
      onNavigateForward: handleNavigateForward,
      title: workRuntimePresentation.title,
      icon: workRuntimePresentation.icon,
    },
    contentCapabilities: {
      copyFullText: workCapabilities.includes('copy-content'),
      memoColors: workCapabilities.includes('memo-colors'),
      exportContent: workCapabilities.includes('export-content'),
      saveAsTemplate: workCapabilities.includes('save-template'),
      versionHistory: workCapabilities.includes('version-history'),
    },
    actions: {
      onCopyLink: handleCopyLink,
      onCopyFullText: handleCopyFullText,
      onExportMarkdown: handleExportMarkdown,
      onSaveAsTemplate: handleSaveAsTemplate,
      onExportWord: handleExportWord,
      onExportPdf: handleExportPdf,
      onDeleteExternalFile: () => {
        const header = workColumnPresentation.header;
        if (header.kind === 'document' && header.document.externalFilePath) {
          void handleDeleteExternalFile(header.document.externalFilePath, selectedNotebook?.path ?? null);
        }
      },
    },
    mediaActions,
    folderCollectionViewType: navigationState.target.kind === 'collection'
      && canonicalPath(navigationState.target.filePath).endsWith('/.index.yaml')
      && navigationState.target.notebookId
      ? {
          current: navigationState.target.collectionType,
          isDefaultFolder: defaultCreateFolderState?.notebookId === navigationState.target.notebookId
            && notebookRelativeDirectoryPath(
              navigationState.target.notebookPath,
              parentDirectoryPath(navigationState.target.filePath, navigationState.target.notebookPath),
            ) === defaultCreateFolder,
          onToggleDefaultFolder: () => {
            const target = navigationState.target;
            if (target.kind === 'collection') void handleToggleDefaultFolder({
              filePath: target.filePath,
              notebookPath: target.notebookPath,
              notebookId: target.notebookId,
            });
          },
          onSelect: (type: 'table' | 'media_library') => {
            const target = navigationState.target;
            if (target.kind !== 'collection' || target.collectionType === type) return;
            void handleSwitchFolderCollectionType({
              filePath: target.filePath,
              notebookPath: target.notebookPath,
              notebookId: target.notebookId,
            }, type);
          },
        }
      : undefined,
  };
}
