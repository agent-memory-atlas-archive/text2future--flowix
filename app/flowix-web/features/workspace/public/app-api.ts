import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
export { ensureFileDisplayTrackingStarted } from '@features/workspace/use-cases/file-display-tracking';
export {
  removeBrowserColumnContentByPath,
} from '@features/workspace/public/browser-column-api';
export { applyNotebookPathMove } from '@features/workspace/use-cases/notebook-path-move';
export { openExternallyCreatedNote, openCreatedDocumentFromNotice } from '@features/workspace/use-cases/open-externally-created-note';

export function syncAppAgentConversationRestore(instanceId: string | null): void {
  const restore = useWorkspaceRestoreStore.getState();
  if (instanceId) restore.selectAgentConversation(instanceId);
  else restore.closeAgentConversationDetail();
}
