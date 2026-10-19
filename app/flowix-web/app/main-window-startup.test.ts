import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStartupStore } from '@/lib/store/workspace-startup-store';
import { notifyWorkbenchMounted } from '@/lib/workbench-mount';

const mocks = vi.hoisted(() => ({
  context: vi.fn(), markError: vi.fn(), resumeNoteLinks: vi.fn(), target: vi.fn(), restore: vi.fn(), restoreStatus: vi.fn(),
  native: vi.fn(), notebook: vi.fn(), notify: vi.fn(), record: vi.fn(), revision: 0,
}));
vi.mock('@platform/tauri/client', () => ({ boot: {
  waitForStartupReady: mocks.native, getStartupNotebookId: mocks.notebook,
  notifyStartupInteractive: mocks.notify, recordStartupStage: mocks.record,
} }));
vi.mock('@features/memo/public/app-api', () => ({
  initializeNotebookContext: mocks.context,
  markMemoLibraryStartupError: mocks.markError,
  resumePendingNoteLinkUpdates: mocks.resumeNoteLinks,
}));
vi.mock('@features/workspace/public/startup-api', () => ({
  captureWorkspaceRestoreTarget: mocks.target, setWorkspaceRestoreStatus: mocks.restoreStatus,
  restoreExternalDocumentWorkspace: mocks.restore, restoreMediaWorkspace: mocks.restore,
  restoreTableWorkspace: mocks.restore, restoreCollectionWorkspace: mocks.restore,
  restoreFolderCollectionWorkspace: mocks.restore, restoreLegacyFolderListWorkspace: mocks.restore,
  restoreAgentConversationWorkspace: mocks.restore,
}));
vi.mock('@features/memo/public/workspace-api', () => ({
  getWorkspaceMemoState: () => ({ notebooks: [{ id: 'notebook-a' }] }),
}));
vi.mock('@features/workspace/public/shell-api', () => ({ getWorkspaceNavigationRevision: () => mocks.revision }));
import { initializeMainWindowStartup } from './main-window-startup';

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1; });
  useWorkspaceStartupStore.setState({ status: 'idle', task: null, error: null });
  notifyWorkbenchMounted();
  mocks.revision = 0;
  mocks.native.mockResolvedValue(undefined); mocks.notebook.mockResolvedValue('notebook-a');
  mocks.context.mockResolvedValue(undefined); mocks.notify.mockResolvedValue(undefined);
  mocks.record.mockResolvedValue(undefined); mocks.target.mockReturnValue(null);
  mocks.restore.mockResolvedValue(undefined);
});

describe('workbench startup', () => {
  it('resolves metadata before releasing the shell and starting content restoration', async () => {
    const order: string[] = [];
    mocks.context.mockImplementation(async () => { order.push('context'); });
    mocks.target.mockReturnValue({ kind: 'external', path: '/notes/a.md', scopePath: '/notes' });
    mocks.notify.mockImplementation(async () => { order.push('interactive'); });
    mocks.restore.mockImplementation(async () => { order.push('restore'); });
    await initializeMainWindowStartup();
    expect(order).toEqual(['context', 'interactive', 'restore']);
    expect(useWorkspaceStartupStore.getState().status).toBe('ready');
  });

  it('starts notebook context loading while the native notebook identity request is pending', async () => {
    let resolveIdentity!: (id: string) => void;
    mocks.notebook.mockReturnValue(new Promise<string>((resolve) => { resolveIdentity = resolve; }));
    let contextStarted = false;
    mocks.context.mockImplementation(async (identityPromise: Promise<string | null>) => {
      contextStarted = true;
      expect(identityPromise).toBeInstanceOf(Promise);
      await identityPromise;
    });

    const startup = initializeMainWindowStartup();
    await vi.waitFor(() => expect(contextStarted).toBe(true));
    resolveIdentity('notebook-a');
    await startup;
  });

  it('does not hold stage 2 open while a restored document is unresolved', async () => {
    let finish!: () => void;
    mocks.target.mockReturnValue({ kind: 'external', path: '/slow.md', scopePath: null });
    mocks.restore.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await initializeMainWindowStartup();
    expect(mocks.restore).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(useWorkspaceStartupStore.getState().status).toBe('ready');
    finish();
    await vi.waitFor(() => expect(mocks.restoreStatus).toHaveBeenLastCalledWith('restored'));
  });

  it('keeps restoration errors local after the workbench is interactive', async () => {
    mocks.target.mockReturnValue({ kind: 'external', path: '/missing.md', scopePath: null });
    mocks.restore.mockRejectedValue(new Error('file unavailable'));
    await initializeMainWindowStartup();
    await vi.waitFor(() => expect(mocks.restoreStatus).toHaveBeenLastCalledWith('unavailable'));
    expect(useWorkspaceStartupStore.getState()).toMatchObject({ status: 'ready', error: null });
  });

  it('does not restore an old target after the user navigates during paint', async () => {
    mocks.target.mockReturnValue({ kind: 'external', path: '/old.md', scopePath: null });
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      mocks.revision = 1; callback(0); return 1;
    });
    await initializeMainWindowStartup();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(useWorkspaceStartupStore.getState().status).toBe('ready');
  });

  it('exposes a metadata failure without starting dependent content restoration', async () => {
    mocks.context.mockRejectedValue(new Error('registry unavailable'));
    await expect(initializeMainWindowStartup()).rejects.toThrow('registry unavailable');
    expect(useWorkspaceStartupStore.getState()).toMatchObject({ status: 'failed', task: 'notebook-context' });
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('does not start background work when native preparation fails', async () => {
    mocks.native.mockRejectedValue(new Error('storage unavailable'));
    await expect(initializeMainWindowStartup()).rejects.toThrow('storage unavailable');
    expect(mocks.notify).not.toHaveBeenCalled(); expect(mocks.context).not.toHaveBeenCalled();
  });

  it('retains the identity error and releases an error screen for retry', async () => {
    mocks.notebook.mockRejectedValue(new Error('identity unavailable'));
    await expect(initializeMainWindowStartup()).rejects.toThrow('identity unavailable');
    expect(mocks.markError).toHaveBeenCalledOnce(); expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent startup calls', async () => {
    let finish!: () => void;
    mocks.context.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = initializeMainWindowStartup(); const second = initializeMainWindowStartup();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mocks.context).toHaveBeenCalledOnce());
    finish(); await first;
    expect(useWorkspaceStartupStore.getState().status).toBe('ready');
  });
});
