export { AgentConversationTitlebar } from '@features/agent/components/agent-conversation-titlebar';
export { AgentConversationList } from '@features/agent/components/agent-conversation-list';
export { AgentConversationStatusBar } from '@features/agent/components/agent-conversation-status-bar';
export { AgentIcon } from '@features/agent/components/agent-icon';
export { AgentTasksSection } from '@features/agent/components/agent-tasks-section';

import { buildInitialInstanceRuntimeConfig } from '@features/agent/store/initial-runtime-config';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { selectAndOpenAgentConversation } from '@features/workspace/use-cases/agent-conversation-navigation';
import { useMemoStore } from '@features/memo/store/memo-store';

/** Create and open a blank, notebook-scoped DSH conversation. */
export function createAndOpenDshConversation(): void {
  const notebookId = useMemoStore.getState().selectedNotebook?.id ?? null;
  const instance = useAgentSessionStore.getState().createInstance({
    agentType: 'deepseek-harness',
    title: '',
    threadId: null,
    source: {
      kind: 'dedicated',
      notebookId,
      documentPath: null,
    },
    runtimeConfig: buildInitialInstanceRuntimeConfig('deepseek-harness'),
  });
  void selectAndOpenAgentConversation(instance.instanceId);
}
