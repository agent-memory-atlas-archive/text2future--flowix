import {
  initializeMemoLibrary,
  restorePersistedMemoSession,
} from '@features/memo/public/app-api';
import {
  captureWorkspaceRestoreTarget,
  restoreAgentConversationWorkspace,
  restoreExternalDocumentWorkspace,
  restoreMediaWorkspace,
  type PersistedWorkspaceTarget,
} from '@features/workspace/public/startup-api';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
import { boot } from '@platform/tauri/client';

/**
 * Run the main-window startup stages in one failure-aware transaction.
 *
 * Memo library initialization is the prerequisite for restoring a persisted
 * memo session. Keeping the stages together means a retry follows the same
 * order as the initial boot and never restores a document against stale
 * notebook state.
 */
export async function initializeMainWindowStartup(): Promise<void> {
  if (isTauriRuntime()) await boot.waitForStartupReady();
  await initializeMemoLibrary();
  const desiredTarget = captureWorkspaceRestoreTarget();
  const restoreStore = useWorkspaceRestoreStore.getState();
  restoreStore.setRestoreStatus('restoring');
  try {
    await restoreDesiredTarget(desiredTarget);
    useWorkspaceRestoreStore.getState().setRestoreStatus('restored');
  } catch (error) {
    // Keep desiredTarget unchanged. Temporary permission, mount, or IPC
    // failures can then be retried on the next launch.
    useWorkspaceRestoreStore.getState().setRestoreStatus('unavailable');
    throw error;
  }
}

async function restoreDesiredTarget(target: PersistedWorkspaceTarget | null): Promise<void> {
  if (!target || target.kind === 'memo') {
    await restorePersistedMemoSession(target?.kind === 'memo' ? target.memoId : null);
    return;
  }
  if (target.kind === 'external') {
    await restoreExternalDocumentWorkspace(target);
    return;
  }
  if (target.kind === 'media') {
    await restoreMediaWorkspace(target);
    return;
  }
  await restoreAgentConversationWorkspace();
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}
