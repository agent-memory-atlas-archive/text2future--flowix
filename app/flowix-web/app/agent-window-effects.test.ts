import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  waitForStartupReady: vi.fn(async (): Promise<void> => undefined),
  waitForWorkspaceRestoration: vi.fn(async (): Promise<void> => undefined),
  useAgentEvents: vi.fn(),
  refreshRuntime: vi.fn(async () => undefined),
  refreshCloudPiModelProviderAtStartup: vi.fn(async () => true),
  refreshAgentModelCatalog: vi.fn(async () => ({ items: [] })),
  loadWorkspace: vi.fn(async (): Promise<void> => undefined),
  initializePiMode: vi.fn(async () => undefined),
  initializeLegacySessionSettings: vi.fn(async () => undefined),
  listenWorkspace: vi.fn(),
  unlistenWorkspace: vi.fn(),
  invalidateNotebookCache: vi.fn(),
  prewarmNotebookCache: vi.fn(async () => undefined),
  invalidateMentionNotes: vi.fn(),
  invalidateMentionTags: vi.fn(),
  acquireMemoEventBridge: vi.fn(),
  releaseMemoEventBridge: vi.fn(),
}));

vi.mock('./main-window-startup', () => ({ waitForWorkspaceRestoration: mocks.waitForWorkspaceRestoration }));
vi.mock('@features/agent/services/agent-catalog-service', () => ({
  prefetchAvailableAgentModels: vi.fn(),
  prefetchNotebookSkills: vi.fn(),
  refreshAgentModelCatalog: mocks.refreshAgentModelCatalog,
}));
vi.mock('@features/memo/store/note-store', () => ({ useNoteStore: (selector: (state: { selectedNotebook: null }) => unknown) => selector({ selectedNotebook: null }) }));
vi.mock('@features/agent/hooks/use-agent-events', () => ({
  useAgentEvents: mocks.useAgentEvents,
}));
vi.mock('@features/agent/store/agent-runtime-store', () => ({
  useAgentRuntimeStore: (selector: (state: { refresh: typeof mocks.refreshRuntime }) => unknown) => (
    selector({ refresh: mocks.refreshRuntime })
  ),
}));
vi.mock('@features/agent/store/agent-data-store', () => ({
  ensureAgentPreferencesReady: async () => {
    await Promise.all([mocks.initializePiMode(), mocks.initializeLegacySessionSettings()]);
  },
  useAgentDataStore: (selector: (state: { initializePiMode: typeof mocks.initializePiMode; initializeLegacySessionSettings: typeof mocks.initializeLegacySessionSettings }) => unknown) => (
    selector({ initializePiMode: mocks.initializePiMode, initializeLegacySessionSettings: mocks.initializeLegacySessionSettings })
  ),
}));
vi.mock('@features/agent/store/agent-workspace-store', () => ({
  useAgentWorkspaceStore: (selector: (state: { workspaceActions: { loadInitial: typeof mocks.loadWorkspace } }) => unknown) => (
    selector({ workspaceActions: { loadInitial: mocks.loadWorkspace } })
  ),
}));
vi.mock('@features/editor/extensions/note-link/memo-resolver', () => ({
  invalidateNotebookCache: mocks.invalidateNotebookCache,
  prewarmNotebookCache: mocks.prewarmNotebookCache,
}));
vi.mock('@features/editor/extensions/note-mention/note-mention-data', () => ({
  invalidateMentionNotes: mocks.invalidateMentionNotes,
}));
vi.mock('@features/editor/extensions/tag-mention/tag-mention-data', () => ({
  invalidateMentionTags: mocks.invalidateMentionTags,
}));
vi.mock('@platform/tauri/client', () => ({
  boot: { waitForStartupReady: mocks.waitForStartupReady },
  cloud: { refreshPiModelProviderAtStartup: mocks.refreshCloudPiModelProviderAtStartup },
  listenToAgentWorkspaceChanges: mocks.listenWorkspace,
}));
vi.mock('@/lib/memo-dispatcher', () => ({
  acquireMemoEventBridge: () => {
    mocks.acquireMemoEventBridge();
    return mocks.releaseMemoEventBridge;
  },
}));

import { AgentWindowEffects } from './agent-window-effects';
import { useAgentWorkspaceWindowLifecycle } from './use-agent-workspace-window-lifecycle';
import { admitStartupStage3 } from '@/lib/startup-stage3';

function PreferencesWorkspaceLifecycle() {
  useAgentWorkspaceWindowLifecycle();
  return null;
}

