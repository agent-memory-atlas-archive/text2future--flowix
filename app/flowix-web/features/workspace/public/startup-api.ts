import { restoreAgentConversationWorkspace as restore } from '@features/workspace/use-cases/agent-conversation-navigation';
export {
  captureWorkspaceRestoreTarget,
  restoreExternalDocumentWorkspace,
  restoreMediaWorkspace,
} from '@features/workspace/use-cases/workspace-navigation';
export type { PersistedWorkspaceTarget } from '@features/workspace/store/workspace-restore-store';

/** Application bootstrap contract; keeps startup imports isolated from the use-case module graph. */
export async function restoreAgentConversationWorkspace(): Promise<void> {
  await restore();
}
