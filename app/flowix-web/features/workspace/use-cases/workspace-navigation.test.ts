import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginDescriptor } from '@platform/tauri/client';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';

function pluginWorkbenchTarget(id: string): Extract<WorkColumnTarget, { kind: 'plugin-workbench' }> {
  return {
    kind: 'plugin-workbench',
    plugin: { manifest: { id } } as unknown as PluginDescriptor,
  };
}

const mocks = vi.hoisted(() => ({
  clearDocument: vi.fn(),
  openExternalDocument: vi.fn(),
  openAgentConversation: vi.fn(),
  replaceActiveMemoPath: vi.fn(),
  discardMemoDocument: vi.fn(),
  closeAgentConversation: vi.fn(),
  flushDocumentPath: vi.fn(),
  setCurrentNotebook: vi.fn(),
  beginNavigation: vi.fn().mockReturnValue(1),
  commitNavigation: vi.fn().mockReturnValue(true),
  failNavigation: vi.fn().mockReturnValue(true),
  isCurrentNavigation: vi.fn().mockReturnValue(true),
  navigationTarget: pluginWorkbenchTarget('plugin-a') as WorkColumnTarget,
  memoState: {
    selectedNotebook: null as { id: string; path: string } | null,
    selectedNotebookId: null as string | null,
    selectedPathNote: null,
    notebooks: [],
    upsertMemo: vi.fn(),
    setSelectedNotebook: vi.fn(),
    setSelectedPathNote: vi.fn(),
    setActiveFilter: vi.fn(),
    setActivePluginId: vi.fn(),
    setNotebooks: vi.fn(),
    setMemos: vi.fn(),
    loadNotebooks: vi.fn(),
    loadMemos: vi.fn(),
    loadPathNotes: vi.fn(),
  },
  documentState: {
    activeExternalSession: null as { fileIdentity: { displayId: string; path: string }; scopePath: string | null; transitionId: number } | null,
    activeAgentConversationId: null as string | null,
  },
}));

vi.mock('@features/document/store/document-store', () => ({
  useDocumentStore: {
    getState: () => ({
      clearDocument: mocks.clearDocument,
      openExternalDocument: mocks.openExternalDocument,
      openAgentConversation: mocks.openAgentConversation,
      replaceActiveMemoPath: mocks.replaceActiveMemoPath,
      discardMemoDocument: mocks.discardMemoDocument,
      closeAgentConversation: mocks.closeAgentConversation,
      ...mocks.documentState,
    }),
  },
}));

vi.mock('@features/document/store/document-session-service', () => ({
  flushDocumentPath: mocks.flushDocumentPath,
}));

vi.mock('@platform/tauri/client', () => ({
  agent: {},
  memos: { resolveMarkdownLocation: vi.fn().mockResolvedValue(null) },
  notebooks: { setCurrent: mocks.setCurrentNotebook },
}));

vi.mock('@features/workspace/store/work-column-store', () => ({
  useWorkColumnStore: {
    getState: () => ({
      navigation: { phase: 'committed', showWorkColumnLoading: false, requestId: 1, target: mocks.navigationTarget, pendingTarget: null, previousTarget: null, failure: null, retryToken: null },
      beginNavigation: mocks.beginNavigation,
      commitNavigation: mocks.commitNavigation,
      failNavigation: mocks.failNavigation,
      isCurrentNavigation: mocks.isCurrentNavigation,
    }),
  },
}));

vi.mock('@features/memo/store/memo-store', () => ({
  useMemoStore: {
    getState: () => mocks.memoState,
  },
}));

import {
  closePluginWorkbench,
  openPluginWorkbench,
} from './workspace-navigation';

describe('workspace navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearDocument.mockResolvedValue(undefined);
    mocks.openExternalDocument.mockResolvedValue(undefined);
    mocks.openAgentConversation.mockResolvedValue(undefined);
    mocks.discardMemoDocument.mockResolvedValue(undefined);
    mocks.flushDocumentPath.mockResolvedValue(true);
    mocks.setCurrentNotebook.mockResolvedValue(undefined);
    mocks.navigationTarget = pluginWorkbenchTarget('plugin-a');
    mocks.documentState.activeExternalSession = null;
    mocks.documentState.activeAgentConversationId = null;
    mocks.memoState.selectedNotebook = null;
    mocks.memoState.selectedNotebookId = null;
    mocks.memoState.notebooks = [];
    mocks.memoState.upsertMemo.mockClear();
    mocks.memoState.setSelectedNotebook.mockClear();
    mocks.memoState.setActiveFilter.mockClear();
    mocks.memoState.setActivePluginId.mockClear();
    mocks.memoState.setNotebooks.mockClear();
    mocks.memoState.setMemos.mockClear();
    mocks.memoState.loadNotebooks.mockResolvedValue(undefined);
    mocks.memoState.loadMemos.mockResolvedValue(undefined);
  });

  it('opens a plugin workbench after the document has been cleared', async () => {
    await openPluginWorkbench({ manifest: { id: 'plugin-b' } } as never);

    expect(mocks.clearDocument).toHaveBeenCalledOnce();
    expect(mocks.commitNavigation).toHaveBeenCalledWith(1, {
      kind: 'plugin-workbench',
      plugin: { manifest: { id: 'plugin-b' } },
    });
    expect(mocks.memoState.setActiveFilter).toHaveBeenCalledWith('all');
    expect(mocks.memoState.setActivePluginId).toHaveBeenCalledWith('plugin-b');
  });

  it('restores the workbench target when closing cannot flush the document', async () => {
    const failure = new Error('save refused');
    mocks.clearDocument.mockRejectedValueOnce(failure);

    await expect(closePluginWorkbench()).rejects.toBe(failure);
    expect(mocks.failNavigation).toHaveBeenCalledWith(1, failure);
  });
});