describe('AgentWindowEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listenWorkspace.mockReturnValue(mocks.unlistenWorkspace);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('loads preferences window Agent data without mounting the Agent runtime', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(createElement(PreferencesWorkspaceLifecycle)));

    expect(mocks.loadWorkspace).toHaveBeenCalledOnce();
    expect(mocks.initializePiMode).toHaveBeenCalledOnce();
    expect(mocks.initializeLegacySessionSettings).toHaveBeenCalledOnce();
    expect(mocks.listenWorkspace).toHaveBeenCalledOnce();
    expect(mocks.refreshRuntime).not.toHaveBeenCalled();
    expect(mocks.useAgentEvents).not.toHaveBeenCalled();
    expect(mocks.prewarmNotebookCache).not.toHaveBeenCalled();

    await act(async () => mocks.listenWorkspace.mock.calls[0][0]());
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(2);

    const { onListenerReady } = mocks.listenWorkspace.mock.calls[0][1];
    await act(async () => onListenerReady());
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(3);
    // Reconcile again if the native listener reconnects after a failure.
    await act(async () => onListenerReady());
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(4);

    await act(async () => root.unmount());
    expect(mocks.unlistenWorkspace).toHaveBeenCalledOnce();
  });

  it('waits for native startup before reading workspace data', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    let ready!: () => void;
    mocks.waitForStartupReady.mockImplementationOnce(() => new Promise<void>((resolve) => { ready = resolve; }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(PreferencesWorkspaceLifecycle)));
      expect(mocks.loadWorkspace).not.toHaveBeenCalled();
      expect(mocks.initializePiMode).not.toHaveBeenCalled();
      expect(mocks.listenWorkspace).not.toHaveBeenCalled();
      await act(async () => ready());
      expect(mocks.loadWorkspace).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('does not read workspace data when native initialization fails', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    mocks.waitForStartupReady.mockRejectedValueOnce(new Error('migration failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(createElement(PreferencesWorkspaceLifecycle)));
      expect(mocks.loadWorkspace).not.toHaveBeenCalled();
      expect(mocks.initializePiMode).not.toHaveBeenCalled();
      expect(mocks.listenWorkspace).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      warn.mockRestore();
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('owns the shared Agent lifecycle for a content-capable Webview', async () => {
    function MainWorkspaceSync({ revision }: { revision: string }) {
      useAgentWorkspaceWindowLifecycle({ deferUntilStage3: true });
      return createElement('span', { 'data-revision': revision });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let finishSnapshot!: () => void;
    mocks.loadWorkspace.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSnapshot = resolve; }));

    await act(async () => {
      root.render(createElement('div', null,
        createElement(MainWorkspaceSync, { key: 'initial', revision: 'initial' }),
        createElement(AgentWindowEffects),
      ));
    });

    expect(mocks.listenWorkspace).toHaveBeenCalledTimes(2);
    await act(async () => mocks.listenWorkspace.mock.calls[0][0]());
    expect(mocks.loadWorkspace).not.toHaveBeenCalled();
    expect(mocks.initializePiMode).not.toHaveBeenCalled();
    expect(mocks.initializeLegacySessionSettings).not.toHaveBeenCalled();
    expect(mocks.useAgentEvents).toHaveBeenCalledOnce();
    expect(mocks.acquireMemoEventBridge).toHaveBeenCalledOnce();
    expect(mocks.refreshRuntime).not.toHaveBeenCalled();
    expect(mocks.loadWorkspace).not.toHaveBeenCalled();
    expect(mocks.listenWorkspace).toHaveBeenCalledTimes(2);
    expect(mocks.prewarmNotebookCache).not.toHaveBeenCalled();
    expect(mocks.refreshCloudPiModelProviderAtStartup).not.toHaveBeenCalled();

    let finishWorkspaceRestoration!: () => void;
    mocks.waitForWorkspaceRestoration.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishWorkspaceRestoration = resolve;
    }));
    await act(async () => admitStartupStage3());
    expect(mocks.loadWorkspace).toHaveBeenCalledOnce();
    expect(mocks.initializePiMode).toHaveBeenCalledOnce();
    expect(mocks.initializeLegacySessionSettings).toHaveBeenCalledOnce();
    expect(mocks.refreshRuntime).toHaveBeenCalledWith({ force: true });
    expect(mocks.prewarmNotebookCache).toHaveBeenCalledOnce();
    expect(mocks.waitForWorkspaceRestoration).toHaveBeenCalledOnce();
    expect(mocks.refreshCloudPiModelProviderAtStartup).not.toHaveBeenCalled();

    await act(async () => root.render(createElement('div', null,
      createElement(MainWorkspaceSync, { key: 'during', revision: 'during' }),
      createElement(AgentWindowEffects),
    )));
    expect(mocks.loadWorkspace).toHaveBeenCalledOnce();
    await act(async () => mocks.listenWorkspace.mock.calls[2][0]());
    expect(mocks.loadWorkspace).toHaveBeenCalledOnce();

    await act(async () => finishWorkspaceRestoration());
    expect(mocks.refreshCloudPiModelProviderAtStartup).toHaveBeenCalledOnce();
    expect(mocks.refreshAgentModelCatalog).toHaveBeenCalledWith('pi');

    await act(async () => finishSnapshot());
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(2);

    mocks.listenWorkspace.mockImplementationOnce((_reload, { onListenerReady }) => {
      onListenerReady();
      return mocks.unlistenWorkspace;
    });
    await act(async () => root.render(createElement('div', null,
      createElement(MainWorkspaceSync, { key: 'after', revision: 'after' }),
      createElement(AgentWindowEffects),
    )));
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(3);
    await act(async () => mocks.listenWorkspace.mock.calls[mocks.listenWorkspace.mock.calls.length - 1][0]());
    expect(mocks.loadWorkspace).toHaveBeenCalledTimes(4);

    await act(async () => root.unmount());
    expect(mocks.unlistenWorkspace).toHaveBeenCalledTimes(4);
    expect(mocks.releaseMemoEventBridge).toHaveBeenCalledOnce();
  });
});
