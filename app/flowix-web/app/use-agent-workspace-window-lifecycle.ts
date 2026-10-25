import { ensureAgentPreferencesReady } from '@features/agent/store/agent-data-store';
import { useAgentWorkspaceStore } from '@features/agent/store/agent-workspace-store';
import { useEffect } from 'react';
import { listenToAgentWorkspaceChanges, boot } from '@platform/tauri/client';
import { runStartupStage3Task, waitForStartupStage3 } from '@/lib/startup-stage3';
import { createLogger } from '@/lib/logger';
import { fireAndForget } from '@/lib/fire-and-forget';

const logger = createLogger('app/use-agent-workspace-window-lifecycle');

interface AgentWorkspaceWindowLifecycleOptions {
  /** Defer main-window Agent data until its shell paints; the preferences window loads on mount. */
  deferUntilStage3?: boolean;
}

// Shared snapshot state outlives effect instances, just like the named task.
let startupSnapshotRequested = false;

/**
 * Initialize per-Webview Agent data and keep its workspace snapshot in sync.
 *
 * 注：这里保持对两个 agent store 的静态 import。曾试过改成 effect 内动态 import
 * （目的是把 agent 数据图移出启动 chunk），实测对启动体积零影响——被多个懒加载块
 * 共享的模块会被 Rollup 上提到入口块（`onlyExplicitManualChunks` 关闭了自动分块），
 * 而且 `agent-window-effects` 本来就在 check-web-bundle 的启动根里。反而让 4 个
 * 生命周期单测的时序变脆，因此回退。
 */
export function useAgentWorkspaceWindowLifecycle(
  { deferUntilStage3 = false }: AgentWorkspaceWindowLifecycleOptions = {},
) {
  const loadInitial = useAgentWorkspaceStore((state) => state.workspaceActions.loadInitial);
  useEffect(() => {
    let active = true;
    let initialLoadStarted = false;
    let initialLoadSettled = false;
    let reloadQueued = false;
    let reloadInFlight = false;
    let unlisten: (() => void) | undefined;
    const runQueuedReload = () => {
      if (!active || !initialLoadSettled || !reloadQueued || reloadInFlight) return;
      reloadQueued = false;
      reloadInFlight = true;
      void loadInitial().catch((error) => {
        logger.warn('Workspace reload failed', { error });
      }).finally(() => {
        reloadInFlight = false;
        runQueuedReload();
      });
    };
    const reload = () => {
      if (!active) return;
      if (!initialLoadSettled || reloadInFlight) {
        reloadQueued = true;
        return;
      }
      reloadQueued = true;
      runQueuedReload();
    };
    const initialize = async () => {
      if ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) {
        await boot.waitForStartupReady();
      }
      if (!active) return;
      unlisten = listenToAgentWorkspaceChanges(reload, {
        onListenerReady: () => {
          // The initial snapshot covers first registration when it has not
          // started yet; reconnects after that need a fresh snapshot.
          if (initialLoadStarted || (deferUntilStage3 && startupSnapshotRequested)) reload();
        },
      });

      // Stage 3 owns scheduling; each store loads its own state independently.
      const markInitialLoadSettled = () => {
        if (!active) return;
        initialLoadSettled = true;
        runQueuedReload();
      };
      const initializeAgentPreferences = () => ensureAgentPreferencesReady().catch((error) => {
        logger.warn('Pi mode initialization failed', { error });
      });

      const workspaceTask = deferUntilStage3
        ? runStartupStage3Task('agent-workspace-snapshot-load', async () => { await loadInitial(); })
        : loadInitial();
      const preferencesTask = deferUntilStage3
        ? runStartupStage3Task('agent-preferences-initialize', initializeAgentPreferences)
        : initializeAgentPreferences();
      fireAndForget(
        workspaceTask.finally(markInitialLoadSettled),
        'agent-workspace:initial-load',
      );

      if (deferUntilStage3) await waitForStartupStage3();
      if (!active) return;
      initialLoadStarted = true;
      if (deferUntilStage3) startupSnapshotRequested = true;
      await Promise.all([workspaceTask, preferencesTask]);
    };
    void initialize().catch((error) => logger.warn('Workspace initialization deferred', { error }));
    return () => { active = false; unlisten?.(); };
  }, [deferUntilStage3, loadInitial]);
}
