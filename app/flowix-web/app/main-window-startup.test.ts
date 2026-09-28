import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from '@platform/tauri/client';
import { useMemoStore } from '@features/memo/store/memo-store';
import { useDocumentStore } from '@features/document/store/document-store';
import { waitForInitialDocumentLoad } from '@features/document/public/startup-api';

const mocks = vi.hoisted(() => ({
  initializeMemoLibrary: vi.fn(),
  restorePersistedMemoSession: vi.fn(),
  restoreAgentConversationWorkspace: vi.fn(),
  calls: [] as string[],
}));

vi.mock('@features/memo/use-cases/initialize-memo-library', () => ({
  initializeMemoLibrary: mocks.initializeMemoLibrary,
}));
vi.mock('@features/memo/use-cases/open-memo-session', () => ({
  restorePersistedMemoSession: mocks.restorePersistedMemoSession,
}));
vi.mock('@features/workspace/use-cases/agent-conversation-navigation', () => ({
  restoreAgentConversationWorkspace: mocks.restoreAgentConversationWorkspace,
}));

import { initializeMainWindowStartup } from './main-window-startup';

describe('initializeMainWindowStartup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    useMemoStore.getState().setStartupPhase('idle');
    useDocumentStore.setState({ isDocumentTransitioning: false, documentTransitionId: 0 });
    mocks.calls.length = 0;
    mocks.initializeMemoLibrary.mockReset().mockImplementation(async () => {
      mocks.calls.push('memo-library');
    });
    mocks.restorePersistedMemoSession.mockReset().mockImplementation(async () => {
      mocks.calls.push('memo-session');
    });
    mocks.restoreAgentConversationWorkspace.mockReset().mockImplementation(async () => {
      mocks.calls.push('agent-workspace');
    });
  });

  it('runs startup stages in dependency order', async () => {
    await initializeMainWindowStartup();

    expect(mocks.calls).toEqual([
      'memo-library',
      'memo-session',
    ]);
  });

  it('stops dependent restoration when library initialization fails', async () => {
    mocks.initializeMemoLibrary.mockRejectedValueOnce(new Error('backend unavailable'));

    await expect(initializeMainWindowStartup()).rejects.toThrow('backend unavailable');
    expect(mocks.restorePersistedMemoSession).not.toHaveBeenCalled();
    expect(mocks.restoreAgentConversationWorkspace).not.toHaveBeenCalled();
  });

  it('shows a retryable error when the native notebook identity cannot be read', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(boot, 'waitForStartupReady').mockResolvedValue();
    vi.spyOn(boot, 'getStartupNotebookId').mockRejectedValue(new Error('notebook identity unavailable'));
    const notifyInteractive = vi.spyOn(boot, 'notifyStartupInteractive').mockResolvedValue();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    await expect(initializeMainWindowStartup()).rejects.toThrow('notebook identity unavailable');

    expect(mocks.initializeMemoLibrary).not.toHaveBeenCalled();
    expect(useMemoStore.getState().startupPhase).toBe('error');
    expect(notifyInteractive).toHaveBeenCalledOnce();
  });

  it('holds background maintenance until the restored document finishes loading', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(boot, 'waitForStartupReady').mockResolvedValue();
    vi.spyOn(boot, 'getStartupNotebookId').mockResolvedValue('notebook-a');
    vi.spyOn(boot, 'recordStartupStage').mockResolvedValue();
    const notifyInteractive = vi.spyOn(boot, 'notifyStartupInteractive').mockResolvedValue();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    mocks.restorePersistedMemoSession.mockImplementationOnce(async () => {
      useDocumentStore.setState({ isDocumentTransitioning: true, documentTransitionId: 1 });
    });

    const startup = initializeMainWindowStartup();
    await vi.waitFor(() => expect(useDocumentStore.getState().isDocumentTransitioning).toBe(true));
    expect(notifyInteractive).not.toHaveBeenCalled();

    useDocumentStore.getState().finishDocumentTransition(1);
    await startup;
    expect(notifyInteractive).toHaveBeenCalledOnce();
  });

  it('releases the initial document barrier if its load stalls', async () => {
    vi.useFakeTimers();
    try {
      useDocumentStore.setState({ isDocumentTransitioning: true, documentTransitionId: 1 });
      const wait = waitForInitialDocumentLoad(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(wait).resolves.toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});
