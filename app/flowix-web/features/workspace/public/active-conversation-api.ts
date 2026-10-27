/** Workspace work-column state consumed by the agent task panel. */
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';

/**
 * The agent conversation currently shown in the work column, or null when the
 * work column is displaying something else. Used to highlight the row the user
 * is already reading without exposing the whole navigation model.
 */
export function useActiveAgentConversationInstanceId(): string | null {
  return useWorkColumnStore((state) => (
    state.navigation.target.kind === 'agent-conversation'
      ? state.navigation.target.instanceId
      : null
  ));
}
