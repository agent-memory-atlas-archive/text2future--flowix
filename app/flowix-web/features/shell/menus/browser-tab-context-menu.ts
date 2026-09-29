import type { BrowserColumnTab } from '@features/workspace/public/browser-column-api';
import type { NativeContextMenuItems } from '@platform/tauri/native-context-menu';

export interface BrowserTabContextMenuLabels {
  close: string;
  closeOther: string;
  closeRight: string;
  closeAll: string;
  sourceMode: string;
  richTextMode: string;
  openInWorkColumn: string;
}

export function buildBrowserTabContextMenuItems({
  tab,
  index,
  tabCount,
  canMoveToWorkColumn,
  editorMode,
  labels,
  actions,
}: {
  tab: BrowserColumnTab;
  index: number;
  tabCount: number;
  canMoveToWorkColumn: boolean;
  editorMode: 'source' | 'rich' | null;
  labels: BrowserTabContextMenuLabels;
  actions: {
    close: () => void;
    closeOther: () => void;
    closeRight: () => void;
    closeAll: () => void;
    toggleMemoEditorMode: () => void;
    openInWorkColumn: () => void;
  };
}): NativeContextMenuItems {
  return [
    { text: labels.close, action: actions.close },
    { text: labels.closeOther, enabled: tabCount > 1, action: actions.closeOther },
    { text: labels.closeRight, enabled: index < tabCount - 1, action: actions.closeRight },
    { text: labels.closeAll, action: actions.closeAll },
    ...(tab.target.kind === 'file-browser' && Boolean(tab.target.activeFilePath && /\.md$/i.test(tab.target.activeFilePath))
      ? [{
          text: editorMode === 'source' ? labels.richTextMode : labels.sourceMode,
          action: actions.toggleMemoEditorMode,
        }]
      : []),
    { item: 'Separator' },
    {
      text: labels.openInWorkColumn,
      enabled: canMoveToWorkColumn,
      action: () => {
        if (canMoveToWorkColumn) actions.openInWorkColumn();
      },
    },
  ];
}
